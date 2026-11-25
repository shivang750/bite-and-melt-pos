// Browser check: Instagram 10% offer (once only) and editing a saved bill.
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path'); const assert = require('assert');
const PORT = 3192, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-e2ei-')); let n = 0;
const ok = (m) => { n++; console.log('  ✓ ' + m); };
(async () => {
  const srv = spawn('node', ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, BM_ADMIN_PASSWORD: 'Secret123', BM_SEED: 'sample' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'] }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto('http://localhost:' + PORT); await page.fill('input[autocomplete=username]', 'admin'); await page.fill('input[type=password]', 'Secret123'); await page.click('button[type=submit]'); await page.waitForSelector('.nav');
    await page.evaluate(() => { location.hash = '#/bill'; }); await page.waitForTimeout(500);
    const openCart = async () => { if (await page.locator('.cartbar').isVisible() && !(await page.locator('.cart.open').count())) await page.click('.cartbar'); };
    const addItem = async (i = 0) => { await page.locator('.chips .chip', { hasText: 'All' }).click(); await page.locator('.item:not(.oos)').nth(i).click(); };
    await addItem(0); await openCart();
    const total = async () => (await page.locator('.totals .grand span').last().innerText()).replace(/[^\d.]/g, '');
    const full = Number(await total());
    // no mobile -> refused
    await page.fill('input[aria-label="Customer Instagram username"]', '@Test_User'); await page.getByRole('button', { name: /Check & apply/ }).click(); await page.waitForTimeout(300);
    assert((await page.locator('.toast').allInnerTexts()).join(' ').includes('mobile')); ok('Instagram offer asks for the mobile number first');
    await page.fill('input[type=tel]', '9876543210');
    await page.getByRole('button', { name: /Check & apply/ }).click(); await page.waitForSelector('.insta-on');
    assert.equal(Number(await total()), Math.round(full * 0.9)); ok(`Instagram offer applied: ₹${full} -> ₹${await total()} (10% off)`);
    assert.equal(await page.locator('.chip', { hasText: '15%' }).count(), 0); ok('other discount buttons are hidden while the offer is on');
    await page.getByRole('button', { name: /Generate Bill/ }).click(); await page.waitForSelector('.billview');
    assert((await page.locator('.paper pre').textContent()).includes('Instagram offer: @test_user')); ok('printed bill shows "Instagram offer: @test_user"');
    // edit the bill
    await page.getByRole('button', { name: /Edit bill/ }).click(); await page.waitForSelector('text=Editing bill');
    await page.waitForTimeout(300); await page.click('.sheet-close'); await addItem(1); await openCart();
    assert(await page.locator('.insta-on').count()); ok('edit screen opens the saved bill with its items and offer');
    await page.getByRole('button', { name: /Save changes/ }).click(); await page.waitForSelector('.billview');
    assert((await page.locator('.modal-head h2').innerText()).includes('updated')); assert(await page.locator('text=/Edited 1 time/').count()); ok('bill edited: item added, saved, marked "Edited 1 time"');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    // second bill, same person tries again
    await addItem(0); await openCart();
    await page.fill('input[type=tel]', '9000000001'); await page.fill('input[aria-label="Customer Instagram username"]', 'TEST_USER');
    await page.getByRole('button', { name: /Check & apply/ }).click(); await page.waitForSelector('text=Offer already used');
    assert((await page.locator('.modal .banner.bad').innerText()).includes('already used')); ok('same Instagram username again is refused with the earlier bill number');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    // helper app sends a follow notification -> name appears as a tap chip -> tap applies the offer
    await page.evaluate(async () => { const k = (await (await fetch('/api/insta-helper')).json()).key; await fetch('/api/insta-follows/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-helper-key': k }, body: JSON.stringify({ title: 'Instagram', text: 'neha_fresh started following you.' }) }); });
    await page.evaluate(() => { location.hash = '#/dashboard'; }); await page.waitForTimeout(300); await page.evaluate(() => { location.hash = '#/bill'; }); await page.waitForTimeout(600);
    await page.locator('.cart.open .sheet-close').click().catch(() => {});
    await addItem(0); await openCart(); await page.fill('input[type=tel]', '9555555555');
    await page.locator('.follows .chip', { hasText: 'neha_fresh' }).click(); await page.waitForSelector('.insta-on');
    assert((await page.locator('.insta-on').innerText()).includes('@neha_fresh')); ok('follower name from the helper shows as a chip; tapping it applies the 10% offer');
    assert.equal(errors.length, 0, errors.join('|')); ok('no JavaScript errors');
    console.log(`\nINSTA E2E PASSED: ${n} checks`);
  } catch (e) { await page.screenshot({ path: path.join(os.tmpdir(), 'insta-fail.png') }).catch(() => {}); console.error('INSTA E2E FAILED:', e.message); process.exitCode = 1; }
  await b.close(); srv.kill(); process.exit(process.exitCode || 0);
})();
