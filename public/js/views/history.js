import { h, icon, btn, toast, field, debounce, badge } from '../ui.js';
import { inr, fmtDateTime, istDate } from '../calc.js';
import { get, qs, NetworkError } from '../api.js';
import { state, queuedBills } from '../store.js';
import { showBill, statusBadge } from './billview.js';
import { PAY_LABEL } from '../receipt.js';

export function mount(root) {
  const f = { q: '', from: '', to: '', method: '', status: '' };
  let offset = 0, total = 0, loaded = [], alive = true;
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'center' });
  const info = h('div', { class: 'muted small' });
  const dat = (k, label) => field(label, h('input', { type: 'date', max: istDate(), value: f[k], onchange: (e) => { f[k] = e.target.value; reload(); } }));
  const sel = (k, label, opts) => field(label, h('select', { onchange: (e) => { f[k] = e.target.value; reload(); } }, opts.map(([v, l]) => h('option', { value: v, selected: f[k] === v }, l))));
  const page = h('div', { class: 'page' },
    h('h1', null, 'Bill History'),
    h('div', { class: 'card filters' },
      h('div', { class: 'searchbox wide' }, icon('search', 20), h('input', { type: 'search', placeholder: 'Search bill number, mobile or name…', 'aria-label': 'Search bills', oninput: debounce((e) => { f.q = e.target.value.trim(); reload(); }, 300) })),
      h('div', { class: 'filter-grid' }, dat('from', 'From date'), dat('to', 'To date'),
        sel('method', 'Payment method', [['', 'All'], ['cash', 'Cash'], ['upi', 'UPI'], ['other', 'Other']]),
        sel('status', 'Status', [['', 'All'], ['paid', 'Paid'], ['pending', 'Pending'], ['void', 'Cancelled']])),
      btn('Clear filters', { cls: 'link', onclick: () => { Object.assign(f, { q: '', from: '', to: '', method: '', status: '' }); mount(root); } })),
    info, list, more);
  root.replaceChildren(page);

  const row = (b) => h('button', { class: 'list-row', type: 'button', onclick: () => showBill(b, { onUpdate: () => reload() }) },
    h('div', null, h('div', null, h('b', null, b.bill_no), b.local ? badge('Not synced', 'warn') : null),
      h('div', { class: 'muted small' }, fmtDateTime(b.created_at) + ' · ' + (PAY_LABEL[b.payment_method] || '') + (b.customer_phone ? ' · ' + b.customer_phone : '')),
      h('div', { class: 'muted small clip' }, b.items.map((i) => `${i.qty}× ${i.name}`).join(', '))),
    h('div', { class: 'right' }, h('b', { class: b.status === 'void' ? 'strike' : '' }, inr(b.grand_total)), statusBadge(b)));

  async function fetchPage() {
    const params = { q: f.q, from: f.from, to: f.to, method: f.method, limit: 40, offset };
    if (f.status === 'void') params.state = 'void'; else if (f.status) params.status = f.status;
    return get('/api/bills?' + qs(params));
  }
  async function reload() {
    offset = 0; loaded = [];
    list.replaceChildren(h('div', { class: 'skeleton' })); more.replaceChildren(); info.textContent = '';
    // unsynced local bills first
    const local = queuedBills().filter((b) => (!f.q || b.bill_no.toLowerCase().includes(f.q.toLowerCase()) || b.customer_phone.includes(f.q)) && (!f.method || b.payment_method === f.method) && (!f.status || (f.status === 'void' ? false : b.payment_status === f.status)));
    try {
      const r = await fetchPage(); if (!alive) return;
      total = r.total; loaded = r.bills; offset = loaded.length;
      list.replaceChildren(...[...local, ...loaded].map(row));
      if (![...local, ...loaded].length) list.replaceChildren(h('div', { class: 'empty' }, 'No bills found.'));
      info.textContent = `${total} bill(s)` + (local.length ? ` + ${local.length} waiting to sync` : '');
      drawMore();
    } catch (e) {
      if (!alive) return;
      list.replaceChildren(...local.map(row));
      info.textContent = e instanceof NetworkError ? 'Offline - showing only bills saved on this device. Connect to the internet to see all bills.' : e.message;
    }
  }
  function drawMore() {
    more.replaceChildren(offset < total ? btn('Load more', { cls: 'ghost', onclick: async () => {
      try { const r = await fetchPage(); loaded = loaded.concat(r.bills); offset = loaded.length; list.append(...r.bills.map(row)); drawMore(); } catch (e) { toast(e.message, 'error'); } } }) : null);
  }
  reload();
  return () => { alive = false; };
}
