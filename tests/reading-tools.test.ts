import { describe,expect,it } from 'vitest';
import { harness } from './harness';
import { now } from '../worker/env';
import { sha } from '../worker/security';
import { app } from '../worker/index';
import { processImport,sweepLearning } from '../worker/learning-import';
import { processReading,readingTools,requestReading,translationBatch,alignChinese,translatedPassages } from '../worker/reading-tools';
import { ownVideo,validAnchor } from '../worker/learning-store';
import { cueAt,type CaptionResult } from '../shared/learning';

const fixture:CaptionResult={
  title:'A long lecture',author:'Author',duration:1200,
  tracks:[{id:'automatic:en',language:'en',name:'English',source:'automatic',translated:false}],
  selectedTrack:'automatic:en',completeness:'complete',
  cues:Array.from({length:240},(_,i)=>({start:i*5,end:(i+1)*5,text:`Original passage number ${i}.`}))
};
async function setup(){
  const h=harness();h.user('alice');h.user('bob');
  const token='reading-test-session';h.sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await sha(token),'alice',now()+3600);
  h.env.CAPTION_SERVICE_URL='https://captions.test.invalid/extract';h.env.CAPTION_SERVICE_SECRET='unit-caption';
  h.env.LLM_API_KEY='unit-key';h.env.LLM_API_URL='https://llm.test.invalid/chat';h.env.LLM_MODEL='unit-model';
  h.env.LLM_DAILY_BUDGET_CENTS='50';h.env.LLM_USER_DAILY_BUDGET_CENTS='20';h.env.LLM_REQUEST_BUDGET_CENTS='5';
  async function request(path:string,body?:unknown,method?:string){
    return app.request('/api/library'+path,{method:method||(body===undefined?'GET':'POST'),
      headers:{Origin:h.env.PUBLIC_ORIGIN,Cookie:`ts_session=${token}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)},h.env);
  }
  const response=await request('',{url:'https://youtu.be/7xTGNNLPyMI'}),{id}=await response.json() as {id:string};
  await processImport(h.env,id,async()=>Response.json(fixture));
  const video=await ownVideo(h.env,'alice',id);
  return {...h,id,video,request};
}
const chapters=[{start:0,end:60,title:'Introduction'},{start:60,end:1200,title:'The model'}];
describe('chapter navigation and translations',()=>{
  it('looks up active passages by playback time including paused seeks and long videos',()=>{
    expect(cueAt(fixture.cues,-1)).toBe(-1);expect(cueAt(fixture.cues,60)).toBe(12);
    expect(cueAt(fixture.cues,1200)).toBe(239);
  });
  it('uses creator chapters without an AI request or minute charge and deduplicates retries',async()=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'chapters');
    const calls:string[]=[];
    await processReading(h.env,task.id,async(url)=>{calls.push(String(url));return Response.json({chapters});});
    expect(calls).toEqual([h.env.CAPTION_SERVICE_URL]);expect((await readingTools(h.env,h.video)).chapters).toEqual(chapters);
    expect((await requestReading(h.env,h.video,'chapters')).id).toBe(task.id);
    await processReading(h.env,task.id,async()=>{throw new Error('Already complete');});
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM learning_ai_spend').get()?.n).toBe(0);
    expect(h.sql.prepare('SELECT reserved FROM users WHERE id=?').get('alice')?.reserved).toBe(0);
  });
  it('reuses creator chapters captured during import without fetching metadata again',async()=>{
    const h=await setup();
    h.sql.prepare("UPDATE library SET caption_status='queued' WHERE id=?").run(h.id);
    // A cached caption snapshot still exposes its immutable chapter metadata on subsequent imports.
    const saved=h.sql.prepare('SELECT object_key FROM caption_tracks WHERE video_id=?').get(h.id)?.object_key as string;
    h.objects.set(saved,JSON.stringify({...fixture,chapters}));
    const task=await requestReading(h.env,h.video,'chapters');
    expect(task).toMatchObject({status:'complete',source:'creator',completed:2,total:2});
    await processReading(h.env,task.id,async()=>{throw new Error('Should be cached');});
    expect((await readingTools(h.env,h.video)).chapters).toEqual(chapters);
  });
  it('leases a running task so duplicate queue messages cannot make a second provider call',async()=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'chapters');
    let release:()=>void=()=>{},started:()=>void=()=>{},calls=0;
    const begin=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);
    const running=processReading(h.env,task.id,async()=>{calls++;started();await hold;return Response.json({chapters});});
    await begin;
    await processReading(h.env,task.id,async()=>{calls++;throw new Error('Duplicate');});
    await requestReading(h.env,h.video,'chapters');
    release();await running;
    expect(calls).toBe(1);expect((await readingTools(h.env,h.video)).chapterTask?.status).toBe('complete');
  });
  it('validates native chapter ordering and keeps AI times anchored to real original cue IDs',async()=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'chapters',0,true);
    await processReading(h.env,task.id,async()=>Response.json({choices:[{message:{content:JSON.stringify({chapters:[{cue:0,title:'Opening'},{cue:18,title:'Next topic'}]})}}]}));
    const result=await readingTools(h.env,h.video);
    expect(result.chapters.map(c=>c.start)).toEqual([0,90]);expect(result.chapterTask?.source).toBe('ai');
  });
  it('aligns Chinese platform tracks and never calls AI if every original passage is covered',async()=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'translation');
    const chinese={...fixture,selectedTrack:'manual:zh-Hans',tracks:[{...fixture.tracks[0],id:'manual:zh-Hans',language:'zh-Hans',source:'manual'}],
      cues:fixture.cues.map(c=>({...c,text:'中文字幕'}))};
    await processReading(h.env,task.id,async()=>Response.json(chinese));
    const result=await readingTools(h.env,h.video);
    expect(result.translation).toMatchObject({source:'youtube',status:'complete',completed:240});
    expect(result.lines['12']).toBe('中文字幕');
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM learning_ai_spend').get()?.n).toBe(0);
    expect(alignChinese([{start:0,end:10,text:'original'}],[{start:0,end:5,text:'前半'},{start:5,end:10,text:'后半'}])['0']).toBe('前半 后半');
  });
  it('translates the current chapter first, resumes saved batches and does not mutate original note anchors',async()=>{
    const h=await setup(),ct=await requestReading(h.env,h.video,'chapters');
    await processReading(h.env,ct.id,async()=>Response.json({chapters}));
    const task=await requestReading(h.env,h.video,'translation',6),batches:number[][]=[];
    const fetcher:typeof fetch=async(url,options)=>{
      if(String(url)===h.env.CAPTION_SERVICE_URL)return Response.json({error:'429'},{status:429});
      const input=JSON.parse(String(options?.body)),passages=JSON.parse(input.messages[1].content).passages as {id:string;text:string}[];
      const source=passages.map(l=>Number(l.text.match(/\d+/)![0]));
      batches.push(source);
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:Object.fromEntries(passages.map((l,i)=>[l.id,`中文 ${source[i]}`]))})}}]});
    };
    await processReading(h.env,task.id,fetcher);
    expect(batches[0]).toEqual([6,7,8,9,10,11]);
    await processReading(h.env,task.id,fetcher);
    expect(batches[1]).toEqual([0,1,2,3,4,5]);
    const result=await readingTools(h.env,h.video);
    expect(result.translation).toMatchObject({completed:12,source:'ai',status:'queued'});
    expect(result.lines['6']).toBe('中文 6');
    const anchor={trackId:'automatic:en',firstCue:6,lastCue:6,startOffset:0,endOffset:fixture.cues[6].text.length,quote:fixture.cues[6].text,start:30,end:35};
    expect(await validAnchor(h.env,h.video,anchor)).toEqual(anchor);
    expect(translationBatch(fixture.cues,result.lines,0,chapters)[0].cue).toBe(12);
  });
  it.each(['account','global'])('pauses at the production %s daily cap, preserves completed translations and does not call the provider',async(limit)=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'translation');
    h.env.APP_ENV='production';
    h.sql.prepare('INSERT INTO learning_ai_spend VALUES(?,?,?,?)').run('spent',limit==='account'?'alice':'bob',new Date().toISOString().slice(0,10),limit==='account'?20:50);
    h.sql.prepare("UPDATE reading_tasks SET platform_tried=1,source='ai',data_json=?,completed=1 WHERE id=?").run('{"0":"已完成"}',task.id);
    let calls=0;await processReading(h.env,task.id,async()=>{calls++;throw new Error('Must not call');});
    const result=await readingTools(h.env,h.video);
    expect(calls).toBe(0);expect(result.translation?.status).toBe('paused');expect(result.lines['0']).toBe('已完成');
    await sweepLearning(h.env);expect(h.sql.prepare('SELECT status FROM reading_tasks WHERE id=?').get(task.id)?.status).toBe('paused');
  });
  it.each(['exhausted','missing'])('continues saved development translations with %s budgets and records every batch',async(budget)=>{
    const h=await setup();
    if(budget==='missing'){
      delete h.env.LLM_DAILY_BUDGET_CENTS;delete h.env.LLM_USER_DAILY_BUDGET_CENTS;delete h.env.LLM_REQUEST_BUDGET_CENTS;
    }
    h.sql.prepare('INSERT INTO learning_ai_spend VALUES(?,?,?,?)').run('spent','alice',new Date().toISOString().slice(0,10),50);
    const task=await requestReading(h.env,h.video,'translation');
    h.sql.prepare("UPDATE reading_tasks SET platform_tried=1,source='ai',data_json=?,completed=1 WHERE id=?").run('{"0":"已完成"}',task.id);
    let calls=0;
    const fetcher:typeof fetch=async(_url,options)=>{
      calls++;
      const passages=JSON.parse(JSON.parse(String(options?.body)).messages[1].content).passages as {id:string;text:string}[];
      expect(passages.every(p=>p.text!==fixture.cues[0].text)).toBe(true);
      return Response.json({choices:[{message:{content:JSON.stringify({translations:Object.fromEntries(passages.map(p=>[p.id,'新译文']))})}}]});
    };
    await processReading(h.env,task.id,fetcher);await processReading(h.env,task.id,fetcher);
    const result=await readingTools(h.env,h.video);
    expect(calls).toBe(2);expect(result.translation).toMatchObject({status:'queued',completed:65,error:null});
    expect(result.lines['0']).toBe('已完成');
    expect(h.sql.prepare('SELECT COUNT(*) AS n,SUM(cents) AS cents FROM learning_ai_spend').get()).toMatchObject({n:3,cents:budget==='missing'?50:60});
  });
  it('does not let a model local index become a long-video database cue index',()=>{
    const batch=[{cue:1560,text:'Original 1560'},{cue:1562,text:'Original 1562'}];
    expect(translatedPassages(batch,{translations:{p0:'译文 A',p1:'译文 B'}})).toEqual({'1560':'译文 A','1562':'译文 B'});
    expect(()=>translatedPassages(batch,{translations:{'0':'错配','1560':'错配'}})).toThrow();
  });
  it('saves unambiguous partial translations and subsequently translates only missing passages',async()=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'translation',150);
    h.sql.prepare('UPDATE reading_tasks SET platform_tried=1 WHERE id=?').run(task.id);
    await processReading(h.env,task.id,async()=>Response.json({choices:[{message:{content:'{"translations":{"p0":"第一条","p2":"第三条","p31":17,"p999":"不属于本批"}}'}}]}));
    let result=await readingTools(h.env,h.video);
    expect(result.translation).toMatchObject({status:'queued',source:'ai',completed:2});
    expect(result.lines).toEqual({'150':'第一条','152':'第三条'});
    const remaining=translationBatch(fixture.cues,result.lines,150,[]);
    expect(remaining[0].cue).toBe(151);expect(remaining.some(p=>p.cue===152)).toBe(false);
    await processReading(h.env,task.id,async(_url,options)=>{
      const passages=JSON.parse(JSON.parse(String(options?.body)).messages[1].content).passages;
      expect(passages[0]).toEqual({id:'p0',text:fixture.cues[151].text});
      return Response.json({choices:[{message:{content:'{"translations":{"p0":"补齐第二条"}}'}}]});
    });
    result=await readingTools(h.env,h.video);
    expect(result.lines['151']).toBe('补齐第二条');expect(result.lines['152']).toBe('第三条');
  });
  it('fails an entirely invalid translation response without inventing aligned passages',async()=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'translation');
    h.sql.prepare('UPDATE reading_tasks SET platform_tried=1 WHERE id=?').run(task.id);
    await processReading(h.env,task.id,async()=>Response.json({choices:[{message:{content:'{"translations":{"p999":"不属于本批"}}'}}]}));
    expect((await readingTools(h.env,h.video)).translation?.status).toBe('failed');
    expect((await readingTools(h.env,h.video)).lines).toEqual({});
  });
  it('protects reading tools by ownership and removes tasks and outbox entries when deleting a video',async()=>{
    const h=await setup(),task=await requestReading(h.env,h.video,'chapters');
    expect((await app.request(`/api/library/${h.id}/reading`,{},h.env)).status).toBe(401);
    const wrong=crypto.randomUUID();expect((await h.request(`/${wrong}/reading`)).status).toBe(404);
    expect((await h.request(`/${h.id}/reading`,{kind:'translation',cue:999})).status).toBe(400);
    await h.request(`/${h.id}`,undefined,'DELETE');
    expect(h.sql.prepare('SELECT id FROM reading_tasks WHERE id=?').get(task.id)).toBeUndefined();
    expect(h.sql.prepare('SELECT id FROM learning_outbox WHERE id=?').get(task.id)).toBeUndefined();
  });
});
