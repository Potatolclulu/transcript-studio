import { describe, it, expect, vi, afterEach } from 'vitest';
import { harness } from './harness';
import { createJob, claim, processJob, sweep } from '../worker/jobs';
import { commitBudget, hmac } from '../worker/security';
import { webhook } from '../worker/billing';
import { now } from '../worker/env';
afterEach(() => vi.unstubAllGlobals());
describe('actual SQLite accounting and task transitions', () => {
  it('creates job, reserve and outbox atomically; duplicate submission reserves once', async () => {
    const h = harness(); h.user('u'); h.quote('q', 'u');
    const id = await createJob(h.env, 'u', 'q');
    expect(await createJob(h.env, 'u', 'q')).toBe(id);
    expect(h.sql.prepare('SELECT balance,reserved FROM users').get()).toEqual({balance:95,reserved:5});
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM ledger').get()?.n).toBe(1);
    expect(h.sql.prepare('SELECT job_id FROM outbox').get()?.job_id).toBe(id);
  });
  it('insufficient balance leaves no job, reserve, or outbox', async () => {
    const h = harness(); h.user('u', 2); h.quote('q', 'u', 5);
    await expect(createJob(h.env, 'u', 'q')).rejects.toThrow('more available minutes');
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n).toBe(0);
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM ledger').get()?.n).toBe(0);
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);
  });
  it('caps global async jobs at two and each user at one across duplicate claims', async () => {
    const h = harness(); h.user('a'); h.user('b'); h.user('c');
    h.quote('qa','a'); h.quote('qa2','a'); h.quote('qb','b'); h.quote('qc','c');
    const a = await createJob(h.env,'a','qa'), a2 = await createJob(h.env,'a','qa2');
    const b = await createJob(h.env,'b','qb'), c = await createJob(h.env,'c','qc');
    const results = await Promise.all([claim(h.env,a),claim(h.env,a),claim(h.env,a2),claim(h.env,b),claim(h.env,c)]);
    expect(results).toEqual([true,false,false,true,false]);
    h.sql.prepare("UPDATE jobs SET status='failed',active=0,updated_at=? WHERE id=?").run(now(),a);
    expect(await claim(h.env,c)).toBe(true);
    expect(h.sql.prepare('SELECT COUNT(*) AS n FROM jobs WHERE active=1').get()?.n).toBe(2);
  });
  it('releases failed job once even if status is delivered twice', async () => {
    const h = harness(); h.user('u'); h.quote('q','u'); const id = await createJob(h.env,'u','q');
    for(let i=0;i<2;i++) h.sql.prepare("UPDATE jobs SET status='failed',updated_at=? WHERE id=?").run(now(),id);
    expect(h.sql.prepare('SELECT balance,reserved FROM users').get()).toEqual({balance:100,reserved:0});
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='release'").get()?.n).toBe(1);
  });
  it('a sample persists in R2 and consumes only once under duplicate queue delivery', async () => {
    const h = harness(); h.user('u'); h.quote('q','u',1,'sample');
    const id=await createJob(h.env,'u','q');
    await processJob(h.env,id); await processJob(h.env,id);
    expect(h.objects.has(`results/${id}/transcript.json`)).toBe(true);
    expect(h.sql.prepare('SELECT balance,reserved FROM users').get()).toEqual({balance:99,reserved:0});
    expect(h.sql.prepare('SELECT status,active FROM jobs').get()).toEqual({status:'complete',active:0});
  });
  it('unknown upstream acceptance stops resubmission, holds slot, refunds at 24h', async () => {
    const h = harness(); h.user('u'); h.quote('q','u');
    const fetcher = vi.fn(async () => {throw new Error('network timeout');}); vi.stubGlobal('fetch',fetcher);
    const id=await createJob(h.env,'u','q');
    await processJob(h.env,id); await processJob(h.env,id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.sql.prepare('SELECT status,active FROM jobs').get()).toEqual({status:'review',active:1});
    h.sql.prepare('UPDATE jobs SET created_at=? WHERE id=?').run(now()-86401,id);
    await sweep(h.env);
    expect(h.sql.prepare('SELECT status,active FROM jobs').get()).toEqual({status:'review_refunded',active:1});
    expect(h.sql.prepare('SELECT balance,reserved FROM users').get()).toEqual({balance:100,reserved:0});
  });
  it('recovers saved raw results without another provider request', async () => {
    const h = harness(); h.user('u'); h.quote('q','u');
    const id=await createJob(h.env,'u','q');
    h.objects.set(`results/${id}/raw.json`,JSON.stringify({mode:'generate',data:{lang:'en',content:[{text:'Hello world.',offset:0,duration:1000}]}}));
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await processJob(h.env,id);
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.sql.prepare('SELECT status FROM jobs').get()?.status).toBe('complete');
  });
  it('counted budget includes outstanding commitments and cannot exceed cap', async () => {
    const h=harness();h.env.DAILY_BUDGET_CENTS='10';
    expect(await commitBudget(h.env,'first',6,'job')).toBe(true);
    expect(await commitBudget(h.env,'first',6,'job')).toBe(true);
    expect(await commitBudget(h.env,'second',5,'job')).toBe(false);
    expect(h.sql.prepare('SELECT committed_cents FROM budgets').get()?.committed_cents).toBe(6);
  });
});
describe('signed payment callbacks', () => {
  function setup() {
    const h=harness(); h.user('u',0);
    h.sql.prepare("INSERT INTO orders(id,user_id,package,product_id,cents,minutes,mode,created_at,updated_at) VALUES('o','u','starter','p',900,120,'test',?,?)").run(now(),now());
    const object={id:'checkout-1',request_id:'o',status:'completed',mode:'test',metadata:{userId:'u'},product:{id:'p',billing_type:'one_time'},order:{id:'order-1',status:'paid',amount:900,currency:'USD'}};
    return {...h,object};
  }
  it('deduplicates both the same event and a resend with a new event id', async () => {
    const h=setup();
    for(const id of ['event-1','event-1','event-2']){
      const raw=JSON.stringify({id,eventType:'checkout.completed',object:h.object});
      await webhook(h.env,raw,await hmac(raw,h.env.CREEM_WEBHOOK_SECRET!));
    }
    expect(h.sql.prepare('SELECT balance FROM users').get()?.balance).toBe(120);
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='purchase'").get()?.n).toBe(1);
  });
  it('rejects forged signatures and mismatched price/environment', async () => {
    const h=setup(); const raw=JSON.stringify({id:'e',eventType:'checkout.completed',object:{...h.object,mode:'prod'}});
    await expect(webhook(h.env,raw,'bad')).rejects.toThrow('signature');
    await expect(webhook(h.env,raw,await hmac(raw,h.env.CREEM_WEBHOOK_SECRET!))).rejects.toThrow('match');
    expect(h.sql.prepare('SELECT balance FROM users').get()?.balance).toBe(0);
  });
});
