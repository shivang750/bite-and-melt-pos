// API / backend tests (no browser). Starts the real server in-process on a temp database.
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-api-'));
process.env.BM_ADMIN_PASSWORD = 'Secret123'; process.env.BM_SEED = 'sample';
const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { ensureAdmin } = await import('../server/auth.js');
const db = openDb(); ensureAdmin(db);
const srv = createApp(db); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
let n = 0, cookie = '';
const t = async (name, fn) => { try { await fn(); n++; console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };
const api = async (method, url, body, ck = cookie) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && url === '/api/login') cookie = sc.split(';')[0];
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; } return { s: r.status, j };
};
let cid = 0; const newBill = (o = {}) => ({ client_id: 'test-client-' + (++cid) + '-abcdef', order_type: 'dine_in', payment_method: 'cash', payment_status: 'paid', items: [], ...o });

await t('API requires login', async () => assert.equal((await api('GET', '/api/bootstrap', null, '')).s, 401));
await t('wrong password rejected, right one accepted', async () => {
  assert.equal((await api('POST', '/api/login', { username: 'admin', password: 'bad' })).s, 401);
  assert.equal((await api('POST', '/api/login', { username: 'admin', password: 'Secret123' })).s, 200);
});
let items;
await t('sample menu has the 7 categories', async () => {
  const b = (await api('GET', '/api/bootstrap')).j; items = b.items;
  for (const c of ['Burgers', 'Sandwiches', 'Pizza', 'Fries', 'Maggi', 'Beverages', 'Other Items']) assert.ok(b.categories.some((x) => x.name === c), c);
  assert.ok(items.length >= 14);
});
await t('server computes totals from DB prices, ignoring prices/totals sent by the client', async () => {
  const it = items[0];
  const r = await api('POST', '/api/bills', newBill({ items: [{ item_id: it.id, qty: 3, price: 1, name: 'HACK' }], grand_total: 1 }));
  assert.equal(r.s, 201); assert.equal(r.j.bill.grand_total, it.price * 3); assert.notEqual(r.j.bill.items[0].name, 'HACK');
});
await t('item % discount + bill % discount are exact (integer paise)', async () => {
  const a = items[0], b = items[1];
  const r = (await api('POST', '/api/bills', newBill({ items: [{ item_id: a.id, qty: 2 }, { item_id: b.id, qty: 1, disc_type: 'amount', disc_value: 1000 }], bill_disc_type: 'percent', bill_disc_value: 10 }))).j.bill;
  const sub = a.price * 2 + b.price, afterItem = sub - 1000, bd = Math.round(afterItem * 0.1);
  assert.equal(r.bill_discount, bd); assert.equal(r.grand_total, afterItem - bd);
});
await t('duplicate client_id does not create a second bill', async () => {
  const p = newBill({ items: [{ item_id: items[0].id, qty: 1 }] });
  const a = await api('POST', '/api/bills', p), b = await api('POST', '/api/bills', p);
  assert.equal(a.j.bill.id, b.j.bill.id); assert.equal(b.j.duplicate, true);
});
await t('bill numbers are unique and sequential', async () => {
  const a = (await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }))).j.bill.bill_no;
  const b = (await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }))).j.bill.bill_no;
  assert.notEqual(a, b);
});
await t('UPI bill cannot be created as Paid without verification; default is Pending', async () => {
  const bad = await api('POST', '/api/bills', newBill({ payment_method: 'upi', payment_status: 'paid', items: [{ item_id: items[0].id, qty: 1 }] }));
  assert.equal(bad.s, 400);
  const ok = await api('POST', '/api/bills', newBill({ payment_method: 'upi', payment_status: 'pending', items: [{ item_id: items[0].id, qty: 1 }] }));
  assert.equal(ok.j.bill.payment_status, 'pending');
});
await t('invalid Indian mobile numbers are rejected, +91 formats normalised', async () => {
  assert.equal((await api('POST', '/api/bills', newBill({ customer_phone: '12345', items: [{ item_id: items[0].id, qty: 1 }] }))).s, 400);
  const r = await api('POST', '/api/bills', newBill({ customer_phone: '+91 98765-43210', items: [{ item_id: items[0].id, qty: 1 }] }));
  assert.equal(r.j.bill.customer_phone, '9876543210');
});
await t('empty bill, qty 0 and unknown item are rejected', async () => {
  assert.equal((await api('POST', '/api/bills', newBill())).s, 400);
  assert.equal((await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 0 }] }))).s, 400);
  assert.equal((await api('POST', '/api/bills', newBill({ items: [{ item_id: 999999, qty: 1 }] }))).s, 400);
});
await t('out-of-stock item cannot be billed; back in stock works', async () => {
  const it = items[2]; await api('PUT', '/api/items/' + it.id, { ...it, available: 0 });
  assert.equal((await api('POST', '/api/bills', newBill({ items: [{ item_id: it.id, qty: 1 }] }))).s, 400);
  await api('PUT', '/api/items/' + it.id, { ...it, available: 1 });
  assert.equal((await api('POST', '/api/bills', newBill({ items: [{ item_id: it.id, qty: 1 }] }))).s, 201);
});
await t('changing a menu price does not change old bills', async () => {
  const it = items[3]; const old = (await api('POST', '/api/bills', newBill({ items: [{ item_id: it.id, qty: 2 }] }))).j.bill;
  await api('PUT', '/api/items/' + it.id, { ...it, price: it.price + 5000 });
  const again = (await api('GET', '/api/bills/' + old.id)).j; const bill = again.bill || again;
  assert.equal(bill.grand_total, old.grand_total); assert.equal(bill.items[0].price, it.price);
  const fresh = (await api('POST', '/api/bills', newBill({ items: [{ item_id: it.id, qty: 1 }] }))).j.bill;
  assert.equal(fresh.grand_total, it.price + 5000);
});
await t('GST is off by default and only applied when enabled', async () => {
  const before = (await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }))).j.bill; assert.equal(before.tax_total, 0);
  const st = (await api('GET', '/api/settings')).j; const s = st.settings || st;
  const put = await api('PUT', '/api/settings', { ...s, gst_enabled: true, gst_rate: 5, gst_mode: 'exclusive' }); assert.equal(put.s, 200);
  const after = (await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }))).j.bill;
  assert.ok(after.tax_total > 0); await api('PUT', '/api/settings', { ...s, gst_enabled: false });
});
await t('void requires the admin password and keeps the record', async () => {
  const b = (await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }))).j.bill;
  assert.equal((await api('POST', `/api/bills/${b.id}/void`, { reason: 'test', admin_password: 'nope' })).s, 403);
  const ok = await api('POST', `/api/bills/${b.id}/void`, { reason: 'test', admin_password: 'Secret123' }); assert.equal(ok.s, 200);
  const g = (await api('GET', '/api/bills/' + b.id)).j; assert.equal((g.bill || g).status, 'void');
});
await t('reports exclude void bills; CSV and XLSX export work', async () => {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const rep = await api('GET', `/api/reports?from=${today}&to=${today}`); assert.equal(rep.s, 200);
  const csv = await fetch(`${base}/api/reports/export?type=bills&from=${today}&to=${today}`, { headers: { Cookie: cookie } }); assert.equal(csv.status, 200);
  const x = await fetch(`${base}/api/reports/export?type=bills&format=xlsx&from=${today}&to=${today}`, { headers: { Cookie: cookie } });
  assert.equal(x.status, 200); assert.equal(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});
await t('staff user can bill but not manage the menu', async () => {
  assert.equal((await api('POST', '/api/users', { username: 'staff1', password: 'Staffpass1', role: 'staff', full_name: 'S' })).s, 200);
  const sc = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'staff1', password: 'Staffpass1' }) });
  const ck = sc.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }), ck)).s, 201);
  assert.equal((await api('POST', '/api/items', { name: 'x', price: 100, category_id: 1 }, ck)).s, 403);
});
await t('database backup download is a valid SQLite file', async () => {
  const r = await fetch(base + '/api/backup', { headers: { Cookie: cookie } }); assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
});
await t('WhatsApp bill link: upload image -> public page + image (no login), bad PNG refused, cancelled bill hidden', async () => {
  const b = (await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }))).j.bill;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
  assert.equal((await api('POST', `/api/bills/${b.id}/share-link`, { png: Buffer.from('not a png'.repeat(40)).toString('base64') })).s, 400);
  const r = await api('POST', `/api/bills/${b.id}/share-link`, { png: png.toString('base64') });
  assert.equal(r.s, 200); assert.match(r.j.url, /\/b\/[A-Za-z0-9_-]{16,}$/);
  const again = await api('POST', `/api/bills/${b.id}/share-link`, { png: png.toString('base64') });
  assert.equal(again.j.token, r.j.token); // same bill keeps the same link
  const path = new URL(r.j.url).pathname;
  const page = await fetch(base + path); const html = await page.text();
  assert.equal(page.status, 200); assert.ok(html.includes('og:image') && html.includes(b.bill_no) && html.includes(path + '.png'));
  const img = await fetch(base + path + '.png');
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/b/AAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await fetch(base + '/api/bills/' + b.id + '/share-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ png: png.toString('base64') }) })).status, 401); // not logged in
  const v = await api('POST', `/api/bills/${b.id}/void`, { admin_password: 'Secret123', reason: 'test' });
  assert.equal(v.s, 200); assert.equal((await fetch(base + path)).status, 404);
});
await t('restore from a downloaded backup brings bills and menu prices back; bad file refused; login kept', async () => {
  const count = () => db.prepare('SELECT COUNT(*) c FROM bills').get().c;
  const price = () => db.prepare('SELECT price FROM items WHERE id=?').get(items[0].id).price;
  const bk = Buffer.from(await (await fetch(base + '/api/backup', { headers: { Cookie: cookie } })).arrayBuffer());
  const c0 = count(), p0 = price();
  await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }));
  await api('PUT', '/api/items/' + items[0].id, { ...items[0], price: p0 + 777 });
  assert.equal(count(), c0 + 1); assert.equal(price(), p0 + 777);
  assert.equal((await api('POST', '/api/restore', { data: Buffer.from('not a database at all, just text'.repeat(10)).toString('base64') })).s, 400);
  const r = await api('POST', '/api/restore', { data: bk.toString('base64') });
  assert.equal(r.s, 200); assert.equal(r.j.bills, c0);
  assert.equal(count(), c0); assert.equal(price(), p0);
  assert.equal((await api('GET', '/api/me')).s, 200);
  assert.equal((await api('POST', '/api/bills', newBill({ items: [{ item_id: items[0].id, qty: 1 }] }))).s, 201); // billing still works after restore
});
await t('online payment is OFF by default: no link can be created, webhook refuses, no secrets/flags exposed', async () => {
  const b = (await api('POST', '/api/bills', newBill({ payment_method: 'upi', payment_status: 'pending', items: [{ item_id: items[0].id, qty: 1 }] }))).j.bill;
  const r = await api('POST', `/api/bills/${b.id}/payment-link`, {}); assert.equal(r.s, 503);
  assert.equal((await fetch(base + '/api/webhooks/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal((await api('GET', '/api/bootstrap')).j.settings.online_payment_enabled, false);
});
await t('logo and favicon routes answer (custom logo if present)', async () => {
  const f = await fetch(base + '/brand/favicon.png'); assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'image/png');
});
await t('food photo upload is stored permanently, served, and shown on the item; names/prices untouched', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const it = (await api('GET', '/api/bootstrap')).j.items[5];
  const up = await api('POST', '/api/upload', { data: png }); assert.equal(up.s, 200); assert.match(up.j.url, /^\/uploads\/[a-f0-9]{24}\.png$/);
  assert.equal((await api('PUT', '/api/items/' + it.id, { image: up.j.url })).s, 200);
  const after = (await api('GET', '/api/bootstrap')).j.items.find((x) => x.id === it.id);
  assert.equal(after.image, up.j.url); assert.equal(after.name, it.name); assert.equal(after.price, it.price); assert.equal(after.available, it.available);
  assert.equal((await fetch(base + up.j.url)).status, 200);
  assert.equal((await api('POST', '/api/upload', { data: 'data:image/png;base64,AAAA' })).s, 400); // fake image refused
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', path.basename(up.j.url))), true); // on disk in the data folder, survives restarts
});
await t('Instagram offer: 10% once per username AND per mobile; repeat is blocked; freed if the bill is cancelled', async () => {
  const it = items[0], line = [{ item_id: it.id, qty: 2 }];
  assert.equal((await api('GET', '/api/insta-offer/check?handle=@Rahul_1&phone=9876543210')).j.ok, true);
  assert.equal((await api('POST', '/api/bills', newBill({ items: line, insta_handle: '@Rahul_1' }))).s, 400); // mobile is required
  const a = await api('POST', '/api/bills', newBill({ items: line, customer_phone: '9876543210', insta_handle: '@Rahul_1', bill_disc_type: 'percent', bill_disc_value: 50 }));
  assert.equal(a.s, 201); assert.equal(a.j.bill.insta_handle, 'rahul_1');
  assert.equal(a.j.bill.bill_discount, Math.round(it.price * 2 * 0.1)); // forced to 10%, client's 50% ignored
  const chk = (await api('GET', '/api/insta-offer/check?handle=rahul_1&phone=9111111111')).j; assert.equal(chk.ok, false); assert.match(chk.message, /already used/);
  assert.equal((await api('POST', '/api/bills', newBill({ items: line, customer_phone: '9111111111', insta_handle: 'RAHUL_1' }))).s, 409); // same username, other number
  assert.equal((await api('POST', '/api/bills', newBill({ items: line, customer_phone: '9876543210', insta_handle: 'new_acc' }))).s, 409); // same number, new account
  assert.equal((await api('POST', '/api/bills', newBill({ items: line, customer_phone: '9222222222', insta_handle: 'someone_else' }))).s, 201); // a different person is fine
  assert.equal((await api('POST', `/api/bills/${a.j.bill.id}/void`, { reason: 'test', admin_password: 'Secret123' })).s, 200);
  assert.equal((await api('GET', '/api/insta-offer/check?handle=rahul_1&phone=9876543210')).j.ok, true); // cancelled bill frees the offer
});
await t('edit a saved bill: add/remove items, totals recomputed, old prices kept, payment record follows, log written', async () => {
  const a = items[0], b = items[1];
  const made = (await api('POST', '/api/bills', newBill({ items: [{ item_id: a.id, qty: 1 }] }))).j.bill;
  await api('PUT', '/api/items/' + a.id, { price: a.price + 5000 }); // menu price rises after the bill was made
  const r = await api('POST', `/api/bills/${made.id}/edit`, { items: [{ item_id: a.id, qty: 2 }, { item_id: b.id, qty: 1 }], order_type: 'takeaway', customer_name: 'Ravi', customer_phone: '', notes: 'x' });
  assert.equal(r.s, 200);
  assert.equal(r.j.bill.grand_total, a.price * 2 + b.price); // item a keeps its ORIGINAL price, b uses current price
  assert.equal(r.j.bill.bill_no, made.bill_no); assert.equal(r.j.bill.edit_count, 1); assert.equal(r.j.bill.order_type, 'takeaway');
  const pay = db.prepare('SELECT SUM(amount) s FROM payments WHERE bill_id=?').get(made.id).s; assert.equal(pay, r.j.bill.grand_total);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bill_edits WHERE bill_id=?').get(made.id).n, 1);
  const r2 = await api('POST', `/api/bills/${made.id}/edit`, { items: [{ item_id: b.id, qty: 1 }], order_type: 'dine_in' });
  assert.equal(r2.j.bill.grand_total, b.price); assert.equal(r2.j.bill.items.length, 1);
  assert.equal((await api('POST', `/api/bills/${made.id}/edit`, { items: [] })).s, 400);
  assert.equal((await api('POST', `/api/bills/${made.id}/edit`, { items: [{ item_id: b.id, qty: 1 }], insta_handle: 'edit_user' })).s, 400); // insta needs mobile
  const ok = await api('POST', `/api/bills/${made.id}/edit`, { items: [{ item_id: b.id, qty: 1 }], customer_phone: '9333333333', insta_handle: 'edit_user' });
  assert.equal(ok.s, 200); assert.equal(ok.j.bill.bill_discount, Math.round(b.price * 0.1));
  await api('PUT', '/api/items/' + a.id, { price: a.price });
  await api('POST', `/api/bills/${made.id}/void`, { reason: 't', admin_password: 'Secret123' });
  assert.equal((await api('POST', `/api/bills/${made.id}/edit`, { items: [{ item_id: b.id, qty: 1 }] })).s, 409); // cancelled bills cannot be edited
});
await t('Instagram helper: key needed, follow notifications parsed + de-duplicated, listed with used/refollow flags', async () => {
  const key = (await api('GET', '/api/insta-helper')).j.key; assert.ok(key && key.length >= 20);
  const ing = (body, k = key) => api('POST', '/api/insta-follows/ingest', body, ''); // no login cookie: only the helper key
  const post = (body, k = key) => fetch(base + '/api/insta-follows/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-helper-key': k }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, j: await r.json() }));
  assert.equal((await ing({ text: 'x started following you' })).s, 401);
  assert.equal((await post({ text: 'x started following you' }, 'wrong-key')).s, 401);
  assert.equal((await post({ test: true })).j.ok, true);
  assert.equal((await post({ title: 'Instagram', text: 'Neha_Shah started following you.' })).j.saved, 1);
  assert.equal((await post({ title: 'Instagram', text: 'Neha_Shah started following you.' })).j.saved, 0); // same notification re-posted
  assert.equal((await post({ title: 'karan.p', text: 'started following you.' })).j.saved, 1); // name in the title
  assert.equal((await post({ title: 'Instagram', text: 'amit_1, riya_2 and 3 others started following you' })).j.saved, 2);
  assert.equal((await post({ title: 'Instagram', text: 'John liked your photo' })).j.saved, 0); // other notifications ignored
  const list = (await api('GET', '/api/insta-follows')).j.follows; const names = list.map((f) => f.name);
  for (const n of ['Neha_Shah', 'karan.p', 'amit_1', 'riya_2']) assert.ok(names.includes(n), n);
  assert.equal((await api('GET', '/api/insta-follows', null, '')).s, 401);
  // use the offer for Neha_Shah, then she shows as already used
  const it = items[0];
  assert.equal((await api('POST', '/api/bills', newBill({ items: [{ item_id: it.id, qty: 1 }], customer_phone: '9444444444', insta_handle: 'neha_shah' }))).s, 201);
  const after = (await api('GET', '/api/insta-follows')).j.follows.find((f) => f.name === 'Neha_Shah'); assert.ok(after.used_bill_no);
  assert.equal((await api('GET', '/api/insta-follows')).j.follows.find((f) => f.name === 'karan.p').used_bill_no, '');
  const staff = (await api('GET', '/api/insta-helper', null, 'bm_session=bad')).s; assert.equal(staff, 401);
});
srv.close(); console.log(`\n${n} backend checks passed` + (process.exitCode ? ' — SOME FAILED' : '')); process.exit(process.exitCode || 0);
