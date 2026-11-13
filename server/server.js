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

const port = Number(process.env.PORT || 3000);
createApp(db).listen(port, process.env.HOST || '0.0.0.0', () => console.log(`BITE AND MELT POS running on http://localhost:${port}`));
