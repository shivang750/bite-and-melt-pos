import { h, icon, toast, $ } from './ui.js';
import { state, bootstrap, onChange, syncQueue, clearLocalSession, ls } from './store.js';
import { brandLogo } from './logo.js';
import { loginScreen } from './views/login.js';
import { changePasswordModal } from './views/settings.js';

const VIEWS = {
  dashboard: { label: 'Dashboard', ic: 'home', load: () => import('./views/dashboard.js') },
  bill: { label: 'New Bill', ic: 'bill', load: () => import('./views/newbill.js') },
  menu: { label: 'Menu', ic: 'menu', admin: true, load: () => import('./views/menu.js') },
  history: { label: 'History', ic: 'history', load: () => import('./views/history.js') },
  reports: { label: 'Reports', ic: 'chart', admin: true, load: () => import('./views/reports.js') },
  settings: { label: 'Settings', ic: 'gear', load: () => import('./views/settings.js') },
};
let cleanup = null, main, navEl, statusEl, offCh = null;

export const go = (name) => { location.hash = '#/' + name; };
const current = () => { const n = location.hash.replace('#/', ''); const v = VIEWS[n]; return v && (!v.admin || state.user.role === 'admin') ? n : 'dashboard'; };

async function route() {
  if (!main) return;
  const name = current();
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  navEl.querySelectorAll('a').forEach((a) => { const on = a.dataset.v === name; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  main.replaceChildren(h('div', { class: 'skeleton' }));
  try { const mod = await VIEWS[name].load(); if (current() !== name) return; cleanup = mod.mount(main, go) || null; window.scrollTo(0, 0); }
  catch (e) { console.error(e); main.replaceChildren(h('div', { class: 'banner bad' }, 'Could not open this screen: ' + e.message)); }
}

function drawStatus() {
  if (!statusEl) return;
  const n = state.queue.length;
  statusEl.className = 'status' + (state.online && !n ? '' : ' off');
  statusEl.replaceChildren(icon(state.online ? 'refresh' : 'wifioff', 16), h('span', null, state.syncing ? 'Syncing…' : !state.online ? `Offline${n ? ' · ' + n + ' to sync' : ''}` : n ? `${n} to sync` : 'Online'));
}

function shell() {
  const s = state.settings;
  statusEl = h('button', { class: 'status', type: 'button', title: 'Tap to sync now', onclick: async () => { const r = await syncQueue(); if (!state.online) toast('Still offline - bills are safe on this device', 'warn'); else if (!r.synced) toast('Everything is up to date', 'ok'); } });
  navEl = h('nav', { class: 'nav', 'aria-label': 'Main' }, Object.entries(VIEWS).filter(([, v]) => !v.admin || state.user.role === 'admin').map(([k, v]) => h('a', { href: '#/' + k, 'data-v': k }, icon(v.ic, 24), v.label)));
  main = h('main', { id: 'main' });
  const top = h('header', { class: 'top' }, brandLogo('top-logo'),
    h('div', { class: 'brand' }, s.cafe_name || 'BITE AND MELT', h('small', null, 'Navsari, Gujarat')), h('div', { class: 'spacer' }), statusEl);
  document.body.replaceChildren(h('div', { class: 'app' }, top, main, navEl));
  if (offCh) offCh();
  offCh = onChange(drawStatus); drawStatus();
  route();
}

async function start() {
  let r;
  try { r = await bootstrap(); } catch (e) { r = { ok: false, error: e }; }
  if (!r.ok) { loginScreen(start); if (r.error) toast('Cannot reach the server. Check your internet connection.', 'error'); return; }
  while (state.user.must_change) { await changePasswordModal(true); await bootstrap(); }
  shell();
  if (r.offline) toast('Offline mode - you can keep billing. Bills will sync automatically.', 'warn', 6000);
  syncQueue();
}

window.addEventListener('hashchange', () => { if (main) route(); });
window.addEventListener('bm-unauthorized', () => { if (state.user) { clearLocalSession(); toast('Your session expired. Please log in again.', 'warn'); loginScreen(start); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
