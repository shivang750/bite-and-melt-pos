import { h, icon, btn, modal, toast, field, segmented, resizeImage, confirmDialog, badge, downloadBlob } from '../ui.js';
import { inr, renderBillNo, isValidVpa, parseRupees } from '../calc.js';
import { get, post, put, del } from '../api.js';
import { state, ls, savePrinterPrefs, printerPrefs, refreshMenu, clearLocalSession } from '../store.js';
import { hasNative, hasWebBluetooth, isAndroid, nativePrinters, blePair, testPrint, resolveTransport } from '../printer.js';
import { qrSvg, upiUri } from '../qr.js';
import { svgDataUrl, LOGO_COLOR } from '../logo.js';

export function mount(root, go) {
  const isAdmin = state.user.role === 'admin';
  const page = h('div', { class: 'page' }, h('h1', null, 'Settings'));
  root.replaceChildren(page);
  const card = (title, ...kids) => { const c = h('section', { class: 'card' }, h('h3', null, title), ...kids); page.append(c); return c; };
  const save = async (patch, msg = 'Saved') => { try { const r = await put('/api/settings', patch); state.settings = r.settings; await refreshMenu(); toast(msg, 'ok'); return true; } catch (e) { toast(e.message, 'error'); return false; } };
  const S = state.settings;

  // ---- account
  card('My account', h('div', { class: 'muted' }, `Signed in as ${state.user.username} (${state.user.role})`),
    h('div', { class: 'row-gap' }, btn('Change password', { cls: 'ghost', onclick: () => changePasswordModal() }), btn('Log out', { cls: 'ghost', ic: 'logout', onclick: async () => { await post('/api/logout').catch(() => {}); clearLocalSession(); location.hash = ''; location.reload(); } })));

  // ---- printer
  const p = printerPrefs();
  const pStatus = h('div', { class: 'muted small' });
  const pBox = h('div');
  const savePrefs = (patch) => { Object.assign(p, patch); savePrinterPrefs(p); drawPrinter(); };
  function drawPrinter() {
    const t = resolveTransport(p);
    const opts = [['auto', 'Automatic']];
    if (hasNative()) opts.push(['native', 'Android app (direct)']);
    opts.push(['rawbt', 'RawBT (Android)'], ['ble', 'Web Bluetooth (BLE)'], ['browser', 'Browser print']);
    const sel = h('select', { onchange: (e) => savePrefs({ transport: e.target.value }) }, opts.map(([v, l]) => h('option', { value: v, selected: (p.transport || 'auto') === v }, l)));
    const info = {
      native: 'Direct classic-Bluetooth printing through the BITE AND MELT Android app.',
      rawbt: 'Prints through the free RawBT app. Install RawBT once from Google Play, pair your printer in Android Bluetooth settings, then choose it inside RawBT (Bluetooth > your printer). Works with almost every 58mm Bluetooth printer.',
      ble: 'Connects straight from Chrome. Only works with BLE (Bluetooth Low Energy) printers. Older “SPP/classic” printers will not appear - use RawBT for those.',
      browser: 'Uses the normal browser print dialog. This is NOT ESC/POS thermal printing and is only a fallback.',
    }[t];
    const devs = [];
    if (t === 'native') {
      const list = nativePrinters();
      devs.push(field('Paired Bluetooth printer', h('select', { onchange: (e) => { const d = list.find((x) => x.address === e.target.value); savePrefs({ native_address: d?.address || '', native_name: d?.name || '' }); } },
        h('option', { value: '' }, list.length ? '— choose a printer —' : '— no paired printers found —'), list.map((d) => h('option', { value: d.address, selected: d.address === p.native_address }, `${d.name} (${d.address})`)))),
        h('div', { class: 'muted small' }, 'Not listed? Pair the printer in Android Settings > Bluetooth first (PIN usually 0000 or 1234), then come back.'));
    }
    if (t === 'ble') {
      devs.push(h('div', { class: 'wa-row' }, h('div', null, h('b', null, p.ble_name || 'No printer selected')), btn(p.ble_name ? 'Choose another' : 'Find printer', { cls: 'sky', ic: 'search', onclick: async () => {
        try { const d = await blePair(); savePrefs({ ble_id: d.id, ble_name: d.name }); toast('Selected ' + d.name, 'ok'); } catch (e) { if (e.name !== 'NotFoundError') toast(e.message, 'error'); } } })));
      if (!hasWebBluetooth()) devs.push(h('div', { class: 'banner warn tight' }, 'This browser does not support Web Bluetooth. Use Chrome on Android, or switch to RawBT.'));
    }
    if (t === 'rawbt') devs.push(h('div', { class: 'row-gap' }, h('a', { class: 'btn ghost', href: 'https://play.google.com/store/apps/details?id=ru.a402d.rawbtprinter', target: '_blank', rel: 'noopener' }, 'Get RawBT'), isAndroid() ? null : h('span', { class: 'muted small' }, 'RawBT is for Android devices.')));
    pBox.replaceChildren(
      field('How to print', sel), h('div', { class: 'muted small' }, info), ...devs,
      field('Paper width', segmented([[58, '58 mm (32 chars)'], [80, '80 mm (48 chars)']], Number(p.paper) || 58, (v) => savePrefs({ paper: v }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.bold !== false, onchange: (e) => savePrefs({ bold: e.target.checked }) }), h('span', null, 'Dark text (bold)')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.print_logo !== false, onchange: (e) => savePrefs({ print_logo: e.target.checked }) }), h('span', null, 'Print logo on receipt')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.cut !== false, onchange: (e) => savePrefs({ cut: e.target.checked }) }), h('span', null, 'Cut paper after printing (ignored by printers without a cutter)')),
      t !== 'rawbt' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!p.auto_print, onchange: (e) => savePrefs({ auto_print: e.target.checked }) }), h('span', null, 'Print automatically after generating a bill')) : null,
      h('div', { class: 'row-gap' }, btn('Test Print', { cls: 'primary', ic: 'print', onclick: async () => { try { toast(await testPrint(), 'info'); } catch (e) { toast('Test print failed: ' + e.message, 'error'); } } })),
      pStatus);
  }
  card('Bluetooth printer', pBox); drawPrinter();
  if (hasNative() && window.BiteMeltPrinter.changeServer) card('Android app', h('div', { class: 'row-gap' }, btn('Change POS server address', { cls: 'ghost', onclick: () => window.BiteMeltPrinter.changeServer() })));

  if (!isAdmin) return () => {};

  // ---- cafe details
  const f = (k, label, o = {}) => { const el = o.area ? h('textarea', { rows: 2, maxlength: o.max || 200, value: S[k] }) : h('input', { type: 'text', maxlength: o.max || 80, value: S[k] ?? '', placeholder: o.ph || '' }); el._k = k; return [field(label, el, o.hint), el]; };
  const [fName, iName] = f('cafe_name', 'Cafe name'), [fAddr, iAddr] = f('address', 'Address', { area: true }), [fPhone, iPhone] = f('phone', 'Contact number', { ph: '98XXXXXXXX' }),
    [fFoot, iFoot] = f('footer', 'Receipt footer message', { max: 100 }), [fCur, iCur] = f('currency', 'Currency symbol', { max: 3, hint: 'Amounts are always Indian Rupees. Receipts print “Rs.” because most thermal printers cannot print ₹.' });
  const logoPrev = h('div', { class: 'img-prev' });
  let logo = S.logo || '';
  const drawLogo = () => logoPrev.replaceChildren(h('img', { src: logo || svgDataUrl(LOGO_COLOR), alt: 'Logo', width: 96, height: 96 }), logo ? btn('Use default logo', { cls: 'link danger-text', onclick: () => { logo = ''; drawLogo(); } }) : h('span', { class: 'muted small' }, 'Default BITE AND MELT logo'));
  drawLogo();
  const logoFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: async (e) => { const fl = e.target.files[0]; if (!fl) return; try { const d = await resizeImage(fl, 400, true); const r = await post('/api/upload', { data: d }); logo = r.url; drawLogo(); } catch (err) { toast(err.message, 'error'); } } });
  card('Cafe details & logo', fName, fAddr, fPhone, fFoot, fCur, field('Cafe logo (shown in the app and printed on receipts)', logoFile, 'Use a simple, high-contrast image - thermal printers print in black & white.'), logoPrev,
    btn('Save cafe details', { cls: 'primary', onclick: () => save({ cafe_name: iName.value, address: iAddr.value, phone: iPhone.value, footer: iFoot.value, currency: iCur.value, logo }) }));

  // ---- UPI
  const upi = h('input', { type: 'text', value: S.upi_id, placeholder: 'yourname@bank', autocapitalize: 'none', autocomplete: 'off' });
  const payee = h('input', { type: 'text', value: S.payee_name, maxlength: 50 });
  const ref = h('input', { type: 'text', value: S.upi_ref, maxlength: 30, placeholder: 'e.g. BiteMelt' });
  const qrBox = h('div', { class: 'center' });
  card('UPI payments', field('UPI ID / VPA', upi, 'Money from scanned QR codes goes to this ID. Double-check it.'), field('Payee name', payee), field('Payment reference (optional)', ref, 'Added in front of the bill number in the payment note.'),
    h('div', { class: 'row-gap' }, btn('Save UPI settings', { cls: 'primary', onclick: () => { if (upi.value.trim() && !isValidVpa(upi.value)) return toast('UPI ID looks wrong. Example: name@okaxis', 'error'); save({ upi_id: upi.value.trim(), payee_name: payee.value, upi_ref: ref.value }); } }),
      btn('Preview test QR (₹1)', { cls: 'ghost', ic: 'qr', onclick: () => { if (!isValidVpa(upi.value)) return toast('Enter a valid UPI ID first', 'error'); qrBox.replaceChildren(h('img', { class: 'qr', width: 200, height: 200, alt: 'Test QR', src: svgDataUrl(qrSvg(upiUri({ vpa: upi.value.trim(), name: payee.value, amountPaise: 100, billNo: 'TEST0001' }), 200)) }), h('div', { class: 'muted small' }, 'Scan to check the payee name shows correctly. Do not pay.')); } })),
    qrBox);

  // ---- billing
  const gstOn = h('input', { type: 'checkbox', checked: S.gst_enabled }), gstRate = h('input', { type: 'text', inputmode: 'decimal', value: S.gst_rate, maxlength: 5 }), gstNo = h('input', { type: 'text', value: S.gst_number, maxlength: 20, placeholder: '24XXXXXXXXXXXXX' });
  let gstMode = S.gst_mode; const gstModeEl = h('div'); const drawGm = () => gstModeEl.replaceChildren(segmented([['exclusive', 'Added on top'], ['inclusive', 'Included in prices']], gstMode, (v) => { gstMode = v; drawGm(); })); drawGm();
  const ro = h('input', { type: 'checkbox', checked: S.round_off });
  const fmt = h('input', { type: 'text', value: S.bill_format, maxlength: 40 }); const fmtPrev = h('div', { class: 'muted small' }); const upd = () => { fmtPrev.textContent = 'Example: ' + renderBillNo(fmt.value, new Date(), 7); }; fmt.oninput = upd; upd();
  card('Billing: GST, round-off & bill numbers',
    h('label', { class: 'check' }, gstOn, h('span', null, 'Charge GST on bills (off by default)')), field('GST rate %', gstRate), field('GST treatment', gstModeEl), field('GSTIN (printed on receipts)', gstNo),
    h('label', { class: 'check' }, ro, h('span', null, 'Round the total to the nearest rupee')),
    field('Bill number format', fmt, 'Tokens: {YYMMDD} {YYYY} {MM} {DD} {SEQ4} (4-digit counter; it restarts every day when a date token is used)'), fmtPrev,
    btn('Save billing settings', { cls: 'primary', onclick: () => save({ gst_enabled: gstOn.checked, gst_rate: gstRate.value, gst_mode: gstMode, gst_number: gstNo.value, round_off: ro.checked, bill_format: fmt.value }) }));

  // ---- users
  const usersBox = h('div');
  async function drawUsers() {
    try {
      const { users } = await get('/api/users');
      usersBox.replaceChildren(h('div', { class: 'list' }, users.map((u) => h('div', { class: 'mrow' + (u.active ? '' : ' dim') }, h('div', { class: 'mrow-main' }, h('b', null, u.username), ' ', badge(u.role, u.role === 'admin' ? 'info' : ''), u.active ? null : badge('Disabled', 'bad')),
        h('div', { class: 'mrow-tools' }, btn('Reset password', { cls: 'link', onclick: () => resetPw(u) }),
          u.id !== state.user.id ? btn(u.active ? 'Disable' : 'Enable', { cls: 'link ' + (u.active ? 'danger-text' : ''), onclick: async () => { try { await put('/api/users/' + u.id, { active: !u.active }); drawUsers(); } catch (e) { toast(e.message, 'error'); } } }) : null)))));
    } catch (e) { usersBox.replaceChildren(h('div', { class: 'muted' }, e.message)); }
  }
  function addUser() {
    const un = h('input', { type: 'text', maxlength: 30, autocapitalize: 'none' }), fn = h('input', { type: 'text', maxlength: 60 }), pw = h('input', { type: 'text', placeholder: 'min 8 characters', autocomplete: 'off' });
    let role = 'staff'; const roleEl = h('div'); const drawR = () => roleEl.replaceChildren(segmented([['staff', 'Staff (billing only)'], ['admin', 'Admin']], role, (v) => { role = v; drawR(); })); drawR();
    const m = modal({ title: 'Add user', body: h('div', null, field('Username', un), field('Full name', fn), field('Temporary password', pw), field('Role', roleEl)), actions: [btn('Cancel', { cls: 'ghost', onclick: () => m.close() }), btn('Create', { cls: 'primary', onclick: async () => { try { await post('/api/users', { username: un.value, full_name: fn.value, password: pw.value, role }); m.close(); drawUsers(); toast('User created. They must change the password at first login.', 'ok'); } catch (e) { toast(e.message, 'error'); } } })] });
  }
  function resetPw(u) {
    const pw = h('input', { type: 'text', placeholder: 'new temporary password', autocomplete: 'off' });
    const m = modal({ title: 'Reset password: ' + u.username, body: field('New temporary password (min 8)', pw), actions: [btn('Cancel', { cls: 'ghost', onclick: () => m.close() }), btn('Reset', { cls: 'primary', onclick: async () => { try { await put('/api/users/' + u.id, { password: pw.value }); m.close(); toast('Password reset. They will be asked to choose a new one.', 'ok'); } catch (e) { toast(e.message, 'error'); } } })] });
  }
  card('Staff accounts', usersBox, btn('Add user', { cls: 'sky', ic: 'plus', onclick: addUser })); drawUsers();

  // ---- backup
  card('Backup & data', h('p', { class: 'muted' }, 'Your data lives on the server in one database file. The server also keeps automatic daily backups (last 30). Download a copy regularly and keep it somewhere safe (Google Drive, email to yourself).'),
    h('a', { class: 'btn ghost', href: '/api/backup', download: '' }, icon('download', 20), h('span', null, 'Download full backup (.db)')));
  return () => {};
}

export function changePasswordModal(forced = false) {
  return new Promise((resolve) => {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const m = modal({ title: forced ? 'Choose a new password' : 'Change password', body: h('div', null, forced ? h('p', null, 'For security, please replace the temporary password before you start.') : null, field('Current password', cur), field('New password (min 8 characters)', n1), field('Repeat new password', n2)),
      onClose: () => resolve(false),
      actions: [forced ? null : btn('Cancel', { cls: 'ghost', onclick: () => m.close() }), btn('Save password', { cls: 'primary', onclick: async () => {
        if (n1.value !== n2.value) return toast('The new passwords do not match', 'error');
        try { await post('/api/change-password', { current_password: cur.value, new_password: n1.value }); toast('Password changed', 'ok'); resolve(true); if (forced) m.close(); else m.close(); } catch (e) { toast(e.message, 'error'); } } })] });
    if (forced) { m.el.parentElement.onmousedown = null; m.el.querySelector('.icon-btn').style.display = 'none'; }
  });
}
