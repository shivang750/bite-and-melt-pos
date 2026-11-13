import { h, icon, btn, toast, field, segmented } from '../ui.js';
import { inr, istDate } from '../calc.js';
import { get, qs, NetworkError } from '../api.js';

const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
function preset(k) {
  const t = istDate();
  if (k === 'today') return [t, t];
  if (k === 'yesterday') return [addDays(t, -1), addDays(t, -1)];
  if (k === 'week') { const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7; return [addDays(t, -dow), t]; }
  if (k === 'last7') return [addDays(t, -6), t];
  if (k === 'month') return [t.slice(0, 8) + '01', t];
  if (k === 'last30') return [addDays(t, -29), t];
  return [t, t];
}

export function mount(root) {
  let [from, to] = preset('today'), group = 'day', active = 'today';
  const out = h('div');
  const fromI = h('input', { type: 'date', max: istDate(), value: from, onchange: (e) => { from = e.target.value; active = 'custom'; load(); } });
  const toI = h('input', { type: 'date', max: istDate(), value: to, onchange: (e) => { to = e.target.value; active = 'custom'; load(); } });
  const chips = h('div', { class: 'chips' });
  const drawChips = () => chips.replaceChildren(...[['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['last7', 'Last 7 days'], ['month', 'This month'], ['last30', 'Last 30 days']]
    .map(([k, l]) => h('button', { class: 'chip' + (active === k ? ' on' : ''), type: 'button', onclick: () => { active = k; [from, to] = preset(k); fromI.value = from; toI.value = to; group = k === 'month' || k === 'last30' ? 'day' : 'day'; drawChips(); load(); } }, l)));
  const grpSeg = h('div');
  const drawSeg = () => grpSeg.replaceChildren(segmented([['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']], group, (v) => { group = v; drawSeg(); load(); }));
  const exportRow = h('div', { class: 'row-gap' });
  const drawExport = () => exportRow.replaceChildren(
    ...[['bills', 'Bills'], ['items', 'Items']].flatMap(([type, label]) => [['csv', 'CSV'], ['xlsx', 'Excel']].map(([format, fl]) =>
      h('a', { class: 'btn ghost', href: '/api/reports/export?' + qs({ from, to, type, format }), download: '' }, icon('download', 20), h('span', null, `${label} ${fl}`)))));
  root.replaceChildren(h('div', { class: 'page' }, h('h1', null, 'Sales Reports'),
    h('div', { class: 'card' }, chips, h('div', { class: 'filter-grid' }, field('From', fromI), field('To', toI), field('Chart', grpSeg)), exportRow), out));
  drawChips(); drawSeg();

  async function load() {
    drawExport();
    out.replaceChildren(h('div', { class: 'skeleton' }));
    try { draw(await get('/api/reports?' + qs({ from, to, group }))); }
    catch (e) { out.replaceChildren(h('div', { class: 'banner warn' }, e instanceof NetworkError ? 'Reports need an internet connection.' : e.message)); }
  }
  const stat = (l, v, cls = '', sub = '') => h('div', { class: 'stat ' + cls }, h('div', { class: 'stat-l' }, l), h('div', { class: 'stat-v' }, v), sub ? h('div', { class: 'muted small' }, sub) : null);

  function bars(items, labelFn, valFn, fmt) {
    const max = Math.max(1, ...items.map(valFn));
    return h('div', { class: 'hbars' }, items.map((i) => h('div', { class: 'hbar' }, h('div', { class: 'hb-l' }, labelFn(i)), h('div', { class: 'hb-track' }, h('div', { class: 'hb-fill', style: { width: Math.max(2, (valFn(i) / max) * 100) + '%' } })), h('div', { class: 'hb-v' }, fmt(i)))));
  }
  function chart(series) {
    if (!series.length) return h('div', { class: 'empty small' }, 'No sales in this period.');
    const W = 640, H = 200, pad = 28, max = Math.max(1, ...series.map((s) => s.sales)), bw = Math.min(60, (W - pad * 2) / series.length - 6);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H + 26}`); svg.setAttribute('class', 'bar-chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Sales chart');
    series.forEach((s, i) => {
      const x = pad + i * ((W - pad * 2) / series.length) + ((W - pad * 2) / series.length - bw) / 2, hh = Math.max(2, (s.sales / max) * (H - 24));
      const r = document.createElementNS(ns, 'rect'); r.setAttribute('x', x); r.setAttribute('y', H - hh); r.setAttribute('width', bw); r.setAttribute('height', hh); r.setAttribute('rx', 5); r.setAttribute('class', 'bar');
      const tt = document.createElementNS(ns, 'title'); tt.textContent = `${s.period}: ${inr(s.sales)} (${s.bills} bills)`; r.append(tt); svg.append(r);
      if (series.length <= 14) { const t = document.createElementNS(ns, 'text'); t.setAttribute('x', x + bw / 2); t.setAttribute('y', H + 16); t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'axis'); t.textContent = s.period.slice(group === 'month' ? 2 : 5); svg.append(t); }
    });
    return svg;
  }
  function draw(r) {
    const t = r.totals;
    out.replaceChildren(
      h('div', { class: 'stats' }, stat('Total sales', inr(t.sales), 'sky'), stat('Total bills', t.bills), stat('Average bill', inr(t.avg_bill)), stat('Cash collected', inr(t.cash)), stat('UPI collected', inr(t.upi)),
        stat('Other collected', inr(t.other)), stat('Pending payments', inr(t.pending_amount), t.pending_bills ? 'warn' : '', t.pending_bills + ' bill(s)'), stat('Total discounts', inr(t.discounts)),
        t.tax ? stat('GST collected', inr(t.tax)) : null, stat('Cancelled bills', r.voided.n, '', r.voided.n ? inr(r.voided.amount) + ' (not in sales)' : '')),
      h('div', { class: 'card' }, h('h3', null, `Sales ${group === 'day' ? 'by day' : group === 'week' ? 'by week (Mon)' : 'by month'}`), chart(r.series)),
      h('div', { class: 'two-col' },
        h('div', { class: 'card' }, h('h3', null, 'Most sold products'), r.top_items.length ? bars(r.top_items, (i) => i.name, (i) => i.qty, (i) => `${i.qty} · ${inr(i.revenue)}`) : h('div', { class: 'empty small' }, 'No data')),
        h('div', { class: 'card' }, h('h3', null, 'Category-wise sales'), r.categories.length ? bars(r.categories, (i) => i.category, (i) => i.revenue, (i) => inr(i.revenue)) : h('div', { class: 'empty small' }, 'No data'))),
      h('p', { class: 'muted small' }, 'Sales exclude cancelled bills. Cash/UPI collected count only bills marked Paid. Dates use Asia/Kolkata time.'));
  }
  load();
  return () => {};
}
