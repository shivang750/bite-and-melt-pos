// Online payment gateway adapter (Razorpay or Cashfree). Everything is configured through environment variables;
// with no configuration the feature stays OFF - no links are created and nothing is ever simulated.
//
//   PAYMENT_PROVIDER        none (default) | razorpay | cashfree
//   PUBLIC_BASE_URL         public https address of this server, e.g. https://pos.yourcafe.in  (used for the return page)
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
//   CASHFREE_CLIENT_ID, CASHFREE_CLIENT_SECRET, CASHFREE_ENV (sandbox | production)
//   PAYMENT_API_BASE        optional override of the gateway API address (used only by automated tests)
//
// A bill is marked PAID only by applyGatewayResult() in app.js, which is called from (a) a webhook whose signature
// was verified here, or (b) "Check payment status", which asks the gateway server-to-server. Opening or clicking
// a link never changes a bill.
import crypto from 'node:crypto';

const timingSafeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function gatewayConfig(env = process.env) {
  const provider = String(env.PAYMENT_PROVIDER || 'none').trim().toLowerCase();
  const need = provider === 'razorpay' ? ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']
    : provider === 'cashfree' ? ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'] : [];
  const known = provider === 'razorpay' || provider === 'cashfree';
  const missing = known ? need.filter((k) => !env[k]) : [];
  const cfg = { provider: known ? provider : 'none', enabled: known && !missing.length, missing, env };
  if (provider !== 'none' && !known) cfg.error = `PAYMENT_PROVIDER "${provider}" is not supported (use razorpay or cashfree)`;
  return cfg;
}
/** What the browser may know: whether the feature is on, never any key. */
export const publicInfo = (cfg) => ({ enabled: cfg.enabled, provider: cfg.enabled ? cfg.provider : 'none' });

const apiBase = (cfg) => cfg.env.PAYMENT_API_BASE
  || (cfg.provider === 'razorpay' ? 'https://api.razorpay.com' : (cfg.env.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com'));

async function call(cfg, method, pathname, body) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.provider === 'razorpay') headers.Authorization = 'Basic ' + Buffer.from(`${cfg.env.RAZORPAY_KEY_ID}:${cfg.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  else { headers['x-client-id'] = cfg.env.CASHFREE_CLIENT_ID; headers['x-client-secret'] = cfg.env.CASHFREE_CLIENT_SECRET; headers['x-api-version'] = '2023-08-01'; }
  let res;
  try { res = await fetch(apiBase(cfg) + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
  catch { throw new GatewayError('Could not reach the payment gateway. Check the internet connection and try again.'); }
  const text = await res.text(); let json = {}; try { json = JSON.parse(text); } catch { /* keep {} */ }
  if (!res.ok) {
    const msg = json?.error?.description || json?.message || `status ${res.status}`;
    console.error(`[payments] ${cfg.provider} ${method} ${pathname} failed: ${res.status} ${msg}`);
    throw new GatewayError(res.status === 401 || res.status === 403 ? 'The payment gateway rejected the API keys. Check the server configuration.' : `Payment gateway error: ${msg}`);
  }
  return json;
}
export class GatewayError extends Error {}

const paise = (n) => Math.round(Number(n));
const rupeesToPaise = (r) => Math.round(Number(r) * 100);
const statusMap = (s) => ({ paid: 'paid', created: 'created', expired: 'expired', cancelled: 'cancelled', partially_paid: 'partial', active: 'created' }[String(s).toLowerCase()] || 'other');

/** Create a payment link for the exact bill amount. amountPaise is an integer. */
export async function createLink(cfg, { linkKey, reference, amountPaise, description, customer, returnUrl, expiresAt }) {
  if (cfg.provider === 'razorpay') {
    const body = { amount: amountPaise, currency: 'INR', accept_partial: false, reference_id: reference.slice(0, 40), description: description.slice(0, 200),
      notify: { sms: false, email: false }, reminder_enable: false, expire_by: Math.floor(expiresAt / 1000), notes: { reference } };
    if (customer.phone) body.customer = { ...(customer.name ? { name: customer.name } : {}), contact: '+91' + customer.phone };
    if (returnUrl) { body.callback_url = returnUrl; body.callback_method = 'get'; }
    const r = await call(cfg, 'POST', '/v1/payment_links', body);
    if (!r.id || !r.short_url) throw new GatewayError('The payment gateway returned an unexpected answer.');
    return { linkId: r.id, url: r.short_url };
  }
  const body = { link_id: linkKey, link_amount: amountPaise / 100, link_currency: 'INR', link_purpose: description.slice(0, 500), link_partial_payments: false,
    link_notify: { send_sms: false, send_email: false }, link_auto_reminders: false, link_expiry_time: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    customer_details: { customer_phone: customer.phone || '9999999999', ...(customer.name ? { customer_name: customer.name } : {}) }, link_notes: { reference } };
  if (returnUrl) body.link_meta = { return_url: returnUrl };
  const r = await call(cfg, 'POST', '/pg/links', body);
  if (!r.link_url) throw new GatewayError('The payment gateway returned an unexpected answer.');
  return { linkId: r.link_id || linkKey, url: r.link_url };
}

/** Ask the gateway (server to server) for the link's real state. */
export async function fetchLink(cfg, linkId) {
  if (cfg.provider === 'razorpay') {
    const r = await call(cfg, 'GET', '/v1/payment_links/' + encodeURIComponent(linkId));
    const pay = Array.isArray(r.payments) ? r.payments.find((p) => p.status === 'captured') : null;
    return { status: statusMap(r.status), amount: paise(r.amount), amountPaid: paise(r.amount_paid || 0), paymentId: pay?.payment_id || '', method: pay?.method || '' };
  }
  const r = await call(cfg, 'GET', '/pg/links/' + encodeURIComponent(linkId));
  return { status: statusMap(r.link_status), amount: rupeesToPaise(r.link_amount), amountPaid: rupeesToPaise(r.link_amount_paid || 0), paymentId: '', method: '' };
}

/**
 * Verify a webhook with the gateway secret, using the exact raw bytes received.
 * Returns {ok:false} or {ok:true, eventKey, type, linkId, amount, amountPaid, paymentId, method}.
 */
export function verifyWebhook(cfg, headers, raw) {
  const text = raw.toString('utf8');
  if (cfg.provider === 'razorpay') {
    const sig = headers['x-razorpay-signature'];
    if (!sig) return { ok: false };
    const expect = crypto.createHmac('sha256', cfg.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if (!timingSafeEq(sig, expect)) return { ok: false };
    let j; try { j = JSON.parse(text); } catch { return { ok: false, malformed: true }; }
    const pl = j?.payload?.payment_link?.entity || {}, pay = j?.payload?.payment?.entity || {};
    const type = j.event === 'payment_link.paid' ? 'paid' : j.event === 'payment_link.expired' ? 'expired' : j.event === 'payment_link.cancelled' ? 'cancelled' : 'other';
    return { ok: true, eventKey: headers['x-razorpay-event-id'] || `${j.event}:${pl.id}:${pay.id || ''}:${j.created_at || ''}`, type, linkId: pl.id || '',
      amount: paise(pl.amount), amountPaid: paise(pl.amount_paid || pay.amount || 0), paymentId: pay.id || '', method: pay.method || '' };
  }
  // Cashfree: HMAC-SHA256 over (timestamp + raw body), base64, keyed with the client secret.
  const sig = headers['x-webhook-signature'], ts = headers['x-webhook-timestamp'];
  if (!sig || !ts) return { ok: false };
  const expect = crypto.createHmac('sha256', cfg.env.CASHFREE_CLIENT_SECRET).update(ts + text).digest('base64');
  if (!timingSafeEq(sig, expect)) return { ok: false };
  if (Math.abs(Date.now() - Number(ts) * (String(ts).length > 11 ? 1 : 1000)) > 24 * 3600 * 1000) return { ok: false, stale: true };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, malformed: true }; }
  const d = j?.data || {};
  const st = statusMap(d.link_status);
  return { ok: true, eventKey: `${j.type}:${d.link_id}:${d.link_status}:${j.event_time || ts}`, type: st === 'paid' ? 'paid' : st === 'expired' ? 'expired' : st === 'cancelled' ? 'cancelled' : 'other',
    linkId: d.link_id || '', amount: rupeesToPaise(d.link_amount), amountPaid: rupeesToPaise(d.link_amount_paid || 0), paymentId: d.order?.transaction_id ? String(d.order.transaction_id) : '', method: '' };
}
