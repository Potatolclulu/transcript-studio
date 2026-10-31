import { describe,it,expect } from 'vitest';
import { normalizeInput, exportTranscript } from '../shared/model';
import { parseTranscript, Supadata } from '../worker/provider';
describe('source safety and format correctness',()=>{
  it('canonicalizes videos without conflating semantic media selectors',()=>{
    expect(normalizeInput('https://youtu.be/dQw4w9WgXcQ?si=tracking').key).toBe(normalizeInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=20').key);
    expect(normalizeInput('https://twitter.com/test/status/123456789').key).toBe(normalizeInput('https://x.com/test/status/123456789').key);
    for(const url of ['https://evil.com/video.mp4','https://x.com/test/status/123456789/video/2','https://youtube.com/watch?v=dQw4w9WgXcQ&list=abc','https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ'])
      expect(()=>normalizeInput(url)).toThrow();
  });
  it('converts millisecond timestamps and makes legal non-overlapping subtitle exports',()=>{
    const t=parseTranscript({lang:'en',content:[{text:'First <word>',offset:1000,duration:4000},{text:'Second',offset:3000,duration:2000}]},'Title','generate',60);
    expect(t.segments[0]).toEqual({text:'First <word>',start:1,end:3});
    expect(exportTranscript(t,'srt')).toContain('00:00:01,000 --> 00:00:03,000');
    expect(exportTranscript(t,'vtt')).toContain('WEBVTT\n\n00:00:01.000');
    expect(exportTranscript(t,'srt')).toContain('&lt;word&gt;');
  });
  it('never fabricates timestamps when returned timing is absent or invalid',()=>{
    const t=parseTranscript({lang:'en',content:[{text:'Hello',offset:-1,duration:1000}]},'Title','native',60);
    expect(t.text).toBe('Hello');expect(t.timed).toBe(false);
    expect(()=>exportTranscript(t,'srt')).toThrow('no verified timestamps');
  });
  it('uses explicit native/generate paths and treats a network submission timeout as unknown',async()=>{
    let observed='';
    const p=new Supadata('test',async(url)=>{observed=String(url);return new Response(JSON.stringify({jobId:'job-1'}),{status:202});});
    expect(await p.submit('https://youtube.com/watch?v=dQw4w9WgXcQ','native')).toEqual({kind:'pending',id:'job-1',credits:null});
    expect(observed).toContain('mode=native');expect(observed).toContain('text=false');
    const timeout=new Supadata('test',async()=>{throw new Error('timeout');});
    await expect(timeout.submit('url','generate')).rejects.toMatchObject({kind:'unknown'});
  });
});
