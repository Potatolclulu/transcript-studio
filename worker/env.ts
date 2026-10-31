export interface Env extends Pick<CloudflareBindings, 'DB' | 'MEDIA' | 'ASSETS'> {
  TASKS: Queue<{ jobId: string; kind?: 'learning' | 'ai' | 'reading' }>;
  APP_ENV: string; PUBLIC_ORIGIN: string; MAX_ACTIVE_JOBS: string; DAILY_BUDGET_CENTS: string;
  SUPADATA_CREDIT_CENTS: string; TRANSCRIPTION_ENABLED: string; BILLING_ENABLED: string;
  SUPADATA_API_KEY?: string; RESEND_API_KEY?: string; EMAIL_FROM?: string;
  TRANSCRIPTION_PROVIDER?: string; DOUBAO_API_KEY?: string; DOUBAO_RESOURCE_ID?: string;
  DOUBAO_BUDGET_CENTS_PER_MINUTE?: string; LOCAL_ASR_TEST_ENABLED?: string;
  MEDIA_SIGNING_SECRET?: string; PROBE_URL?: string; PROBE_SECRET?: string;
  CREEM_API_KEY?: string; CREEM_WEBHOOK_SECRET?: string; CREEM_MODE: string;
  CREEM_STARTER_PRODUCT_ID?: string; CREEM_PLUS_PRODUCT_ID?: string;
  R2_ACCOUNT_ID?: string; R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string; R2_BUCKET_NAME?: string;
  SUPPORT_EMAIL?: string;
  CAPTION_SERVICE_URL?: string; CAPTION_SERVICE_SECRET?: string;
  LLM_API_URL?: string; LLM_API_KEY?: string; LLM_MODEL?: string;
  LLM_DAILY_BUDGET_CENTS?: string; LLM_USER_DAILY_BUDGET_CENTS?: string; LLM_REQUEST_BUDGET_CENTS?: string;
}
export interface User { id: string; email: string; balance: number; reserved: number; demo: number; blocked: number }
export interface JobRow {
  id: string; user_id: string; source: string; input_url: string; input_key: string; upload_id: string | null;
  title: string; duration: number; minutes: number; status: string; phase: string; active: number;
  lease_until: number; lease_token: string | null; provider_id: string | null; next_run: number;
  budget_reserved: number; cancel_requested: number; settlement: string; error: string | null;
  created_at: number; updated_at: number; expires_at: number;
}
export const now = () => Math.floor(Date.now() / 1000);
export const uid = () => crypto.randomUUID();
export const isDev = (e: Env) => e.APP_ENV === 'development';
export const usesDoubao = (e: Env) => e.TRANSCRIPTION_PROVIDER !== 'supadata';
export const providerEnabled = (e: Env) => !!(usesDoubao(e) ? e.DOUBAO_API_KEY : e.SUPADATA_API_KEY) && Number(e.DAILY_BUDGET_CENTS) > 0;
export const realEnabled = (e: Env) => e.TRANSCRIPTION_ENABLED === 'true' && providerEnabled(e);
export const localAsrEnabled = (e: Env) => isDev(e) && e.LOCAL_ASR_TEST_ENABLED === 'true' && !!e.DOUBAO_API_KEY && Number(e.DAILY_BUDGET_CENTS) > 0;
export const billingEnabled = (e: Env) => e.BILLING_ENABLED === 'true' && !!(e.CREEM_API_KEY && e.CREEM_WEBHOOK_SECRET && e.CREEM_STARTER_PRODUCT_ID && e.CREEM_PLUS_PRODUCT_ID && e.PUBLIC_ORIGIN);
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function row<T>(e: Env, sql: string, ...args: unknown[]): Promise<T | null> {
  return e.DB.prepare(sql).bind(...args).first<T>();
}
export async function rows<T>(e: Env, sql: string, ...args: unknown[]): Promise<T[]> {
  return (await e.DB.prepare(sql).bind(...args).all<T>()).results;
}
export async function run(e: Env, sql: string, ...args: unknown[]) {
  return e.DB.prepare(sql).bind(...args).run();
}
