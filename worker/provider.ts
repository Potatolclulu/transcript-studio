import { MAX_SECONDS, type Transcript, type Segment } from '../shared/model';
export class ProviderError extends Error {
  constructor(public kind: 'unavailable' | 'rejected' | 'unknown' | 'invalid' | 'retryable', public code: number, message: string) { super(message); }
}
type Fetcher = typeof fetch;
export type ProviderMode = 'native' | 'generate' | 'doubao';
export type ProviderResult = { kind: 'pending'; id: string; credits: number | null } |
  { kind: 'complete'; data: Record<string, unknown>; credits: number | null } | { kind: 'waiting' };
export class Supadata {
  constructor(private key: string, private request: Fetcher = (...args) => fetch(...args)) {}
  private async call(path: string, submitting: boolean): Promise<{ response: Response; data: any; credits: number | null }> {
    let response: Response;
    try {
      response = await this.request(`https://api.supadata.ai/v1/${path}`, {
        headers: { 'x-api-key': this.key }, signal: AbortSignal.timeout(75000),
      });
    } catch { throw new ProviderError(submitting ? 'unknown' : 'rejected', 0, 'The provider did not confirm the request.'); }
    if (response.status === 206) throw new ProviderError('unavailable', 206, 'No existing captions were available.');
    if (!response.ok) {
      const definitive = [400, 401, 402, 403, 404, 413, 422, 429].includes(response.status);
      throw new ProviderError(submitting && !definitive ? 'unknown' : 'rejected', response.status, response.status === 403 || response.status === 404 ? 'The media is private, restricted, or unavailable.' : 'The transcription provider could not process this request.');
    }
    let data: any;
    try { data = await response.json(); } catch { throw new ProviderError(submitting ? 'unknown' : 'invalid', response.status, 'The provider returned an unreadable response.'); }
    const raw = response.headers.get('x-billable-requests'), credits = raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
    return { response, data, credits };
  }
  async metadata(url: string) {
    const { data, credits } = await this.call(`metadata?${new URLSearchParams({ url })}`, false);
    const duration = data.media?.duration, flags = data.additionalData || {};
    if (data.type !== 'video' || data.media?.type !== 'video' || !Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS ||
      flags.isLive === true || flags.isLiveNow === true || flags.isUpcoming === true || flags.liveStatus === 'is_live')
      throw new ProviderError('invalid', 422, 'Use a finished video up to 120 minutes with one video and a known duration.');
    return { title: String(data.title || 'Untitled video').slice(0, 240), duration: Number(duration), credits };
  }
  async submit(url: string, mode: 'native' | 'generate'): Promise<ProviderResult> {
    const { response, data, credits } = await this.call(`transcript?${new URLSearchParams({ url, mode, text: 'false' })}`, true);
    if (response.status === 202) {
      if (typeof data.jobId !== 'string' || !data.jobId) throw new ProviderError('unknown', 202, 'The provider did not return a tracking ID.');
      return { kind: 'pending', id: data.jobId, credits };
    }
    return { kind: 'complete', data, credits };
  }
  async poll(id: string): Promise<ProviderResult> {
    const { data, credits } = await this.call(`transcript/${encodeURIComponent(id)}`, false);
    if (['queued', 'active'].includes(data.status)) return { kind: 'waiting' };
    if (data.status === 'failed') throw new ProviderError('rejected', 422, 'The provider could not transcribe this media.');
    if (data.status !== 'completed') throw new ProviderError('invalid', 200, 'The provider returned an unknown status.');
    return { kind: 'complete', data: data.result || data, credits };
  }
}
export class Doubao {
  constructor(private key: string, private resource = 'volc.seedasr.auc', private request: Fetcher = (...args) => fetch(...args)) {}
  private async call(action: 'submit' | 'query', id: string, body: unknown) {
    let response: Response;
    try {
      response = await this.request(`https://openspeech.bytedance.com/api/v3/auc/bigmodel/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'X-Api-Key': this.key, 'X-Api-Resource-Id': this.resource,
          'X-Api-Request-Id': id, ...(action === 'submit' ? { 'X-Api-Sequence': '-1' } : {}),
        },
        body: JSON.stringify(body), signal: AbortSignal.timeout(75000),
      });
    } catch (error) {
      console.error(JSON.stringify({ event: 'doubao_connection_error', action, type: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message.replaceAll(this.key, '[redacted]').slice(0, 220) : 'Connection failed' }));
      throw new ProviderError(action === 'submit' ? 'unknown' : 'retryable', 0, 'The speech service did not confirm the request. We will check its tracking ID.');
    }
    const rawCode = response.headers.get('X-Api-Status-Code');
    const code = rawCode && /^\d+$/.test(rawCode) ? Number(rawCode) : 0;
    if (code === 45000292) {
      const message = response.headers.get('X-Api-Message') || '';
      // This code covers several quota types. Concurrency is not an account-balance error.
      if (/concurrency/i.test(message)) throw new ProviderError('retryable', code, 'The speech service concurrency limit was reached. This task will wait and retry.');
      throw new ProviderError('rejected', code, 'The speech service quota is unavailable. Check the recording-service quota and account balance.');
    }
    if ([20000001, 20000002].includes(code)) return { kind: 'waiting' } as const;
    if (code === 20000003) throw new ProviderError('rejected', code, 'No speech was found in this recording.');
    if (!response.ok || code !== 20000000) {
      const rejected = String(code).startsWith('450') || [400, 401, 403, 413, 422].includes(response.status);
      throw new ProviderError(rejected ? 'rejected' : action === 'submit' ? 'unknown' : 'retryable', code || response.status,
        rejected ? 'The speech service rejected this audio or its credentials.' : 'The speech service could not confirm its status. We will check the tracking ID.');
    }
    if (action === 'submit') return { kind: 'pending', id, credits: null } as const;
    let data: Record<string, unknown>;
    try { data = await response.json(); } catch { throw new ProviderError('retryable', code, 'The speech service returned an unreadable result.'); }
    return { kind: 'complete', data, credits: null } as const;
  }
  async submit(url: string, id: string): Promise<ProviderResult> {
    const ext = new URL(url).pathname.split('.').at(-1)?.toLowerCase();
    if (!ext || !['mp3', 'wav', 'ogg'].includes(ext))
      throw new ProviderError('invalid', 422, 'Doubao currently needs MP3, WAV, or OGG audio. Video and M4A conversion is not configured yet.');
    const result = await this.call('submit', id, {
      user: { uid: 'transcript-studio' }, audio: { url, format: ext },
      request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, show_utterances: true },
    });
    return result.kind === 'waiting' ? { kind: 'pending', id, credits: null } : result;
  }
  async poll(id: string): Promise<ProviderResult> { return this.call('query', id, {}); }
}
export function parseDoubaoTranscript(data: Record<string, any>, title: string, quotedDuration: number): Transcript {
  const duration = data.audio_info?.duration / 1000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS || Math.ceil(duration / 60) > Math.ceil(quotedDuration / 60))
    throw new ProviderError('invalid', 422, 'The recognized audio duration did not match the minute estimate.');
  const utterances = data.result?.utterances;
  const text = typeof data.result?.text === 'string' ? data.result.text.trim() :
    Array.isArray(utterances) ? utterances.map((s: any) => typeof s.text === 'string' ? s.text.trim() : '').filter(Boolean).join('\n\n') : '';
  if (!text || text.length > 2_000_000) throw new ProviderError('invalid', 422, 'No readable speech transcript was returned.');
  let segments: Segment[] = [];
  if (Array.isArray(utterances) && utterances.length && utterances.every((s: any, i: number) =>
    typeof s.text === 'string' && s.text.trim() && Number.isFinite(s.start_time) && Number.isFinite(s.end_time) &&
    s.start_time >= 0 && s.end_time > s.start_time && s.end_time <= duration * 1000 + 100 &&
    (!i || s.start_time >= utterances[i - 1].start_time))) {
    segments = utterances.map((s: any, i: number) => ({
      text: s.text.trim(), start: s.start_time / 1000,
      end: Math.min(s.end_time / 1000, duration, i + 1 < utterances.length ? utterances[i + 1].start_time / 1000 : Infinity),
    }));
    if (segments.some(s => s.end <= s.start)) segments = [];
  }
  return { title, text, segments, timed: segments.length > 0, language: data.result?.language || 'und', source: 'generated' };
}
export function parseTranscript(data: Record<string, any>, title: string, mode: 'native' | 'generate', mediaDuration: number): Transcript {
  let segments: Segment[] = [], text: string;
  if (typeof data.content === 'string') {
    text = data.content.trim();
  } else if (Array.isArray(data.content)) {
    text = data.content.map((s: any) => typeof s.text === 'string' ? s.text.trim() : '').filter(Boolean).join('\n\n');
    const valid = data.content.length > 0 && data.content.every((s: any, i: number) => typeof s.text === 'string' && s.text.trim() &&
      Number.isFinite(s.offset) && Number.isFinite(s.duration) && s.offset >= 0 && s.duration > 0 &&
      s.offset / 1000 < mediaDuration + 5 && (s.offset + s.duration) / 1000 <= mediaDuration + 10 &&
      (!i || s.offset >= data.content[i - 1].offset));
    if (valid) segments = data.content.map((s: any, i: number) => ({
      text: s.text.trim(), start: s.offset / 1000,
      end: Math.min((s.offset + s.duration) / 1000, data.content[i + 1]?.offset / 1000 || Infinity),
    }));
    if (segments.some(s => s.end <= s.start)) segments = [];
  } else throw new ProviderError('invalid', 200, 'No readable transcript was returned.');
  if (!text || text.length > 2_000_000) throw new ProviderError('invalid', 200, 'The transcript was empty or exceeded the result limit.');
  return { title, text, segments, timed: segments.length > 0, language: typeof data.lang === 'string' ? data.lang : 'und', source: mode === 'native' ? 'native' : 'generated' };
}
