import { captionResultSchema } from '../shared/learning';
import { AppError, now, row, rows, run, uid, type Env } from './env';
import { boundedJson, captionFor, captionsEnabled, type VideoRow } from './learning-store';
import { mediaJob } from './platform-media';

export async function processImport(env: Env, id: string, fetcher: typeof fetch = (...args) => fetch(...args)) {
  const token = uid();
  const video = await env.DB.prepare(`UPDATE library SET caption_status='importing',import_token=?,lease_until=?,error=NULL
    WHERE id=? AND (caption_status='queued' OR (platform!='youtube' AND caption_status='importing' AND lease_until<=?))
    RETURNING *`).bind(token, now() + 240, id, now()).first<VideoRow>();
  if (!video) return;
  let objectKey: string | null = null;
  try {
    if (!captionsEnabled(env)) throw new AppError(503, 'Caption import is not configured on this server. Your link is saved; retry after the service is connected.');
    let imported:unknown;
    if(video.platform!=='youtube'){
      const job=await mediaJob(env,video,fetcher);
      await run(env,`UPDATE library SET media_key=?,import_progress=?,title=COALESCE(?,title),duration=COALESCE(?,duration)
        WHERE id=? AND import_token=?`,job.key,job.progress,job.title||null,job.duration||null,id,token);
      if(job.status==='failed')throw new AppError(422,job.error||'Media import failed. Please retry.');
      if(job.status!=='complete'){
        await run(env,'UPDATE library SET lease_until=?,import_token=NULL WHERE id=? AND import_token=?',now()+8,id,token);
        await run(env,"UPDATE learning_outbox SET due_at=? WHERE id=? AND kind='learning'",now()+8,id);
        return;
      }
      imported=job.result;
    }else{
      const endpoint = new URL(env.CAPTION_SERVICE_URL!);
      if (endpoint.protocol !== 'https:' && !(env.APP_ENV === 'development' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname)))
        throw new AppError(503, 'Caption service needs a secure HTTPS endpoint.');
      const response = await fetcher(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CAPTION_SERVICE_SECRET}` },
        body: JSON.stringify({ youtubeId: video.youtube_id, trackId: video.selected_track }),
        redirect: 'manual', signal: AbortSignal.timeout(120000),
      });
      if(response.status>=300&&response.status<400)throw new AppError(502,'Caption service redirects are not accepted. Check the configured endpoint.');
      const data = await boundedJson(response);
      if (!response.ok) throw new AppError(422, typeof data === 'object' && data && 'error' in data ? String(data.error).slice(0,300) : 'Caption retrieval failed. Please retry.');
      imported=data;
    }
    const result = captionResultSchema.parse(imported), selected = result.tracks.find(t => t.id === result.selectedTrack);
    if (result.cues.length && (!selected || result.completeness === 'none')) throw new Error('Invalid caption track.');
    if (!result.cues.length && result.completeness !== 'none') throw new Error('Empty caption result.');
    if (result.cues.some((cue, i) => cue.end > result.duration + 5 || i > 0 && cue.start < result.cues[i - 1].start)) throw new Error('Invalid timeline.');
    if (!await row(env, 'SELECT id FROM library WHERE id=? AND import_token=?', id, token)) return;
    if (selected && result.cues.length) {
      // A track's first saved snapshot remains stable for notes and source citations.
      const cached = await captionFor(env,id,selected.id);
      if(cached) { result.cues=cached.cues; result.completeness=cached.completeness; }
      if(!cached){
        objectKey = `learning/${video.user_id}/${id}/${token}.json`;
        await env.MEDIA.put(objectKey, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
        await run(env,'INSERT INTO caption_tracks VALUES(?,?,?,?,?,?,?,?)',
          id, selected.id, selected.language, selected.source, Number(selected.translated), result.completeness, objectKey, now());
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM learning_search WHERE video_id=? AND kind='transcript'").bind(id),
      ]);
      // Index chunks rather than one database row for every subtitle.
      const entries = [];
      for (let i = 0; i < result.cues.length; i += 12) {
        const cue = result.cues[i], text = result.cues.slice(i, i + 12).map(c => c.text).join('\n');
        entries.push(env.DB.prepare('INSERT INTO learning_search VALUES(?,?,?,?,?,?,?,NULL)')
          .bind(`${id}:caption:${i}`, video.user_id, id, 'transcript', text, cue.start, i));
      }
      for (let i = 0; i < entries.length; i += 50) await env.DB.batch(entries.slice(i, i + 50));
    }
    const saved = await run(env, `UPDATE library SET title=?,author=?,duration=?,tracks_json=?,selected_track=?,
      caption_status=?,error=NULL,import_progress=NULL,lease_until=0,import_token=NULL,reading_cue=MIN(reading_cue,?) WHERE id=? AND import_token=?`,
    result.title, result.author, result.duration, JSON.stringify(result.tracks), result.selectedTrack,
    result.completeness === 'complete' ? 'ready' : result.completeness, Math.max(0,result.cues.length-1),id, token);
    if (!saved.meta.changes && objectKey) await env.MEDIA.delete(objectKey);
  } catch (error) {
    console.error(JSON.stringify({event:'caption_import_error',type:error instanceof Error?error.name:'unknown',
      detail:env.APP_ENV==='development'&&error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,350):undefined}));
    if (objectKey && !await row(env,'SELECT object_key FROM caption_tracks WHERE video_id=? AND object_key=?',id,objectKey)) await env.MEDIA.delete(objectKey);
    await run(env, `UPDATE library SET caption_status='error',error=?,import_progress=NULL,lease_until=0,import_token=NULL WHERE id=? AND import_token=?`,
      error instanceof AppError ? error.message : 'Captions could not be retrieved. Your link and notes are saved. Please retry.', id, token);
  }
  await run(env, "DELETE FROM learning_outbox WHERE id=? AND kind='learning'", id);
}

export async function sweepLearning(env: Env) {
  await run(env, `UPDATE library SET caption_status='queued',import_token=NULL,lease_until=0 WHERE caption_status='importing' AND lease_until<? AND platform='youtube'`, now());
  await run(env, `UPDATE learning_questions SET status='failed',error='The AI request was interrupted. Your question is saved; retry explicitly.',updated_at=? WHERE status='running' AND updated_at<?`, now(), now() - 180);
  await run(env,"UPDATE reading_tasks SET status='failed',error='This request was interrupted. Completed work is saved; retry explicitly.',lease_token=NULL,lease_until=0 WHERE status='running' AND lease_until<?",now());
  const queued = await rows<{id:string;kind:'learning'|'ai'|'reading'}>(env, `SELECT id,'learning' AS kind FROM library WHERE caption_status='queued' OR (platform!='youtube' AND caption_status='importing' AND lease_until<=${now()})
    UNION ALL SELECT id,'ai' AS kind FROM learning_questions WHERE status='queued'
    UNION ALL SELECT id,'reading' AS kind FROM reading_tasks WHERE status='queued' LIMIT 20`);
  for (const task of queued) {
    const pending = await row<{due_at:number}>(env, 'SELECT due_at FROM learning_outbox WHERE id=?', task.id);
    if (pending && pending.due_at > now()) continue;
    await run(env, 'INSERT OR REPLACE INTO learning_outbox VALUES(?,?,?)', task.id, task.kind, now() + 180);
    try { await env.TASKS.send({ jobId: task.id, kind: task.kind }); } catch { await run(env, 'UPDATE learning_outbox SET due_at=? WHERE id=?', now() + 30, task.id); }
  }
  await run(env, `DELETE FROM learning_outbox WHERE (kind='learning' AND id NOT IN (SELECT id FROM library WHERE caption_status IN ('queued','importing')))
    OR (kind='ai' AND id NOT IN (SELECT id FROM learning_questions WHERE status IN ('queued','running')))
    OR (kind='reading' AND id NOT IN (SELECT id FROM reading_tasks WHERE status IN ('queued','running')))`);
}
