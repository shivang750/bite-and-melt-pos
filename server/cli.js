// Recovery tool:  node server/cli.js reset-password <username> <new-password>
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
const [cmd, user, pass] = process.argv.slice(2);
if (cmd !== 'reset-password' || !user || !pass || pass.length < 8) {
  console.log('Usage: node --no-warnings server/cli.js reset-password <username> <new-password (min 8 chars)>');
  process.exit(1);
}
const db = openDb();
const { salt, hash } = hashPassword(pass);
const r = db.prepare('UPDATE users SET pass_salt=?, pass_hash=?, must_change=0, active=1 WHERE username=?').run(salt, hash, user);
if (!r.changes) { console.log('No such user: ' + user); process.exit(1); }
db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)').run(user);
console.log('Password updated for ' + user);
