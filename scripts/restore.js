// Restore a database backup.  STOP THE SERVER FIRST, then:
//   node --no-warnings scripts/restore.js /path/to/backup.db
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('Usage: node --no-warnings scripts/restore.js /path/to/backup.db'); process.exit(1); }
const check = new DatabaseSync(src, { readOnly: true });
try {
  const have = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const missing = ['bills', 'bill_items', 'items', 'categories', 'users', 'settings'].filter((t) => !have.includes(t));
  if (missing.length) throw new Error('not a BITE AND MELT backup (missing: ' + missing.join(', ') + ')');
  if (Object.values(check.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('backup failed the integrity check');
} catch (e) { console.error('Refusing to restore:', e.message); process.exit(1); } finally { check.close(); }
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const dest = path.join(dataDir, 'bitemelt.db');
fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(dest)) { const keep = `${dest}.before-restore-${Date.now()}`; fs.copyFileSync(dest, keep); console.log('Current database kept as', keep); }
for (const x of ['-wal', '-shm']) fs.rmSync(dest + x, { force: true });
fs.copyFileSync(src, dest);
console.log(`Restored ${src} -> ${dest}\nStart the server again.`);
