import { describe, expect, it } from 'vitest';
import { app } from '../worker/index';
import { harness } from './harness';
import { now } from '../worker/env';
import { sha } from '../worker/security';
import { processImport, sweepLearning } from '../worker/learning-import';
import { AI_INPUT_BUDGET, aiEnabled, contextFor, processQuestion } from '../worker/learning-ai';
import { type Anchor, type CaptionResult, youtubeInput } from '../shared/learning';

const fixture: CaptionResult = {
  title:'Learning from evidence',author:'Test author',duration:120,
  tracks:[{id:'manual:en',language:'en',name:'English',source:'manual',translated:false},{id:'automatic:fr',language:'fr',name:'French',source:'automatic',translated:false}],
  selectedTrack:'manual:en',completeness:'complete',
  cues:[{start:0,end:30,text:'A question can make an idea clearer.'},{start:30,end:90,text:'Evidence is what connects a claim to its source.'},{start:90,end:120,text:'Keep your own thought next to the original words.'}],
};
const anchor:Anchor={trackId:'manual:en',firstCue:0,lastCue:0,startOffset:0,endOffset:fixture.cues[0].text.length,quote:fixture.cues[0].text,start:0,end:30};
async function setup(){
  const h=harness();h.user('alice',8);h.user('bob',8);
  const token='test-session-alice',token2='test-session-bob';
  h.sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await sha(token),'alice',now()+3600);
  h.sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await sha(token2),'bob',now()+3600);
  h.env.CAPTION_SERVICE_URL='https://captions.test.invalid/extract';h.env.CAPTION_SERVICE_SECRET='unit-test-caption-only';
  async function request(path:string,body?:unknown,method?:string,owner='alice'){
    const response=await app.request(`/api/library${path}`,{
      method:method||(body===undefined?'GET':'POST'),
      headers:{Origin:h.env.PUBLIC_ORIGIN,Cookie:`ts_session=${owner==='alice'?token:token2}`,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),
    },h.env);
    return {status:response.status,data:await response.json() as any};
  }
  async function add(){
    const result=await request('',{url:'https://youtu.be/arj7oStGLkU'});
    return result.data.id as string;
  }
  async function imported(){
    const id=await add();
    await processImport(h.env,id,async()=>Response.json(fixture));
    return id;
  }
  return {...h,request,add,imported};
}
describe('private learning library',()=>{
  it('normalizes tags, atomically adds and merges without erasing unrelated tags',async()=>{
    const h=await setup(),id=await h.imported(),other=(await h.request('',{url:'https://youtu.be/dQw4w9WgXcQ'})).data.id;
    await h.request(`/${id}`,{tags:['  AI  ','ai','Deep   Learning']},'PATCH');
    expect((await h.request(`/${id}`)).data.video.tags).toEqual(['AI','Deep Learning']);
    await h.request(`/${other}`,{tags:['Writing']},'PATCH');
    expect((await h.request('/tags',{action:'add',ids:[id,other],tag:' ai '})).status).toBe(200);
    expect((await h.request(`/${other}`)).data.video.tags).toEqual(['Writing','AI']);
    expect((await h.request('/tags',{action:'rename',from:'AI',to:'Writing'})).status).toBe(200);
    expect((await h.request(`/${id}`)).data.video.tags).toEqual(['Writing','Deep Learning']);
    expect((await h.request(`/${other}`)).data.video.tags).toEqual(['Writing']);
    await h.request('/tags',{action:'remove',ids:[id,other],tag:'Writing'});
    expect((await h.request(`/${id}`)).data.video.tags).toEqual(['Deep Learning']);
    expect((await h.request(`/${other}`)).data.video.tags).toEqual([]);
  });
  it('rejects unauthorized batches and full-tag batches without partially changing videos',async()=>{
    const h=await setup(),id=await h.imported(),other=(await h.request('',{url:'https://youtu.be/dQw4w9WgXcQ'})).data.id;
    const bob=(await h.request('',{url:'https://youtu.be/arj7oStGLkU'},'POST','bob')).data.id;
    expect((await h.request('/tags',{action:'add',ids:[id,bob],tag:'Private'})).status).toBe(404);
    expect((await h.request(`/${id}`)).data.video.tags).toEqual([]);
    await h.request(`/${other}`,{tags:Array.from({length:12},(_,i)=>`Tag ${i}`)},'PATCH');
    expect((await h.request('/tags',{action:'add',ids:[id,other],tag:'Extra'})).status).toBe(422);
    expect((await h.request(`/${id}`)).data.video.tags).toEqual([]);
    expect((await h.request('/tags',{action:'rename',from:'Tag 0',to:'Mine'},'POST','bob')).status).toBe(200);
    expect((await h.request(`/${other}`)).data.video.tags).toContain('Tag 0');
  });
  it('aborts an entire batch when a tag changes between validation and update',async()=>{
    const h=await setup(),id=await h.imported(),other=(await h.request('',{url:'https://youtu.be/dQw4w9WgXcQ'})).data.id;
    const prepare=h.env.DB.prepare.bind(h.env.DB);
    h.env.DB.prepare=((sql:string)=>{
      if(sql.startsWith('WITH changes'))h.sql.prepare('UPDATE library SET tags_json=? WHERE id=?').run('["Concurrent"]',other);
      return prepare(sql);
    }) as typeof h.env.DB.prepare;
    expect((await h.request('/tags',{action:'add',ids:[id,other],tag:'Extra'})).status).toBe(409);
    expect((await h.request(`/${id}`)).data.video.tags).toEqual([]);
    expect((await h.request(`/${other}`)).data.video.tags).toEqual(['Concurrent']);
  });
  it('scopes transcript search and saved notes by tag, untagged and learning status',async()=>{
    const h=await setup(),id=await h.imported(),other=(await h.request('',{url:'https://youtu.be/dQw4w9WgXcQ'})).data.id;
    await h.request(`/${id}`,{tags:['Science'],status:'complete'},'PATCH');
    const note=crypto.randomUUID();
    await h.request(`/${id}/records`,{id:note,kind:'note',body:'Evidence connects ideas',anchor});
    await h.request(`/${id}/records`,{id:crypto.randomUUID(),kind:'highlight',anchor});
    await h.request(`/${id}/drafts/${crypto.randomUUID()}`,{body:'Evidence draft',anchor},'PUT');
    await h.request(`/${other}/records`,{id:crypto.randomUUID(),kind:'note',body:'Evidence without captions'});
    expect((await h.request('/search?q=Evidence&tag=Science')).data.results.every((r:any)=>r.video_id===id)).toBe(true);
    expect((await h.request('/search?q=Evidence&tag=Absent')).data.results).toHaveLength(0);
    expect((await h.request('/search?q=Evidence&status=new')).data.results).toHaveLength(0);
    const tagged=(await h.request('/notes?tag=Science&status=complete')).data;
    expect(tagged.total).toBe(1);
    expect(tagged.notes[0]).toMatchObject({id:note,anchor,title:fixture.title,tags:['Science']});
    expect(tagged.notes[0]).not.toHaveProperty('user_id');
    expect((await h.request('/notes?untagged=1')).data.notes[0].video_id).toBe(other);
    expect((await h.request('/notes?q=question')).data.notes[0].id).toBe(note);
    expect((await h.request('/notes',undefined,'GET','bob')).data.notes).toHaveLength(0);
    expect((await h.request('/notes?status=broken')).status).toBe(400);
    expect((await h.request('')).data.noteCounts[id]).toBe(1);
    await h.request(`/${id}`,undefined,'DELETE');
    expect((await h.request('/notes?tag=Science')).data.total).toBe(0);
  });
  it('paginates saved notes without duplicates when timestamps are identical and escapes search wildcards',async()=>{
    const h=await setup(),id=await h.imported();
    for(let i=0;i<45;i++)await h.request(`/${id}/records`,{id:crypto.randomUUID(),kind:'note',body:i===0?'100%_literal':`Saved thought ${i}`});
    const first=(await h.request('/notes')).data;
    expect(first.notes).toHaveLength(40);expect(first.total).toBe(45);
    const second=(await h.request('/notes?cursor='+encodeURIComponent(first.nextCursor))).data;
    expect(second.notes).toHaveLength(5);expect(second.nextCursor).toBeNull();
    expect(new Set([...first.notes,...second.notes].map((n:any)=>n.id)).size).toBe(45);
    expect((await h.request('/notes?q=%25_')).data.notes).toHaveLength(1);
    expect((await h.request('/notes?cursor=not-json')).status).toBe(400);
  });
  it('deduplicates links, stores real caption timestamps, and never reserves transcription minutes',async()=>{
    const h=await setup(),id=await h.imported();
    expect((await h.add())).toBe(id);
    const detail=await h.request(`/${id}`);
    expect(detail.data.video.title).toBe(fixture.title);
    expect(detail.data.transcript.cues[1].start).toBe(30);
    expect(h.sql.prepare('SELECT balance,reserved FROM users WHERE id=?').get('alice')).toMatchObject({balance:8,reserved:0});
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toMatchObject({n:0});
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM ledger').get()).toMatchObject({n:0});
  });
  it('rejects private, playlist, non-YouTube and forged URLs',()=>{
    for(const url of ['https://youtube.com.evil.test/watch?v=arj7oStGLkU','https://youtube.com/watch?v=arj7oStGLkU&list=abc','file:///arj7oStGLkU','https://user:secret@youtube.com/watch?v=arj7oStGLkU','https://youtu.be/arj7oStGLkU/anything'])
      expect(()=>youtubeInput(url)).toThrow();
  });
  it('checks ownership on reading, writing, deleting and search',async()=>{
    const h=await setup(),id=await h.imported();
    expect((await h.request(`/${id}`,undefined,'GET','bob')).status).toBe(404);
    expect((await h.request(`/${id}`,{tags:['stolen']},'PATCH','bob')).status).toBe(404);
    expect((await h.request(`/${id}`,undefined,'DELETE','bob')).status).toBe(404);
    expect((await h.request('/search?q=Evidence',undefined,'GET','bob')).data.results).toHaveLength(0);
    const imported=await h.request('',{url:'https://youtu.be/arj7oStGLkU'},'POST','bob');
    expect(imported.data.id).not.toBe(id);
    expect((await h.request('',undefined,'GET','bob')).data.videos).toHaveLength(1);
  });
  it('keeps local preview sign-in closed in production',async()=>{
    const h=await setup();
    h.env.APP_ENV='production';
    const response=await app.request('/api/auth/learning-preview',{method:'POST',headers:{Origin:h.env.PUBLIC_ORIGIN,'Content-Type':'application/json'},body:'{}'},h.env);
    expect(response.status).toBe(404);
    expect((await h.request('',{url:'https://youtu.be/arj7oStGLkU'})).status).toBe(202);
    const anonymous=await app.request('/api/library',{},h.env);
    expect(anonymous.status).toBe(401);
  });
  it('validates exact anchored text and saves idempotent notes with conflict detection',async()=>{
    const h=await setup(),id=await h.imported(),record=crypto.randomUUID();
    expect((await h.request(`/${id}/records`,{id:record,kind:'note',body:'My durable question',anchor:{...anchor,quote:'Invented quote'}})).status).toBe(400);
    expect((await h.request(`/${id}/records`,{id:record,kind:'note',body:'My durable question',anchor})).status).toBe(200);
    await h.request(`/${id}/records`,{id:record,kind:'note',body:'My durable question',anchor});
    expect((await h.request(`/${id}`)).data.records).toHaveLength(1);
    expect((await h.request(`/${id}/records/${record}`,{body:'Edited learning note',revision:1},'PATCH')).status).toBe(200);
    expect((await h.request(`/${id}/records/${record}`,{body:'Stale edit',revision:1},'PATCH')).status).toBe(409);
    expect((await h.request('/search?q=Edited')).data.results[0]).toMatchObject({kind:'note',record_id:record});
    expect((await h.request(`/${id}`)).data.records[0].body).toBe('Edited learning note');
  });
  it('keeps multiple notes at one selection and recovers drafts outside saved notes',async()=>{
    const h=await setup(),id=await h.imported(),draft=crypto.randomUUID();
    expect((await h.request(`/${id}/drafts/${draft}`,{body:'An unfinished thought',anchor},'PUT')).status).toBe(200);
    let detail=(await h.request(`/${id}`)).data;
    expect(detail.records).toHaveLength(0);
    expect(detail.drafts[0]).toMatchObject({id:draft,body:'An unfinished thought',anchor});
    expect((await h.request(`/${id}/drafts/${draft}`,{body:'A revised draft',anchor},'PUT')).status).toBe(200);
    expect((await h.request(`/${id}/drafts/${draft}`,{body:'Not mine',anchor},'PUT','bob')).status).toBe(404);
    expect((await h.request(`/${id}/records`,{id:draft,kind:'note',body:'First saved note',anchor})).status).toBe(200);
    await h.request(`/${id}/records`,{id:crypto.randomUUID(),kind:'note',body:'Another thought at the same selection',anchor});
    // A late autosave cannot turn the saved new note back into a draft.
    await h.request(`/${id}/drafts/${draft}`,{body:'Late draft',anchor},'PUT');
    detail=(await h.request(`/${id}`)).data;
    expect(detail.records).toHaveLength(2);expect(detail.drafts).toHaveLength(0);
    expect(detail.records.every((r:any)=>r.anchor.quote===anchor.quote)).toBe(true);
  });
  it('preserves an edit draft revision so an old draft cannot overwrite a newer note',async()=>{
    const h=await setup(),id=await h.imported(),note=crypto.randomUUID(),draft=crypto.randomUUID();
    await h.request(`/${id}/records`,{id:note,kind:'note',body:'Original',anchor});
    expect((await h.request(`/${id}/drafts/${draft}`,{body:'Draft edit',recordId:note,recordRevision:1,anchor},'PUT')).status).toBe(200);
    await h.request(`/${id}/records/${note}`,{body:'Newer edit from another tab',revision:1},'PATCH');
    const restored=(await h.request(`/${id}`)).data.drafts[0];
    expect(restored.record_revision).toBe(1);
    expect((await h.request(`/${id}/records/${note}`,{body:restored.body,revision:restored.record_revision,draftId:draft},'PATCH')).status).toBe(409);
    expect((await h.request(`/${id}`)).data.records[0].body).toBe('Newer edit from another tab');
  });
  it('retains failed imports and no-caption collections without fabricated text',async()=>{
    const h=await setup(),id=await h.add();
    await processImport(h.env,id,async()=>Response.json({error:'Source is unavailable.'},{status:422}));
    const failed=await h.request(`/${id}`);
    expect(failed.data.video.caption_status).toBe('error');expect(failed.data.transcript).toBeNull();
    await h.request(`/${id}/import`,{});
    await processImport(h.env,id,async()=>Response.json({...fixture,tracks:[],selectedTrack:null,cues:[],completeness:'none'}));
    const empty=await h.request(`/${id}`);
    expect(empty.data.video.caption_status).toBe('none');expect(empty.data.transcript).toBeNull();
    expect((await h.request(`/${id}/records`,{id:crypto.randomUUID(),kind:'note',body:'Thought without captions'})).status).toBe(200);
  });
  it('does not forward credentials on service redirects and preserves stable track snapshots',async()=>{
    const h=await setup(),id=await h.add();let calls=0;
    await processImport(h.env,id,async(_url,options)=>{
      calls++;expect(options?.redirect).toBe('manual');return new Response(null,{status:302,headers:{Location:'https://other.invalid/'}});
    });
    expect(calls).toBe(1);expect((await h.request(`/${id}`)).data.video.caption_status).toBe('error');
    await h.request(`/${id}/import`,{});
    await processImport(h.env,id,async()=>Response.json(fixture));
    await h.request(`/${id}/records`,{id:crypto.randomUUID(),kind:'highlight',anchor});
    await h.request(`/${id}/import`,{});
    await processImport(h.env,id,async()=>Response.json({...fixture,cues:fixture.cues.map(c=>({...c,text:'Changed source text'}))}));
    const detail=(await h.request(`/${id}`)).data;
    expect(detail.transcript.cues[0].text).toBe(anchor.quote);expect(detail.records[0].anchor.quote).toBe(anchor.quote);
  });
  it('preserves old quotes when switching tracks and removes all owned data on deletion',async()=>{
    const h=await setup(),id=await h.imported();
    await h.request(`/${id}/records`,{id:crypto.randomUUID(),kind:'highlight',anchor});
    await h.request(`/${id}/import`,{trackId:'automatic:fr'});
    await processImport(h.env,id,async()=>Response.json({...fixture,selectedTrack:'automatic:fr',cues:[{start:0,end:120,text:'Une question utile.'}]}));
    const detail=(await h.request(`/${id}`)).data;
    expect(detail.transcript.track.id).toBe('automatic:fr');expect(detail.records[0].anchor.quote).toBe(anchor.quote);
    expect((await h.request('/search?q=question')).data.results.filter((r:any)=>r.kind==='transcript')[0].body).toContain('Une question');
    await h.request(`/${id}`,undefined,'DELETE');
    expect(h.objects.size).toBe(0);
    expect((await h.request('/search?q=question')).data.results).toHaveLength(0);
    expect((await h.request(`/${id}`)).status).toBe(404);
  });
  it('recovers an expired import lease and saves playback and reading positions separately',async()=>{
    const h=await setup(),id=await h.imported();
    await h.request(`/${id}`,{playback:75,readingCue:1,status:'learning',tags:['Science']},'PATCH');
    const v=(await h.request(`/${id}`)).data.video;
    expect(v).toMatchObject({playback_position:75,reading_cue:1,learning_status:'learning',tags:['Science']});
    h.sql.prepare("UPDATE library SET caption_status='importing',lease_until=0,import_token='lost' WHERE id=?").run(id);
    await sweepLearning(h.env);
    expect(h.queue.filter(q=>q===id).length).toBeGreaterThan(1);
    expect(h.sql.prepare('SELECT caption_status FROM library WHERE id=?').get(id)).toMatchObject({caption_status:'queued'});
  });
});
describe('grounded AI questions',()=>{
  async function aiSetup(){
    const h=await setup(),video=await h.imported();
    h.env.LLM_API_URL='https://llm.test.invalid/chat/completions';h.env.LLM_API_KEY='test-key-only';h.env.LLM_MODEL='test-model';
    h.env.LLM_DAILY_BUDGET_CENTS='10';h.env.LLM_USER_DAILY_BUDGET_CENTS='4';h.env.LLM_REQUEST_BUDGET_CENTS='2';
    h.env.APP_ENV='production';
    const id=crypto.randomUUID();
    await h.request(`/${video}/questions`,{id,question:'How does a question help?',anchor});
    return {...h,video,id};
  }
  const good=()=>Response.json({choices:[{message:{content:JSON.stringify({videoAnswer:'A question helps clarify an idea.',supplement:'You can write down an example.',citations:[1]})}}]});
  it('stays unavailable without an explicitly configured provider',async()=>{
    const h=await setup(),id=await h.imported();
    expect((await h.request(`/${id}/questions`,{id:crypto.randomUUID(),question:'Explain this',anchor})).status).toBe(503);
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM learning_questions').get()).toMatchObject({n:0});
  });
  it('requires positive finite budgets in production and provider credentials in development',()=>{
    const h=harness();
    h.env.LLM_API_URL='https://llm.test.invalid/chat';h.env.LLM_API_KEY='test-key';h.env.LLM_MODEL='test-model';
    expect(aiEnabled(h.env)).toBe(true);
    h.env.APP_ENV='production';expect(aiEnabled(h.env)).toBe(false);
    for(const value of ['0','-1','Infinity','invalid']){
      h.env.LLM_DAILY_BUDGET_CENTS=value;h.env.LLM_USER_DAILY_BUDGET_CENTS='4';h.env.LLM_REQUEST_BUDGET_CENTS='2';
      expect(aiEnabled(h.env)).toBe(false);
    }
    h.env.LLM_DAILY_BUDGET_CENTS='10';expect(aiEnabled(h.env)).toBe(true);
    h.env.APP_ENV='development';delete h.env.LLM_API_KEY;expect(aiEnabled(h.env)).toBe(false);
    h.env.LLM_API_KEY='test-key';delete h.env.LLM_MODEL;expect(aiEnabled(h.env)).toBe(false);
    h.env.LLM_MODEL='test-model';h.env.LLM_API_URL='http://llm.test.invalid/chat';expect(aiEnabled(h.env)).toBe(false);
  });
  it.each(['exhausted','missing'])('answers development questions with %s budgets while recording reservations',async(budget)=>{
    const h=await aiSetup();h.env.APP_ENV='development';
    if(budget==='missing'){
      delete h.env.LLM_DAILY_BUDGET_CENTS;delete h.env.LLM_USER_DAILY_BUDGET_CENTS;delete h.env.LLM_REQUEST_BUDGET_CENTS;
    }
    h.sql.prepare('INSERT INTO learning_ai_spend VALUES(?,?,?,?)').run('spent','alice',new Date().toISOString().slice(0,10),10);
    let calls=0;
    await processQuestion(h.env,h.id,async()=>{calls++;return good();});
    const next=crypto.randomUUID();
    expect((await h.request(`/${h.video}/questions`,{id:next,question:'Explain again',anchor,conversationId:h.id})).status).toBe(202);
    await processQuestion(h.env,next,async()=>{calls++;return good();});
    expect(calls).toBe(2);
    expect(h.sql.prepare('SELECT status FROM learning_questions WHERE id=?').get(next)?.status).toBe('complete');
    expect(h.sql.prepare('SELECT COUNT(*) AS n,SUM(cents) AS cents FROM learning_ai_spend').get()).toMatchObject({n:3,cents:budget==='missing'?10:14});
  });
  it('saves cited answers once, sends only source data and protects per-user limits',async()=>{
    const h=await aiSetup();let calls=0;
    await processQuestion(h.env,h.id,async(_url,options)=>{
      calls++;const payload=JSON.parse(options!.body as string);
      expect(payload.messages[1].content).toContain(anchor.quote);
      expect(payload.messages[0].content).toContain('untrusted');
      expect(payload.messages[1].content).not.toContain('test-session');
      return good();
    });
    await processQuestion(h.env,h.id,async()=>{calls++;return good();});
    expect(calls).toBe(1);
    const detail=(await h.request(`/${h.video}`)).data;
    expect(detail.questions[0]).toMatchObject({status:'complete',citations:[1],answer:'A question helps clarify an idea.'});
    expect((await h.request('/search?q=clarify')).data.results[0].kind).toBe('question');
    for(let i=0;i<2;i++){
      const id=crypto.randomUUID();await h.request(`/${h.video}/questions`,{id,question:'Explain again',anchor,conversationId:h.id});
      await processQuestion(h.env,id,async()=>{calls++;return good();});
    }
    expect(calls).toBe(2);
    expect(h.sql.prepare('SELECT SUM(cents) AS cents FROM learning_ai_spend').get()).toMatchObject({cents:4});
    expect((await h.request(`/${h.video}`)).data.questions.at(-1).status).toBe('failed');
  });
  it('sends a stable full transcript prefix and saves only cited passages with reported cache usage',async()=>{
    const h=await aiSetup();let prefix='';
    await processQuestion(h.env,h.id,async(_url,options)=>{
      const payload=JSON.parse(options!.body as string);prefix=payload.messages[1].content;
      expect(prefix).toContain(fixture.cues[2].text);
      expect(prefix).not.toContain('How does a question help?');
      expect(new TextEncoder().encode(payload.messages.map((m:any)=>m.content).join('')).length).toBeLessThan(AI_INPUT_BUDGET);
      return Response.json({choices:[{message:{content:'{"videoAnswer":"A clearer idea.","supplement":"","citations":[1]}'}}],
        usage:{prompt_tokens:1200,prompt_cache_hit_tokens:1000,prompt_cache_miss_tokens:200}});
    });
    const detail=(await h.request(`/${h.video}`)).data;
    expect(detail.questions[0]).toMatchObject({context_scope:'full_transcript',input_tokens:1200,cache_hit_tokens:1000,cache_miss_tokens:200});
    expect(detail.questions[0].context).toHaveLength(1);
    expect(detail.records).toHaveLength(0);
    const next=crypto.randomUUID();
    await h.request(`/${h.video}/questions`,{id:next,question:'Explain the later evidence',anchor,conversationId:h.id});
    await processQuestion(h.env,next,async(_url,options)=>{
      const payload=JSON.parse(options!.body as string);
      expect(payload.messages[1].content).toBe(prefix);
      expect(payload.messages[2].content).toContain('A clearer idea.');
      return good();
    });
  });
  it('uses nearby time context and Chinese terms when a transcript is too large',()=>{
    const cues=Array.from({length:100},(_,i)=>({start:i*20,end:i*20+20,text:'无关背景。'.repeat(80)}));
    cues[50]={...cues[50],text:'后面给出的认知边界例子。'};
    const at={...anchor,trackId:'manual:zh',quote:cues[0].text,start:0,end:20,endOffset:cues[0].text.length};
    const result=contextFor(cues,at,'认知边界指什么？',9000);
    expect(result.scope).toBe('relevant_passages');
    expect(result.evidence.some(e=>e.cue===0)).toBe(true);
    expect(result.evidence.some(e=>e.cue===50)).toBe(true);
    expect(result.evidence.every(e=>e.id===e.cue+1)).toBe(true);
  });
  it('converts an answer to a note only on explicit save and preserves its owned source',async()=>{
    const h=await aiSetup();
    await processQuestion(h.env,h.id,async()=>good());
    const draft=crypto.randomUUID();
    expect((await h.request(`/${h.video}/drafts/${draft}`,{body:'My edited understanding',anchor,sourceQuestionId:h.id},'PUT')).status).toBe(200);
    expect((await h.request(`/${h.video}`)).data.records).toHaveLength(0);
    expect((await h.request('/notes')).data.total).toBe(0);
    const note=await h.request(`/${h.video}/records`,{id:draft,kind:'note',body:'My edited understanding',anchor,sourceQuestionId:h.id});
    expect(note.status).toBe(200);
    const detail=(await h.request(`/${h.video}`)).data;
    expect(detail.records[0]).toMatchObject({body:'My edited understanding',source_question_id:h.id});
    expect((await h.request('/notes')).data.notes[0]).toMatchObject({id:draft,source_question_id:h.id,body:'My edited understanding'});
    expect(detail.drafts).toHaveLength(0);
    const other=await h.request('',{url:'https://youtu.be/arj7oStGLkU'},'POST','bob');
    await processImport(h.env,other.data.id,async()=>Response.json(fixture));
    expect((await h.request(`/${other.data.id}/records`,{id:crypto.randomUUID(),kind:'note',body:'Stolen source',anchor,sourceQuestionId:h.id},'POST','bob')).status).toBe(400);
  });
  it('rejects fabricated citations and preserves the original question on failure',async()=>{
    const h=await aiSetup();
    await processQuestion(h.env,h.id,async()=>Response.json({choices:[{message:{content:'{"videoAnswer":"False claim","supplement":"","citations":[999]}'}}]}));
    const question=(await h.request(`/${h.video}`)).data.questions[0];
    expect(question.status).toBe('failed');expect(question.answer).toBeNull();expect(question.question).toBe('How does a question help?');
    expect((await h.request('/search?q=False')).data.results).toHaveLength(0);
  });
  it('uses DeepSeek JSON output without reasoning and keeps user-language answers',async()=>{
    const h=await aiSetup();
    h.env.LLM_API_URL='https://api.deepseek.com/chat/completions';
    h.env.LLM_MODEL='deepseek-flash';
    await processQuestion(h.env,h.id,async(_url,options)=>{
      const payload=JSON.parse(options!.body as string);
      expect(payload.thinking).toEqual({type:'disabled'});
      expect(payload.response_format).toEqual({type:'json_object'});
      expect(payload.messages[0].content).toContain('language of the user question');
      return Response.json({choices:[{message:{content:JSON.stringify({videoAnswer:'这是根据原文作出的解释。',supplement:'',citations:[1]})}}]});
    });
    expect((await h.request(`/${h.video}`)).data.questions[0]).toMatchObject({status:'complete',answer:'这是根据原文作出的解释。'});
  });
  it('does not publish an answer after the user stops a running request',async()=>{
    const h=await aiSetup();
    await processQuestion(h.env,h.id,async()=>{
      expect((await h.request(`/${h.video}/questions/${h.id}/stop`,{})).status).toBe(200);return good();
    });
    const q=(await h.request(`/${h.video}`)).data.questions[0];
    expect(q.status).toBe('cancelled');expect(q.answer).toBeNull();
  });
});
