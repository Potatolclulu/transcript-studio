import { describe, it, expect, vi, afterEach } from 'vitest';
import { Doubao, parseDoubaoTranscript } from '../worker/provider';
import { createJob, processJob } from '../worker/jobs';
import { app } from '../worker/index';
import { harness } from './harness';
import { DOUBAO_SAMPLE_URL } from '../shared/doubao-sample';
import { exportTranscript } from '../shared/model';
import { now } from '../worker/env';

const result = { audio_info: { duration: 6312 }, result: { text: '你好，世界。', utterances: [{ text: '你好，世界。', start_time: 0, end_time: 6312 }] } };
const response = (code: number, body: unknown = {}, message = '') =>
  new Response(JSON.stringify(body), { headers: { 'X-Api-Status-Code': String(code), 'X-Api-Message': message } });
afterEach(() => vi.unstubAllGlobals());

describe('Doubao protocol and timestamps', () => {
  it('uses the persisted UUID, correct headers, punctuation, and real utterances', async () => {
    const request = vi.fn(async (_url: any, init: any) => {
      expect(init.headers['X-Api-Key']).toBe('unit-test');
      expect(init.headers['X-Api-Resource-Id']).toBe('volc.seedasr.auc');
      expect(init.headers['X-Api-Request-Id']).toBe('stable-id');
      expect(JSON.parse(init.body).request).toMatchObject({ enable_punc: true, show_utterances: true });
      return response(20000000);
    });
    expect(await new Doubao('unit-test', undefined, request).submit(DOUBAO_SAMPLE_URL, 'stable-id')).toEqual({ kind: 'pending', id: 'stable-id', credits: null });
    const transcript = parseDoubaoTranscript(result, 'Recording', 6.312);
    expect(transcript.source).toBe('generated');
    expect(transcript.segments).toEqual([{ text: '你好，世界。', start: 0, end: 6.312 }]);
    expect(exportTranscript(transcript, 'srt')).toContain('00:00:00,000 --> 00:00:06,312');
  });
  it('maps status headers rather than treating HTTP 200 as a completed result', async () => {
    for (const code of [20000001, 20000002]) {
      expect(await new Doubao('test', undefined, async () => response(code)).poll('id')).toEqual({ kind: 'waiting' });
    }
    await expect(new Doubao('test', undefined, async () => response(20000003)).poll('id')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(new Doubao('test', undefined, async () => response(45000292, {}, 'quota exceeded for types: concurrency')).submit(DOUBAO_SAMPLE_URL, 'id')).rejects.toMatchObject({ kind: 'retryable' });
    await expect(new Doubao('test', undefined, async () => response(45000292, {}, 'quota exceeded for types: duration')).poll('id')).rejects.toMatchObject({ kind: 'rejected' });
  });
  it('rejects excess duration and keeps text-only results free of invented subtitle timing', () => {
    expect(() => parseDoubaoTranscript({ ...result, audio_info: { duration: 61000 } }, 'Audio', 6.312)).toThrow('minute estimate');
    const transcript = parseDoubaoTranscript({ audio_info: result.audio_info, result: { text: 'Hello', utterances: [{ text: 'Hello', start_time: -1, end_time: 2000 }] } }, 'Audio', 6.312);
    expect(transcript.text).toBe('Hello'); expect(transcript.timed).toBe(false);
    expect(() => exportTranscript(transcript, 'vtt')).toThrow('no verified timestamps');
  });
});

describe('Doubao real-task accounting and recovery', () => {
  function setup() {
    const h = harness(); h.env.TRANSCRIPTION_PROVIDER = 'doubao'; h.env.DOUBAO_API_KEY = 'unit-test-only'; h.env.LOCAL_ASR_TEST_ENABLED = 'true';
    h.user('u'); h.quote('q', 'u', 1, 'doubao-test');
    h.sql.prepare('UPDATE quotes SET input_url=?,duration=?').run(DOUBAO_SAMPLE_URL, 6.312);
    return h;
  }
  it('queries after an ambiguous submit, never submits twice, delivers and consumes once', async () => {
    const h = setup(); let submittedId = '';
    const request = vi.fn(async (url: string, init: any) => {
      const id = init.headers['X-Api-Request-Id'];
      expect(h.sql.prepare('SELECT provider_id FROM jobs').get()?.provider_id).toBe(id);
      if (url.endsWith('/submit')) { submittedId = id; throw new Error('timeout after upstream acceptance'); }
      expect(id).toBe(submittedId); return response(20000000, result);
    });
    vi.stubGlobal('fetch', request);
    const id = await createJob(h.env, 'u', 'q');
    await processJob(h.env, id);
    expect(h.sql.prepare('SELECT status,phase FROM jobs').get()).toEqual({ status: 'running', phase: 'submitting' });
    h.sql.prepare('UPDATE jobs SET next_run=0').run();
    await processJob(h.env, id); await processJob(h.env, id);
    expect(request.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
    expect(h.sql.prepare('SELECT balance,reserved FROM users').get()).toEqual({ balance: 99, reserved: 0 });
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='consume'").get()?.n).toBe(1);
    expect(JSON.parse(h.objects.get(`results/${id}/transcript.json`)!).text).toBe('你好，世界。');
  });
  it('queues a definitive concurrency rejection, retries the same UUID, and refunds a definitive failure', async () => {
    const h = setup(); const ids: string[] = [];
    const request = vi.fn(async (_url: string, init: any) => {
      ids.push(init.headers['X-Api-Request-Id']);
      return ids.length === 1 ? response(45000292, {}, 'quota exceeded for types: concurrency') : response(45000010);
    });
    vi.stubGlobal('fetch', request);
    const id = await createJob(h.env, 'u', 'q'); await processJob(h.env, id);
    expect(h.sql.prepare('SELECT state FROM attempts').get()?.state).toBe('retryable');
    h.sql.prepare('UPDATE jobs SET next_run=0').run(); await processJob(h.env, id);
    expect(ids[0]).toBe(ids[1]);
    expect(h.sql.prepare('SELECT balance,reserved FROM users').get()).toEqual({ balance: 100, reserved: 0 });
    expect(h.sql.prepare('SELECT status FROM jobs').get()?.status).toBe('failed');
  });
  it('recovers a saved Doubao result without calling ASR again', async () => {
    const h = setup(); const id = await createJob(h.env, 'u', 'q');
    h.objects.set(`results/${id}/raw.json`, JSON.stringify({ mode: 'doubao', data: result }));
    const request = vi.fn(); vi.stubGlobal('fetch', request); await processJob(h.env, id);
    expect(request).not.toHaveBeenCalled(); expect(h.sql.prepare('SELECT status FROM jobs').get()?.status).toBe('complete');
  });
  it('never grants local test minutes twice and disables the endpoint in production', async () => {
    const h = setup();
    const makeRequest = () => new Request(`${h.env.PUBLIC_ORIGIN}/api/auth/local-asr`, { method: 'POST', headers: { Origin: h.env.PUBLIC_ORIGIN } });
    expect((await app.fetch(makeRequest(), h.env)).status).toBe(200);
    expect((await app.fetch(makeRequest(), h.env)).status).toBe(200);
    expect(h.sql.prepare("SELECT balance FROM users WHERE email='local-asr@local.invalid'").get()?.balance).toBe(2);
    h.env.APP_ENV = 'production';
    expect((await app.fetch(makeRequest(), h.env)).status).toBe(404);
  });
  it('holds unresolved UUIDs for review without submitting again', async () => {
    const h = setup(); const id = await createJob(h.env, 'u', 'q');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    await processJob(h.env, id);
    h.sql.prepare('UPDATE jobs SET next_run=0,created_at=?').run(now() - 21601);
    await processJob(h.env, id);
    expect(h.sql.prepare('SELECT status,active FROM jobs').get()).toEqual({ status: 'review', active: 1 });
  });
});
