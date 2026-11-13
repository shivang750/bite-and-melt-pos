// App state, cached menu for offline use, and the offline bill queue with safe synchronisation.
import { get, post, put, ApiError, NetworkError } from './api.js';
import { computeBill, istDate, renderBillNo } from './calc.js';
import { uuid } from './ui.js';

export const state = { user: null, settings: null, categories: [], items: [], online: true, queue: [], syncing: false, lastSync: null };
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
export { ls };

// ---------- bootstrap / cache ---------------------------------------------
export async function bootstrap() {
  try {
    const d = await get('/api/bootstrap');
    Object.assign(state, { user: d.user, settings: d.settings, categories: d.categories, items: d.items, online: true });
    ls.set('bm_cache', { user: d.user, settings: d.settings, categories: d.categories, items: d.items, at: Date.now() });
    mergePrinterDefaults();
    state.queue = ls.get('bm_queue', []);
    emit();
    return { ok: true };
  } catch (e) {
    if (e instanceof NetworkError) {
      const c = ls.get('bm_cache');
      if (c && c.user) { Object.assign(state, c, { online: false }); state.queue = ls.get('bm_queue', []); emit(); return { ok: true, offline: true }; }
      throw e;
    }
    if (e instanceof ApiError && e.status === 401) { state.user = null; return { ok: false }; }
    throw e;
  }
}
export async function refreshMenu() {
  try { const d = await get('/api/bootstrap'); Object.assign(state, { settings: d.settings, categories: d.categories, items: d.items, online: true }); ls.set('bm_cache', { user: d.user, settings: d.settings, categories: d.categories, items: d.items, at: Date.now() }); emit(); }
  catch (e) { if (e instanceof NetworkError) { state.online = false; emit(); } else throw e; }
}
export function clearLocalSession() { ls.del('bm_cache'); ls.del('bm_cart'); state.user = null; }

function mergePrinterDefaults() {
  if (!ls.get('bm_printer') && state.settings?.printer && Object.keys(state.settings.printer).length) ls.set('bm_printer', state.settings.printer);
}

// ---------- offline queue ---------------------------------------------------
const saveQueue = () => { if (!ls.set('bm_queue', state.queue)) throw new Error('This device is out of storage - cannot save the bill locally. Free some space.'); };
function deviceCode() { let d = ls.get('bm_device'); if (!d) { d = Math.random().toString(36).slice(2, 5).toUpperCase(); ls.set('bm_device', d); } return d; }
function localBillNo(when) {
  const day = istDate(when), c = ls.get('bm_localseq', { day, n: 0 });
  if (c.day !== day) { c.day = day; c.n = 0; }
  c.n += 1; ls.set('bm_localseq', c);
  return `OFL-${renderBillNo('{YYMMDD}', when, 0)}-${deviceCode()}-${String(c.n).padStart(3, '0')}`;
}

/** Build a bill object (same shape the server returns) locally, from the cached menu and settings. */
export function buildLocalBill(payload, billNo, when) {
  const s = state.settings;
  const lines = payload.items.map((l) => ({ ...l }));
  const calc = computeBill(lines.map((l) => ({ price: l.price, qty: l.qty, discType: l.disc_type, discValue: l.disc_value })), {
    billDiscType: payload.bill_disc_type, billDiscValue: payload.bill_disc_value, gst: { enabled: s.gst_enabled, rate: s.gst_rate, mode: s.gst_mode }, roundOff: s.round_off });
  return {
    id: null, local: true, bill_no: billNo, client_id: payload.client_id, created_at: when.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    order_type: payload.order_type, customer_name: payload.customer_name || '', customer_phone: payload.customer_phone || '', notes: payload.notes || '',
    subtotal: calc.subtotal, item_discount: calc.itemDiscount, bill_discount: calc.billDiscount, discount_total: calc.discountTotal, tax_total: calc.tax, round_off: calc.roundOff, grand_total: calc.grandTotal,
    gst_rate: s.gst_enabled ? s.gst_rate : 0, gst_mode: s.gst_mode, payment_method: payload.payment_method, payment_status: calc.grandTotal <= 0 ? 'paid' : payload.payment_status, status: 'active',
    items: lines.map((l, i) => ({ name: l.name, category: l.category, qty: l.qty, price: l.price, disc_type: l.disc_type, disc_value: l.disc_value, disc_amount: calc.lines[i].disc, line_total: calc.lines[i].net })),
  };
}

/** Save a bill: online -> server (server recomputes totals). Network failure -> safely queued on this device. */
export async function saveBill(payload) {
  try {
    const r = await post('/api/bills', payload);
    state.online = true; emit();
    return { bill: r.bill, queued: false, duplicate: r.duplicate };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    state.online = false;
    const when = new Date();
    const billNo = localBillNo(when);
    const bill = buildLocalBill(payload, billNo, when);
    state.queue.push({ client_id: payload.client_id, payload: { ...payload, offline: true, bill_no: billNo, created_at: bill.created_at }, bill, error: null });
    saveQueue(); emit();
    scheduleSync(5000);
    return { bill, queued: true };
  }
}

let timer = null;
export function scheduleSync(ms = 15000) { clearTimeout(timer); timer = setTimeout(syncQueue, ms); }
export async function syncQueue() {
  if (state.syncing) return { synced: 0 };
  state.queue = ls.get('bm_queue', state.queue);
  const pending = state.queue.filter((q) => !q.error || q.retry);
  if (!pending.length) return { synced: 0 };
  state.syncing = true; emit();
  let synced = 0;
  try {
    for (const q of pending) {
      try {
        const r = await post('/api/bills', q.payload);
        state.queue = state.queue.filter((x) => x.client_id !== q.client_id);
        saveQueue(); synced++;
        const recent = ls.get('bm_synced', []); recent.unshift({ local: q.bill.bill_no, server: r.bill.bill_no }); ls.set('bm_synced', recent.slice(0, 50));
      } catch (e) {
        if (e instanceof NetworkError) { state.online = false; break; }
        if (e instanceof ApiError && e.status === 401) break;
        q.error = e.message; q.retry = false; saveQueue(); // keep the bill - never discard. Admin decides.
      }
    }
    if (synced) { state.online = true; state.lastSync = new Date(); await refreshMenu().catch(() => {}); }
  } finally { state.syncing = false; emit(); }
  if (state.queue.some((q) => !q.error)) scheduleSync(20000);
  window.dispatchEvent(new CustomEvent('bm-synced', { detail: { synced } }));
  return { synced };
}
export function retryFailed(clientId) { const q = state.queue.find((x) => x.client_id === clientId); if (q) { q.error = null; saveQueue(); emit(); syncQueue(); } }
export const queuedBills = () => state.queue.map((q) => q.bill);

window.addEventListener('online', () => { state.online = true; emit(); syncQueue(); });
window.addEventListener('offline', () => { state.online = false; emit(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.queue.length) syncQueue(); });

export const printerPrefs = () => ({ transport: 'auto', paper: 58, bold: true, cut: true, print_logo: true, ...ls.get('bm_printer', {}) });
export function savePrinterPrefs(p) { ls.set('bm_printer', p); put('/api/printer-prefs', { printer: { ...p, native_address: undefined } }).catch(() => {}); }
