// Bulk-attach food photos.  Name each photo like the menu item (any case; spaces, - or _ are ignored):
//   "Veg Burger.jpg"  or  veg-burger.jpg  ->  menu item "Veg Burger"
// Usage:  node --no-warnings scripts/import-images.js /path/to/photos      (add --dry to only show the matches)
// Set DATA_DIR if your data is not in ./data. Existing images are replaced only for matched items. Nothing else changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, DATA_DIR } from '../server/db.js';

const dir = process.argv[2], dry = process.argv.includes('--dry');
if (!dir || !fs.existsSync(dir)) { console.log('Usage: node --no-warnings scripts/import-images.js <folder-with-photos> [--dry]'); process.exit(1); }
const norm = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '');
const db = openDb();
const items = db.prepare('SELECT id,name FROM items').all();
const byName = new Map(items.map((i) => [norm(i.name), i]));
const kind = (b) => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b.subarray(0, 4).toString() === 'RIFF' ? 'webp' : null);
let ok = 0;
for (const f of fs.readdirSync(dir)) {
  if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
  const item = byName.get(norm(f));
  if (!item) { console.log('  no menu item matches:', f); continue; }
  const buf = fs.readFileSync(path.join(dir, f)), ext = kind(buf);
  if (!ext) { console.log('  not a real image:', f); continue; }
  if (buf.length > 1_500_000) { console.log('  too large (max 1.5 MB), resize it first:', f); continue; }
  console.log(`  ${dry ? 'would set' : 'set'} "${item.name}" <- ${f}`);
  if (dry) { ok++; continue; }
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
  db.prepare('UPDATE items SET image=? WHERE id=?').run('/uploads/' + name, item.id); ok++;
}
console.log(`${ok} photo(s) ${dry ? 'matched' : 'attached'}.`);
