// End-to-end test in a real Chromium (Playwright). Usage: node tests/e2e.cjs   (server is started by this script)
const { chromium, devices } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const assert = require('assert');
const PORT = 3190, BASE = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-e2e-'));
const results = [];
let srv, browser, page0;
const ok = (name) => { results.push(name); console.log('  ✓ ' + name); };

(async () => {
  srv = spawn('node', ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, BM_ADMIN_PASSWORD: 'Secret123', BM_SEED: 'sample' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], permissions: [] });
  await ctx.addInitScript(() => {
    window.__printed = [];
    window.BiteMeltPrinter = { listPrinters: () => JSON.stringify([{ name: 'MockPrinter 58', address: 'AA:BB:CC:DD:EE:FF' }]), print: (a, b) => { window.__printed.push({ a, b }); return 'OK'; } };
  });
  await ctx.route(/wa\.me|whatsapp\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'wa stub' }));
  const page = page0 = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const toastText = async () => (await page.locator('.toast').allInnerTexts()).join(' | ');
  const go = async (v) => { await page.click(`a[data-v=${v}]`); await page.waitForTimeout(300); };
  const waitIdle = () => page.waitForTimeout(350);

  // ---- login
  await page.goto(BASE);
  await page.fill('input[autocomplete=username]', 'admin'); await page.fill('input[type=password]', 'WRONGpass');
  await page.click('button[type=submit]'); await page.waitForSelector('.err:not(:empty)');
  ok('wrong password rejected with clear message');
  await page.fill('input[type=password]', 'Secret123'); await page.click('button[type=submit]'); await page.waitForSelector('.nav');
  ok('admin login works');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(() => {});

  // ---- settings: UPI id
  await go('settings');
  await page.fill('input[placeholder="yourname@bank"]', 'bitemelt@okaxis');
  await page.click('text=Save UPI settings'); await waitIdle();
  assert.match(await toastText(), /Saved/); ok('UPI ID saved');

  // ---- printer: choose paired printer, test print
  await page.selectOption('.card select >> nth=0', 'native').catch(() => {});
  await page.locator('select', { has: page.locator('option', { hasText: 'MockPrinter 58' }) }).selectOption('AA:BB:CC:DD:EE:FF');
  await page.click('text=Test Print'); await waitIdle();
  const tp = await page.evaluate(() => window.__printed);
  assert.equal(tp.length, 1); assert.equal(tp[0].a, 'AA:BB:CC:DD:EE:FF');
  assert.deepEqual([...Buffer.from(tp[0].b, 'base64').subarray(0, 2)], [0x1b, 0x40]);
  await page.evaluate(() => { window.__printed.length = 0; });
  ok('printer selected & saved; Test Print sends ESC/POS bytes to the paired printer');

  // ---- menu: edit price & verify in new bill
  await go('menu');
  const row = page.locator('.mrow', { hasText: 'Veg Burger' }).first();
  await row.locator('[aria-label=Edit]').click();
  await page.fill('input[placeholder="0.00"]', '70'); await page.click('.modal-actions >> text=Save'); await waitIdle();
  ok('menu price edited (60 -> 70)');

  await go('bill'); await page.waitForSelector('.item');
  const burger = page.locator('.item', { hasText: /^\s*V?e?g Burger/ }).first();
  assert.match(await page.locator('.item', { hasText: 'Veg Burger' }).first().innerText(), /₹70/); ok('new bill shows updated price ₹70');

  // ---- build bill: 2 burgers + 1 cold coffee, change quantities
  const tap = async (name) => { await page.locator('.nb-main .chip', { hasText: /^All$/ }).click(); await page.locator('.item', { hasText: name }).first().click(); };
  await tap('Veg Burger'); await tap('Veg Burger'); await tap('Veg Burger'); await tap('Cold Coffee');
  await page.click('.cartbar'); await page.waitForTimeout(350);
  await page.locator('.cl', { hasText: 'Veg Burger' }).locator('[aria-label=Decrease]').click(); // 3 -> 2
  await page.locator('.cl', { hasText: 'Cold Coffee' }).locator('[aria-label=Increase]').click(); // 1 -> 2
  await page.locator('.cl', { hasText: 'Cold Coffee' }).locator('[aria-label=Decrease]').click(); // 2 -> 1
  let totals = await page.locator('.totals').innerText();
  assert.match(totals, /Subtotal\s*₹220/); assert.match(totals, /TOTAL\s*₹220/); ok('quantity changes recalculate (2×70 + 1×80 = ₹220)');
  // bill discount 10%
  await page.locator('.disc-row .seg button', { hasText: '%' }).click();
  await page.fill('input[aria-label="Bill discount value"]', '10');
  totals = await page.locator('.totals').innerText();
  assert.match(totals, /Bill discount\s*−₹22/); assert.match(totals, /TOTAL\s*₹198/); ok('bill-wise 10% discount => ₹198');
  // item discount on coffee: ₹10 off
  await page.locator('.cl', { hasText: 'Cold Coffee' }).locator('text=Discount').click();
  await page.locator('.modal .seg button', { hasText: '₹' }).click(); await page.fill('.modal input[type=text]', '10'); await page.click('.modal-actions >> text=Apply');
  totals = await page.locator('.totals').innerText();
  assert.match(totals, /Item discounts\s*−₹10/); assert.match(totals, /TOTAL\s*₹189/); ok('item-wise ₹10 discount + 10% bill discount => ₹189 (210 - 10% = 189)');
  await page.fill('input[type=tel]', '12345'); await page.click('text=Generate Bill'); await waitIdle();
  assert.match(await toastText(), /mobile number is not valid/); ok('invalid customer mobile blocked');
  await page.fill('input[type=tel]', '98765 43210'); await page.fill('input[placeholder^="e.g. less"]', 'Less spicy');
  await page.locator('.seg.big button', { hasText: 'UPI' }).click();
  await page.click('text=Generate Bill'); await page.waitForSelector('.billview .qr');
  const modalText = await page.locator('.billview').innerText();
  const billNo = (modalText.match(/Bill (BM-\d{6}-\d{4})/) || [])[1];
  assert.ok(billNo, 'bill number'); assert.match(modalText, /₹189/); assert.match(modalText, /Pending/i);
  ok('bill saved with unique auto number ' + billNo + ' and status PENDING (UPI QR does not mark Paid)');
  assert.ok(!/Paid\b/.test(await page.locator('.bv-badges').innerText())); ok('status badge is Pending, not Paid');

  // ---- QR verification: screenshot & decode
  const qrPng = path.join(DATA, 'qr.png'); await page.locator('.billview .qr').screenshot({ path: qrPng });
  const dec = spawnSync('python3', ['-c', `import cv2,sys\nimg=cv2.imread(sys.argv[1]);img=cv2.resize(img,None,fx=2,fy=2,interpolation=cv2.INTER_NEAREST)\nv,_,_=cv2.QRCodeDetector().detectAndDecode(img);print(v)`, qrPng]);
  const uri = dec.stdout.toString().trim();
  assert.ok(uri.startsWith('upi://pay?'), 'decoded: ' + uri);
  const u = new URL(uri.replace('upi://', 'http://'));
  assert.equal(u.searchParams.get('pa'), 'bitemelt@okaxis'); assert.equal(u.searchParams.get('pn'), 'BITE AND MELT'); assert.equal(u.searchParams.get('am'), '189.00');
  assert.equal(u.searchParams.get('cu'), 'INR'); assert.equal(u.searchParams.get('tr'), billNo.replace(/\W/g, ''));
  ok('scanned QR decodes to UPI link with exact amount ₹189.00, payee, bill-number reference');

  // ---- print via native bridge, verify ESC/POS bytes
  await page.click('text=Print Bill'); await waitIdle();
  const printed = await page.evaluate(() => window.__printed);
  assert.equal(printed.length, 1); const bytes = Buffer.from(printed[0].b, 'base64');
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]); const asText = bytes.toString('latin1');
  assert.ok(asText.includes('BITE AND MELT') && asText.includes(billNo) && asText.includes('PENDING') && asText.includes('Thank You'));
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x76, 0x30])), 'raster image (logo/QR)'); assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0x42])), 'cut');
  const rasterCount = bytes.toString('hex').split('1d763000').length - 1; assert.ok(rasterCount >= 2, 'logo + QR rasters: ' + rasterCount);
  assert.equal(printed[0].a, 'AA:BB:CC:DD:EE:FF');
  ok(`Print Bill sends ESC/POS (init, logo+QR raster, text, cut) to saved printer; ${bytes.length} bytes`);
  // receipt line width <= 32
  const lines = asText.split('\n'); const longest = Math.max(...lines.filter((l) => /^[\x20-\x7e]+$/.test(l)).map((l) => l.length));
  assert.ok(longest <= 32 + 3, 'wrap ' + longest); ok('receipt text wraps within 58mm (32 chars)');

  // ---- WhatsApp
  const phoneInput = page.locator('.wa-row input'); await phoneInput.fill('12345'); await page.waitForTimeout(1200); await page.click('text=Share image');
  assert.match(await page.locator('.wa-box .err').innerText(), /valid 10-digit/); ok('WhatsApp rejects invalid Indian mobile');
  await phoneInput.fill('+91 98765-43210');
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }), page.click('text=Send as text')]);
  const wa = popup.url().startsWith('https://wa.me/') ? popup.url() : await popup.evaluate(() => location.href).catch(() => popup.url());
  await popup.close().catch(() => {});
  assert.ok(wa.startsWith('https://wa.me/919876543210?text='), wa); const msg = decodeURIComponent(wa.split('text=')[1]);
  assert.ok(msg.includes('BITE AND MELT') && msg.includes(billNo) && msg.includes('Total: ₹189') && msg.includes('PENDING') && msg.includes('Veg Burger'));
  assert.match(await page.locator('.wa-box').innerText(), /cannot see whether it was delivered/); ok('WhatsApp click-to-chat URL pre-filled (name, bill no, items, total, status); no delivery claim');

  // ---- WhatsApp receipt IMAGE (phone path: system share sheet with a PNG file; stubbed here because headless Chromium has no share sheet)
  await page.evaluate(() => { window.__shared = null; navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = { n: d.files[0].name, t: d.files[0].type, sz: d.files[0].size, text: d.text, buf: await d.files[0].arrayBuffer() }; }; });
  await page.click('text=Share image'); await page.waitForTimeout(500);
  const sh = await page.evaluate(() => { const s = window.__shared; if (!s) return null; const v = new DataView(s.buf); return { n: s.n, t: s.t, sz: s.sz, text: s.text, sig: v.getUint32(0), w: v.getUint32(16), h: v.getUint32(20) }; });
  assert.ok(sh, 'share sheet was not opened'); assert.equal(sh.t, 'image/png'); assert.equal(sh.n, `Bill-${billNo}.png`); assert.equal(sh.sig, 0x89504e47); assert.equal(sh.w, 768); assert.ok(sh.h > 800 && sh.sz > 10000, `png ${sh.w}x${sh.h} ${sh.sz}`);
  assert.ok(sh.text.includes(billNo) && sh.text.includes('Total: ₹189') && sh.text.includes('PENDING') && !sh.text.includes('Veg Burger'));
  assert.match(await page.locator('.wa-box').innerText(), /Share sheet opened.*cannot see whether it was delivered/s); ok(`WhatsApp receipt image: ${sh.w}x${sh.h} PNG passed to the share sheet with a short caption; no delivery claim`);
  // an invalid number is still refused for the image flow
  await phoneInput.fill('12345'); await page.click('text=Share image'); assert.match(await page.locator('.wa-box .err').innerText(), /valid 10-digit/); await phoneInput.fill('+91 98765-43210'); ok('image flow validates the Indian mobile number');

  // ---- mark paid
  await page.click('text=Mark as Paid (I verified it)'); await page.click('.modal-actions >> text=Mark Paid'); await waitIdle();
  assert.match(await toastText(), /tick the confirmation/i); ok('Mark Paid refuses without the verification tick');
  await page.locator('.modal input[type=checkbox]').check(); await page.click('.modal-actions >> text=Mark Paid'); await waitIdle();
  assert.match(await page.locator('.bv-badges').innerText(), /Paid/); ok('manual verified payment marks bill Paid; QR disappears');
  await page.click('.modal-head .icon-btn');

  // ---- cash bill #2 (default Paid), then price change doesn't alter old bill
  await go('bill'); await tap('Plain Maggi'); await page.click('.cartbar'); await page.waitForTimeout(300);
  await page.click('text=Generate Bill'); await page.waitForSelector('.billview'); const t2 = await page.locator('.billview').innerText();
  assert.match(t2, /₹50/); assert.match(t2, /Paid/); await page.click('.modal-head .icon-btn'); ok('cash bill defaults to Paid');

  // ---- reports
  await go('reports'); await page.waitForSelector('.stat'); await waitIdle();
  const rep = await page.locator('.stats').innerText();
  assert.match(rep, /Total sales\s*₹239/); assert.match(rep, /Total bills\s*2/); assert.match(rep, /Cash collected\s*₹50/); assert.match(rep, /UPI collected\s*₹189/); assert.match(rep, /Total discounts\s*₹31/);
  ok('daily report: sales ₹239, 2 bills, cash ₹50, UPI ₹189, discounts ₹31');
  assert.match(await page.locator('.hbars').first().innerText(), /Veg Burger/); ok('most sold products + category sales shown');
  const csvRes = await page.request.get(`${BASE}/api/reports/export?type=bills`); const csv = await csvRes.text();
  assert.ok(csv.startsWith('﻿Bill No,') && csv.includes(billNo)); ok('CSV export contains bills');

  // ---- price change must not alter old bills
  await go('menu'); await page.locator('.mrow', { hasText: 'Veg Burger' }).first().locator('[aria-label=Edit]').click();
  await page.fill('input[placeholder="0.00"]', '99'); await page.click('.modal-actions >> text=Save'); await waitIdle();
  await go('history'); await page.waitForSelector('.list-row'); await page.fill('input[aria-label="Search bills"]', billNo); await page.waitForTimeout(700);
  await page.locator('.list-row').first().click(); await page.waitForSelector('.billview');
  const old = await page.locator('.paper pre').innerText(); assert.match(old, /2 x 70\.00\s+140\.00/); assert.match(old, /Total|TOTAL\s+Rs\.189\.00/);
  ok('old bill unchanged after menu price change (still 2 x 70.00, total 189.00)');
  await page.click('.bv-actions >> text=Print Bill'); await waitIdle(); assert.equal((await page.evaluate(() => window.__printed)).length, 2); ok('reprint of old bill works');

  // ---- void needs admin password
  await page.click('text=Cancel this bill…');
  await page.fill('input[placeholder^="Reason"]', 'wrong order'); await page.fill('input[placeholder="Admin password"]', 'nope'); await page.click('.modal-actions >> text=Cancel bill'); await waitIdle();
  assert.match(await toastText(), /Admin password is wrong/); ok('void rejected with wrong admin password');
  await page.fill('input[placeholder="Admin password"]', 'Secret123'); await page.click('.modal-actions >> text=Cancel bill'); await waitIdle();
  assert.match(await page.locator('.banner.bad').innerText(), /Cancelled.*wrong order/s); ok('void with admin password keeps a cancelled record');
  await page.click('.modal-head .icon-btn >> nth=0');
  await go('reports'); await page.waitForSelector('.stat'); await waitIdle();
  const rep2 = await page.locator('.stats').innerText(); assert.match(rep2, /Total sales\s*₹50/); assert.match(rep2, /Cancelled bills\s*1/); ok('cancelled bill excluded from sales and counted separately');

  // ---- OFFLINE: reload offline, bill, print, then sync
  await go('bill'); await page.waitForSelector('.item'); await waitIdle();
  await ctx.setOffline(true);
  await page.reload(); await page.waitForSelector('.nav', { timeout: 10000 });
  assert.match(await page.locator('.status').innerText(), /Offline/); ok('app reopens offline from cache (service worker) and shows Offline');
  await page.click('a[data-v=bill]'); await page.waitForSelector('.item');
  await tap('Cold Coffee'); await tap('Cold Coffee'); await page.click('.cartbar'); await page.waitForTimeout(300);
  await page.click('text=Generate Bill'); await page.waitForSelector('.billview');
  const offText = await page.locator('.billview').innerText(); const offNo = (offText.match(/Bill (OFL-[\w-]+)/) || [])[1];
  assert.ok(offNo && /Saved on this device/.test(offText)); ok('offline bill saved locally with number ' + offNo);
  await page.click('.bv-actions >> text=Print Bill'); await waitIdle(); assert.equal((await page.evaluate(() => window.__printed)).length, 1); ok('offline bill prints');
  await page.click('.modal-head .icon-btn');
  const q = await page.evaluate(() => JSON.parse(localStorage.getItem('bm_queue'))); assert.equal(q.length, 1); ok('bill persisted in local queue');
  await page.reload(); await page.waitForSelector('.nav'); assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('bm_queue')))).length, 1); ok('queued bill survives app reload');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('bm_queue') || '[]').length === 0, null, { timeout: 15000 });
  ok('queue syncs automatically when internet returns');
  const all = await (await page.request.get(`${BASE}/api/bills?q=${offNo}`)).json();
  assert.equal(all.total, 1); assert.equal(all.bills[0].grand_total, 16000); assert.equal(all.bills[0].offline, 1); ok('synced bill stored on server with same bill number and total ₹160');
  // duplicate protection: resend same client_id
  const clientId = q[0].client_id; const dup = await page.evaluate(async (p) => { const r = await fetch('/api/bills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); return { s: r.status, j: await r.json() }; }, q[0].payload);
  assert.equal(dup.s, 200); assert.equal(dup.j.duplicate, true); assert.equal((await (await page.request.get(`${BASE}/api/bills?q=${offNo}`)).json()).total, 1); ok('re-sending the same bill does not create a duplicate');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
  ok('no JavaScript errors during the whole run');
  await browser.close(); srv.kill();
  console.log(`\nE2E PASSED: ${results.length} checks`);
  fs.rmSync(DATA, { recursive: true, force: true });
})().catch(async (e) => { console.error('\nE2E FAILED:', e.message); try { if (page0) { await page0.screenshot({ path: path.join(os.tmpdir(), 'e2e-fail.png') }); console.error(await page0.evaluate(() => { const a = document.querySelector('a[data-v=menu]'); const r = a.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return JSON.stringify({ r: [r.x, r.y, r.width, r.height], vw: innerWidth, vh: innerHeight, sy: scrollY, hit: e && (e.className + ' ' + e.tagName), body: document.body.className }); }).catch(() => '')); } } catch {} try { srv && srv.kill(); await browser?.close(); } catch {} try { console.error(e.stack.split('\n').slice(1, 4).join('\n')); } catch {} process.exit(1); });
