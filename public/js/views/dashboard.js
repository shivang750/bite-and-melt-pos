import { h, icon, btn, toast } from '../ui.js';
import { inr, istDate, fmtDateTime } from '../calc.js';
import { get, qs, NetworkError } from '../api.js';
import { state, onChange, syncQueue, retryFailed } from '../store.js';
import { showBill, statusBadge } from './billview.js';
import { doPrint } from './billview.js';
import { resolveTransport } from '../printer.js';
import { brandLogo } from '../logo.js';

export function mount(root, go) {
  const wrap = h('div', { class: 'page' });
  root.replaceChildren(wrap);
  let alive = true;

  async function load() {
    wrap.replaceChildren(h('div', { class: 'skeleton' }));
    const today = istDate();
    let rep = null, recent = [], err = '';
    try {
      [rep, { bills: recent }] = await Promise.all([get('/api/reports?' + qs({ from: today, to: today })), get('/api/bills?' + qs({ from: today, to: today, limit: 8 }))]);
    } catch (e) { err = e instanceof NetworkError ? 'You are offline. Sales figures need an internet connection, but you can keep billing - bills sync later.' : e.message; }
    if (!alive) return;
    draw(rep, recent, err);
  }

  function draw(rep, recent, err) {
    const t = rep?.totals;
    const q = state.queue;
    wrap.replaceChildren(
      h('div', { class: 'hello' }, brandLogo('dash-logo'), h('div', null, h('h1', null, 'Hello, ' + (state.user.full_name || state.user.username)), h('div', { class: 'muted' }, 'Today · ' + fmtDateTime(new Date().toISOString()).split(',')[0])),
        btn('New Bill', { cls: 'primary xl', ic: 'plus', onclick: () => go('bill') })),
      q.length ? syncCard(q) : null,
      err ? h('div', { class: 'banner warn' }, icon('wifioff', 20), h('div', null, err)) : null,
      t ? h('div', { class: 'stats' },
        stat('Today’s sales', inr(t.sales), 'sky'), stat('Bills today', t.bills), stat('Cash collected', inr(t.cash)), stat('UPI collected', inr(t.upi)),
        stat('Pending payments', inr(t.pending_amount), t.pending_bills ? 'warn' : '', t.pending_bills ? t.pending_bills + ' bill(s)' : ''), stat('Discounts given', inr(t.discounts))) : null,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Recent bills today'), btn('All bills', { cls: 'link', onclick: () => go('history') })),
        recent.length ? h('div', { class: 'list' }, recent.map(billRow)) : h('div', { class: 'empty small' }, 'No bills yet today.')),
      h('div', { class: 'card' }, h('h3', null, 'Printer'), h('div', { class: 'muted' }, printerLine()), btn('Printer settings', { cls: 'link', onclick: () => go('settings') })));
  }
  const stat = (label, val, cls = '', sub = '') => h('div', { class: 'stat ' + cls }, h('div', { class: 'stat-l' }, label), h('div', { class: 'stat-v' }, val), sub ? h('div', { class: 'muted small' }, sub) : null);
  const billRow = (b) => h('button', { class: 'list-row', type: 'button', onclick: () => showBill(b, { onUpdate: load }) },
    h('div', null, h('b', null, b.bill_no), h('div', { class: 'muted small' }, fmtDateTime(b.created_at))), h('div', { class: 'right' }, h('b', null, inr(b.grand_total)), statusBadge(b)));
  function printerLine() { const t = resolveTransport(); return ({ native: 'BITE AND MELT Android app (direct Bluetooth)', rawbt: 'RawBT Android print service', ble: 'Web Bluetooth printer', browser: 'Browser print (set up a Bluetooth printer in Settings)' })[t]; }
  function syncCard(q) {
    const failed = q.filter((x) => x.error), waiting = q.filter((x) => !x.error);
    return h('div', { class: 'card sync' },
      h('div', { class: 'card-head' }, h('h3', null, icon('refresh', 18), ' Offline bills'), waiting.length ? btn(state.syncing ? 'Syncing…' : 'Sync now', { cls: 'sky', ic: 'refresh', disabled: state.syncing, onclick: async () => { const r = await syncQueue(); toast(r.synced ? `${r.synced} bill(s) synced` : state.online ? 'Nothing synced' : 'Still offline', r.synced ? 'ok' : 'warn'); } }) : null),
      waiting.length ? h('p', null, `${waiting.length} bill(s) are saved safely on this device and will upload automatically.`) : null,
      failed.map((f) => h('div', { class: 'banner bad' }, h('div', null, h('b', null, f.bill.bill_no), ' could not be uploaded: ' + f.error, h('div', { class: 'small' }, 'The bill is still safe on this device.')), btn('Retry', { cls: 'ghost', onclick: () => retryFailed(f.client_id) }))));
  }
  const off = onChange(() => { /* refresh the sync card only */ if (alive && state.queue.length !== 0) { const old = wrap.querySelector('.sync'); if (old) old.replaceWith(syncCard(state.queue)); } });
  const onSynced = () => load();
  window.addEventListener('bm-synced', onSynced);
  load();
  return () => { alive = false; off(); window.removeEventListener('bm-synced', onSynced); };
}
