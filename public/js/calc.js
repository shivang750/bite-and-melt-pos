// Shared billing maths. Used by BOTH the browser and the server (server recomputes every bill).
// All money is integer paise (₹1 = 100) so there are no floating point errors.

export const MAX_QTY = 999;
export const MAX_PRICE = 10_000_000; // ₹1,00,000

const bps = (pct) => Math.round(Number(pct) * 100); // percent -> basis points

export function percentOf(amount, pct) {
  return Math.round((amount * bps(pct)) / 10000);
}

/**
 * items: [{price, qty, discType:'none'|'percent'|'amount', discValue}]  (price/amount in paise, percent as number)
 * opts : {billDiscType, billDiscValue, gst:{enabled, rate, mode:'exclusive'|'inclusive'}, roundOff}
 */
export function computeBill(items, opts = {}) {
  const lines = items.map((it) => {
    const price = Math.round(it.price);
    const qty = Math.round(it.qty);
    const gross = price * qty;
    let disc = 0;
    if (it.discType === 'percent') disc = percentOf(gross, clamp(it.discValue, 0, 100));
    else if (it.discType === 'amount') disc = Math.round(it.discValue || 0);
    disc = clamp(disc, 0, gross);
    return { gross, disc, net: gross - disc };
  });
  const subtotal = sum(lines.map((l) => l.gross));
  const itemDiscount = sum(lines.map((l) => l.disc));
  const afterItem = subtotal - itemDiscount;

  let billDiscount = 0;
  if (opts.billDiscType === 'percent') billDiscount = percentOf(afterItem, clamp(opts.billDiscValue, 0, 100));
  else if (opts.billDiscType === 'amount') billDiscount = Math.round(opts.billDiscValue || 0);
  billDiscount = clamp(billDiscount, 0, afterItem);

  const afterDiscount = afterItem - billDiscount;
  const gst = opts.gst || { enabled: false };
  let tax = 0;
  let total = afterDiscount;
  let taxable = afterDiscount;
  if (gst.enabled && gst.rate > 0) {
    const r = Number(gst.rate);
    if (gst.mode === 'inclusive') {
      tax = Math.round(afterDiscount - (afterDiscount * 10000) / (10000 + bps(r)));
      taxable = afterDiscount - tax;
      total = afterDiscount;
    } else {
      tax = percentOf(afterDiscount, r);
      total = afterDiscount + tax;
    }
  }
  let roundOff = 0;
  if (opts.roundOff) {
    roundOff = Math.round(total / 100) * 100 - total;
    total += roundOff;
  }
  return {
    lines,
    subtotal,
    itemDiscount,
    billDiscount,
    discountTotal: itemDiscount + billDiscount,
    taxable,
    tax,
    roundOff,
    grandTotal: total,
  };
}

export const sum = (a) => a.reduce((s, n) => s + n, 0);
export function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// ---- formatting -----------------------------------------------------------
/** "1234.50" (no symbol) */
export function plain(paise) {
  const neg = paise < 0;
  const p = Math.abs(Math.round(paise));
  return (neg ? '-' : '') + Math.floor(p / 100) + '.' + String(p % 100).padStart(2, '0');
}
/** "₹1,234.50" with Indian digit grouping */
export function inr(paise) {
  const neg = paise < 0;
  const p = Math.abs(Math.round(paise));
  let whole = String(Math.floor(p / 100));
  if (whole.length > 3) {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    whole = rest + ',' + last3;
  }
  const frac = p % 100;
  return (neg ? '-' : '') + '₹' + whole + (frac ? '.' + String(frac).padStart(2, '0') : '');
}
/** rupees string typed by user ("12.5") -> paise int, or null if invalid */
export function parseRupees(s) {
  if (typeof s === 'number') s = String(s);
  s = String(s ?? '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

// ---- Asia/Kolkata time ----------------------------------------------------
const IST_MS = 330 * 60 * 1000;
export function istDate(d = new Date()) {
  return new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);
}
export function istParts(d = new Date()) {
  const s = new Date(new Date(d).getTime() + IST_MS).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return { date: s.slice(0, 10), time: s.slice(11, 19), yy: s.slice(2, 4), yyyy: s.slice(0, 4), mm: s.slice(5, 7), dd: s.slice(8, 10) };
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "12 Nov 2026, 02:35 PM" in IST regardless of device time zone */
export function fmtDateTime(iso) {
  const s = new Date(new Date(iso).getTime() + IST_MS);
  const h = s.getUTCHours();
  const h12 = h % 12 || 12;
  return `${String(s.getUTCDate()).padStart(2, '0')} ${MON[s.getUTCMonth()]} ${s.getUTCFullYear()}, ${String(h12).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Render a bill number from the admin format. tokens: {YYMMDD} {YYYY} {MM} {DD} {SEQ} {SEQ3} {SEQ4} {SEQ5} */
export function renderBillNo(format, date, seq) {
  const p = istParts(date);
  return String(format || 'BM-{YYMMDD}-{SEQ4}')
    .replace(/\{YYMMDD\}/g, p.yy + p.mm + p.dd)
    .replace(/\{YYYY\}/g, p.yyyy)
    .replace(/\{MM\}/g, p.mm)
    .replace(/\{DD\}/g, p.dd)
    .replace(/\{SEQ(\d?)\}/g, (_, n) => String(seq).padStart(Number(n) || 1, '0'));
}

// ---- validation -----------------------------------------------------------
/** Normalise an Indian mobile number -> 10 digits, or null */
export function normalizeIndianMobile(input) {
  let d = String(input ?? '').replace(/[\s\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
export const isValidVpa = (v) => /^[A-Za-z0-9._\-]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,63}$/.test(String(v || '').trim());
