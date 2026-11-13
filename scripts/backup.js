// Manual backup:  node --no-warnings scripts/backup.js [output.db]
import path from 'node:path';
import fs from 'node:fs';
import { openDb, DATA_DIR } from '../server/db.js';
import { backupTo } from '../server/app.js';
const out = path.resolve(process.argv[2] || path.join(DATA_DIR, 'backups', `manual-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
fs.mkdirSync(path.dirname(out), { recursive: true });
backupTo(openDb(), out);
console.log('Backup written to', out);
