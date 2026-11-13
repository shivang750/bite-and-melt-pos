// Static check: every `import {x} from './file.js'` in public/js must match a real export of that file (and path/case must exist).
import fs from 'node:fs'; import path from 'node:path';
const root = new URL('../public/js/', import.meta.url).pathname; let bad = 0, count = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
const exportsOf = (src) => { const names = new Set(); for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]); for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) m[1].split(',').forEach((x) => names.add(x.trim().split(/\s+as\s+/).pop())); if (/export\s+default/.test(src)) names.add('default'); return names; };
for (const f of walk(root)) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*'(\.[^']+)'/g)) {
    const target = path.resolve(path.dirname(f), m[3]);
    const real = fs.existsSync(target) && fs.readdirSync(path.dirname(target)).includes(path.basename(target)); // exact-case match
    if (!real) { console.error(`  ✗ ${path.relative(root, f)}: cannot find ${m[3]}`); bad++; continue; }
    const have = exportsOf(fs.readFileSync(target, 'utf8'));
    for (const n of (m[2] || '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) { count++; if (!have.has(n)) { console.error(`  ✗ ${path.relative(root, f)}: '${n}' is not exported by ${m[3]}`); bad++; } }
  }
}
console.log(bad ? `${bad} import problem(s)` : `  ✓ all ${count} named imports match real exports`); process.exit(bad ? 1 : 0);
