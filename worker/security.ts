import { AppError, now, row, run, type Env, type User } from './env';
export async function sha(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
function hex(value: ArrayBuffer) { return Array.from(new Uint8Array(value), v => v.toString(16).padStart(2, '0')).join(''); }
export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function auth(e: Env, cookie: string | undefined): Promise<User> {
  const token = cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('ts_session='))?.slice(11);
  if (!token) throw new AppError(401, 'Sign in to continue.');
  const user = await row<User>(e, 'SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?', await sha(token), now());
  if (!user) throw new AppError(401, 'Your session expired. Please sign in again.');
  return user;
}
export async function rateLimit(e: Env, key: string, limit: number, window = 3600) {
  const bucket = `${key}:${Math.floor(now() / window)}`;
  const count = await e.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(bucket, now() + window * 2).first<{count:number}>();
  if (!count || count.count > limit) throw new AppError(429, 'Too many requests. Please try again later.');
}
// Budget entries never auto-release: an upstream timeout may still be billable.
export async function commitBudget(e: Env, id: string, cents: number, kind: string): Promise<boolean> {
  if (await row(e, 'SELECT id FROM budget_entries WHERE id=?', id)) return true;
  const day = new Date().toISOString().slice(0, 10), cap = Math.floor(Number(e.DAILY_BUDGET_CENTS));
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(cents) || cents <= 0) return false;
  const result = await run(e, `INSERT OR IGNORE INTO budget_entries(id,day,cents,kind,created_at)
    SELECT ?,?,?,?,? WHERE COALESCE((SELECT committed_cents FROM budgets WHERE day=?),0)+?<=?`,
  id, day, cents, kind, now(), day, cents, cap);
  return result.meta.changes > 0 || !!await row(e, 'SELECT id FROM budget_entries WHERE id=?', id);
}
export async function mediaToken(e: Env, uploadId: string, expiry: number): Promise<string> {
  if (!e.MEDIA_SIGNING_SECRET || e.MEDIA_SIGNING_SECRET.length < 32) throw new AppError(503, 'File processing is not configured.');
  return hmac(`${uploadId}:${expiry}`, e.MEDIA_SIGNING_SECRET);
}
