import { h, btn, toast, field } from '../ui.js';
import { post } from '../api.js';
import { brandLogo } from '../logo.js';

export function loginScreen(onDone) {
  const err = h('div', { class: 'err', role: 'alert' });
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', required: true, value: '' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const go = btn('Log in', { cls: 'primary xl', type: 'submit' });
  const form = h('form', { class: 'login-card', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; go.disabled = true;
    try { await post('/api/login', { username: user.value.trim(), password: pass.value }); await onDone(); }
    catch (x) { err.textContent = x.message; pass.value = ''; pass.focus(); } finally { go.disabled = false; }
  } },
    brandLogo('login-logo', 'BITE AND MELT logo'),
    h('div', { class: 'tag' }, 'Cafe billing · Navsari'),
    field('Username', user), field('Password', pass), err, go);
  const el = h('div', { class: 'login' }, form);
  document.body.replaceChildren(el);
  user.focus();
}
