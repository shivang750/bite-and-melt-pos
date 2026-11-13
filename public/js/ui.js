// Tiny DOM helpers (no innerHTML with user data -> no XSS) + shared components.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') el[k] = v;
    else if (k === 'html') throw new Error('html prop not allowed');
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
// Make replaceChildren/append ignore null/false/undefined (conditional children) instead of printing "null".
for (const m of ['replaceChildren', 'append']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...k) { return orig.apply(this, k.flat(Infinity).filter((x) => x != null && x !== false)); };
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  bill: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4',
  menu: 'M4 4v7a3 3 0 0 0 3 3v7M7 4v6M10 4v7a3 3 0 0 1-3 3M17 21V4c-2.5 1-4 4-4 8h4',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', x: 'M6 6l12 12M18 6L6 18', check: 'M5 13l4 4L19 7',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14',
  wa: 'M3 21l1.6-4.7A8.5 8.5 0 1 1 8 19.5zM9 9c0 3 3 6 6 6l1.5-1.5-2-1-1 .8c-1-.4-2-1.4-2.4-2.4l.8-1-1-2z',
  wifioff: 'M2 8.8a15 15 0 0 1 4-2.3M22 8.8a15 15 0 0 0-8.5-3.7M5 12.5a10 10 0 0 1 3-1.8M19 12.5a10 10 0 0 0-3.5-2M8.5 16a5 5 0 0 1 4-1.4M12 20h.01M2 2l20 20',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  upload: 'M4 17v3h16v-3M12 4v12M7 9l5-5 5 5', download: 'M4 17v3h16v-3M12 4v12M7 11l5 5 5-5',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v3M14 20h3M20 20h1',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  cart: 'M3 4h2l2.5 11h10l2-8H6M9 20h.01M17 20h.01',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
};
export function icon(name, size = 22) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.x); s.append(p);
  return s;
}
export const btn = (label, { cls = '', ic, onclick, type = 'button', disabled, title } = {}) =>
  h('button', { class: 'btn ' + cls, type, onclick, disabled, title }, ic ? icon(ic, 20) : null, label ? h('span', null, label) : null);

export function toast(msg, kind = 'info', ms = 3800) {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? Math.max(ms, 6000) : ms);
}

export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const back = h('div', { class: 'backdrop' });
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  append(box, [
    h('div', { class: 'modal-head' }, h('h2', null, title || ''), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions) : null,
  ]);
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  const f = box.querySelector('input,select,textarea'); if (f && window.innerWidth > 700) f.focus();
  return { close, el: box };
}
export function confirmDialog(message, { okText = 'Confirm', danger = false, title = 'Please confirm' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title, body: h('p', { class: 'pre' }, message), onClose: () => { if (!done) resolve(false); },
      actions: [btn('Cancel', { cls: 'ghost', onclick: () => m.close() }), btn(okText, { cls: danger ? 'danger' : 'primary', onclick: () => { done = true; resolve(true); m.close(); } })] });
  });
}
export const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
export const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);
export function segmented(options, value, onChange, cls = '') {
  const wrap = h('div', { class: 'seg ' + cls, role: 'group' });
  options.forEach(([val, label]) => wrap.append(h('button', { type: 'button', class: val === value ? 'on' : '', 'aria-pressed': val === value, onclick: () => onChange(val) }, label)));
  return wrap;
}
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
/** Blob -> base64 (used to hand files to the Android wrapper, whose WebView cannot download blob: URLs) */
export const blobToBase64 = (blob) => new Promise((ok, err) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => err(r.error); r.readAsDataURL(blob); });
export function downloadBlob(blob, name) {
  if (window.BiteMeltPrinter && window.BiteMeltPrinter.saveFile) { blobToBase64(blob).then((b) => window.BiteMeltPrinter.saveFile(name, blob.type || 'application/octet-stream', b)); return; }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
/** resize an image File to max px and return a data URL (JPEG, or PNG when keepAlpha) */
export async function resizeImage(file, max = 480, keepAlpha = false) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d');
  if (!keepAlpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.85);
}
