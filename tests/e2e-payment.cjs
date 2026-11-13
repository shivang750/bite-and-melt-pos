// Browser check of the WhatsApp "Pay Now" flow against a LOCAL MOCK gateway.
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process'); const http = require('http'); const fs = require('fs'), os = require('os'), path = require('path'); const assert = require('assert');
const PORT = 3191, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-e2ep-')); let n = 0;
const mock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.method === 'POST' ? { id: 'plink_e2e1', short_url: 'https://rzp.io/mock/e2e1' } : { id: 'plink_e2e1', status: 'created', amount: 0, amount_paid: 0 })); }); });
(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const env = { ...process.env, PORT, DATA_DIR: DATA, BM_ADMIN_PASSWORD: 'Secret123', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', PAYMENT_API_BASE: 'http://127.0.0.1:' + mock.address().port };
  const srv = global.__srv = spawn('node', ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env, stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 1500));
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['iPhone 13'] }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); let waUrl = null;
  await ctx.route(/wa\.me/, (r) => { waUrl = r.request().url(); r.fulfill({ status: 200, contentType: 'text/html', body: 'wa' }); });
  await page.goto('http://localhost:' + PORT); await page.fill('input[autocomplete=username]', 'admin'); await page.fill('input[type=password]', 'Secret123'); await page.click('button[type=submit]'); await page.waitForTimeout(1200);
  await page.evaluate(() => { location.hash = '#/bill'; }); await page.waitForTimeout(600);
  await page.click('.item:not(.oos)'); await page.waitForTimeout(200);
  if (await page.locator('.cartbar').isVisible()) await page.click('.cartbar');
  await page.locator('.cart .seg button', { hasText: 'UPI' }).first().click().catch(() => {});
  await page.getByRole('button', { name: /Generate Bill/ }).click(); await page.waitForTimeout(1500);
  await page.getByText('Online payment link ready').waitFor({ timeout: 6000 }).catch(async (e) => { await page.screenshot({ path: '/tmp/claude-0/shots/pay-debug.png' }); throw e; }); n++; console.log('  ✓ online payment link is prepared automatically after the bill is created');
  assert(await page.getByText(/Pending/).first().isVisible()); n++; console.log('  ✓ bill is still Pending (a link alone never marks it paid)');
  page.on('dialog', (d) => { console.log('DIALOG', d.message()); d.dismiss(); }); page.on('console', (m) => console.log('CONSOLE', m.text())); await page.fill('.wa-row input', '98765 43210'); await page.getByRole('button', { name: /Open WhatsApp/ }).click(); await page.waitForTimeout(800);
  if (!waUrl) console.log('ERR TEXT:', await page.locator('.wa-box .err').innerText().catch(()=>'?'), '| note:', await page.locator('.wa-box .muted.small').allInnerTexts()); assert(waUrl, 'wa.me not opened'); const text = decodeURIComponent(waUrl.split('text=')[1]);
  assert(text.includes('Pay Now:* https://rzp.io/mock/e2e1')); assert(/Order No: BM-/.test(text)); assert(/Payment Ref: BM-.*-P1/.test(text)); assert(!/UPI:|@/.test(text.split('Pay Now')[0].split('Payment:')[1] || '')); assert(!text.includes('Pay via UPI'));
  n++; console.log('  ✓ WhatsApp message contains Pay Now link, order number, payment reference and no UPI ID');
  assert.equal(errors.length, 0, errors.join()); n++; console.log('  ✓ no JavaScript errors');
  await b.close(); srv.kill(); mock.close(); console.log(`\nPAYMENT E2E PASSED: ${n} checks`);
})().catch((e) => { console.error('FAILED:', e.message); try { global.__srv && global.__srv.kill(); } catch {} process.exit(1); });
