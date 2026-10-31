import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { now, type Env } from '../worker/env';
export function harness() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0002_learning.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0003_reader_margin.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0004_reading_tools.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0005_platform_media.sql', import.meta.url), 'utf8'));
  class Statement {
    args: any[] = [];
    constructor(public query: string) {}
    bind(...args: any[]) { this.args = args; return this; }
    async first<T>(column?: string): Promise<T | null> {
      const r = sql.prepare(this.query).get(...this.args);
      return (r ? column ? r[column] : r : null) as T | null;
    }
    async run() {
      const r = sql.prepare(this.query).run(...this.args);
      return { success: true, meta: { changes: Number(r.changes) } };
    }
    async all() { return { results: sql.prepare(this.query).all(...this.args), success: true }; }
  }
  const objects = new Map<string, string>();
  const queue: string[] = [];
  const env = {
    DB: {
      prepare: (query: string) => new Statement(query),
      batch: async (statements: Statement[]) => {
        sql.exec('BEGIN');
        try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; }
        catch (error) { sql.exec('ROLLBACK'); throw error; }
      },
    },
    MEDIA: {
      put: async (key: string, body: string) => { objects.set(key, body); },
      get: async (key: string) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!), body: objects.get(key) } : null,
      head: async (key: string) => objects.has(key) ? { size: objects.get(key)!.length } : null,
      delete: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
    },
    TASKS: { send: async ({jobId}:{jobId:string}) => { queue.push(jobId); } },
    APP_ENV: 'development', PUBLIC_ORIGIN: 'http://127.0.0.1:5178',
    MAX_ACTIVE_JOBS: '2', DAILY_BUDGET_CENTS: '1000', SUPADATA_CREDIT_CENTS: '1',
    TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER: 'supadata', SUPADATA_API_KEY: 'unit-test-only',
    BILLING_ENABLED: 'false', CREEM_MODE: 'test', CREEM_WEBHOOK_SECRET: 'unit-test-webhook-secret',
  } as unknown as Env;
  function user(id: string, minutes = 100) {
    sql.prepare('INSERT INTO users(id,email,balance,created_at) VALUES(?,?,?,?)').run(id, `${id}@test.invalid`, minutes, now());
  }
  function quote(id: string, userId: string, minutes = 5, source = 'youtube', input = `youtube:${id}`) {
    sql.prepare('INSERT INTO quotes VALUES(?,?,?,?,?,NULL,?,?,?,?,?)').run(id, userId, source, input,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Test recording', minutes * 60, minutes, now(), now() + 900);
  }
  return { sql, env, objects, queue, user, quote };
}
