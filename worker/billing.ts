import { PACKAGES } from '../shared/model';
import { AppError, billingEnabled, now, row, run, uid, type Env, type User } from './env';
import { hmac, safeEqual } from './security';

export async function checkout(e: Env, user: User, pack: keyof typeof PACKAGES) {
  if (!billingEnabled(e) || user.demo) throw new AppError(503, 'Checkout is not available in this preview.');
  if (user.blocked) throw new AppError(403, 'Please contact support before making another purchase.');
  const p = PACKAGES[pack], product = pack === 'starter' ? e.CREEM_STARTER_PRODUCT_ID : e.CREEM_PLUS_PRODUCT_ID;
  if (!p || !product) throw new AppError(400, 'Choose an available minute pack.');
  const id = uid(), time = now(), mode = e.CREEM_MODE === 'prod' ? 'prod' : 'test';
  await run(e, 'INSERT INTO orders(id,user_id,package,product_id,cents,minutes,mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, user.id, pack, product, p.cents, p.minutes, mode, time, time);
  let response: Response;
  try {
    response = await fetch(`https://${mode === 'test' ? 'test-api' : 'api'}.creem.io/v1/checkouts`, {
      method: 'POST', headers: { 'x-api-key': e.CREEM_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: product, request_id: id, units: 1, customer: { email: user.email }, success_url: `${e.PUBLIC_ORIGIN}/app?checkout=returned`, metadata: { userId: user.id } }),
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw new AppError(503, 'Checkout did not respond. No minutes have been charged. Please check your account before trying again.'); }
  if (!response.ok) throw new AppError(503, 'Checkout is temporarily unavailable.');
  const data = await response.json() as any;
  let url: URL;
  try { url = new URL(data.checkout_url); } catch { throw new AppError(502, 'Checkout returned an invalid address.'); }
  if (url.protocol !== 'https:' || !(url.hostname === 'creem.io' || url.hostname.endsWith('.creem.io')) || !data.id) throw new AppError(502, 'Checkout returned an invalid address.');
  await run(e, 'UPDATE orders SET checkout_id=?,updated_at=? WHERE id=?', data.id, now(), id);
  return url.toString();
}
export async function webhook(e: Env, raw: string, signature: string | undefined) {
  if (!e.CREEM_WEBHOOK_SECRET || !signature || !safeEqual(await hmac(raw, e.CREEM_WEBHOOK_SECRET), signature.toLowerCase()))
    throw new AppError(401, 'Invalid webhook signature.');
  let event: any;
  try { event = JSON.parse(raw); } catch { throw new AppError(400, 'Invalid webhook payload.'); }
  if (typeof event.id !== 'string' || typeof event.eventType !== 'string') throw new AppError(400, 'Missing event identity.');
  if (await row(e, 'SELECT id FROM payment_events WHERE id=?', event.id)) return;
  const object = event.object || {}, time = now();
  if (event.eventType === 'checkout.completed') {
    const order = await row<any>(e, 'SELECT * FROM orders WHERE id=?', object.request_id || '');
    const product = typeof object.product === 'object' ? object.product : {};
    const payment = object.order || {};
    if (!order || object.status !== 'completed' || object.mode !== order.mode ||
      product.id !== order.product_id || product.billing_type !== 'one_time' ||
      payment.status !== 'paid' || payment.amount !== order.cents || String(payment.currency).toUpperCase() !== 'USD' ||
      !payment.id || !object.id || order.checkout_id && order.checkout_id !== object.id ||
      object.metadata?.userId !== order.user_id)
      throw new AppError(400, 'Payment does not match the server order.');
    await e.DB.batch([
      e.DB.prepare('INSERT OR IGNORE INTO payment_events VALUES(?,?,?,?)').bind(event.id, event.eventType, order.id, time),
      e.DB.prepare("UPDATE orders SET status='paid',checkout_id=?,provider_order_id=?,updated_at=? WHERE id=? AND status='pending'").bind(object.id, payment.id, time, order.id),
    ]);
  } else if (['refund.created', 'dispute.created'].includes(event.eventType)) {
    const providerId = typeof object.order === 'string' ? object.order : object.order?.id;
    const order = await row<any>(e, 'SELECT * FROM orders WHERE provider_order_id=?', providerId || '');
    if (!order || object.mode !== order.mode) throw new AppError(400, 'Payment reversal needs manual reconciliation.');
    await e.DB.batch([
      e.DB.prepare('INSERT OR IGNORE INTO payment_events VALUES(?,?,?,?)').bind(event.id, event.eventType, order.id, time),
      e.DB.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=? AND status='paid'").bind(event.eventType === 'refund.created' ? 'refunded' : 'disputed', time, order.id),
    ]);
  } else {
    await run(e, 'INSERT OR IGNORE INTO payment_events VALUES(?,?,NULL,?)', event.id, event.eventType, time);
  }
}
