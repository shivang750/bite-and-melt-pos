import crypto from 'node:crypto';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  const e = Buffer.from(hash, 'hex');
  return e.length === h.length && crypto.timingSafeEqual(h, e);
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export function randomPassword(n = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
}
export const DUMMY = hashPassword('dummy-password-for-timing');

export function ensureAdmin(db) {
  const n = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
  if (n) return null;
  const username = 'admin';
  const password = process.env.BM_ADMIN_PASSWORD || randomPassword();
  const { salt, hash } = hashPassword(password);
  db.prepare("INSERT OR REPLACE INTO users(id,username,full_name,role,pass_salt,pass_hash,must_change,created_at) VALUES((SELECT id FROM users WHERE username='admin'),?,?,?,?,?,?,?)")
    .run(username, 'Administrator', 'admin', salt, hash, process.env.BM_ADMIN_PASSWORD ? 0 : 1, new Date().toISOString());
  return { username, password, generated: !process.env.BM_ADMIN_PASSWORD };
}
