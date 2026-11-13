// ESC/POS command builder for 58mm (32 col / 384 dot) and 80mm (48 col / 576 dot) thermal printers.
import { makeQr } from './qr.js';
import { ascii } from './receipt.js';

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

export class EscPos {
  constructor({ cols = 32, dots = 384, bold = true, cut = true } = {}) {
    this.cols = cols; this.dots = dots; this.alwaysBold = bold; this.doCut = cut;
    this.b = [];
    this.raw(ESC, 0x40);            // initialise
    this.raw(ESC, 0x74, 0);         // code page PC437 (ASCII safe)
    this.raw(ESC, 0x32);            // default line spacing
    this.setBold(false);
  }
  raw(...bytes) { for (const x of bytes) this.b.push(x & 0xff); return this; }
  align(a) { return this.raw(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0); }
  setBold(on) { return this.raw(ESC, 0x45, on || this.alwaysBold ? 1 : 0); }
  size(big) { return this.raw(GS, 0x21, big ? 0x11 : 0x00); } // double width+height
  text(str) { for (const ch of ascii(str)) this.b.push(ch.charCodeAt(0)); return this; }
  line(str = '') { return this.text(str).raw(LF); }
  feed(n = 1) { return this.raw(ESC, 0x64, n); }
  cut() { return this.doCut ? this.raw(GS, 0x56, 0x42, 0x00) : this; } // partial cut after feed (ignored by printers without a cutter)
  /** bitmap: {width(multiple of 8), height, data: packed 1bpp rows, 1 = black} */
  image(bm) {
    const bytesPerRow = bm.width / 8;
    for (let y0 = 0; y0 < bm.height; y0 += 128) {  // strips keep cheap printers' buffers happy
      const h = Math.min(128, bm.height - y0);
      this.raw(GS, 0x76, 0x30, 0, bytesPerRow & 0xff, bytesPerRow >> 8, h & 0xff, h >> 8);
      for (let i = y0 * bytesPerRow; i < (y0 + h) * bytesPerRow; i++) this.b.push(bm.data[i]);
    }
    return this;
  }
  bytes() { return Uint8Array.from(this.b); }
}

/** QR matrix -> centred 1bpp bitmap for the paper width */
export function qrBitmap(payload, dots = 384, ecl = 'M') {
  const { size, modules } = makeQr(payload, ecl);
  const quiet = 2;
  const scale = Math.max(2, Math.min(8, Math.floor((dots * 0.62) / (size + quiet * 2))));
  const side = (size + quiet * 2) * scale;
  const width = dots, height = side;
  const bpr = width / 8, data = new Uint8Array(bpr * height);
  const left = Math.floor((width - side) / 2);
  for (let y = 0; y < size * scale; y++)
    for (let x = 0; x < size * scale; x++)
      if (modules[Math.floor(y / scale)][Math.floor(x / scale)]) {
        const px = left + quiet * scale + x, py = quiet * scale + y;
        data[py * bpr + (px >> 3)] |= 0x80 >> (px & 7);
      }
  return { width, height, data };
}

/** RGBA pixels -> 1bpp bitmap, centred on paper width; transparent counts as white */
export function rgbaToBitmap(rgba, w, h, dots = 384, threshold = 160) {
  const width = dots, bpr = width / 8, data = new Uint8Array(bpr * h);
  const left = Math.floor((width - w) / 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
      if (lum < threshold) { const px = left + x; data[y * bpr + (px >> 3)] |= 0x80 >> (px & 7); }
    }
  return { width, height: h, data };
}

/** layout entries (from receipt.js) -> ESC/POS bytes. logoBitmap optional (null = skip). */
export function receiptToEscPos(layout, { cols = 32, dots = 384, bold = true, cut = true, logoBitmap = null } = {}) {
  const p = new EscPos({ cols, dots, bold, cut });
  for (const e of layout) {
    if (e.t === 'logo') {
      if (logoBitmap) { p.align('center').image(logoBitmap).raw(LF); }
    } else if (e.t === 'qr') {
      p.align('center').image(qrBitmap(e.data, dots)).raw(LF);
    } else if (e.t === 'text') {
      p.align(e.align).setBold(e.bold).size(e.big).line(e.text);
      if (e.big) p.size(false);
    }
  }
  p.align('left').setBold(false).size(false).feed(4).cut();
  return p.bytes();
}

export function testPage({ cols = 32, dots = 384, bold = true, cut = true, name = 'BITE AND MELT' } = {}) {
  const p = new EscPos({ cols, dots, bold, cut });
  p.align('center').setBold(true).size(true).line(name).size(false);
  p.line('PRINTER TEST').line('-'.repeat(cols));
  p.align('left').setBold(false).line('Width: ' + cols + ' chars / ' + dots + ' dots');
  p.line('1234567890'.repeat(4).slice(0, cols));
  p.line('Normal text: Burger  Rs.120.00');
  p.setBold(true).line('Bold text:   Pizza   Rs.250.00').setBold(false);
  p.align('center').image(qrBitmap('BITE AND MELT PRINTER TEST', dots));
  p.line('If you can read this,').line('your printer works!').feed(4).cut();
  return p.bytes();
}

export const toBase64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64');
};
