import { h, icon, btn, modal, toast, field, segmented, uuid, debounce } from '../ui.js';
import { computeBill, inr, parseRupees, plain, fmtDateTime, normalizeIndianMobile, MAX_QTY } from '../calc.js';
import { state, ls, saveBill, onChange, printerPrefs } from '../store.js';
import { LOGO_COLOR, svgDataUrl } from '../logo.js';
import { showBill, doPrint } from './billview.js';
import { resolveTransport } from '../printer.js';
import { get, post, qs, NetworkError } from '../api.js';

const emptyCart = () => ({ lines: [], order_type: 'dine_in', notes: '', customer_name: '', customer_phone: '', bill_disc_type: 'none', bill_disc_value: '', payment_method: 'cash', payment_status: 'paid', verified: false, client_id: uuid(), insta_handle: '', insta_phone: '', editing: null });

export function mount(root) {
  let cart = { ...emptyCart(), ...ls.get('bm_cart', {}) };
  if (!cart.client_id) cart.client_id = uuid();
  let q = '', cat = (state.categories.find((c) => c.visible) || {}).id ?? 'all', saving = false;
  const persist = () => ls.set('bm_cart', cart);

  const priceOf = (l) => { if (l.locked) return l.price; const it = state.items.find((i) => i.id === l.item_id); return it ? it.price : l.price; };
  const calc = () => computeBill(cart.lines.map((l) => ({ price: priceOf(l), qty: l.qty, discType: l.disc_type, discValue: l.disc_value })), {
    billDiscType: cart.bill_disc_type, billDiscValue: cart.bill_disc_type === 'amount' ? (parseRupees(cart.bill_disc_value) ?? 0) : Number(cart.bill_disc_value) || 0,
    gst: { enabled: state.settings.gst_enabled, rate: state.settings.gst_rate, mode: state.settings.gst_mode }, roundOff: state.settings.round_off });

  // ---- elements
  const clock = h('span', { class: 'clock' });
  const tick = () => { clock.textContent = fmtDateTime(new Date().toISOString()); };
  tick(); const clockT = setInterval(tick, 10000);
  const search = h('input', { type: 'search', placeholder: 'Search items…', 'aria-label': 'Search items', oninput: debounce((e) => { q = e.target.value.trim().toLowerCase(); renderItems(); }, 120) });
  const chips = h('div', { class: 'chips wrap' });
  const grid = h('div', { class: 'item-grid' });
  const cartEl = h('aside', { class: 'cart' });
  const bar = h('button', { class: 'cartbar', type: 'button', onclick: () => cartEl.classList.add('open') });
  const ui = h('div', { class: 'nb' },
    h('section', { class: 'nb-main' }, h('div', { class: 'nb-top' }, h('div', { class: 'searchbox' }, icon('search', 20), search), clock), chips, grid),
    cartEl, bar);
  root.replaceChildren(ui);

  // ---- recent Instagram followers (sent by the Android helper app); tap a name to use it
  let instaInpRef = null, follows = [];
  const followsEl = h('div', { class: 'follows' });
  const ago = (iso) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 1 ? 'now' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h'; };
  function drawFollows() {
    if (!follows.length) { followsEl.replaceChildren(); return; }
    followsEl.replaceChildren(h('div', { class: 'muted small' }, 'Recently followed (tap the customer\'s name):'),
      h('div', { class: 'chips wrap' }, follows.slice(0, 12).map((f) => h('button', { type: 'button', class: 'chip' + (f.used_bill_no ? ' used' : ''),
        title: f.used_bill_no ? `Offer already used on bill ${f.used_bill_no}` : f.times > 1 ? `Followed ${f.times} times (unfollow and follow again?)` : '',
        onclick: () => { if (instaInpRef) instaInpRef.value = f.name; applyInsta(f.name); } },
        (f.used_bill_no ? '⚠ ' : f.times > 1 ? '↻ ' : '') + f.name + ' · ' + ago(f.seen_at)))));
  }
  async function loadFollows() { try { follows = (await get('/api/insta-follows')).follows || []; drawFollows(); } catch { /* offline: just keep the old list */ } }
  const followsT = setInterval(loadFollows, 20000);

  // ---- edit an already saved bill (opened from the bill screen)
  function loadEdit() {
    const b = ls.get('bm_edit_bill', null);
    if (!b) return;
    ls.del('bm_edit_bill');
    cart = { ...emptyCart(), editing: { id: b.id, bill_no: b.bill_no }, order_type: b.order_type, customer_name: b.customer_name || '', customer_phone: b.customer_phone || '', notes: b.notes || '',
      bill_disc_type: b.insta_handle ? 'percent' : b.bill_disc_type, bill_disc_value: b.insta_handle ? '10' : b.bill_disc_type === 'amount' ? plain(b.bill_disc_value) : b.bill_disc_type === 'percent' ? String(b.bill_disc_value) : '',
      insta_handle: b.insta_handle || '', insta_phone: b.insta_handle ? (b.customer_phone || '') : '', payment_method: b.payment_method, payment_status: b.payment_status, verified: true,
      lines: b.items.map((it) => ({ item_id: it.item_id, name: it.name, category: it.category || '', qty: it.qty, price: it.price, disc_type: it.disc_type, disc_value: it.disc_value, locked: true })) };
    cartEl.classList.add('open');
    changed(true);
  }
  async function applyInsta(raw) {
    const phone = normalizeIndianMobile(cart.customer_phone);
    if (!phone) { toast("First enter the customer's 10-digit mobile number", 'error'); return; }
    const handle = String(raw || '').trim().toLowerCase().replace(/^@+/, '');
    if (!handle) { toast('Enter the Instagram username', 'error'); return; }
    try {
      const r = await get('/api/insta-offer/check?' + qs({ handle, phone, except: cart.editing ? cart.editing.id : '' }));
      if (!r.ok) { const mm = modal({ title: 'Offer already used', body: h('div', { class: 'banner bad' }, r.message), actions: [btn('OK', { cls: 'primary', onclick: () => mm.close() })] }); return; }
      cart.insta_handle = r.handle; cart.insta_phone = phone; cart.bill_disc_type = 'percent'; cart.bill_disc_value = String(r.percent);
      changed(); toast('Instagram offer applied: 10% off', 'ok');
    } catch (e) { toast(e instanceof NetworkError ? 'No internet: the Instagram offer cannot be checked offline' : e.message, 'error'); }
  }
  function removeInsta() { cart.insta_handle = ''; cart.insta_phone = ''; cart.bill_disc_type = 'none'; cart.bill_disc_value = ''; changed(); }
  const onEditEvent = () => loadEdit();
  window.addEventListener('bm-edit-bill', onEditEvent);

  function renderChips() {
    chips.replaceChildren(
      ...state.categories.filter((c) => c.visible).map((c) => h('button', { class: 'chip' + (cat === c.id ? ' on' : ''), onclick: () => { cat = c.id; renderChips(); renderItems(); } }, c.name)),
      h('button', { class: 'chip' + (cat === 'all' ? ' on' : ''), onclick: () => { cat = 'all'; renderChips(); renderItems(); } }, 'All'));
  }
  function renderItems() {
    const vis = new Set(state.categories.filter((c) => c.visible).map((c) => c.id));
    const items = state.items.filter((i) => i.visible && (i.category_id == null || vis.has(i.category_id)) && (cat === 'all' || q || i.category_id === cat) && (!q || i.name.toLowerCase().includes(q)));
    grid.replaceChildren(...(items.length ? items.map(itemCard) : [h('div', { class: 'empty' }, state.items.length ? 'No items match.' : 'No menu items yet. An admin can add items in Menu Management.')]));
  }
  function itemCard(it) {
    const inCart = cart.lines.find((l) => l.item_id === it.id);
    return h('button', { class: 'item' + (it.available ? '' : ' oos'), type: 'button', disabled: !it.available, onclick: () => add(it), 'aria-label': `${it.name} ${inr(it.price)}${it.available ? '' : ' out of stock'}` },
      it.image ? h('img', { src: it.image, alt: '', loading: 'lazy' }) : h('div', { class: 'ph', 'aria-hidden': 'true' }, icon('menu', 44)),
      h('div', { class: 'item-name' }, it.name), h('div', { class: 'item-price' }, inr(it.price)),
      !it.available ? h('span', { class: 'oos-tag' }, 'Out of stock') : null,
      inCart ? h('span', { class: 'qty-tag' }, '×' + inCart.qty) : null);
  }

  function add(it) {
    const l = cart.lines.find((x) => x.item_id === it.id);
    if (l) { if (l.qty < MAX_QTY) l.qty++; }
    else {
      const catName = state.categories.find((c) => c.id === it.category_id)?.name || '';
      cart.lines.push({ item_id: it.id, name: it.name, category: catName, price: it.price, qty: 1, disc_type: 'none', disc_value: 0 });
    }
    changed(true);
  }
  function setQty(l, n) { if (n <= 0) cart.lines = cart.lines.filter((x) => x !== l); else l.qty = Math.min(MAX_QTY, n); changed(true); }
  function changed(items) { persist(); renderCart(); if (items) renderItems(); }

  function discountModal(l) {
    let type = l.disc_type, val = l.disc_type === 'amount' ? plain(l.disc_value) : l.disc_type === 'percent' ? String(l.disc_value) : '';
    const inp = h('input', { type: 'text', inputmode: 'decimal', value: val, placeholder: '0' });
    const seg = h('div');
    const draw = () => seg.replaceChildren(segmented([['none', 'None'], ['percent', '%'], ['amount', '₹']], type, (v) => { type = v; draw(); }));
    draw();
    const m = modal({ title: 'Discount: ' + l.name, body: h('div', null, seg, field('Value', inp)),
      actions: [btn('Cancel', { cls: 'ghost', onclick: () => m.close() }), btn('Apply', { cls: 'primary', onclick: () => {
        if (type === 'none') { l.disc_type = 'none'; l.disc_value = 0; }
        else if (type === 'percent') { const p = Number(inp.value); if (!(p > 0 && p <= 100)) { toast('Enter a percentage between 0 and 100', 'error'); return; } l.disc_type = 'percent'; l.disc_value = p; }
        else { const r = parseRupees(inp.value); if (r == null || r <= 0) { toast('Enter a valid rupee amount', 'error'); return; } l.disc_type = 'amount'; l.disc_value = r; }
        m.close(); changed(); } })] });
  }

  function renderCart() {
    const c = calc(), s = state.settings;
    const count = cart.lines.reduce((n, l) => n + l.qty, 0);
    bar.replaceChildren(icon('cart', 22), h('span', { class: 'cb-count' }, count + (count === 1 ? ' item' : ' items')), h('span', { class: 'cb-total' }, inr(c.grandTotal)), h('span', { class: 'cb-go' }, 'Review & Pay'));
    bar.classList.toggle('empty', !count);

    const phoneOk = !cart.customer_phone.trim() || normalizeIndianMobile(cart.customer_phone);
    const lines = cart.lines.length ? cart.lines.map((l, i) => h('div', { class: 'cl' },
      h('div', { class: 'cl-main' },
        h('div', { class: 'cl-name' }, l.name),
        h('div', { class: 'muted small' }, `${inr(priceOf(l))} each`, c.lines[i].disc ? h('span', { class: 'good-text' }, `  −${inr(c.lines[i].disc)}`) : null)),
      h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Decrease', onclick: () => setQty(l, l.qty - 1) }, icon('minus', 18)),
        h('span', { class: 'qn' }, l.qty), h('button', { type: 'button', 'aria-label': 'Increase', onclick: () => setQty(l, l.qty + 1) }, icon('plus', 18))),
      h('div', { class: 'cl-amt' }, inr(c.lines[i].net)),
      h('div', { class: 'cl-tools' }, h('button', { class: 'link', type: 'button', onclick: () => discountModal(l) }, l.disc_type === 'none' ? 'Discount' : 'Edit discount'),
        h('button', { class: 'link danger-text', type: 'button', onclick: () => setQty(l, 0) }, icon('trash', 16), ' Remove'))))
      : [h('div', { class: 'empty small' }, 'Tap items to add them to the bill.')];

    const discInput = h('input', { type: 'text', inputmode: 'decimal', placeholder: cart.bill_disc_type === 'percent' ? '10' : '0', value: cart.bill_disc_value, disabled: cart.bill_disc_type === 'none', 'aria-label': 'Bill discount value',
      oninput: (e) => { cart.bill_disc_value = e.target.value; persist(); renderTotals(); } });
    const instaInp = instaInpRef = h('input', { type: 'text', placeholder: '@username', autocapitalize: 'none', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Customer Instagram username' });
    const totals = h('div', { class: 'totals' });
    function renderTotals() {
      const cc = calc();
      totals.replaceChildren(
        row('Subtotal', inr(cc.subtotal)),
        cc.itemDiscount ? row('Item discounts', '−' + inr(cc.itemDiscount), 'good-text') : null,
        cc.billDiscount ? row('Bill discount', '−' + inr(cc.billDiscount), 'good-text') : null,
        cc.tax ? row(`GST ${s.gst_rate}%${s.gst_mode === 'inclusive' ? ' (incl.)' : ''}`, inr(cc.tax)) : null,
        cc.roundOff ? row('Round off', (cc.roundOff > 0 ? '+' : '−') + inr(Math.abs(cc.roundOff))) : null,
        h('div', { class: 'row grand' }, h('span', null, 'TOTAL'), h('span', null, inr(cc.grandTotal))));
      bar.querySelector('.cb-total') && (bar.querySelector('.cb-total').textContent = inr(cc.grandTotal));
      goBtn.disabled = saving || !cart.lines.length;
    }
    const row = (a, b, cls = '') => h('div', { class: 'row ' + cls }, h('span', null, a), h('span', null, b));

    const goBtn = h('button', { class: 'btn primary xl', type: 'button', onclick: generate }, icon('check', 22), h('span', null, saving ? 'Saving…' : cart.editing ? 'Save changes' : 'Generate Bill'));
    const payNote = cart.payment_method === 'upi' && cart.payment_status === 'paid'
      ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cart.verified, onchange: (e) => { cart.verified = e.target.checked; persist(); } }), h('span', null, 'I have verified this UPI payment in my UPI / bank app'))
      : cart.payment_method === 'upi' ? h('div', { class: 'muted small' }, 'A QR for the exact amount will be shown after you generate the bill. It stays Pending until you confirm payment.') : null;

    cartEl.replaceChildren(
      h('div', { class: 'cart-head' }, h('h2', null, 'Current Bill'), h('div', { class: 'row-gap' },
        cart.lines.length ? btn('Clear', { cls: 'link danger-text', onclick: clearAll }) : null,
        h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Close cart', onclick: () => cartEl.classList.remove('open') }, icon('x')))),
      h('div', { class: 'cart-scroll' },
        cart.editing ? h('div', { class: 'banner warn' }, icon('edit', 20), h('div', { class: 'grow' }, h('b', null, 'Editing bill ' + cart.editing.bill_no), h('div', { class: 'small' }, 'Add or remove items, then press Save changes.')), btn('Cancel edit', { cls: 'link danger-text', onclick: () => { cart = emptyCart(); changed(true); } })) : null,
        segmented([['dine_in', 'Dine-in'], ['takeaway', 'Takeaway'], ['delivery', 'Delivery']], cart.order_type, (v) => { cart.order_type = v; changed(); }, 'wide'),
        h('div', { class: 'cart-lines' }, lines),
        h('div', { class: 'two' },
          field('Customer name (optional)', h('input', { type: 'text', maxlength: 60, value: cart.customer_name, oninput: (e) => { cart.customer_name = e.target.value; persist(); } })),
          field('Mobile (optional)', h('input', { type: 'tel', inputmode: 'numeric', maxlength: 17, class: phoneOk ? '' : 'invalid', value: cart.customer_phone, oninput: (e) => { cart.customer_phone = e.target.value; persist(); e.target.classList.toggle('invalid', !!e.target.value.trim() && !normalizeIndianMobile(e.target.value)); } }), phoneOk ? null : 'Enter a valid 10-digit Indian mobile')),
        field('Notes (optional)', h('input', { type: 'text', maxlength: 300, placeholder: 'e.g. less spicy, no onion', value: cart.notes, oninput: (e) => { cart.notes = e.target.value; persist(); } })),
        cart.insta_handle
          ? h('div', { class: 'banner good insta-on' }, icon('check', 20), h('div', { class: 'grow' }, h('b', null, 'Instagram offer: 10% off'), h('div', { class: 'small' }, '@' + cart.insta_handle)), btn('Remove', { cls: 'link danger-text', onclick: removeInsta }))
          : h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Instagram offer (10% off, one time only)'),
            h('div', { class: 'insta-row' }, instaInp, btn('Check & apply', { cls: 'ghost', onclick: () => applyInsta(instaInp.value) })),
            followsEl,
            h('div', { class: 'muted small' }, "Ask the customer to show the \"Following\" screen of our Instagram page, then tap or type the username. Mobile number is needed first.")),
        cart.insta_handle ? null : h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Bill discount'),
          h('div', { class: 'chips wrap', role: 'group', 'aria-label': 'Quick bill discount' }, [0, 5, 10, 15, 20, 25, 50, 100].map((n) => {
            const on = n === 0 ? cart.bill_disc_type === 'none' : (cart.bill_disc_type === 'percent' && Number(cart.bill_disc_value) === n);
            return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on),
              onclick: () => { if (n === 0) { cart.bill_disc_type = 'none'; cart.bill_disc_value = ''; } else { cart.bill_disc_type = 'percent'; cart.bill_disc_value = String(n); } changed(); } }, n === 0 ? 'No disc' : n + '%');
          })),
          h('div', { class: 'disc-row' }, segmented([['none', 'None'], ['percent', '%'], ['amount', '₹']], cart.bill_disc_type, (v) => { cart.bill_disc_type = v; if (v === 'none') cart.bill_disc_value = ''; changed(); }), discInput)),
        totals,
        cart.editing ? h('div', { class: 'muted small' }, `Payment stays as it was: ${cart.payment_method.toUpperCase()} · ${cart.payment_status === 'paid' ? 'PAID' : 'PENDING'}. If the total changes on a paid bill, collect or return the difference.`) : [
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Payment method'),
          segmented([['cash', 'Cash'], ['upi', 'UPI'], ['other', 'Other']], cart.payment_method, (v) => { cart.payment_method = v; cart.payment_status = v === 'cash' ? 'paid' : 'pending'; cart.verified = false; changed(); }, 'wide big')),
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Payment status'),
          segmented([['paid', 'Paid'], ['pending', 'Pending']], cart.payment_status, (v) => { cart.payment_status = v; cart.verified = false; changed(); }, 'wide')),
        payNote]),
      h('div', { class: 'cart-foot' }, goBtn));
    renderTotals();
  }

  async function clearAll() { cart = emptyCart(); changed(true); }

  async function generate() {
    if (saving || !cart.lines.length) return;
    const phoneRaw = cart.customer_phone.trim();
    const phone = phoneRaw ? normalizeIndianMobile(phoneRaw) : '';
    if (phoneRaw && !phone) { toast('Customer mobile number is not valid', 'error'); return; }
    if (cart.insta_handle && cart.insta_phone !== phone) { removeInsta(); toast('Mobile number changed. Apply the Instagram offer again.', 'error'); return; }
    if (cart.payment_method === 'upi' && cart.payment_status === 'paid' && !cart.verified) { toast('Tick the box to confirm you verified the UPI payment, or set status to Pending', 'error'); return; }
    if (cart.bill_disc_type === 'amount' && cart.bill_disc_value && parseRupees(cart.bill_disc_value) == null) { toast('Bill discount amount is not valid', 'error'); return; }
    if (cart.bill_disc_type === 'percent' && cart.bill_disc_value && !(Number(cart.bill_disc_value) >= 0 && Number(cart.bill_disc_value) <= 100)) { toast('Bill discount % must be 0-100', 'error'); return; }
    saving = true; renderCart();
    const payload = {
      client_id: cart.client_id, order_type: cart.order_type, customer_name: cart.customer_name.trim(), customer_phone: phone, notes: cart.notes.trim(),
      bill_disc_type: cart.bill_disc_type, bill_disc_value: cart.bill_disc_type === 'amount' ? (parseRupees(cart.bill_disc_value) ?? 0) : Number(cart.bill_disc_value) || 0,
      payment_method: cart.payment_method, payment_status: cart.payment_status, payment_verified: cart.verified, insta_handle: cart.insta_handle || '',
      items: cart.lines.map((l) => ({ item_id: l.item_id, name: l.name, category: l.category, qty: l.qty, price: priceOf(l), disc_type: l.disc_type, disc_value: l.disc_value })),
    };
    if (cart.editing) {
      try {
        const r = await post(`/api/bills/${cart.editing.id}/edit`, payload);
        cart = emptyCart(); persist(); saving = false; cartEl.classList.remove('open');
        renderCart(); renderItems(); toast('Bill updated', 'ok');
        showBill(r.bill, { fresh: true, title: 'Bill updated', onNewBill: () => search.focus() });
      } catch (e) { saving = false; renderCart(); toast(e instanceof NetworkError ? 'No internet: a saved bill can only be edited online' : (e.message || 'Could not update the bill'), 'error'); }
      return;
    }
    try {
      const r = await saveBill(payload);
      cart = emptyCart(); persist(); saving = false; cartEl.classList.remove('open');
      renderCart(); renderItems();
      toast(r.queued ? 'Saved on this device - will sync when online' : 'Bill saved', r.queued ? 'warn' : 'ok');
      showBill(r.bill, { fresh: true, onNewBill: () => search.focus() });
      const p = printerPrefs();
      if (p.auto_print && resolveTransport(p) !== 'rawbt') doPrint(r.bill);
    } catch (e) { saving = false; renderCart(); toast(e.message || 'Could not save the bill', 'error'); }
  }

  const off = onChange(() => { renderChips(); renderItems(); });
  renderChips(); renderItems(); renderCart(); loadEdit(); loadFollows();
  return () => { clearInterval(clockT); clearInterval(followsT); off(); window.removeEventListener('bm-edit-bill', onEditEvent); };
}
