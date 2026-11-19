import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getSettings, setSetting } from './db.js';
import { createXlsx } from './xlsx.js';
import { gatewayConfig, publicInfo, createLink, fetchLink, verifyWebhook, GatewayError } from './payments.js';
import { hashPassword, verifyPassword, sha256, newToken, DUMMY } from './auth.js';
import { computeBill, renderBillNo, istDate, normalizeIndianMobile, isValidVpa, MAX_QTY, MAX_PRICE } from '../public/js/calc.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_DAYS = 30;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const str = (v, max, field, { required = false } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is too long (max ${max})`);
  return s;
};
const intIn = (v, lo, hi, field) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${field} must be a whole number between ${lo} and ${hi}`); return n; };
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

export function createApp(db) {
  const sql = (q) => db.prepare(q);
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
  const loginFails = new Map(); // key -> {n, until}
  const gw = gatewayConfig();
  if (gw.error) console.warn('[payments] ' + gw.error);
  else if (gw.provider !== 'none' && !gw.enabled) console.warn(`[payments] ${gw.provider} selected but missing: ${gw.missing.join(', ')} - online payment stays OFF`);
  else if (gw.enabled) console.log(`[payments] online payment ON via ${gw.provider}`);
  const pubSettings = () => ({ ...getSettings(db), online_payment_enabled: gw.enabled, online_payment_provider: publicInfo(gw).provider });

  // ---------------- bills -------------------------------------------------
  function nextBillNo(format, when) {
    const key = renderBillNo(format, when, 0);
    for (let i = 0; i < 50; i++) {
      const n = sql('INSERT INTO counters(key,n) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET n=n+1 RETURNING n').get(key).n;
      const no = renderBillNo(format, when, n);
      if (!sql('SELECT 1 FROM bills WHERE bill_no=?').get(no)) return no;
    }
    throw new HttpError(500, 'Could not allocate a bill number');
  }

  function loadBills(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const items = db.prepare(`SELECT * FROM bill_items WHERE bill_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
    const by = new Map();
    for (const it of items) (by.get(it.bill_id) || by.set(it.bill_id, []).get(it.bill_id)).push(it);
    const links = new Map();
    for (const l of db.prepare(`SELECT bill_id, provider, short_url url, reference, status, amount, expires_at, paid_at FROM payment_links WHERE bill_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids)) links.set(l.bill_id, l); // newest wins
    return rows.map((r) => ({ ...r, items: by.get(r.id) || [], payment_link: links.get(r.id) || null }));
  }
  const getBill = (id) => loadBills([sql('SELECT * FROM bills WHERE id=?').get(id)].filter(Boolean))[0];

  function createBill(body, user) {
    const clientId = String(body.client_id || '');
    if (!/^[A-Za-z0-9_\-]{8,64}$/.test(clientId)) throw bad('client_id is required (8-64 letters/digits)');
    const existing = sql('SELECT id FROM bills WHERE client_id=?').get(clientId);
    if (existing) return { bill: getBill(existing.id), duplicate: true };

    const orderType = ['dine_in', 'takeaway', 'delivery'].includes(body.order_type) ? body.order_type : (() => { throw bad('Invalid order type'); })();
    const method = ['cash', 'upi', 'other'].includes(body.payment_method) ? body.payment_method : (() => { throw bad('Invalid payment method'); })();
    let status = body.payment_status === 'paid' ? 'paid' : 'pending';
    if (method === 'upi' && status === 'paid' && body.payment_verified !== true) throw bad('UPI payments can only be marked Paid after you have verified the money in your UPI/bank app');
    const phoneRaw = str(body.customer_phone, 20, 'Mobile number');
    let phone = '';
    if (phoneRaw) { phone = normalizeIndianMobile(phoneRaw); if (!phone) throw bad('Enter a valid 10-digit Indian mobile number'); }
    const customerName = str(body.customer_name, 60, 'Customer name');
    const notes = str(body.notes, 300, 'Notes');
    if (!Array.isArray(body.items) || !body.items.length) throw bad('Add at least one item to the bill');
    if (body.items.length > 100) throw bad('Too many lines on one bill');
    const offline = body.offline === true;
    const s = getSettings(db);

    const lines = body.items.map((raw) => {
      const qty = intIn(raw.qty, 1, MAX_QTY, 'Quantity');
      const dbItem = raw.item_id ? sql('SELECT i.*, c.name AS cat FROM items i LEFT JOIN categories c ON c.id=i.category_id WHERE i.id=?').get(raw.item_id) : null;
      let name, price, category;
      if (offline) { // sold while offline: the price the customer was shown is the truth
        name = str(raw.name || dbItem?.name, 80, 'Item name', { required: true });
        price = intIn(raw.price, 0, MAX_PRICE, 'Price');
        category = str(raw.category || dbItem?.cat || '', 40, 'Category');
      } else {
        if (!dbItem) throw bad('An item on this bill no longer exists. Refresh the menu and try again.');
        if (!dbItem.available) throw bad(`"${dbItem.name}" is marked Out of Stock`);
        name = dbItem.name; price = dbItem.price; category = dbItem.cat || '';
      }
      const dt = ['percent', 'amount'].includes(raw.disc_type) ? raw.disc_type : 'none';
      let dv = 0;
      if (dt === 'percent') { dv = Number(raw.disc_value); if (!(dv >= 0 && dv <= 100)) throw bad('Item discount % must be 0-100'); }
      if (dt === 'amount') dv = intIn(raw.disc_value, 0, MAX_PRICE * MAX_QTY, 'Item discount');
      return { item_id: dbItem?.id ?? null, name, category, qty, price, disc_type: dt, disc_value: dv };
    });
    const bdt = ['percent', 'amount'].includes(body.bill_disc_type) ? body.bill_disc_type : 'none';
    let bdv = 0;
    if (bdt === 'percent') { bdv = Number(body.bill_disc_value); if (!(bdv >= 0 && bdv <= 100)) throw bad('Bill discount % must be 0-100'); }
    if (bdt === 'amount') bdv = intIn(body.bill_disc_value, 0, 1_000_000_000, 'Bill discount');

    const calc = computeBill(lines.map((l) => ({ price: l.price, qty: l.qty, discType: l.disc_type, discValue: l.disc_value })), {
      billDiscType: bdt, billDiscValue: bdv, gst: { enabled: s.gst_enabled, rate: s.gst_rate, mode: s.gst_mode }, roundOff: s.round_off,
    });
    if (calc.grandTotal <= 0 && status === 'pending') status = 'paid'; // free bill: nothing to collect

    let createdAt = new Date();
    if (offline && body.created_at) {
      const t = new Date(body.created_at);
      const now = Date.now();
      if (!Number.isNaN(t.getTime()) && t.getTime() > now - 45 * 864e5 && t.getTime() < now + 10 * 6e4) createdAt = t;
    }
    const iso = createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');

    return tx(() => {
      const dup = sql('SELECT id FROM bills WHERE client_id=?').get(clientId);
      if (dup) return { bill: getBill(dup.id), duplicate: true };
      let billNo = null;
      if (offline && /^[A-Za-z0-9\-_]{4,40}$/.test(String(body.bill_no || '')) && !sql('SELECT 1 FROM bills WHERE bill_no=?').get(body.bill_no)) billNo = body.bill_no;
      if (!billNo) billNo = nextBillNo(s.bill_format, createdAt);
      const id = sql(`INSERT INTO bills(bill_no,client_id,created_at,local_date,order_type,customer_name,customer_phone,notes,subtotal,item_discount,bill_disc_type,bill_disc_value,bill_discount,discount_total,tax_total,round_off,grand_total,gst_rate,gst_mode,payment_method,payment_status,paid_at,payment_ref,created_by,offline,synced_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        billNo, clientId, iso, istDate(createdAt), orderType, customerName, phone, notes, calc.subtotal, calc.itemDiscount, bdt, bdv, calc.billDiscount, calc.discountTotal, calc.tax, calc.roundOff, calc.grandTotal,
        s.gst_enabled ? s.gst_rate : 0, s.gst_mode, method, status, status === 'paid' ? iso : null, str(body.payment_ref, 60, 'Payment reference'), user.username, offline ? 1 : 0, offline ? new Date().toISOString() : null,
      ).lastInsertRowid;
      lines.forEach((l, i) => sql('INSERT INTO bill_items(bill_id,item_id,name,category,qty,price,disc_type,disc_value,disc_amount,line_total) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, l.item_id, l.name, l.category, l.qty, l.price, l.disc_type, l.disc_value, calc.lines[i].disc, calc.lines[i].net));
      if (status === 'paid' && calc.grandTotal > 0) sql('INSERT INTO payments(bill_id,method,amount,reference,recorded_by,recorded_at,source) VALUES(?,?,?,?,?,?,?)')
        .run(id, method, calc.grandTotal, str(body.payment_ref, 60, 'Payment reference'), user.username, iso, method === 'upi' ? 'manual-verified' : 'manual');
      return { bill: getBill(id), duplicate: false };
    });
  }

  // ---------------- reports -----------------------------------------------
  function range(q) {
    const today = istDate();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : from;
    return from <= to ? [from, to] : [to, from];
  }
  function report(q) {
    const [from, to] = range(q);
    const A = "status='active' AND local_date BETWEEN ? AND ?";
    const t = sql(`SELECT COUNT(*) bills, COALESCE(SUM(grand_total),0) sales, COALESCE(SUM(discount_total),0) discounts, COALESCE(SUM(tax_total),0) tax,
      COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='cash' THEN grand_total END),0) cash,
      COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='upi' THEN grand_total END),0) upi,
      COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='other' THEN grand_total END),0) other,
      COALESCE(SUM(CASE WHEN payment_status='pending' THEN grand_total END),0) pending_amount,
      COALESCE(SUM(CASE WHEN payment_status='pending' THEN 1 END),0) pending_bills FROM bills WHERE ${A}`).get(from, to);
    const v = sql("SELECT COUNT(*) n, COALESCE(SUM(grand_total),0) amount FROM bills WHERE status='void' AND local_date BETWEEN ? AND ?").get(from, to);
    const top = sql(`SELECT bi.name, SUM(bi.qty) qty, SUM(bi.line_total) revenue FROM bill_items bi JOIN bills b ON b.id=bi.bill_id WHERE b.${A} GROUP BY bi.name ORDER BY qty DESC, revenue DESC LIMIT 10`).all(from, to);
    const cats = sql(`SELECT CASE WHEN bi.category='' THEN 'Uncategorised' ELSE bi.category END category, SUM(bi.qty) qty, SUM(bi.line_total) revenue FROM bill_items bi JOIN bills b ON b.id=bi.bill_id WHERE b.${A} GROUP BY 1 ORDER BY revenue DESC`).all(from, to);
    const group = ['day', 'week', 'month'].includes(q.group) ? q.group : 'day';
    const expr = group === 'day' ? 'local_date' : group === 'week' ? "date(local_date,'-6 days','weekday 1')" : 'substr(local_date,1,7)';
    const series = sql(`SELECT ${expr} period, COUNT(*) bills, SUM(grand_total) sales FROM bills WHERE ${A} GROUP BY 1 ORDER BY 1`).all(from, to);
    return { from, to, group, totals: { ...t, avg_bill: t.bills ? Math.round(t.sales / t.bills) : 0 }, voided: v, top_items: top, categories: cats, series };
  }
  const csvCell = (v) => { let s = v == null ? '' : String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rupees = (p) => (p / 100).toFixed(2);
  function exportTable(q) {
    const [from, to] = range(q);
    let head, rows;
    if (q.type === 'items') {
      head = ['Bill No', 'Date (IST)', 'Item', 'Category', 'Qty', 'Rate', 'Item Discount', 'Line Total', 'Bill Status'];
      rows = sql('SELECT b.bill_no,b.local_date,bi.name,bi.category,bi.qty,bi.price,bi.disc_amount,bi.line_total,b.status FROM bill_items bi JOIN bills b ON b.id=bi.bill_id WHERE b.local_date BETWEEN ? AND ? ORDER BY b.id,bi.id').all(from, to)
        .map((r) => [r.bill_no, r.local_date, r.name, r.category, r.qty, rupees(r.price), rupees(r.disc_amount), rupees(r.line_total), r.status]);
    } else {
      head = ['Bill No', 'Date (IST)', 'Time (UTC)', 'Order Type', 'Customer', 'Mobile', 'Subtotal', 'Discount', 'GST', 'Round Off', 'Total', 'Payment Method', 'Payment Status', 'Bill Status', 'Void Reason', 'Notes'];
      rows = sql('SELECT * FROM bills WHERE local_date BETWEEN ? AND ? ORDER BY id').all(from, to).map((b) => [b.bill_no, b.local_date, b.created_at.slice(11, 19), b.order_type, b.customer_name, b.customer_phone, rupees(b.subtotal), rupees(b.discount_total), rupees(b.tax_total), rupees(b.round_off), rupees(b.grand_total), b.payment_method, b.payment_status, b.status, b.void_reason, b.notes]);
    }
    return [head, ...rows];
  }
  const exportCsv = (q) => '\ufeff' + exportTable(q).map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

  // ---------------- images ------------------------------------------------
  function saveImage(dataUrl) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw bad('Only PNG, JPEG or WebP images are allowed');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 1_500_000) throw bad('Image is too large (max 1.5 MB)');
    const okMagic = (m[1] === 'image/png' && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
      (m[1] === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'image/webp' && buf.subarray(0, 4).toString() === 'RIFF');
    if (!okMagic) throw bad('File content does not match its image type');
    const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/jpeg' ? 'jpg' : 'webp';
    const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24) + '.' + ext;
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
    return '/uploads/' + name;
  }

  // ---------------- users / session helpers ---------------------------------
  const publicUser = (u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change: !!u.must_change });
  function startSession(res, req, user) {
    const token = newToken();
    const now = new Date(), exp = new Date(Date.now() + SESSION_DAYS * 864e5);
    sql('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(sha256(token), user.id, now.toISOString(), exp.toISOString());
    cookie(res, req, 'bm_session', token, SESSION_DAYS * 86400);
  }
  function cookie(res, req, name, value, maxAge) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }
  function authUser(req) {
    const m = /(?:^|;\s*)bm_session=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const row = sql(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.active=1`).get(sha256(m[1]));
    if (!row) return null;
    if (row.expires_at < new Date().toISOString()) { sql('DELETE FROM sessions WHERE token_hash=?').run(sha256(m[1])); return null; }
    return row;
  }
  const adminPasswordOk = (pw) => sql("SELECT * FROM users WHERE role='admin' AND active=1").all().find((a) => verifyPassword(pw, a.pass_salt, a.pass_hash));

  // ---------------- routes ------------------------------------------------
  const routes = [];
  const route = (method, pattern, auth, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, handler });

  route('GET', '/api/health', null, () => ({ ok: true, time: new Date().toISOString() }));

  route('POST', '/api/login', null, (ctx) => {
    const username = str(ctx.body.username, 40, 'Username', { required: true });
    const key = ctx.ip + '|' + username.toLowerCase();
    const f = loginFails.get(key);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Please wait a minute and try again.');
    const u = sql('SELECT * FROM users WHERE username=? AND active=1').get(username);
    const ok = u ? verifyPassword(String(ctx.body.password ?? ''), u.pass_salt, u.pass_hash) : (verifyPassword('x', DUMMY.salt, DUMMY.hash), false);
    if (!ok) {
      const n = (f?.n || 0) + 1;
      loginFails.set(key, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      throw new HttpError(401, 'Wrong username or password');
    }
    loginFails.delete(key);
    startSession(ctx.res, ctx.req, u);
    return { user: publicUser(u) };
  });
  route('POST', '/api/logout', null, (ctx) => {
    const m = /(?:^|;\s*)bm_session=([^;]+)/.exec(ctx.req.headers.cookie || '');
    if (m) sql('DELETE FROM sessions WHERE token_hash=?').run(sha256(m[1]));
    cookie(ctx.res, ctx.req, 'bm_session', '', 0);
    return { ok: true };
  });
  route('GET', '/api/me', 'any', (ctx) => ({ user: publicUser(ctx.user) }));
  route('POST', '/api/change-password', 'any', (ctx) => {
    const { current_password: cur, new_password: nw } = ctx.body;
    if (!verifyPassword(String(cur ?? ''), ctx.user.pass_salt, ctx.user.pass_hash)) throw new HttpError(403, 'Current password is wrong');
    if (typeof nw !== 'string' || nw.length < 8 || nw.length > 100) throw bad('New password must be at least 8 characters');
    if (nw === cur) throw bad('New password must be different');
    const { salt, hash } = hashPassword(nw);
    sql('UPDATE users SET pass_salt=?, pass_hash=?, must_change=0 WHERE id=?').run(salt, hash, ctx.user.id);
    const m = /(?:^|;\s*)bm_session=([^;]+)/.exec(ctx.req.headers.cookie || '');
    sql('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(ctx.user.id, sha256(m[1]));
    return { ok: true };
  });

  route('GET', '/api/users', 'admin', () => ({ users: sql('SELECT id,username,full_name,role,active,created_at FROM users ORDER BY id').all() }));
  route('POST', '/api/users', 'admin', (ctx) => {
    const username = str(ctx.body.username, 30, 'Username', { required: true });
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) throw bad('Username: 3-30 letters, digits, . _ -');
    const pw = String(ctx.body.password ?? '');
    if (pw.length < 8) throw bad('Password must be at least 8 characters');
    const role = ctx.body.role === 'admin' ? 'admin' : 'staff';
    if (sql('SELECT 1 FROM users WHERE username=?').get(username)) throw new HttpError(409, 'That username is already taken');
    const { salt, hash } = hashPassword(pw);
    const id = sql('INSERT INTO users(username,full_name,role,pass_salt,pass_hash,must_change,created_at) VALUES(?,?,?,?,?,1,?)').run(username, str(ctx.body.full_name, 60, 'Name'), role, salt, hash, new Date().toISOString()).lastInsertRowid;
    return { id };
  });
  route('PUT', '/api/users/:id', 'admin', (ctx) => {
    const id = Number(ctx.params.id);
    const u = sql('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new HttpError(404, 'User not found');
    if (ctx.body.active === false || ctx.body.active === 0) {
      if (id === ctx.user.id) throw bad('You cannot deactivate your own account');
      sql('UPDATE users SET active=0 WHERE id=?').run(id); sql('DELETE FROM sessions WHERE user_id=?').run(id);
    } else if (ctx.body.active === true || ctx.body.active === 1) sql('UPDATE users SET active=1 WHERE id=?').run(id);
    if (ctx.body.password) {
      if (String(ctx.body.password).length < 8) throw bad('Password must be at least 8 characters');
      const { salt, hash } = hashPassword(String(ctx.body.password));
      sql('UPDATE users SET pass_salt=?, pass_hash=?, must_change=1 WHERE id=?').run(salt, hash, id); sql('DELETE FROM sessions WHERE user_id=?').run(id);
    }
    return { ok: true };
  });

  // menu + settings
  const menu = () => ({
    categories: sql('SELECT * FROM categories ORDER BY sort_order, id').all(),
    items: sql('SELECT * FROM items ORDER BY sort_order, id').all(),
  });
  route('GET', '/api/bootstrap', 'any', (ctx) => ({ user: publicUser(ctx.user), settings: pubSettings(), ...menu(), server_time: new Date().toISOString() }));

  route('POST', '/api/categories', 'admin', (ctx) => {
    const name = str(ctx.body.name, 40, 'Category name', { required: true });
    if (sql('SELECT 1 FROM categories WHERE name=?').get(name)) throw new HttpError(409, 'A category with this name already exists');
    const max = sql('SELECT COALESCE(MAX(sort_order),0) m FROM categories').get().m;
    return { id: sql('INSERT INTO categories(name,sort_order,visible) VALUES(?,?,1)').run(name, max + 1).lastInsertRowid };
  });
  route('PUT', '/api/categories/:id', 'admin', (ctx) => {
    const c = sql('SELECT * FROM categories WHERE id=?').get(ctx.params.id);
    if (!c) throw new HttpError(404, 'Category not found');
    const name = ctx.body.name !== undefined ? str(ctx.body.name, 40, 'Category name', { required: true }) : c.name;
    const dup = sql('SELECT id FROM categories WHERE name=?').get(name);
    if (dup && dup.id !== c.id) throw new HttpError(409, 'A category with this name already exists');
    sql('UPDATE categories SET name=?, visible=? WHERE id=?').run(name, ctx.body.visible === undefined ? c.visible : bool(ctx.body.visible), c.id);
    return { ok: true };
  });
  route('DELETE', '/api/categories/:id', 'admin', (ctx) => {
    const n = sql('SELECT COUNT(*) c FROM items WHERE category_id=?').get(ctx.params.id).c;
    if (n) throw new HttpError(409, `This category still has ${n} item(s). Move or delete them first.`);
    sql('DELETE FROM categories WHERE id=?').run(ctx.params.id);
    return { ok: true };
  });
  route('POST', '/api/categories/reorder', 'admin', (ctx) => {
    if (!Array.isArray(ctx.body.ids)) throw bad('ids required');
    tx(() => ctx.body.ids.forEach((id, i) => sql('UPDATE categories SET sort_order=? WHERE id=?').run(i + 1, Number(id))));
    return { ok: true };
  });

  const itemFields = (b, cur = {}) => {
    const name = b.name !== undefined ? str(b.name, 80, 'Item name', { required: true }) : cur.name;
    const price = b.price !== undefined ? intIn(b.price, 0, MAX_PRICE, 'Price') : cur.price;
    let cat = b.category_id !== undefined ? (b.category_id === null ? null : Number(b.category_id)) : cur.category_id;
    if (cat != null && !sql('SELECT 1 FROM categories WHERE id=?').get(cat)) throw bad('Unknown category');
    let image = b.image !== undefined ? String(b.image) : cur.image || '';
    if (image && !/^\/uploads\/[a-f0-9]{24}\.(png|jpg|webp)$/.test(image)) throw bad('Invalid image');
    return { name, price, category_id: cat, image, available: b.available !== undefined ? bool(b.available) : cur.available ?? 1, visible: b.visible !== undefined ? bool(b.visible) : cur.visible ?? 1 };
  };
  route('POST', '/api/items', 'admin', (ctx) => {
    const f = itemFields(ctx.body);
    if (f.price == null) throw bad('Price is required');
    const max = sql('SELECT COALESCE(MAX(sort_order),0) m FROM items').get().m;
    return { id: sql('INSERT INTO items(category_id,name,price,image,available,visible,sort_order) VALUES(?,?,?,?,?,?,?)').run(f.category_id, f.name, f.price, f.image, f.available, f.visible, max + 1).lastInsertRowid };
  });
  route('PUT', '/api/items/:id', 'admin', (ctx) => {
    const cur = sql('SELECT * FROM items WHERE id=?').get(ctx.params.id);
    if (!cur) throw new HttpError(404, 'Item not found');
    const f = itemFields(ctx.body, cur);
    sql('UPDATE items SET category_id=?,name=?,price=?,image=?,available=?,visible=? WHERE id=?').run(f.category_id, f.name, f.price, f.image, f.available, f.visible, cur.id);
    return { ok: true };
  });
  route('DELETE', '/api/items/:id', 'admin', (ctx) => { sql('DELETE FROM items WHERE id=?').run(ctx.params.id); return { ok: true }; });
  route('POST', '/api/items/clear', 'admin', (ctx) => {
    if (ctx.body.confirm !== 'DELETE ALL ITEMS') throw bad('Confirmation text missing');
    return { deleted: sql('DELETE FROM items').run().changes };
  });
  route('POST', '/api/items/reorder', 'admin', (ctx) => {
    if (!Array.isArray(ctx.body.ids)) throw bad('ids required');
    tx(() => ctx.body.ids.forEach((id, i) => sql('UPDATE items SET sort_order=? WHERE id=?').run(i + 1, Number(id))));
    return { ok: true };
  });
  route('POST', '/api/upload', 'admin', (ctx) => ({ url: saveImage(ctx.body.data) }));

  route('GET', '/api/settings', 'any', () => ({ settings: pubSettings() }));
  route('PUT', '/api/settings', 'admin', (ctx) => {
    const b = ctx.body, out = {};
    const put = (k, v) => { out[k] = v; };
    if (b.cafe_name !== undefined) put('cafe_name', str(b.cafe_name, 60, 'Cafe name', { required: true }));
    if (b.address !== undefined) put('address', str(b.address, 200, 'Address'));
    if (b.phone !== undefined) put('phone', str(b.phone, 20, 'Contact number'));
    if (b.footer !== undefined) put('footer', str(b.footer, 100, 'Footer message'));
    if (b.currency !== undefined) put('currency', str(b.currency, 3, 'Currency symbol', { required: true }));
    if (b.payee_name !== undefined) put('payee_name', str(b.payee_name, 50, 'Payee name', { required: true }));
    if (b.upi_ref !== undefined) put('upi_ref', str(b.upi_ref, 30, 'Payment reference'));
    if (b.upi_id !== undefined) { const v = str(b.upi_id, 80, 'UPI ID'); if (v && !isValidVpa(v)) throw bad('UPI ID looks wrong. Example: name@okaxis'); put('upi_id', v); }
    for (const k of ['print_logo', 'gst_enabled', 'round_off']) if (b[k] !== undefined) put(k, bool(b[k]) ? '1' : '0');
    if (b.gst_rate !== undefined) { const r = Number(b.gst_rate); if (!(r >= 0 && r <= 28)) throw bad('GST rate must be between 0 and 28'); put('gst_rate', String(r)); }
    if (b.gst_mode !== undefined) { if (!['exclusive', 'inclusive'].includes(b.gst_mode)) throw bad('Invalid GST mode'); put('gst_mode', b.gst_mode); }
    if (b.gst_number !== undefined) put('gst_number', str(b.gst_number, 20, 'GSTIN'));
    if (b.bill_format !== undefined) {
      const f = str(b.bill_format, 40, 'Bill number format', { required: true });
      if (!/\{SEQ\d?\}/.test(f)) throw bad('Bill number format must include {SEQ4} (or {SEQ}, {SEQ3}, {SEQ5})');
      if (!/^[A-Za-z0-9\-_/{}]+$/.test(f)) throw bad('Bill number format may only contain letters, digits, - _ / and {tokens}');
      put('bill_format', f);
    }
    if (b.logo !== undefined) { if (b.logo && !/^\/uploads\/[a-f0-9]{24}\.(png|jpg|webp)$/.test(b.logo)) throw bad('Invalid logo'); put('logo', b.logo); }
    if (b.printer !== undefined) { const j = JSON.stringify(b.printer || {}); if (j.length > 2000) throw bad('Printer settings too large'); put('printer', j); }
    tx(() => Object.entries(out).forEach(([k, v]) => setSetting(db, k, v)));
    return { settings: pubSettings() };
  });
  // staff may save THEIR printer choice (stored per cafe so a new tablet starts with the same defaults)
  route('PUT', '/api/printer-prefs', 'any', (ctx) => {
    const j = JSON.stringify(ctx.body.printer || {});
    if (j.length > 2000) throw bad('Printer settings too large');
    setSetting(db, 'printer', j);
    return { ok: true };
  });

  // bills
  route('POST', '/api/bills', 'any', (ctx) => { const r = createBill(ctx.body, ctx.user); ctx.status = r.duplicate ? 200 : 201; return r; });
  route('GET', '/api/bills', 'any', (ctx) => {
    const q = ctx.query, where = [], args = [];
    if (q.q) { where.push('(bill_no LIKE ? OR customer_phone LIKE ? OR customer_name LIKE ?)'); const l = '%' + q.q.replace(/[%_]/g, '') + '%'; args.push(l, l, l); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { where.push('local_date >= ?'); args.push(q.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { where.push('local_date <= ?'); args.push(q.to); }
    if (['cash', 'upi', 'other'].includes(q.method)) { where.push('payment_method=?'); args.push(q.method); }
    if (['paid', 'pending'].includes(q.status)) { where.push("payment_status=? AND status='active'"); args.push(q.status); }
    if (q.state === 'void') where.push("status='void'"); else if (q.state === 'active') where.push("status='active'");
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50)), offset = Math.max(0, Number(q.offset) || 0);
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = sql(`SELECT COUNT(*) c FROM bills ${W}`).get(...args).c;
    return { total, bills: loadBills(sql(`SELECT * FROM bills ${W} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)) };
  });
  route('GET', '/api/bills/:id', 'any', (ctx) => { const b = getBill(ctx.params.id); if (!b) throw new HttpError(404, 'Bill not found'); return { bill: b }; });
  route('GET', '/api/bills/by-client/:cid', 'any', (ctx) => { const r = sql('SELECT id FROM bills WHERE client_id=?').get(ctx.params.cid); return { bill: r ? getBill(r.id) : null }; });
  route('POST', '/api/bills/:id/pay', 'any', (ctx) => {
    const b = sql('SELECT * FROM bills WHERE id=?').get(ctx.params.id);
    if (!b) throw new HttpError(404, 'Bill not found');
    if (b.status === 'void') throw new HttpError(409, 'This bill is cancelled');
    if (b.payment_status === 'paid') throw new HttpError(409, 'This bill is already marked Paid');
    if (ctx.body.confirm !== true) throw bad('Please confirm that you have verified the payment');
    const method = ['cash', 'upi', 'other'].includes(ctx.body.method) ? ctx.body.method : b.payment_method;
    const ref = str(ctx.body.reference, 60, 'Payment reference');
    const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    tx(() => {
      sql("UPDATE bills SET payment_status='paid', payment_method=?, paid_at=?, payment_ref=? WHERE id=?").run(method, iso, ref, b.id);
      sql('INSERT INTO payments(bill_id,method,amount,reference,recorded_by,recorded_at,source) VALUES(?,?,?,?,?,?,?)').run(b.id, method, b.grand_total, ref, ctx.user.username, iso, 'manual-verified');
    });
    return { bill: getBill(b.id) };
  });
  // ---------------- online payment links (Razorpay / Cashfree) ---------------------------------
  // A bill becomes PAID here only when the gateway itself says so (signed webhook + server-to-server check).
  const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const inflight = new Map();
  function applyGatewayResult(link, r) {
    const b = sql('SELECT * FROM bills WHERE id=?').get(link.bill_id);
    if (r.status === 'paid') {
      if (link.status === 'paid') return 'already_paid';
      if (r.amountPaid !== b.grand_total || link.amount !== b.grand_total || r.amount !== b.grand_total) {
        sql("UPDATE payment_links SET status='amount_mismatch', updated_at=?, note=? WHERE id=?").run(isoNow(), `gateway amount ${r.amount}/${r.amountPaid} vs bill ${b.grand_total}`, link.id);
        console.warn(`[payments] amount mismatch on ${b.bill_no}; bill NOT marked paid`);
        return 'amount_mismatch';
      }
      return tx(() => {
        const t = isoNow(), fresh = sql('SELECT * FROM bills WHERE id=?').get(b.id);
        if (fresh.status === 'void') { sql("UPDATE payment_links SET status='paid_on_void', paid_at=?, updated_at=?, gateway_payment_id=? WHERE id=?").run(t, t, r.paymentId || '', link.id); console.warn(`[payments] ${fresh.bill_no} was paid online but the bill is cancelled - refund needed`); return 'paid_on_void'; }
        if (fresh.payment_status === 'paid') { sql("UPDATE payment_links SET status='paid_duplicate', paid_at=?, updated_at=?, gateway_payment_id=? WHERE id=?").run(t, t, r.paymentId || '', link.id); console.warn(`[payments] ${fresh.bill_no} was already marked paid; online payment received too - check for a refund`); return 'paid_duplicate'; }
        const method = r.method === 'upi' ? 'upi' : 'other', ref = r.paymentId || link.reference;
        sql("UPDATE bills SET payment_status='paid', payment_method=?, paid_at=?, payment_ref=? WHERE id=?").run(method, t, ref, b.id);
        sql('INSERT INTO payments(bill_id,method,amount,reference,recorded_by,recorded_at,source) VALUES(?,?,?,?,?,?,?)').run(b.id, method, b.grand_total, ref, 'gateway', t, 'gateway-' + link.provider);
        sql("UPDATE payment_links SET status='paid', paid_at=?, updated_at=?, gateway_payment_id=? WHERE id=?").run(t, t, r.paymentId || '', link.id);
        return 'paid';
      });
    }
    if ((r.status === 'expired' || r.status === 'cancelled') && link.status !== 'paid') { sql('UPDATE payment_links SET status=?, updated_at=? WHERE id=?').run(r.status, isoNow(), link.id); return r.status; }
    return 'unchanged';
  }

  route('POST', '/api/bills/:id/payment-link', 'any', async (ctx) => {
    if (!gw.enabled) throw new HttpError(503, 'Online payment is not set up yet. The owner needs to add the payment gateway keys on the server.');
    const b = sql('SELECT * FROM bills WHERE id=?').get(ctx.params.id);
    if (!b) throw new HttpError(404, 'Bill not found');
    if (b.status === 'void') throw new HttpError(409, 'This bill is cancelled');
    if (b.payment_status === 'paid') throw new HttpError(409, 'This bill is already Paid');
    if (b.grand_total < 100) throw bad('Online payment needs a bill of at least ₹1');
    while (inflight.has(b.id)) await inflight.get(b.id).catch(() => {});
    const job = (async () => {
      const live = sql("SELECT * FROM payment_links WHERE bill_id=? AND provider=? AND amount=? AND status IN ('created','partial') AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC").get(b.id, gw.provider, b.grand_total, isoNow());
      if (live) return;
      const n = sql('SELECT COUNT(*) c FROM payment_links WHERE bill_id=?').get(b.id).c + 1;
      const reference = `${b.bill_no}-P${n}`.slice(0, 40), linkKey = reference.replace(/[^A-Za-z0-9_-]/g, '-');
      const hours = Math.min(24 * 30, Math.max(1, Number(process.env.PAYMENT_LINK_EXPIRY_HOURS) || 72)), expiresAt = Date.now() + hours * 3600_000;
      const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      let made;
      try { made = await createLink(gw, { linkKey, reference, amountPaise: b.grand_total, description: `${getSettings(db).cafe_name} - Bill ${b.bill_no}`, customer: { phone: b.customer_phone, name: b.customer_name }, returnUrl: base ? base + '/pay-return.html' : '', expiresAt }); }
      catch (e) { if (e instanceof GatewayError) throw new HttpError(502, e.message); throw e; }
      sql('INSERT INTO payment_links(bill_id,provider,link_id,short_url,reference,amount,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(b.id, gw.provider, made.linkId, made.url, reference, b.grand_total, 'created', isoNow(), new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    })();
    inflight.set(b.id, job);
    try { await job; } finally { inflight.delete(b.id); }
    return { bill: getBill(b.id) };
  });

  // "Check payment status": asks the gateway directly. Staff cannot use this to force a bill to Paid.
  route('POST', '/api/bills/:id/payment-link/check', 'any', async (ctx) => {
    if (!gw.enabled) throw new HttpError(503, 'Online payment is not set up on this server');
    const link = sql('SELECT * FROM payment_links WHERE bill_id=? ORDER BY id DESC').get(ctx.params.id);
    if (!link) throw new HttpError(404, 'This bill has no payment link');
    let g; try { g = await fetchLink(gw, link.link_id); } catch (e) { if (e instanceof GatewayError) throw new HttpError(502, e.message); throw e; }
    const outcome = applyGatewayResult(link, g);
    return { outcome, bill: getBill(link.bill_id) };
  });

  // Gateway -> server notification. Public URL, protected by the signature, never by cookies.
  route('POST', '/api/webhooks/payments', null, async (ctx) => {
    if (!gw.enabled) throw new HttpError(503, 'Online payment is not enabled');
    const v = verifyWebhook(gw, ctx.req.headers, ctx.raw || Buffer.alloc(0));
    if (!v.ok) throw new HttpError(v.malformed ? 400 : 401, 'Invalid webhook');
    if (!sql('INSERT OR IGNORE INTO webhook_events(event_key,provider,received_at) VALUES(?,?,?)').run(v.eventKey, gw.provider, isoNow()).changes) return { ok: true, duplicate: true };
    const done = (outcome, extra = {}) => { sql('UPDATE webhook_events SET outcome=? WHERE event_key=?').run(outcome, v.eventKey); return { ok: true, outcome, ...extra }; };
    try {
      const link = sql('SELECT * FROM payment_links WHERE link_id=?').get(v.linkId);
      if (!link) return done('unknown_link');
      if (v.type === 'other') return done('ignored');
      let r = v;
      if (v.type === 'paid') { // never trust the notification alone: confirm with the gateway, server to server
        const g = await fetchLink(gw, link.link_id);
        if (g.status !== 'paid') return done('not_paid_at_gateway');
        r = { ...g, paymentId: g.paymentId || v.paymentId, method: g.method || v.method };
      } else r = { status: v.type };
      return done(applyGatewayResult(link, r));
    } catch (e) {
      sql('DELETE FROM webhook_events WHERE event_key=?').run(v.eventKey); // let the gateway retry later
      console.error('[payments] webhook processing failed:', e.message);
      throw new HttpError(503, 'Temporary problem, please retry');
    }
  });

  route('POST', '/api/bills/:id/void', 'any', (ctx) => {
    const b = sql('SELECT * FROM bills WHERE id=?').get(ctx.params.id);
    if (!b) throw new HttpError(404, 'Bill not found');
    if (b.status === 'void') throw new HttpError(409, 'Bill is already cancelled');
    const reason = str(ctx.body.reason, 200, 'Reason', { required: true });
    const admin = adminPasswordOk(String(ctx.body.admin_password ?? ''));
    if (!admin) throw new HttpError(403, 'Admin password is wrong. Only an admin can cancel a bill.');
    sql("UPDATE bills SET status='void', void_reason=?, voided_at=?, voided_by=?, void_authorized_by=? WHERE id=?").run(reason, new Date().toISOString(), ctx.user.username, admin.username, b.id);
    return { bill: getBill(b.id) };
  });

  route('GET', '/api/reports', 'any', (ctx) => report(ctx.user.role === 'admin' ? ctx.query : { from: istDate(), to: istDate(), group: 'day' })); // staff: today only
  route('GET', '/api/reports/export', 'admin', (ctx) => {
    const q = ctx.query, base = `bite-and-melt-${q.type === 'items' ? 'items' : 'bills'}-${range(q).join('_to_')}`;
    if (q.format === 'xlsx') {
      const rows = exportTable(q).map((r, i) => i === 0 ? r : r.map((v) => (typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v) ? Number(v) : v)));
      return { __raw: createXlsx([{ name: 'Bite and Melt', rows }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: base + '.xlsx' };
    }
    return { __raw: exportCsv(q), type: 'text/csv; charset=utf-8', filename: base + '.csv' };
  });
  route('GET', '/api/backup', 'admin', (ctx) => {
    const tmp = path.join(DATA_DIR, 'backups', `download-${Date.now()}.db`);
    backupTo(db, tmp);
    const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
    return { __raw: buf, type: 'application/octet-stream', filename: `bite-and-melt-backup-${istDate()}.db` };
  });

  // ---- WhatsApp bill link: the phone uploads the receipt image it just drew; customers open /b/<token> (public, unguessable).
  const origin = (req) => `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
  route('POST', '/api/bills/:id/share-link', 'any', (ctx) => {
    const b = sql('SELECT id, status, public_token FROM bills WHERE id=?').get(ctx.params.id);
    if (!b) throw new HttpError(404, 'Bill not found');
    if (b.status === 'void') throw bad('A cancelled bill cannot be shared');
    const png = Buffer.from(String(ctx.body.png || ''), 'base64');
    if (png.length < 200 || png.length > 2_000_000 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw bad('Receipt image is not a valid PNG');
    const token = b.public_token || crypto.randomBytes(15).toString('base64url');
    if (!b.public_token) sql('UPDATE bills SET public_token=? WHERE id=?').run(token, b.id);
    fs.writeFileSync(path.join(DATA_DIR, 'receipts', token + '.png'), png);
    return { ok: true, token, url: `${origin(ctx.req)}/b/${token}` };
  });

  // Restore bills/menu/settings from a backup (.db) downloaded earlier. Users and logins are NOT touched (the current admin stays logged in).
  route('POST', '/api/restore', 'admin', (ctx) => {
    const b64 = String(ctx.body.data || '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100 || buf.subarray(0, 15).toString() !== 'SQLite format 3') throw bad('This is not a Bite and Melt backup (.db) file');
    const tmp = path.join(DATA_DIR, 'backups', `restore-upload-${Date.now()}.db`);
    fs.writeFileSync(tmp, buf);
    const q = (f) => "'" + f.replace(/'/g, "''") + "'";
    let attached = false;
    try {
      const probe = new DatabaseSync(tmp);
      try {
        const ic = probe.prepare('PRAGMA integrity_check').get();
        if (!ic || Object.values(ic)[0] !== 'ok') throw bad('Backup file is damaged');
        probe.prepare('SELECT COUNT(*) FROM bills').get(); probe.prepare('SELECT COUNT(*) FROM items').get();
      } catch (e) { if (e instanceof HttpError) throw e; throw bad('This is not a Bite and Melt backup (.db) file'); } finally { probe.close(); }
      backupTo(db, path.join(DATA_DIR, 'backups', `pre-restore-${Date.now()}.db`)); // safety copy of what is there now
      db.exec(`ATTACH DATABASE ${q(tmp)} AS bk`); attached = true;
      const cols = (schema, t) => db.prepare(`PRAGMA ${schema}.table_info(${t})`).all().map((c) => c.name);
      const order = ['categories', 'items', 'counters', 'bills', 'bill_items', 'payments', 'payment_links', 'webhook_events', 'settings'];
      const have = order.filter((t) => cols('bk', t).length);
      const counts = {};
      tx(() => {
        for (const t of [...have].reverse()) db.exec(`DELETE FROM main.${t}`);
        for (const t of have) {
          const mine = new Set(cols('main', t)), common = cols('bk', t).filter((c) => mine.has(c)).join(',');
          db.exec(`INSERT INTO main.${t}(${common}) SELECT ${common} FROM bk.${t}`);
          counts[t] = db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n;
        }
      });
      return { ok: true, bills: counts.bills || 0, items: counts.items || 0 };
    } finally {
      if (attached) { try { db.exec('DETACH DATABASE bk'); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  // ---------------- http plumbing -------------------------------------------
  async function readBody(req, ctx, limit = 3_000_000) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Request too large'); chunks.push(c); }
    const raw = Buffer.concat(chunks); if (ctx) ctx.raw = raw;
    if (!n) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch { throw bad('Invalid JSON'); }
  }
  const secHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" };

  async function handleApi(req, res, url) {
    const query = Object.fromEntries(url.searchParams);
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json') && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined)
      throw new HttpError(415, 'Content-Type must be application/json');
    const ctx = { req, res, query, params: r.re.exec(url.pathname).groups || {}, ip: req.socket.remoteAddress, status: 200, body: {} };
    if (r.auth) {
      ctx.user = authUser(req);
      if (!ctx.user) throw new HttpError(401, 'Please log in');
      if (r.auth === 'admin' && ctx.user.role !== 'admin') throw new HttpError(403, 'Admin access required');
    }
    if (req.method !== 'GET') ctx.body = await readBody(req, ctx, url.pathname === '/api/restore' ? 60_000_000 : undefined);
    const out = await r.handler(ctx);
    if (out && out.__raw !== undefined) {
      res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store', ...secHeaders });
      return res.end(out.__raw);
    }
    res.writeHead(ctx.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...secHeaders });
    res.end(JSON.stringify(out));
  }

  // Brand images. Logo: admin-uploaded logo (Settings) -> public/brand/logo.png -> 404 (the app then shows its built-in logo).
  // Favicon: public/brand/favicon.png -> admin logo -> public/brand/logo.png -> built-in icon.
  function serveBrand(res, kind) {
    const dir = path.join(PUBLIC_DIR, 'brand'), up = getSettings(db).logo;
    const list = [];
    if (kind === 'favicon') list.push(path.join(dir, 'favicon.png'));
    if (up && /^\/uploads\/[a-f0-9]{24}\.(png|jpg|webp)$/.test(up)) list.push(path.join(DATA_DIR, 'uploads', path.basename(up)));
    list.push(path.join(dir, 'logo.png'));
    if (kind === 'favicon') list.push(path.join(PUBLIC_DIR, 'icons', 'icon-192.png'));
    const file = list.find((f) => fs.existsSync(f));
    if (!file) { res.writeHead(404, { 'Cache-Control': 'no-cache', ...secHeaders }); return res.end('No custom logo'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'image/png', 'Cache-Control': 'no-cache', ...secHeaders });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    let base = PUBLIC_DIR;
    if (rel.startsWith('/uploads/')) { base = path.join(DATA_DIR, 'uploads'); rel = rel.slice('/uploads'.length); }
    let file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep) && file !== base) { res.writeHead(403); return res.end('Forbidden'); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) { res.writeHead(404, secHeaders); return res.end('Not found'); }
      file = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    const isUpload = base !== PUBLIC_DIR;
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': isUpload ? 'public, max-age=31536000, immutable' : 'no-cache', ...secHeaders });
    fs.createReadStream(file).pipe(res);
  }


  // Public bill page + image for customers (no login). Only unguessable tokens; cancelled bills are not shown.
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function servePublicBill(req, res, url) {
    const m = /^\/b\/([A-Za-z0-9_-]{16,40})(\.png)?$/.exec(url.pathname);
    if (!m) return false;
    const pubHeaders = { ...secHeaders, 'X-Robots-Tag': 'noindex, nofollow' };
    const b = db.prepare("SELECT bill_no, grand_total, status FROM bills WHERE public_token=?").get(m[1]);
    const file = path.join(DATA_DIR, 'receipts', m[1] + '.png');
    if (!b || b.status === 'void' || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...pubHeaders });
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bill not available</title><body style="font-family:system-ui;text-align:center;padding:3rem 1rem"><h2>This bill link is no longer available</h2><p>Please ask the cafe to send it again.</p></body>');
      return true;
    }
    if (m[2]) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', ...pubHeaders });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
      return true;
    }
    const cafe = getSettings(db).cafe_name || 'BITE AND MELT';
    const img = `${origin(req)}/b/${m[1]}.png`;
    const title = `${cafe} - Bill ${b.bill_no}`;
    const total = (b.grand_total / 100).toFixed(2);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...pubHeaders });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex,nofollow">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="Total Rs. ${esc(total)}. Thank you for visiting!">
<meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary">
<style>body{margin:0;background:#eaf6ff;font-family:system-ui,sans-serif;text-align:center;color:#12213a}main{max-width:420px;margin:0 auto;padding:16px}img{width:100%;height:auto;background:#fff;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.12)}a.b{display:inline-block;margin:14px 0 24px;padding:12px 22px;background:#ffc629;color:#12213a;font-weight:700;border-radius:999px;text-decoration:none}</style></head>
<body><main><h2>${esc(cafe)}</h2><p>Bill ${esc(b.bill_no)} &middot; Total &#8377;${esc(total)}</p><img src="/b/${m[1]}.png" alt="Bill ${esc(b.bill_no)}"><br><a class="b" href="/b/${m[1]}.png" download="Bill-${esc(b.bill_no)}.png">Download bill</a></main></body></html>`);
    return true;
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/b/') && servePublicBill(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/brand/logo.png' || url.pathname === '/brand/favicon.png')) serveBrand(res, url.pathname.includes('favicon') ? 'favicon' : 'logo');
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else throw new HttpError(405, 'Method not allowed');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...secHeaders });
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on the server. Please try again.' : e.message }));
    }
  });
}

export function backupTo(db, file) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
export function runBackup(db, keep = 30) {
  const d = new Date(Date.now() + 330 * 60000).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const dir = path.join(DATA_DIR, 'backups');
  const file = path.join(dir, `auto-${d}.db`);
  if (!fs.existsSync(file)) backupTo(db, file);
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('auto-')).sort();
  all.slice(0, Math.max(0, all.length - keep)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  return file;
}
