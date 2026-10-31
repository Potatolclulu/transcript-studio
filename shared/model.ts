export type Source = 'youtube' | 'x' | 'upload' | 'sample' | 'doubao-test';
export type JobStatus = 'queued' | 'running' | 'review' | 'review_refunded' | 'complete' | 'failed' | 'cancelled' | 'deleted';
export interface Segment { text: string; start: number; end: number }
export interface Transcript {
  title: string; language: string; source: 'native' | 'generated' | 'sample';
  segments: Segment[]; text: string; timed: boolean;
}
export interface Job {
  id: string; source: Source; title: string; status: JobStatus; duration: number;
  minutes: number; created_at: number; error: string | null; cancel_requested: number;
  expires_at: number; input_url?: string; settlement?: string;
}
export interface Quote {
  id: string; source: Source; title: string; duration: number; minutes: number; expires_at: number;
}
export const MAX_BYTES = 250 * 1024 * 1024;
export const MAX_SECONDS = 120 * 60;
export const FILE_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
};
export const PACKAGES = {
  starter: { name: 'Starter', minutes: 120, cents: 900 },
  plus: { name: 'Regular', minutes: 300, cents: 1900 },
} as const;
export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'In queue', running: 'Transcribing', review: 'Checking processing status',
  review_refunded: 'Minutes returned · under review', complete: 'Ready', failed: 'Could not transcribe',
  cancelled: 'Cancelled', deleted: 'Deleted',
};
export function clock(seconds: number, milliseconds = false, separator = '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${milliseconds ? separator + String(ms % 1000).padStart(3, '0') : ''}`;
}
export function shortTime(seconds: number): string {
  return clock(seconds).replace(/^00:/, '');
}
export function exportTranscript(t: Transcript, format: 'txt' | 'md' | 'srt' | 'vtt'): string {
  if (format === 'txt') return `${t.title}\n\n${t.text}\n`;
  if (format === 'md') return `# ${t.title.replace(/[\r\n]/g, ' ')}\n\n${t.segments.length ? t.segments.map(s => `**${shortTime(s.start)}** ${s.text}`).join('\n\n') : t.text}\n`;
  if (!t.timed) throw new Error('This transcript has no verified timestamps. Choose TXT or Markdown.');
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + t.segments.map((s, i) =>
    `${format === 'srt' ? `${i + 1}\n` : ''}${clock(s.start, true, format === 'srt' ? ',' : '.')} --> ${clock(s.end, true, format === 'srt' ? ',' : '.')}\n${escape(s.text).replace(/\n\s*\n/g, '\n')}\n`
  ).join('\n');
}
export function normalizeInput(input: string): { source: 'youtube' | 'x'; url: string; key: string } {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error('Paste a full YouTube or X video URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('Use a public HTTPS video URL.');
  const host = u.hostname.toLowerCase();
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    let id = host === 'youtu.be' ? u.pathname.slice(1) : u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1];
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id) || u.searchParams.has('list')) throw new Error('Use one YouTube video, not a playlist.');
    return { source: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, key: `youtube:${id}:v1` };
  }
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) {
    const match = /^\/([a-zA-Z0-9_]{1,15})\/status\/(\d{5,25})\/?$/.exec(u.pathname);
    if (!match) throw new Error('Use one public X video post. Spaces and media selectors are not supported.');
    return { source: 'x', url: `https://x.com/${match[1]}/status/${match[2]}`, key: `x:${match[2]}:v1` };
  }
  throw new Error('We currently accept YouTube and X links. Upload other audio or video files.');
}
