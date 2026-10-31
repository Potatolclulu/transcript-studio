import { AppError, now, row, rows, run, uid, type Env } from './env';
import { anchorSchema, quoteFrom, type Anchor, type CaptionResult, type LearningDetail, type LibraryVideo } from '../shared/learning';

export interface VideoRow {
  id: string; user_id: string; youtube_id: string; url: string; title: string; author: string;
  duration: number; caption_status: LibraryVideo['caption_status']; selected_track: string | null;
  tracks_json: string; tags_json: string; learning_status: LibraryVideo['learning_status'];
  playback_position: number; reading_cue: number; error: string | null;
  import_token: string | null; lease_until: number; created_at: number; updated_at: number;
}
export function visibleVideo(v: VideoRow): LibraryVideo {
  const { user_id, tracks_json, tags_json, import_token, lease_until, ...video } = v;
  return { ...video, tracks: JSON.parse(tracks_json), tags: JSON.parse(tags_json) };
}
export async function ownVideo(env: Env, userId: string, id: string) {
  const video = await row<VideoRow>(env, 'SELECT * FROM library WHERE id=? AND user_id=?', id, userId);
  if (!video) throw new AppError(404, 'Video not found in your library.');
  return video;
}
export async function captionFor(env: Env, id: string, trackId: string | null) {
  if (!trackId) return null;
  const track = await row<{object_key:string}>(env, 'SELECT object_key FROM caption_tracks WHERE video_id=? AND track_id=?', id, trackId);
  return track ? (await env.MEDIA.get(track.object_key))?.json<CaptionResult>() || null : null;
}
export async function validAnchor(env: Env, video: VideoRow, input: unknown): Promise<Anchor> {
  const anchor = anchorSchema.parse(input), captions = await captionFor(env, video.id, anchor.trackId);
  if (!captions) throw new AppError(409, 'That caption track is unavailable. Reopen the transcript and select the passage again.');
  let text = '';
  try { text = quoteFrom(captions.cues, anchor); } catch (error) { throw new AppError(400, (error as Error).message); }
  if (text !== anchor.quote || anchor.start !== captions.cues[anchor.firstCue].start || anchor.end !== captions.cues[anchor.lastCue].end)
    throw new AppError(400, 'The selected quote must match the saved original transcript.');
  return anchor;
}
export async function learningDetail(env: Env, userId: string, id: string): Promise<LearningDetail> {
  const video = await ownVideo(env, userId, id), captions = await captionFor(env, id, video.selected_track);
  const records = await rows<{anchor_json:string|null}&LearningDetail['records'][number]>(env,
    'SELECT id,kind,body,anchor_json,source_question_id,revision,created_at,updated_at FROM learning_records WHERE video_id=? AND user_id=? ORDER BY created_at DESC', id, userId);
  const questions = await rows<{anchor_json:string;context_json:string;citations_json:string}&LearningDetail['questions'][number]>(env,
    'SELECT id,conversation_id,question,anchor_json,status,answer,supplement,context_json,citations_json,context_scope,input_tokens,cache_hit_tokens,cache_miss_tokens,error,created_at FROM learning_questions WHERE video_id=? AND user_id=? ORDER BY created_at ASC', id, userId);
  const drafts = await rows<{anchor_json:string|null}&LearningDetail['drafts'][number]>(env,
    'SELECT id,body,anchor_json,record_id,record_revision,source_question_id,updated_at FROM learning_drafts WHERE video_id=? AND user_id=? ORDER BY updated_at DESC', id, userId);
  const selected = captions?.tracks.find(t => t.id === video.selected_track);
  return {
    video: visibleVideo(video),
    transcript: captions && selected ? { cues: captions.cues, track: selected, completeness: captions.completeness } : null,
    records: records.map(({anchor_json, ...r}) => ({ ...r, anchor: anchor_json ? JSON.parse(anchor_json) : null })),
    drafts: drafts.map(({anchor_json, ...d}) => ({ ...d, anchor: anchor_json ? JSON.parse(anchor_json) : null })),
    questions: questions.map(({anchor_json,context_json,citations_json,...q}) => ({...q,anchor:JSON.parse(anchor_json),context:JSON.parse(context_json),citations:JSON.parse(citations_json)})),
  };
}
export const captionsEnabled = (env: Env) => !!(env.CAPTION_SERVICE_URL && env.CAPTION_SERVICE_SECRET);
export async function boundedJson(response: Response, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new AppError(502, 'The service returned no data.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new AppError(502, 'The service response exceeded the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0; for (const c of chunks) { data.set(c, offset); offset += c.length; }
  return JSON.parse(new TextDecoder().decode(data));
}
export async function enqueueLearning(env: Env, id: string, kind: 'learning' | 'ai' | 'reading') {
  await run(env, 'INSERT OR REPLACE INTO learning_outbox VALUES(?,?,?)', id, kind, now());
  try {
    await env.TASKS.send({ jobId: id, kind });
    await run(env, 'UPDATE learning_outbox SET due_at=? WHERE id=?', now() + 180, id);
  } catch { /* Persistent outbox will be retried by the scheduled handler. */ }
}
export async function touchVideo(env: Env, id: string) {
  await run(env, "UPDATE library SET updated_at=?,learning_status=CASE WHEN learning_status='new' THEN 'learning' ELSE learning_status END WHERE id=?", now(), id);
}
export function recordSearch(env: Env, id: string, userId: string, videoId: string, kind: string, text: string, anchor: Anchor | null) {
  return env.DB.prepare('INSERT OR REPLACE INTO learning_search VALUES(?,?,?,?,?,?,?,?)')
    .bind(id, userId, videoId, kind, text, anchor?.start ?? null, anchor?.firstCue ?? null, id);
}
export function newRecordId() { return uid(); }
