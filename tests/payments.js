// Online-payment tests with a LOCAL MOCK gateway (no real Razorpay/Cashfree account involved).
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto';

// ---- mock gateway ----
const links = new Map(); let created = 0, lastCreateBody = null;
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!/^Basic /.test(req.headers.authorization || '')) return send(401, { error: { description: 'auth' } });
  if (req.method === 'POST' && req.url === '/v1/payment_links') {
    const b = JSON.parse(Buffer.concat(chunks).toString()); lastCreateBody = b; created++;
    const id = 'plink_mock' + created; links.set(id, { id, amount: b.amount, amount_paid: 0, status: 'created', payments: [] });
    return send(200, { id, short_url: 'https://rzp.io/mock/' + id, status: 'created' });
  }
  const m = /^\/v1\/payment_links\/(.+)$/.exec(req.url);
  if (req.method === 'GET' && m && links.has(m[1])) return send(200, links.get(m[1]));
  send(404, { error: { description: 'nope' } });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const WH = 'whsec_test_123456';
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bm-pay-')), BM_ADMIN_PASSWORD: 'Secret123', PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_KEYID', RAZORPAY_KEY_SECRET: 'SUPERSECRETKEY', RAZORPAY_WEBHOOK_SECRET: WH, PAYMENT_API_BASE: `http://127.0.0.1:${mock.address().port}`, PUBLIC_BASE_URL: 'https://pos.example.in' });
const { openDb } = await import('../server/db.js'); const { createApp } = await import('../server/app.js'); const { ensureAdmin } = await import('../server/auth.js');
const { gatewayConfig, verifyWebhook } = await import('../server/payments.js');
const db = openDb(); ensureAdmin(db); const srv = createApp(db); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
let n = 0, cookie = '';
const t = async (name, fn) => { try { await fn(); n++; console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };
const api = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && url === '/api/login') cookie = sc.split(';')[0]; const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; } return { s: r.status, j }; };
await api('POST', '/api/login', { username: 'admin', password: 'Secret123' });
const items = (await api('GET', '/api/bootstrap')).j.items; let cid = 0;
const mkBill = async (qty = 2) => (await api('POST', '/api/bills', { client_id: 'pay-test-' + (++cid) + '-abcdef', order_type: 'takeaway', payment_method: 'upi', payment_status: 'pending', customer_phone: '9876543210', items: [{ item_id: items[0].id, qty }] })).j.bill;
const getB = async (id) => (await api('GET', '/api/bills/' + id)).j.bill;
const sign = (obj) => { const raw = JSON.stringify(obj); return { raw, sig: crypto.createHmac('sha256', WH).update(raw).digest('hex') }; };
const hook = (obj, { sig, eid } = {}) => { const s = sign(obj); return fetch(base + '/api/webhooks/payments', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig ?? s.sig, 'X-Razorpay-Event-Id': eid || 'evt_' + Math.random().toString(36).slice(2) }, body: s.raw }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) })); };
const paidEvent = (link, pay = 'pay_1', amt = link.amount) => ({ entity: 'event', event: 'payment_link.paid', created_at: 1, payload: { payment_link: { entity: { id: link.id, amount: link.amount, amount_paid: amt, status: 'paid' } }, payment: { entity: { id: pay, amount: amt, status: 'captured', method: 'upi' } } } });
const gwPaid = (id, amt, pay = 'pay_1') => { const l = links.get(id); Object.assign(l, { status: 'paid', amount_paid: amt, payments: [{ payment_id: pay, status: 'captured', method: 'upi', amount: amt }] }); };

await t('feature is OFF without credentials (no fake links)', async () => {
  assert.equal(gatewayConfig({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'x' }).enabled, false);
  assert.equal(gatewayConfig({}).enabled, false); assert.equal(gatewayConfig({ PAYMENT_PROVIDER: 'cashfree', CASHFREE_CLIENT_ID: 'a' }).enabled, false);
  assert.deepEqual(gatewayConfig({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'a', RAZORPAY_KEY_SECRET: 'b' }).missing, ['RAZORPAY_WEBHOOK_SECRET']);
});
let bill, link;
await t('payment link is created for the exact bill amount with order number and reference', async () => {
  bill = await mkBill(2);
  const r = await api('POST', `/api/bills/${bill.id}/payment-link`, {}); assert.equal(r.s, 200);
  link = r.j.bill.payment_link; assert.ok(link.url.startsWith('https://rzp.io/mock/')); assert.equal(link.reference, bill.bill_no + '-P1'); assert.equal(link.amount, bill.grand_total);
  assert.equal(lastCreateBody.amount, bill.grand_total); assert.equal(lastCreateBody.currency, 'INR'); assert.equal(lastCreateBody.reference_id, bill.bill_no + '-P1');
  assert.equal(lastCreateBody.callback_url, 'https://pos.example.in/pay-return.html'); assert.equal(lastCreateBody.customer.contact, '+919876543210');
});
await t('creating a link does NOT mark the bill paid; asking twice reuses the same link', async () => {
  const again = await api('POST', `/api/bills/${bill.id}/payment-link`, {}); assert.equal(again.j.bill.payment_link.url, link.url); assert.equal(created, 1);
  assert.equal((await getB(bill.id)).payment_status, 'pending');
});
await t('browser never receives gateway secrets; only an on/off flag', async () => {
  const txt = JSON.stringify((await api('GET', '/api/bootstrap')).j); assert.ok(txt.includes('"online_payment_enabled":true'));
  for (const secret of ['SUPERSECRETKEY', WH, 'rzp_test_KEYID']) assert.ok(!txt.includes(secret), secret);
});
const gid = () => 'plink_mock' + created;
await t('webhook with a wrong signature is rejected and the bill stays unpaid', async () => {
  gwPaid(link.url.split('/').pop(), bill.grand_total);
  const r = await hook(paidEvent({ id: link.url.split('/').pop(), amount: bill.grand_total }), { sig: 'deadbeef' }); assert.equal(r.s, 401);
  assert.equal((await getB(bill.id)).payment_status, 'pending');
});
await t('signed webhook that the gateway API does not confirm does not mark paid', async () => {
  const b2 = await mkBill(1); const l2 = (await api('POST', `/api/bills/${b2.id}/payment-link`, {})).j.bill.payment_link; const id2 = l2.url.split('/').pop();
  const r = await hook(paidEvent({ id: id2, amount: b2.grand_total })); assert.equal(r.s, 200); assert.equal(r.j.outcome, 'not_paid_at_gateway');
  assert.equal((await getB(b2.id)).payment_status, 'pending');
});
await t('verified webhook + gateway confirmation marks the bill PAID and records the payment', async () => {
  const id = link.url.split('/').pop();
  const r = await hook(paidEvent({ id, amount: bill.grand_total }, 'pay_ok1'), { eid: 'evt_paid_1' }); assert.equal(r.j.outcome, 'paid');
  const b = await getB(bill.id); assert.equal(b.payment_status, 'paid'); assert.equal(b.payment_method, 'upi'); assert.equal(b.payment_ref, 'pay_1');
  const p = db.prepare('SELECT * FROM payments WHERE bill_id=?').all(bill.id); assert.equal(p.length, 1); assert.equal(p[0].source, 'gateway-razorpay'); assert.equal(p[0].amount, bill.grand_total);
});
await t('the same webhook delivered twice is ignored (one payment only)', async () => {
  const id = link.url.split('/').pop(); const r = await hook(paidEvent({ id, amount: bill.grand_total }, 'pay_ok1'), { eid: 'evt_paid_1' }); assert.equal(r.j.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payments WHERE bill_id=?').get(bill.id).c, 1);
});
await t('a paid bill gets no new link', async () => assert.equal((await api('POST', `/api/bills/${bill.id}/payment-link`, {})).s, 409));
await t('wrong amount paid -> NOT marked paid', async () => {
  const b = await mkBill(3); const l = (await api('POST', `/api/bills/${b.id}/payment-link`, {})).j.bill.payment_link; const id = l.url.split('/').pop();
  gwPaid(id, b.grand_total - 100); const r = await hook(paidEvent({ id, amount: b.grand_total }, 'pay_x', b.grand_total - 100)); assert.equal(r.j.outcome, 'amount_mismatch');
  assert.equal((await getB(b.id)).payment_status, 'pending');
});
await t('payment received for a cancelled bill is flagged, bill stays cancelled/unpaid', async () => {
  const b = await mkBill(1); const l = (await api('POST', `/api/bills/${b.id}/payment-link`, {})).j.bill.payment_link; const id = l.url.split('/').pop();
  await api('POST', `/api/bills/${b.id}/void`, { reason: 't', admin_password: 'Secret123' }); gwPaid(id, b.grand_total, 'pay_void');
  const r = await hook(paidEvent({ id, amount: b.grand_total }, 'pay_void')); assert.equal(r.j.outcome, 'paid_on_void');
  const x = await getB(b.id); assert.equal(x.status, 'void'); assert.equal(x.payment_status, 'pending');
});
await t('"Check payment status" asks the gateway: unpaid stays unpaid, paid becomes PAID', async () => {
  const b = await mkBill(1); const l = (await api('POST', `/api/bills/${b.id}/payment-link`, {})).j.bill.payment_link; const id = l.url.split('/').pop();
  let r = await api('POST', `/api/bills/${b.id}/payment-link/check`, {}); assert.equal(r.j.outcome, 'unchanged'); assert.equal(r.j.bill.payment_status, 'pending');
  gwPaid(id, b.grand_total, 'pay_chk'); r = await api('POST', `/api/bills/${b.id}/payment-link/check`, {}); assert.equal(r.j.outcome, 'paid'); assert.equal(r.j.bill.payment_status, 'paid');
});
await t('expired link event keeps bill unpaid; a fresh link can then be made', async () => {
  const b = await mkBill(1); const l = (await api('POST', `/api/bills/${b.id}/payment-link`, {})).j.bill.payment_link; const id = l.url.split('/').pop();
  const r = await hook({ event: 'payment_link.expired', created_at: 2, payload: { payment_link: { entity: { id, amount: b.grand_total, status: 'expired' } } } }); assert.equal(r.j.outcome, 'expired');
  assert.equal((await getB(b.id)).payment_status, 'pending');
  const again = (await api('POST', `/api/bills/${b.id}/payment-link`, {})).j.bill.payment_link; assert.equal(again.reference, b.bill_no + '-P2'); assert.notEqual(again.url, l.url);
});
await t('manual "I verified" payment flow still works', async () => {
  const b = await mkBill(1); const r = await api('POST', `/api/bills/${b.id}/pay`, { confirm: true, method: 'upi', reference: 'UTR1' }); assert.equal(r.j.bill.payment_status, 'paid');
});
await t('Cashfree webhook signature scheme (timestamp + raw body, HMAC-SHA256, base64)', async () => {
  const cfg = gatewayConfig({ PAYMENT_PROVIDER: 'cashfree', CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'sek' });
  const raw = Buffer.from(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', event_time: 'x', data: { link_id: 'L1', link_status: 'PAID', link_amount: 189, link_amount_paid: 189 } }));
  const ts = String(Date.now()), sig = crypto.createHmac('sha256', 'sek').update(ts + raw.toString()).digest('base64');
  const ok = verifyWebhook(cfg, { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts }, raw); assert.equal(ok.ok, true); assert.equal(ok.type, 'paid'); assert.equal(ok.amountPaid, 18900);
  assert.equal(verifyWebhook(cfg, { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts }, Buffer.from(raw.toString() + ' ')).ok, false);
});
srv.close(); mock.close(); console.log(`\n${n} payment checks passed` + (process.exitCode ? ' — SOME FAILED' : '')); process.exit(process.exitCode || 0);
