import { describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import { harness } from './harness';
import { now } from '../worker/env';
import { sha } from '../worker/security';
import { processImport } from '../worker/learning-import';
import { processQuestion } from '../worker/learning-ai';
import { ownVideo } from '../worker/learning-store';
import { processReading, readingTools, requestReading } from '../worker/reading-tools';
import { mediaInput, type Anchor, type CaptionResult } from '../shared/learning';

const sources = [
  ['youtube','https://youtu.be/arj7oStGLkU','en'],
  // Synthetic source IDs; every import and provider call below is mocked.
  ['bilibili','https://www.bilibili.com/video/BV1234567890/','zh'],
  ['xiaoyuzhou','https://www.xiaoyuzhoufm.com/episode/0123456789abcdef01234567','zh'],
] as const;

async function setup(url:string,language:string) {
  const h=harness();h.user('alice');h.user('bob');
  for(const owner of ['alice','bob'])
    h.sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await sha(owner),owner,now()+3600);
  Object.assign(h.env,{CAPTION_SERVICE_URL:'https://media.test.invalid/extract',CAPTION_SERVICE_SECRET:'unit-secret',
    LLM_API_URL:'https://llm.test.invalid/chat',LLM_API_KEY:'unit-key',LLM_MODEL:'unit-model'});
  const fixture:CaptionResult={title:'Shared learning fixture',author:'A creator',duration:700,
    tracks:[{id:`automatic:${language}`,language,name:language,source:'automatic',translated:false}],
    selectedTrack:`automatic:${language}`,completeness:'complete',
    cues:[{start:0,end:20,text:language==='zh'?'证据让问题更清楚。':'Evidence makes a question clearer.'},
      {start:600,end:700,text:language==='zh'?'保存原文旁的想法。':'Keep a thought beside its source.'}]};
  const request=async(path:string,body?:unknown,method?:string,owner='alice')=>{
    const response=await app.request('/api/library'+path,{method:method||(body===undefined?'GET':'POST'),
      headers:{Origin:h.env.PUBLIC_ORIGIN,Cookie:`ts_session=${owner}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)},h.env);
    return {status:response.status,data:await response.json() as any};
  };
  const {data:{id}}=await request('',{url});
  const imported=()=>processImport(h.env,id,async()=>Response.json(mediaInput(url).platform==='youtube'?fixture:
    {key:'a'.repeat(64),status:'complete',progress:'Ready',error:null,result:fixture}));
  const anchor:Anchor={trackId:fixture.selectedTrack!,firstCue:0,lastCue:0,startOffset:0,
    endOffset:fixture.cues[0].text.length,quote:fixture.cues[0].text,start:0,end:20};
  return {...h,id,fixture,anchor,request,imported};
}

describe.each(sources)('%s learning parity',(_platform,url,language)=>{
  it('marks playback as learning without captions and preserves a completed status on later activity',async()=>{
    const h=await setup(url,language);
    expect((await h.request(`/${h.id}`,{activity:'playback',playback:10},'PATCH')).status).toBe(200);
    expect(h.sql.prepare('SELECT learning_status,playback_position FROM library WHERE id=?').get(h.id))
      .toMatchObject({learning_status:'learning',playback_position:10});
    await h.request(`/${h.id}`,{status:'complete'},'PATCH');
    await h.request(`/${h.id}`,{activity:'playback',playback:15},'PATCH');
    expect(h.sql.prepare('SELECT learning_status FROM library WHERE id=?').get(h.id)?.learning_status).toBe('complete');
    expect((await h.request(`/${h.id}`,{activity:'playback'},'PATCH','bob')).status).toBe(404);
    await h.request(`/${h.id}`,{status:'new'},'PATCH');
    expect(h.sql.prepare('SELECT learning_status FROM library WHERE id=?').get(h.id)?.learning_status).toBe('new');
  });
  it('keeps tag and status scopes, drafts, highlights and note source anchors across reloads',async()=>{
    const h=await setup(url,language);await h.imported();
    await h.request('/tags',{action:'add',ids:[h.id],tag:'Parity'});
    await h.request(`/${h.id}`,{status:'learning',playback:12,readingCue:1},'PATCH');
    const draft=crypto.randomUUID(),highlight=crypto.randomUUID();
    expect((await h.request(`/${h.id}/drafts/${draft}`,{body:'Parity draft',anchor:h.anchor},'PUT')).status).toBe(200);
    expect((await h.request(`/${h.id}/records`,{id:highlight,kind:'highlight',anchor:h.anchor})).status).toBe(200);
    let detail=(await h.request(`/${h.id}`)).data;
    expect(detail.drafts[0]).toMatchObject({id:draft,anchor:h.anchor});
    expect(detail.records).toHaveLength(1);
    expect((await h.request(`/${h.id}/records`,{id:draft,kind:'note',body:'Parity saved note',anchor:h.anchor})).status).toBe(200);
    detail=(await h.request(`/${h.id}`)).data;
    expect(detail.drafts).toHaveLength(0);
    expect(detail.video).toMatchObject({tags:['Parity'],learning_status:'learning',playback_position:12,reading_cue:1});
    const notes=(await h.request('/notes?tag=Parity&status=learning')).data.notes;
    expect(notes).toHaveLength(1);expect(notes[0]).toMatchObject({id:draft,video_id:h.id,anchor:h.anchor});
    expect((await h.request('/notes?tag=Parity&status=complete')).data.notes).toHaveLength(0);
    const search=(await h.request('/search?q=Parity&tag=Parity&status=learning')).data.results;
    expect(search.find((r:any)=>r.record_id===draft)).toMatchObject({cue:0,start:0,video_id:h.id});
    const transcript=(await h.request('/search?q='+encodeURIComponent(h.anchor.quote.slice(0,8)))).data.results;
    expect(transcript.find((r:any)=>r.kind==='transcript')).toMatchObject({cue:0,start:0,video_id:h.id});
    expect((await h.request('/notes',undefined,'GET','bob')).data.notes).toHaveLength(0);
  });
  it('answers from this platform transcript and preserves citations when an answer is saved as a note',async()=>{
    const h=await setup(url,language);await h.imported();
    const id=crypto.randomUUID();
    expect((await h.request(`/${h.id}/questions`,{id,question:'这段讲的是什么？',anchor:h.anchor})).status).toBe(202);
    const provider=vi.fn(async(_url:RequestInfo|URL,options?:RequestInit)=>{
      const {messages}=JSON.parse(String(options?.body));
      expect(messages[1].content).toContain(h.anchor.quote);
      expect(JSON.parse(messages[2].content).selectedQuote).toBe(h.anchor.quote);
      return Response.json({choices:[{message:{content:JSON.stringify({
        videoAnswer:'这段说明要把想法保存在原文旁。',supplement:'',citations:[1],
      })}}]});
    });
    await processQuestion(h.env,id,provider);
    const detail=(await h.request(`/${h.id}`)).data;
    expect(detail.questions[0]).toMatchObject({status:'complete',anchor:h.anchor,citations:[1]});
    const note=crypto.randomUUID();
    expect((await h.request(`/${h.id}/records`,{id:note,kind:'note',body:detail.questions[0].answer,
      anchor:h.anchor,sourceQuestionId:id})).status).toBe(200);
    expect((await h.request(`/${h.id}`)).data.records[0]).toMatchObject({source_question_id:id,anchor:h.anchor});
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('generates an outline in the source language with timestamps anchored to real cues',async()=>{
    const h=await setup(url,language);await h.imported();
    const video=await ownVideo(h.env,'alice',h.id),task=await requestReading(h.env,video,'chapters',0,true);
    const provider=vi.fn(async(_url:RequestInfo|URL,options?:RequestInit)=>{
      const {messages}=JSON.parse(String(options?.body));
      expect(messages[0].content).toContain(language==='zh'?'Simplified Chinese':'original transcript language (en)');
      return Response.json({choices:[{message:{content:JSON.stringify({chapters:[
        {cue:0,title:language==='zh'?'问题与证据':'Evidence'},{cue:1,title:language==='zh'?'保存想法':'Notes'},
      ]})}}]});
    });
    await processReading(h.env,task.id,provider);
    const tools=await readingTools(h.env,video);
    expect(tools.chapterTask).toMatchObject({source:'ai',status:'complete'});
    expect(tools.chapters.map(c=>c.start)).toEqual([0,600]);
    expect(provider).toHaveBeenCalledTimes(1);
    if(language==='zh')await expect(requestReading(h.env,video,'translation')).rejects.toThrow('already in Chinese');
  });
});

it('preserves a manual completion that arrives between the activity read and update',async()=>{
  const h=await setup(sources[1][1],'zh'),prepare=h.env.DB.prepare.bind(h.env.DB);
  h.env.DB.prepare=((query:string)=>{
    if(query.startsWith('UPDATE library SET updated_at')&&query.includes('CASE WHEN'))
      h.sql.prepare("UPDATE library SET learning_status='complete' WHERE id=?").run(h.id);
    return prepare(query);
  }) as typeof h.env.DB.prepare;
  expect((await h.request(`/${h.id}`,{activity:'playback'},'PATCH')).status).toBe(200);
  expect(h.sql.prepare('SELECT learning_status FROM library WHERE id=?').get(h.id)?.learning_status).toBe('complete');
});

it.each(sources.slice(1))('translates a non-Chinese %s recording without using a YouTube caption request',async(_platform,url)=>{
  const h=await setup(url,'fr');await h.imported();
  const video=await ownVideo(h.env,'alice',h.id),task=await requestReading(h.env,video,'translation');
  const provider=vi.fn(async(url:RequestInfo|URL,options?:RequestInit)=>{
    expect(String(url)).toBe(h.env.LLM_API_URL);
    const passages=JSON.parse(JSON.parse(String(options?.body)).messages[1].content).passages;
    return Response.json({choices:[{message:{content:JSON.stringify({
      translations:Object.fromEntries(passages.map((p:{id:string})=>[p.id,'中文译文'])),
    })}}]});
  });
  await processReading(h.env,task.id,provider);
  expect((await readingTools(h.env,video)).translation).toMatchObject({source:'ai',status:'complete',completed:2});
  expect(provider).toHaveBeenCalledTimes(1);
});
