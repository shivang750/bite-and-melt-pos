// Printing bridge. Transports (in order of preference on Android):
//   native  - the BITE AND MELT Android wrapper app (classic Bluetooth SPP, direct, lists paired printers)
//   rawbt   - the free "RawBT" Android print service (classic Bluetooth printers, works from Chrome / installed PWA)
//   ble     - Web Bluetooth straight from Chrome (BLE thermal printers only)
//   browser - window.print() (last resort, NOT thermal-ESC/POS)
import { buildReceipt } from './receipt.js';
import { receiptToEscPos, testPage, toBase64, rgbaToBitmap } from './escpos.js';
import { LOGO_MONO, svgDataUrl } from './logo.js';
import { printerPrefs, state } from './store.js';

const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb', '00001101-0000-1000-8000-00805f9b34fb'];

export const hasNative = () => typeof window.BiteMeltPrinter !== 'undefined';
export const hasWebBluetooth = () => !!navigator.bluetooth;
export const isAndroid = () => /Android/i.test(navigator.userAgent);

export function resolveTransport(p = printerPrefs()) {
  if (p.transport && p.transport !== 'auto') return p.transport;
  if (hasNative()) return 'native';
  if (p.ble_name && hasWebBluetooth()) return 'ble';
  if (isAndroid()) return 'rawbt';
  return 'browser';
}
export const paperSpec = (p = printerPrefs()) => (Number(p.paper) === 80 ? { cols: 48, dots: 576 } : { cols: 32, dots: 384 });

// ---------- logo bitmap ---------------------------------------------------------
const logoCache = new Map();
async function loadImage(src) {
  const img = new Image(); img.decoding = 'async';
  await new Promise((ok, err) => { img.onload = ok; img.onerror = () => err(new Error('logo load failed')); img.src = src; });
  return img;
}
export async function logoBitmap(settings, dots) {
  const src = settings.logo || svgDataUrl(LOGO_MONO);
  const key = src + '|' + dots;
  if (logoCache.has(key)) return logoCache.get(key);
  try {
    const img = await loadImage(src);
    const maxW = Math.floor(dots * 0.42), maxH = 150;
    const k = Math.min(maxW / (img.naturalWidth || 200), maxH / (img.naturalHeight || 200));
    const w = Math.max(8, Math.round((img.naturalWidth || 200) * k)), hgt = Math.max(8, Math.round((img.naturalHeight || 200) * k));
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); ctx.drawImage(img, 0, 0, w, hgt);
    const bm = rgbaToBitmap(ctx.getImageData(0, 0, w, hgt).data, w, hgt, dots, 170);
    logoCache.set(key, bm);
    return bm;
  } catch { return null; } // logo is optional - never block a receipt
}

export async function receiptBytes(bill, settings = state.settings) {
  const p = printerPrefs(), { cols, dots } = paperSpec(p);
  const wantLogo = p.print_logo !== false && settings.print_logo !== false;
  const layout = buildReceipt(bill, { ...settings, print_logo: wantLogo }, cols);
  return receiptToEscPos(layout, { cols, dots, bold: p.bold !== false, cut: p.cut !== false, logoBitmap: wantLogo ? await logoBitmap(settings, dots) : null });
}

// ---------- transports ------------------------------------------------------------
let bleDev = null, bleChar = null;
async function bleConnect(forcePick = false) {
  if (!hasWebBluetooth()) throw new Error('This browser has no Web Bluetooth. Use RawBT or the BITE AND MELT Android app instead.');
  const p = printerPrefs();
  if (!forcePick && bleDev && bleChar && bleDev.gatt.connected) return bleChar;
  if (!bleDev || forcePick) {
    if (!forcePick && navigator.bluetooth.getDevices && p.ble_id) {
      const known = await navigator.bluetooth.getDevices().catch(() => []);
      bleDev = known.find((d) => d.id === p.ble_id) || null;
    }
    if (!bleDev) bleDev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  }
  const server = await bleDev.gatt.connect();
  let found = null;
  for (const svc of await server.getPrimaryServices()) {
    for (const ch of await svc.getCharacteristics()) { if (ch.properties.writeWithoutResponse || ch.properties.write) { found = ch; break; } }
    if (found) break;
  }
  if (!found) throw new Error('Connected, but this device has no writable print channel (it may be a classic-Bluetooth printer - use RawBT).');
  bleChar = found;
  return found;
}
export async function blePair() {
  bleDev = null; bleChar = null;
  await bleConnect(true);
  return { id: bleDev.id, name: bleDev.name || 'Bluetooth printer' };
}
async function bleSend(bytes) {
  let ch;
  try { ch = await bleConnect(); } catch (e) { bleDev = null; bleChar = null; throw e; }
  const size = 100;
  for (let i = 0; i < bytes.length; i += size) {
    const chunk = bytes.slice(i, i + size);
    if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(chunk); else await ch.writeValue(chunk);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function nativeSend(bytes) {
  const p = printerPrefs();
  if (!p.native_address) throw new Error('No printer selected. Go to Settings > Printer and choose one.');
  const r = String(window.BiteMeltPrinter.print(p.native_address, toBase64(bytes)));
  if (r !== 'OK') throw new Error(r.replace(/^ERROR:\s*/, ''));
}
function rawbtSend(bytes) {
  const b64 = toBase64(bytes);
  const fallback = encodeURIComponent('https://play.google.com/store/apps/details?id=ru.a402d.rawbtprinter');
  window.location.href = `intent:base64,${b64}#Intent;scheme=rawbt;launchFlags=0x10000000;package=ru.a402d.rawbtprinter;S.browser_fallback_url=${fallback};end;`;
}

export async function sendBytes(bytes, transport = resolveTransport()) {
  if (transport === 'native') { nativeSend(bytes); return 'Sent to printer'; }
  if (transport === 'ble') { await bleSend(bytes); return 'Sent to printer'; }
  if (transport === 'rawbt') { rawbtSend(bytes); return 'Sent to RawBT (check the printer)'; }
  throw new Error('browser');
}

export async function printBill(bill, settings = state.settings) {
  const t = resolveTransport();
  if (t === 'browser') { browserPrint(bill, settings); return 'Opened the browser print dialog'; }
  return sendBytes(await receiptBytes(bill, settings), t);
}
export async function testPrint() {
  const p = printerPrefs(), { cols, dots } = paperSpec(p), t = resolveTransport(p);
  if (t === 'browser') { browserPrint(null, state.settings, 'PRINTER TEST\n' + '1234567890'.repeat(4).slice(0, cols)); return 'Opened the browser print dialog'; }
  return sendBytes(testPage({ cols, dots, bold: p.bold !== false, cut: p.cut !== false, name: state.settings?.cafe_name || 'BITE AND MELT' }), t);
}
export function nativePrinters() {
  try { return JSON.parse(window.BiteMeltPrinter.listPrinters()); } catch { return []; }
}

// ---------- last resort: browser print ------------------------------------------------
function browserPrint(bill, settings, rawText) {
  const { cols } = paperSpec();
  const text = rawText ?? buildReceipt(bill, { ...settings, print_logo: false }, cols).filter((e) => e.t === 'text').map((e) => {
    const pad = e.align === 'center' ? Math.max(0, Math.floor((cols - e.text.length) / 2)) : 0; return ' '.repeat(pad) + e.text; }).join('\n');
  let area = document.getElementById('print-area');
  if (!area) { area = document.createElement('pre'); area.id = 'print-area'; document.body.append(area); }
  area.textContent = text;
  window.print();
}
