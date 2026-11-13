// Tiny PDF writer: renders the receipt layout as a narrow, selectable-text PDF (Courier), with the UPI QR as vector squares.
import { buildReceipt, ascii } from './receipt.js';
import { makeQr } from './qr.js';

const esc = (s) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const num = (n) => (Math.round(n * 100) / 100).toString();

export function receiptPdf(bill, settings, cols = 32) {
  const layout = buildReceipt(bill, { ...settings, print_logo: false }, cols);
  const fs = 7, cw = 0.6 * fs, margin = 14, lh = 9.5;
  const pageW = Math.ceil(cols * cw + margin * 2);
  // measure height
  let h = margin * 2;
  for (const e of layout) h += e.t === 'qr' ? 120 : e.big ? lh * 1.8 : lh;
  const pageH = Math.ceil(h + 10);
  let y = pageH - margin;
  let c = '';
  for (const e of layout) {
    if (e.t === 'text') {
      const size = e.big ? fs * 1.6 : fs;
      const w = e.text.length * 0.6 * size;
      let x = margin;
      if (e.align === 'center') x = (pageW - w) / 2; else if (e.align === 'right') x = pageW - margin - w;
      y -= e.big ? lh * 1.5 : lh;
      c += `BT /${e.bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(x)} ${num(y)} Td (${esc(e.text)}) Tj ET\n`;
      if (e.big) y -= lh * 0.3;
    } else if (e.t === 'qr') {
      const { size, modules } = makeQr(e.data, 'M');
      const side = 104, m = side / (size + 4);
      const x0 = (pageW - side) / 2, y0 = y - side;
      c += '1 1 1 rg\n' + `${num(x0)} ${num(y0)} ${num(side)} ${num(side)} re f\n0 0 0 rg\n`;
      for (let r = 0; r < size; r++) for (let q = 0; q < size; q++) if (modules[r][q]) c += `${num(x0 + (q + 2) * m)} ${num(y0 + side - (r + 3) * m)} ${num(m)} ${num(m)} re f\n`;
      y -= side + 6;
    }
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${c.length} >>\nstream\n${c}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const u8 = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 0xff;
  return u8;
}
