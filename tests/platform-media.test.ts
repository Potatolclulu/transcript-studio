import { describe, expect, it, vi } from 'vitest';
import { mediaInput, type CaptionResult } from '../shared/learning';
import { harness } from './harness';
import { now, uid } from '../worker/env';
import { processImport, sweepLearning } from '../worker/learning-import';
import { mediaEndpoint } from '../worker/platform-media';
import { app } from '../worker/index';
import { sha } from '../worker/security';

// Synthetic IDs; these tests use mocked media services.
const bili='https://www.bilibili.com/video/BV1234567890/';
const xiao='https://www.xiaoyuzhoufm.com/episode/0123456789abcdef01234567';
const key='a'.repeat(64);
const result:CaptionResult={title:'Public recording',author:'Creator',duration:700,selectedTrack:'automatic:asr-original',
  tracks:[{id:'automatic:asr-original',language:'zh',name:'Original',source:'automatic',translated:false}],
  completeness:'complete',cues:[{start:0,end:20,text:'开场'},{start:600,end:700,text:'结束'}],chapters:[]};
function setup(url=bili){
  const h=harness();h.user('alice');h.user('bob');
  h.env.CAPTION_SERVICE_URL='https://media.test.invalid/extract';h.env.CAPTION_SERVICE_SECRET='test-media-secret';
  const input=mediaInput(url),id=uid();
  h.sql.prepare('INSERT INTO library(id,user_id,youtube_id,url,title,platform,source_id,media_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id,'alice',input.identity,input.url,'Pending',input.platform,input.id,input.mediaKind,now(),now());
  return {...h,id};
}
describe('public platform media',()=>{
  it('canonicalizes tracking URLs and preserves independent bilibili parts',()=>{
    expect(mediaInput(bili+'?spm_id=tracking&p=1').identity).toBe('bilibili:BV1234567890:p1');
    expect(mediaInput(bili+'?p=2').url).toBe(bili+'?p=2');
    expect(mediaInput(xiao+'?share=1').url).toBe(xiao);
    expect(mediaInput('https://youtu.be/arj7oStGLkU').identity).toBe('arj7oStGLkU');
  });
  it('rejects forged hosts credentials arbitrary ports live pages and invalid parts',()=>{
    for(const url of [bili.replace('bilibili.com','bilibili.com.evil.invalid'),bili.replace('www.','user:password@www.'),
      bili+'?p=0',bili+'?p=1&p=2',bili+'?p=2.5','https://live.bilibili.com/1','https://b23.tv/unknown',
      xiao.replace('/episode/','/podcast/'),'http://localhost:8791/media/test'])
      expect(()=>mediaInput(url)).toThrow();
  });
  it('retains a persistent pending job without holding a long worker request',async()=>{
    const h=setup(),fetcher=vi.fn(async()=>Response.json({key,status:'running',progress:'Transcribing segment 1 of 2',error:null}));
    await processImport(h.env,h.id,fetcher);
    let row=h.sql.prepare('SELECT * FROM library WHERE id=?').get(h.id)!;
    expect(row.caption_status).toBe('importing');expect(row.import_token).toBeNull();expect(row.media_key).toBe(key);
    await processImport(h.env,h.id,fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
    h.sql.prepare('UPDATE library SET lease_until=0 WHERE id=?').run(h.id);
    await processImport(h.env,h.id,fetcher);expect(fetcher).toHaveBeenCalledTimes(2);
    const requests=fetcher.mock.calls as unknown as [URL,RequestInit][];
    expect(JSON.parse(String(requests[0][1].body)).attempt).toBe(JSON.parse(String(requests[1][1].body)).attempt);
    await sweepLearning(h.env);
    row=h.sql.prepare('SELECT * FROM library WHERE id=?').get(h.id)!;
    expect(row.caption_status).toBe('importing');
  });
  it('saves timed speech snapshots and does not overwrite anchors on retry',async()=>{
    const h=setup(xiao);
    const completed=(value:CaptionResult)=>async()=>Response.json({key,status:'complete',progress:'Ready',error:null,result:value});
    await processImport(h.env,h.id,completed(result));
    expect(h.sql.prepare('SELECT caption_status FROM library WHERE id=?').get(h.id)!.caption_status).toBe('ready');
    h.sql.prepare("UPDATE library SET caption_status='queued' WHERE id=?").run(h.id);
    await processImport(h.env,h.id,completed({...result,cues:[{start:1,end:700,text:'Changed provider output'}]}));
    expect([...h.objects.values()].map(v=>JSON.parse(v).cues)[0]).toEqual(result.cues);
  });
  it('rejects out-of-order transcripts and explicit service redirects',async()=>{
    const h=setup();
    await processImport(h.env,h.id,async()=>Response.json({key,status:'complete',progress:'Ready',error:null,
      result:{...result,cues:[{start:600,end:700,text:'later'},{start:0,end:1,text:'earlier'}]}}));
    expect(h.objects.size).toBe(0);
    expect(h.sql.prepare('SELECT caption_status FROM library WHERE id=?').get(h.id)!.caption_status).toBe('error');
    expect(()=>mediaEndpoint({...h.env,APP_ENV:'production',CAPTION_SERVICE_URL:'http://localhost:8791/extract'},'/jobs')).toThrow();
  });
  it('clears stale transcription progress when a persistent native job fails',async()=>{
    const h=setup();
    h.sql.prepare('UPDATE library SET import_progress=? WHERE id=?').run('Transcribing segment 1 of 2',h.id);
    await processImport(h.env,h.id,async()=>Response.json({key,status:'failed',progress:'Transcribing segment 1 of 2',error:'Speech unavailable.'}));
    expect(h.sql.prepare('SELECT caption_status,import_progress,error FROM library WHERE id=?').get(h.id))
      .toMatchObject({caption_status:'error',import_progress:null,error:'Speech unavailable.'});
  });
  it('streams byte ranges only for the owning account, including HEAD',async()=>{
    const h=setup();h.sql.prepare('UPDATE library SET media_key=? WHERE id=?').run(key,h.id);
    for(const owner of ['alice','bob'])h.sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await sha(owner),owner,now()+3600);
    const upstream=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>new Response(options?.method==='HEAD'?null:new Uint8Array([1,2,3]),{
      status:206,headers:{'Content-Type':'video/mp4','Content-Length':'3','Content-Range':'bytes 10-12/100','Accept-Ranges':'bytes'},
    }));
    try{
      const get=(owner:string,method='GET')=>app.request(`/api/library/${h.id}/media`,{method,headers:{Cookie:`ts_session=${owner}`,Range:'bytes=10-12'}},h.env);
      expect((await get('bob')).status).toBe(404);expect(upstream).not.toHaveBeenCalled();
      const response=await get('alice');
      expect(response.status).toBe(206);expect(response.headers.get('Content-Range')).toBe('bytes 10-12/100');
      expect((await response.arrayBuffer()).byteLength).toBe(3);
      expect((await get('alice','HEAD')).body).toBeNull();
      expect(upstream.mock.calls[0][1]?.headers).toBeInstanceOf(Headers);
    }finally{upstream.mockRestore();}
  });
});
