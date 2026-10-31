import { z } from 'zod';

export const cueSchema = z.object({
  start: z.number().finite().min(0).max(14400),
  end: z.number().finite().min(0).max(14400),
  text: z.string().min(1).max(12000),
}).refine(c => c.end >= c.start);
export const trackSchema = z.object({
  id: z.string().min(1).max(120), language: z.string().min(1).max(50),
  name: z.string().max(120), source: z.enum(['manual', 'automatic']),
  translated: z.boolean(),
});
export const chapterSchema = z.object({
  start: z.number().finite().min(0).max(14400),
  end: z.number().finite().positive().max(14400),
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(500).optional(),
}).refine(c=>c.end>c.start);
export const captionResultSchema = z.object({
  title: z.string().min(1).max(500), author: z.string().max(300),
  duration: z.number().finite().positive().max(14400),
  tracks: z.array(trackSchema).max(100),
  selectedTrack: z.string().max(120).nullable(),
  completeness: z.enum(['complete', 'partial', 'none']),
  cues: z.array(cueSchema).max(12000),
  chapters: z.array(chapterSchema).max(100).optional(),
});
export type Chapter = z.infer<typeof chapterSchema>;
export type ReadingTask = {
  id:string; kind:'chapters'|'translation'; status:'queued'|'running'|'complete'|'paused'|'failed';
  source:'creator'|'youtube'|'ai'|null; completed:number; total:number; error:string|null;
};
export type ReadingTools = {
  chapters:Chapter[]; chapterTask:ReadingTask|null;
  translation:ReadingTask|null; lines:Record<string,string>;
};
export function cueAt(cues:Cue[], seconds:number) {
  let low=0,high=cues.length;
  while(low<high){const middle=(low+high)>>>1;if(cues[middle].start<=seconds)low=middle+1;else high=middle;}
  return low-1;
}
export const anchorSchema = z.object({
  trackId: z.string().min(1).max(120),
  firstCue: z.number().int().min(0), lastCue: z.number().int().min(0),
  startOffset: z.number().int().min(0), endOffset: z.number().int().min(0),
  quote: z.string().min(1).max(6000), start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
});
export type Cue = z.infer<typeof cueSchema>;
export type CaptionTrack = z.infer<typeof trackSchema>;
export type CaptionResult = z.infer<typeof captionResultSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type LibraryVideo = {
  id: string; youtube_id: string; url: string; title: string; author: string; duration: number;
  caption_status: 'queued' | 'importing' | 'ready' | 'partial' | 'none' | 'error';
  selected_track: string | null; tracks: CaptionTrack[]; tags: string[];
  learning_status: 'new' | 'learning' | 'complete';
  playback_position: number; reading_cue: number; error: string | null;
  created_at: number; updated_at: number;
};
export type LearningRecord = {
  id: string; kind: 'highlight' | 'note'; body: string; anchor: Anchor | null;
  source_question_id: string | null;
  revision: number; created_at: number; updated_at: number;
};
export type LearningDraft = {
  id: string; body: string; anchor: Anchor | null; record_id: string | null; record_revision: number | null;
  source_question_id: string | null; updated_at: number;
};
export type Evidence = { id: number; start: number; end: number; text: string; cue: number; trackId: string };
export type LearningQuestion = {
  id: string; conversation_id: string; question: string; anchor: Anchor;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  answer: string | null; supplement: string | null; context: Evidence[]; citations: number[];
  context_scope: 'full_transcript' | 'relevant_passages' | null;
  input_tokens: number | null; cache_hit_tokens: number | null; cache_miss_tokens: number | null;
  error: string | null; created_at: number;
};
export type LearningDetail = {
  video: LibraryVideo; transcript: { cues: Cue[]; track: CaptionTrack; completeness: string } | null;
  records: LearningRecord[]; questions: LearningQuestion[]; drafts: LearningDraft[];
};
export type SearchResult = { id: string; video_id: string; title: string; kind: string; body: string; start: number | null; cue: number | null; record_id: string | null };
export const tagName = z.string().transform(s=>s.normalize('NFKC').trim().replace(/\s+/g,' '))
  .pipe(z.string().min(1).max(32).refine(s=>! /[\u0000-\u001f\u007f]/.test(s),'Use a printable tag name.'));
export const tagKey = (s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export function uniqueTags(tags:string[]) {
  const seen=new Set<string>();
  return tags.filter(t=>{const key=tagKey(t);if(seen.has(key))return false;seen.add(key);return true;});
}
export const tagsInput = z.array(tagName).max(24).transform(uniqueTags).pipe(z.array(z.string()).max(12));
export type LibraryNote = LearningRecord & {video_id:string;title:string;author:string;tags:string[]};
export type NotesPage = {notes:LibraryNote[];total:number;nextCursor:string|null};

export function youtubeInput(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Paste a valid YouTube video URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.searchParams.has('list'))
    throw new Error('Use a single public YouTube video, without a playlist.');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be' && /^\/[\w-]{11}\/?$/.test(url.pathname)) id = url.pathname.split('/')[1];
  if (['youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else if (/^\/(shorts|embed)\/[\w-]{11}\/?$/.test(url.pathname)) id = url.pathname.split('/')[2];
  }
  if (!/^[\w-]{11}$/.test(id)) throw new Error('Only single YouTube videos are supported in this version.');
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}
export function quoteFrom(cues: Cue[], a: Pick<Anchor, 'firstCue' | 'lastCue' | 'startOffset' | 'endOffset'>) {
  if (a.lastCue < a.firstCue || a.lastCue - a.firstCue > 80) throw new Error('Select a shorter continuous passage.');
  const first = cues[a.firstCue], last = cues[a.lastCue];
  if (!first || !last || a.startOffset > first.text.length || a.endOffset > last.text.length ||
    (a.firstCue === a.lastCue && a.endOffset <= a.startOffset)) throw new Error('This selection is no longer available.');
  return cues.slice(a.firstCue, a.lastCue + 1).map((c, i, arr) =>
    c.text.slice(i === 0 ? a.startOffset : 0, i === arr.length - 1 ? a.endOffset : c.text.length)).join('\n');
}
