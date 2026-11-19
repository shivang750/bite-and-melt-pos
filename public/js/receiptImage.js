// Renders the SAME receipt layout that is sent to the thermal printer (buildReceipt) as a PNG image, for WhatsApp.
// Geometry mirrors the ESC/POS output: 58 mm = 32 columns x 12 dots = 384 dots wide (80 mm = 48 columns / 576 dots),
// 30-dot line pitch, double-size lines are 24 dots wide, logo and QR use the same sizing rules as the printer code.
import { buildReceipt, ascii, PAY_LABEL } from './receipt.js';
import { makeQr } from './qr.js';
import { plain } from './calc.js';
import { LOGO_MONO, svgDataUrl } from './logo.js';
import { printerPrefs, state } from './store.js';
import { paperSpec } from './printer.js';

const SCALE = 2;            // 2x resolution so the text stays sharp on phone screens
const CELL = 12, LINE = 30; // dots per character cell / per text line (printer font A)
const MONO = '"Courier New","Liberation Mono","DejaVu Sans Mono",Menlo,Consolas,monospace';

function loadImage(src) {
  return new Promise((ok, err) => { const img = new Image(); img.decoding = 'async'; img.onload = () => ok(img); img.onerror = () => err(new Error('logo load failed')); img.src = src; });
}
async function loadLogo(settings) {
  for (const src of [settings.logo, '/brand/logo.png', svgDataUrl(LOGO_MONO)].filter(Boolean)) { try { return await loadImage(src); } catch { /* try next */ } }
  return null;
}

export async function receiptPng(bill, settings = state.settings) {
  const p = printerPrefs(), { cols, dots } = paperSpec(p);
  const wantLogo = p.print_logo !== false && settings.print_logo !== false;
  const layout = buildReceipt(bill, { ...settings, print_logo: wantLogo }, cols);
  const alwaysBold = p.bold !== false;
  const logo = wantLogo && layout.some((e) => e.t === 'logo') ? await loadLogo(settings) : null;

  // --- measure
  let logoBox = null; if (logo) { const k = Math.min(Math.floor(dots * 0.42) / (logo.naturalWidth || 200), 150 / (logo.naturalHeight || 200)); logoBox = { w: Math.max(8, Math.round((logo.naturalWidth || 200) * k)), h: Math.max(8, Math.round((logo.naturalHeight || 200) * k)) }; }
  const qrOf = (e) => { const { size, modules } = makeQr(e.data, 'M'), quiet = 2, scale = Math.max(2, Math.min(8, Math.floor((dots * 0.62) / (size + quiet * 2)))); return { size, modules, quiet, scale, side: (size + quiet * 2) * scale }; };
  const TOP = 16, BOTTOM = LINE * 3;
  let H = TOP + BOTTOM;
  for (const e of layout) H += e.t === 'logo' ? (logoBox ? logoBox.h + LINE : 0) : e.t === 'qr' ? qrOf(e).side + LINE : e.big ? LINE * 2 : LINE;

  // --- draw
  const c = document.createElement('canvas'); c.width = dots * SCALE; c.height = Math.ceil(H * SCALE);
  const g = c.getContext('2d'); g.scale(SCALE, SCALE);
  g.fillStyle = '#fff'; g.fillRect(0, 0, dots, H); g.fillStyle = '#000'; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
  let y = TOP;
  for (const e of layout) {
    if (e.t === 'logo') {
      if (logoBox) { g.drawImage(logo, Math.floor((dots - logoBox.w) / 2), y, logoBox.w, logoBox.h); y += logoBox.h + LINE; }
    } else if (e.t === 'qr') {
      const q = qrOf(e), left = Math.floor((dots - q.side) / 2);
      for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++) if (q.modules[r][k]) g.fillRect(left + (q.quiet + k) * q.scale, y + (q.quiet + r) * q.scale, q.scale, q.scale);
      y += q.side + LINE;
    } else {
      const text = ascii(e.text), mul = e.big ? 2 : 1, cell = CELL * mul, w = text.length * cell;
      const x0 = e.align === 'center' ? Math.floor((dots - w) / 2) : e.align === 'right' ? dots - w : 0;
      g.font = `${e.bold || alwaysBold ? 'bold ' : ''}${Math.round(20 * mul)}px ${MONO}`;
      const base = y + (e.big ? LINE * 2 - 12 : LINE - 8);
      for (let i = 0; i < text.length; i++) if (text[i] !== ' ') g.fillText(text[i], x0 + i * cell + cell / 2, base); // fixed cells = same column alignment as the printer
      y += e.big ? LINE * 2 : LINE;
    }
  }
  return new Promise((ok, err) => c.toBlob((b) => (b ? ok(b) : err(new Error('Could not create the image'))), 'image/png'));
}

export const receiptImageName = (bill) => `Bill-${bill.bill_no}.png`;

/** Short caption that travels with the image (WhatsApp shows it under the picture where the app supports captions). */
export function receiptCaption(bill, s) {
  const lines = [`*${s.cafe_name || 'BITE AND MELT'}* - Bill ${bill.bill_no}`, `Total: ₹${plain(bill.grand_total)} - ${bill.payment_status === 'paid' ? 'PAID' : 'PENDING'} (${PAY_LABEL[bill.payment_method] || ''})`];
  const pl = bill.payment_link;
  if (bill.payment_status !== 'paid' && bill.status !== 'void' && pl && pl.url && (pl.status === 'created' || pl.status === 'partial')) {
    lines.push('', `👉 *Pay Now:* ${pl.url}`, `Order No: ${bill.bill_no}`, `Payment Ref: ${pl.reference}`);
  }
  lines.push('', s.footer || 'Thank you! Visit again 🙏');
  return lines.join('\n');
}
