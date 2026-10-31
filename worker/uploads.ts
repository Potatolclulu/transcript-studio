import { AwsClient } from 'aws4fetch';
import { FILE_TYPES, MAX_BYTES, MAX_SECONDS } from '../shared/model';
import { AppError, isDev, now, row, run, uid, type Env, type User } from './env';
import { mediaToken } from './security';

export function uploadsEnabled(e: Env) {
  return !!(e.PROBE_URL && e.PROBE_SECRET && e.MEDIA_SIGNING_SECRET && e.MEDIA_SIGNING_SECRET.length >= 32 &&
    (isDev(e) || e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && e.R2_BUCKET_NAME));
}
export async function newUpload(e: Env, user: User, name: string, size: number) {
  if (!uploadsEnabled(e) || user.demo) throw new AppError(503, 'File uploads are not configured in this preview.');
  const ext = name.split('.').at(-1)?.toLowerCase() || '', mime = FILE_TYPES[ext];
  if (!mime || !Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) throw new AppError(400, 'Choose an MP3, M4A, WAV, MP4, or WEBM file up to 250 MB.');
  const id = uid(), time = now(), key = `uploads/${id}/incoming`;
  const cleanName = name.replace(/[/\\\u0000-\u001f]/g, '_').slice(-160);
  await run(e, 'INSERT INTO uploads(id,user_id,name,mime,size,object_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', id, user.id, cleanName, mime, size, key, time, time + 86400);
  let url: string;
  if (isDev(e)) {
    const expires = time + 900;
    url = `/api/uploads/${id}/body?expires=${expires}&token=${await mediaToken(e, `put:${id}`, expires)}`;
  } else {
    const aws = new AwsClient({ accessKeyId: e.R2_ACCESS_KEY_ID!, secretAccessKey: e.R2_SECRET_ACCESS_KEY!, service: 's3', region: 'auto' });
    const target = new URL(`https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${e.R2_BUCKET_NAME}/${key}`);
    target.searchParams.set('X-Amz-Expires', '900');
    url = (await aws.sign(new Request(target, { method: 'PUT', headers: { 'Content-Type': mime } }), { aws: { signQuery: true } })).url;
  }
  return { id, url, mime };
}
export async function finalizeUpload(e: Env, user: User, id: string) {
  const upload = await row<any>(e, 'SELECT * FROM uploads WHERE id=? AND user_id=? AND expires_at>?', id, user.id, now());
  if (!upload) throw new AppError(404, 'Upload not found or expired.');
  if (upload.state === 'ready') return upload;
  if (upload.state !== 'pending') throw new AppError(409, 'This file is being checked, or it needs to be uploaded again.');
  const acquired = await run(e, "UPDATE uploads SET state='probing' WHERE id=? AND state='pending'", id);
  if (!acquired.meta.changes) throw new AppError(409, 'The file is already being checked.');
  try {
    const object = await e.MEDIA.get(upload.object_key);
    if (!object || object.size !== upload.size || object.size > MAX_BYTES) throw new AppError(400, 'The upload was incomplete or exceeded the file limit.');
    // Freeze a new object before probing. Reusing the presigned PUT cannot change the quoted media.
    const immutableKey = `uploads/${id}/original`;
    await e.MEDIA.put(immutableKey, object.body, { httpMetadata: { contentType: upload.mime } });
    await run(e, 'UPDATE uploads SET object_key=? WHERE id=?', immutableKey, id);
    const expires = now() + 600;
    const url = `${e.PUBLIC_ORIGIN}/api/media/${id}/${encodeURIComponent(upload.name)}?expires=${expires}&token=${await mediaToken(e, id, expires)}`;
    let response: Response;
    try {
      response = await fetch(`${e.PROBE_URL}/probe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${e.PROBE_SECRET}` },
        body: JSON.stringify({ url, bytes: upload.size }), signal: AbortSignal.timeout(110000),
      });
    } catch { throw new AppError(503, 'We could not check this file. Please upload it again in a moment.'); }
    if (!response.ok) throw new AppError(422, 'The file could not be read. It must have an audio track and be no longer than 120 minutes.');
    const data = await response.json() as any;
    if (data.audio !== true || !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > MAX_SECONDS)
      throw new AppError(422, 'The file must have an audio track and be no longer than 120 minutes.');
    await run(e, "UPDATE uploads SET state='ready',duration=? WHERE id=?", data.duration, id);
    await e.MEDIA.delete(`uploads/${id}/incoming`);
    return { ...upload, object_key: immutableKey, state: 'ready', duration: data.duration };
  } catch (error) {
    await run(e, "UPDATE uploads SET state='failed' WHERE id=?", id);
    await e.MEDIA.delete([`uploads/${id}/incoming`, `uploads/${id}/original`]);
    throw error;
  }
}
