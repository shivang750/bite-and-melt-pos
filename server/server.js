import { openDb } from './db.js';
import { createApp, runBackup } from './app.js';
import { ensureAdmin } from './auth.js';

const db = openDb();
const created = ensureAdmin(db);
if (created) {
  console.log('\n==============================================================');
  console.log(' BITE AND MELT POS - first run');
  console.log(` Admin login:  username: ${created.username}   password: ${created.password}`);
  console.log(created.generated ? ' You will be asked to change this password after you log in.' : ' (password taken from BM_ADMIN_PASSWORD)');
  console.log('==============================================================\n');
}
try { runBackup(db); } catch (e) { console.error('Backup failed:', e.message); }
setInterval(() => { try { runBackup(db); } catch (e) { console.error('Backup failed:', e.message); } }, 6 * 3600 * 1000).unref();

// PORT is a number on most hosts; cPanel/Passenger style hosts may give a socket path or manage the port themselves.
const rawPort = process.env.PORT;
const app = createApp(db);
if (rawPort && !/^\d+$/.test(rawPort)) app.listen(rawPort, () => console.log(`BITE AND MELT POS running (${rawPort})`));
else { const port = Number(rawPort || 3000); app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`BITE AND MELT POS running on http://localhost:${port}`)); }
