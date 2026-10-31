import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { FILE_TYPES, MAX_BYTES, normalizeInput, exportTranscript, type Transcript } from '../shared/model';
import { SAMPLE_TITLE } from '../shared/sample';
import { DOUBAO_SAMPLE_URL, DOUBAO_SAMPLE_TITLE, DOUBAO_SAMPLE_DURATION } from '../shared/doubao-sample';
import { AppError, now, uid, isDev, realEnabled, localAsrEnabled, usesDoubao, billingEnabled, row, rows, run, type Env, type User, type JobRow } from './env';
import { auth, sha, hmac, safeEqual, mediaToken, rateLimit, commitBudget } from './security';
import { Supadata, ProviderError } from './provider';
import { createJob, processJob, sweep } from './jobs';
import { checkout, webhook } from './billing';
import { newUpload, finalizeUpload, uploadsEnabled } from './uploads';
import { learning } from './learning-routes';
import { captionsEnabled } from './learning-store';
import { aiEnabled, processQuestion } from './learning-ai';
import { processImport, sweepLearning } from './learning-import';
import { processReading } from './reading-tools';

type C = Context<{ Bindings: Env; Variables: { user: User } }>;
export const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.path !== '/api/billing/webhook') {
    if (!c.env.PUBLIC_ORIGIN || c.req.header('Origin') !== c.env.PUBLIC_ORIGIN)
      throw new AppError(403, 'This request must come from the website.');
  }
  await next();
});
app.use('/api/*', async (c, next) => {
  if (/^\/api\/uploads\/[^/]+\/body$/.test(c.req.path)) return next();
  return bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'Request is too large.' }, 413) })(c, next);
});
app.onError((error, c) => {
  if (error instanceof AppError) return c.json({ error: error.message }, error.status as 400);
  if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message || 'Invalid request.' }, 400);
  if (error instanceof ProviderError) return c.json({ error: error.message }, 422);
  console.error(JSON.stringify({ event: 'api_error', type: error.name, path: c.req.path.replace(/[a-f0-9-]{36}/g, ':id') }));
  return c.json({ error: 'Something went wrong. Your existing transcripts and minutes are safe. Please try again.' }, 500);
});
const requireUser = async (c: C) => {
  const user = await auth(c.env, c.req.header('Cookie'));
  if (user.blocked && c.req.method !== 'GET' && c.req.method !== 'DELETE') throw new AppError(403, 'Your account needs a payment review. Contact support.');
  return user;
};
const ipHash = (c: C) => sha(c.req.header('CF-Connecting-IP') || 'local');
async function session(c: C, userId: string) {
  const token = `${uid()}${uid()}`;
  await run(c.env, 'INSERT INTO sessions VALUES(?,?,?)', await sha(token), userId, now() + 30 * 86400);
  c.header('Set-Cookie', `ts_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${isDev(c.env) ? '' : '; Secure'}`);
}
app.get('/api/config', c => c.json({
  environment: c.env.APP_ENV, transcription: realEnabled(c.env), uploads: realEnabled(c.env) && uploadsEnabled(c.env) && (!usesDoubao(c.env) || c.env.PUBLIC_ORIGIN.startsWith('https://')),
  links: realEnabled(c.env) && !usesDoubao(c.env), localAsr: localAsrEnabled(c.env),
  billing: billingEnabled(c.env), demo: isDev(c.env), supportEmail: c.env.SUPPORT_EMAIL || '',
  globalConcurrency: Math.max(1, Math.min(10, Number(c.env.MAX_ACTIVE_JOBS) || 2)), userConcurrency: 1,
  captions: captionsEnabled(c.env), ai: aiEnabled(c.env), aiModel: aiEnabled(c.env) ? c.env.LLM_MODEL : null,
}));
app.get('/api/me', async c => {
  let user: User;
  try { user = await auth(c.env, c.req.header('Cookie')); } catch { return c.json({ user: null }); }
  return c.json({ user: { id: user.id, email: user.email, balance: user.balance, reserved: user.reserved, demo: !!user.demo, blocked: !!user.blocked } });
});
app.post('/api/auth/start', async c => {
  const { email } = z.object({ email: z.email().max(254).transform(v => v.toLowerCase().trim()) }).parse(await c.req.json());
  if (!isDev(c.env) && !(c.env.RESEND_API_KEY && c.env.EMAIL_FROM)) throw new AppError(503, 'Email sign-in is not configured yet.');
  await rateLimit(c.env, `login-ip:${await ipHash(c)}`, 10);
  await rateLimit(c.env, `login-email:${await sha(email)}`, 4);
  const token = `${uid()}${uid()}`, tokenHash = await sha(token);
  await run(c.env, 'INSERT INTO login_tokens VALUES(?,?,?,NULL)', tokenHash, email, now() + 900);
  const link = `${c.env.PUBLIC_ORIGIN}/auth/verify#token=${token}`;
  if (c.env.RESEND_API_KEY && c.env.EMAIL_FROM) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': tokenHash },
      body: JSON.stringify({ from: c.env.EMAIL_FROM, to: [email], subject: 'Sign in to Transcript Studio', text: `Sign in to Transcript Studio:\n\n${link}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, you can ignore this email.` }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new AppError(503, 'The sign-in email could not be sent. Please try again later.');
    return c.json({ sent: true });
  }
  return c.json({ sent: true, developmentLink: link });
});
app.post('/api/auth/verify', async c => {
  const { token } = z.object({ token: z.string().min(60).max(200) }).parse(await c.req.json());
  await rateLimit(c.env, `verify-ip:${await ipHash(c)}`, 20);
  const login = await c.env.DB.prepare('UPDATE login_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING email')
    .bind(now(), await sha(token), now()).first<{email:string}>();
  if (!login) throw new AppError(410, 'This sign-in link expired or was already used. Request a new one.');
  await run(c.env, 'INSERT OR IGNORE INTO users(id,email,created_at) VALUES(?,?,?)', uid(), login.email, now());
  const user = (await row<User>(c.env, 'SELECT * FROM users WHERE email=?', login.email))!;
  await session(c, user.id);
  return c.json({ ok: true });
});
app.post('/api/auth/demo', async c => {
  if (!isDev(c.env)) throw new AppError(404, 'Not found.');
  await rateLimit(c.env, `demo:${await ipHash(c)}`, 30);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users(id,email,demo,created_at) VALUES(?,?,1,?)').bind(id, `sample-${id.slice(0, 8)}@local.invalid`, now()),
    c.env.DB.prepare('INSERT INTO ledger VALUES(?,?,NULL,NULL,?,12,0,?,?)').bind(`demo:${id}`, id, 'demo', 'Local sample minutes; no cash value', now()),
  ]);
  await session(c, id);
  return c.json({ ok: true });
});
app.post('/api/auth/learning-preview', async c => {
  if (!isDev(c.env)) throw new AppError(404,'Not found.');
  await rateLimit(c.env,`learning-preview:${await ipHash(c)}`,30);
  const email='learning-preview@local.invalid';
  await run(c.env,'INSERT OR IGNORE INTO users(id,email,created_at) VALUES(?,?,?)',uid(),email,now());
  const user=(await row<User>(c.env,'SELECT * FROM users WHERE email=?',email))!;
  await session(c,user.id);
  return c.json({ok:true});
});
app.post('/api/auth/local-asr', async c => {
  if (!localAsrEnabled(c.env)) throw new AppError(404, 'Not found.');
  await rateLimit(c.env, `local-asr:${await ipHash(c)}`, 10);
  const email = 'local-asr@local.invalid';
  await run(c.env, 'INSERT OR IGNORE INTO users(id,email,created_at) VALUES(?,?,?)', uid(), email, now());
  const user = (await row<User>(c.env, 'SELECT * FROM users WHERE email=?', email))!;
  // One grant per local database. Refreshing or signing in again cannot replenish it.
  await run(c.env, 'INSERT OR IGNORE INTO ledger VALUES(?,?,NULL,NULL,?,2,0,?,?)', `local-asr:${user.id}`, user.id, 'test', 'Local real ASR test allowance; no cash value', now());
  await session(c, user.id);
  return c.json({ ok: true });
});
app.post('/api/auth/logout', async c => {
  const token = c.req.header('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('ts_session='))?.slice(11);
  if (token) await run(c.env, 'DELETE FROM sessions WHERE token_hash=?', await sha(token));
  c.header('Set-Cookie', 'ts_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return c.json({ ok: true });
});
app.post('/api/quotes', async c => {
  const user = await requireUser(c);
  const body = z.object({ url: z.string().max(2000).optional(), uploadId: z.string().uuid().optional(), sample: z.boolean().optional(), realTest: z.boolean().optional(), rights: z.literal(true) }).parse(await c.req.json());
  let source: string, key: string, url = '', title: string, duration: number, uploadId: string | null = null;
  if (body.realTest) {
    if (!localAsrEnabled(c.env) || user.email !== 'local-asr@local.invalid') throw new AppError(404, 'Not found.');
    source = 'doubao-test'; key = 'doubao-test:official:v1'; title = DOUBAO_SAMPLE_TITLE; duration = DOUBAO_SAMPLE_DURATION; url = DOUBAO_SAMPLE_URL;
  } else if (body.sample && isDev(c.env)) {
    source = 'sample'; key = 'sample:listening:v1'; title = SAMPLE_TITLE; duration = 57;
  } else {
    if (!realEnabled(c.env) || user.demo) throw new AppError(503, 'Real transcriptions are not available in this preview. You can explore the sample.');
    await rateLimit(c.env, `preflight-user:${user.id}`, 20, 86400);
    await rateLimit(c.env, `preflight-ip:${await ipHash(c)}`, 40, 86400);
    if (body.uploadId) {
      const upload = await row<any>(c.env, "SELECT * FROM uploads WHERE id=? AND user_id=? AND state='ready' AND expires_at>?", body.uploadId, user.id, now() + 600);
      if (!upload) throw new AppError(422, 'Finish uploading and checking your file first.');
      source = 'upload'; key = `upload:${upload.id}:v1`; uploadId = upload.id; title = upload.name; duration = upload.duration;
    } else {
      if (usesDoubao(c.env)) throw new AppError(503, 'YouTube and X audio acquisition is not connected yet. Signing in does not make those links accessible to the speech service.');
      let normalized: ReturnType<typeof normalizeInput>;
      try { normalized = normalizeInput(body.url || ''); } catch (error) { throw new AppError(400, (error as Error).message); }
      source = normalized.source; key = normalized.key; url = normalized.url;
      const existing = await row<any>(c.env, "SELECT id FROM jobs WHERE user_id=? AND input_key=? AND status NOT IN ('failed','cancelled','deleted')", user.id, key);
      if (existing) return c.json({ existingJobId: existing.id });
      const cached = await row<any>(c.env, 'SELECT * FROM quotes WHERE user_id=? AND input_key=? AND expires_at>? ORDER BY created_at DESC LIMIT 1', user.id, key, now());
      if (cached) return c.json({ quote: cached });
      if (!await commitBudget(c.env, `metadata:${uid()}`, Math.max(1, Math.ceil(Number(c.env.SUPADATA_CREDIT_CENTS) || 1)), 'metadata')) throw new AppError(503, 'The daily processing limit has been reached. Please try again tomorrow.');
      const metadata = await new Supadata(c.env.SUPADATA_API_KEY!).metadata(url);
      title = metadata.title; duration = metadata.duration;
    }
  }
  const id = uid(), minutes = Math.ceil(duration / 60), expires = now() + 900;
  await run(c.env, 'INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, user.id, source, key, url, uploadId, title, duration, minutes, now(), expires);
  return c.json({ quote: { id, source, title, duration, minutes, expires_at: expires } });
});
app.post('/api/jobs', async c => {
  const user = await requireUser(c);
  const { quoteId } = z.object({ quoteId: z.string().uuid() }).parse(await c.req.json());
  const quote = await row<any>(c.env, 'SELECT source FROM quotes WHERE id=? AND user_id=?', quoteId, user.id);
  if (quote?.source === 'doubao-test' && (!localAsrEnabled(c.env) || user.email !== 'local-asr@local.invalid')) throw new AppError(404, 'Not found.');
  if (quote?.source !== 'sample' && quote?.source !== 'doubao-test' && (!realEnabled(c.env) || user.demo)) throw new AppError(503, 'New transcriptions are currently paused.');
  if (quote?.source === 'sample' && !isDev(c.env)) throw new AppError(404, 'Not found.');
  return c.json({ id: await createJob(c.env, user.id, quoteId) }, 202);
});
app.get('/api/jobs', async c => {
  const user = await requireUser(c);
  return c.json({ jobs: await rows(c.env, "SELECT id,source,title,status,duration,minutes,created_at,error,cancel_requested,expires_at,settlement FROM jobs WHERE user_id=? AND status!='deleted' ORDER BY created_at DESC LIMIT 100", user.id) });
});
async function ownJob(c: C): Promise<JobRow> {
  const user = await requireUser(c), id = c.req.param('id') || '';
  const job = await row<JobRow>(c.env, "SELECT * FROM jobs WHERE id=? AND user_id=? AND status!='deleted' AND expires_at>?", id, user.id, now());
  if (!job) throw new AppError(404, 'Transcript not found.');
  return job;
}
app.get('/api/jobs/:id', async c => {
  const job = await ownJob(c);
  let transcript = null;
  if (job.status === 'complete') transcript = await (await c.env.MEDIA.get(`results/${job.id}/transcript.json`))?.json<Transcript>();
  const { input_key, user_id, lease_token, provider_id, ...visible } = job;
  return c.json({ job: visible, transcript });
});
app.get('/api/jobs/:id/export', async c => {
  const job = await ownJob(c);
  if (job.status !== 'complete') throw new AppError(409, 'Your transcript is not ready yet.');
  const format = z.enum(['txt', 'md', 'srt', 'vtt']).parse(c.req.query('format'));
  const transcript = await (await c.env.MEDIA.get(`results/${job.id}/transcript.json`))?.json<Transcript>();
  if (!transcript) throw new AppError(404, 'Transcript not found.');
  if (['srt', 'vtt'].includes(format) && !transcript.timed) throw new AppError(422, 'Timestamps are unavailable. Export TXT or Markdown.');
  c.header('Content-Type', format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="transcript-${job.id.slice(0, 8)}.${format}"`);
  return c.body(exportTranscript(transcript, format));
});
app.post('/api/jobs/:id/cancel', async c => {
  const job = await ownJob(c);
  await run(c.env, `UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE id=? AND status IN ('queued','running','review')`, now(), job.id);
  return c.json({ ok: true });
});
app.delete('/api/jobs/:id', async c => {
  const job = await ownJob(c);
  if (job.active) throw new AppError(409, 'Cancel this request first. We must confirm that processing stopped before deleting it.');
  await run(c.env, "UPDATE jobs SET status='deleted',updated_at=? WHERE id=? AND active=0", now(), job.id);
  await c.env.MEDIA.delete([`results/${job.id}/raw.json`, `results/${job.id}/transcript.json`]);
  if (job.upload_id) {
    await run(c.env, "UPDATE uploads SET state='deleted' WHERE id=?", job.upload_id);
    await c.env.MEDIA.delete([`uploads/${job.upload_id}/incoming`, `uploads/${job.upload_id}/original`]);
  }
  return c.json({ ok: true });
});
app.get('/api/account', async c => {
  const user = await requireUser(c);
  return c.json({
    ledger: await rows(c.env, 'SELECT kind,available_delta,reserved_delta,note,created_at,job_id FROM ledger WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100', user.id),
    orders: await rows(c.env, 'SELECT id,package,cents,minutes,status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50', user.id),
  });
});
app.post('/api/billing/checkout', async c => {
  const user = await requireUser(c);
  await rateLimit(c.env, `checkout:${user.id}`, 5);
  const { pack } = z.object({ pack: z.enum(['starter', 'plus']) }).parse(await c.req.json());
  return c.json({ url: await checkout(c.env, user, pack) });
});
app.post('/api/billing/webhook', async c => {
  await webhook(c.env, await c.req.text(), c.req.header('creem-signature'));
  return c.json({ received: true });
});
app.post('/api/uploads', async c => {
  const user = await requireUser(c);
  if (!realEnabled(c.env)) throw new AppError(503, 'File uploads are paused.');
  await rateLimit(c.env, `uploads:${user.id}`, 10, 86400);
  const { name, size } = z.object({ name: z.string().min(1).max(200), size: z.number().int().positive().max(MAX_BYTES) }).parse(await c.req.json());
  return c.json(await newUpload(c.env, user, name, size));
});
app.put('/api/uploads/:id/body', async c => {
  if (!isDev(c.env)) throw new AppError(404, 'Not found.');
  const user = await requireUser(c), id = c.req.param('id'), expiry = Number(c.req.query('expires'));
  if (!Number.isSafeInteger(expiry) || expiry < now() || expiry > now() + 900 || !safeEqual(c.req.query('token') || '', await mediaToken(c.env, `put:${id}`, expiry)))
    throw new AppError(403, 'Upload permission expired.');
  const upload = await row<any>(c.env, "SELECT * FROM uploads WHERE id=? AND user_id=? AND state='pending'", id, user.id);
  const size = Number(c.req.header('Content-Length'));
  if (!upload || !size || size !== upload.size || size > MAX_BYTES || !c.req.raw.body) throw new AppError(400, 'Invalid file upload.');
  await c.env.MEDIA.put(upload.object_key, c.req.raw.body, { httpMetadata: { contentType: upload.mime } });
  return c.json({ ok: true });
});
app.post('/api/uploads/:id/complete', async c => {
  const user = await requireUser(c);
  return c.json({ upload: await finalizeUpload(c.env, user, c.req.param('id')) });
});
app.on(['GET', 'HEAD'], '/api/media/:id/:name', async c => {
  const id = c.req.param('id'), expiry = Number(c.req.query('expires'));
  if (!Number.isSafeInteger(expiry) || expiry < now() || expiry > now() + 6 * 3600 ||
    !safeEqual(c.req.query('token') || '', await mediaToken(c.env, id, expiry))) throw new AppError(403, 'File access expired.');
  const upload = await row<any>(c.env, "SELECT * FROM uploads WHERE id=? AND state IN ('probing','ready') AND expires_at>?", id, now());
  if (!upload) throw new AppError(404, 'File not found.');
  const headers = new Headers({ 'Content-Type': upload.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  if (c.req.method === 'HEAD') {
    const head = await c.env.MEDIA.head(upload.object_key);
    if (!head) throw new AppError(404, 'File not found.');
    headers.set('Content-Length', String(head.size));
    return new Response(null, { headers });
  }
  const range = c.req.header('Range');
  if (range && !/^bytes=\d*-\d*$/.test(range)) return new Response(null, { status: 416, headers });
  let object: R2ObjectBody | null;
  try { object = await c.env.MEDIA.get(upload.object_key, range ? { range: c.req.raw.headers } : {}); }
  catch { return new Response(null, { status: 416, headers }); }
  if (!object) throw new AppError(404, 'File not found.');
  const r = object.range as {offset?:number;length?:number;suffix?:number} | undefined;
  const offset = r?.offset ?? (r?.suffix ? Math.max(0, object.size - r.suffix) : 0);
  const length = r?.length ?? (r?.suffix ? Math.min(object.size, r.suffix) : object.size);
  headers.set('Content-Length', String(length));
  if (range) headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
});
app.route('/api/library', learning);
app.all('/api/*', c => c.json({ error: 'Not found.' }, 404));
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{jobId:string;kind?:'learning'|'ai'|'reading'}>, env: Env) {
    for (const message of batch.messages) {
      try {
        if(message.body.kind==='learning') await processImport(env,message.body.jobId);
        else if(message.body.kind==='ai') await processQuestion(env,message.body.jobId);
        else if(message.body.kind==='reading') await processReading(env,message.body.jobId);
        else await processJob(env, message.body.jobId);
        message.ack();
      }
      catch { message.retry({ delaySeconds: 30 }); }
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(sweep(env)); ctx.waitUntil(sweepLearning(env)); },
};
