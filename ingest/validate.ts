/** npm run validate [-- file.json ...]  – validate sheet files and rebuild library/index.json */
import fs from 'node:fs';
import path from 'node:path';
import { validateSheet } from '../src/engine';
import { SheetFile } from '../src/schema';
import { LIBRARY_DIR, rebuildIndex } from './library';

const files = process.argv.slice(2);
const targets = files.length
  ? files
  : fs
      .readdirSync(LIBRARY_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(LIBRARY_DIR, d.name, 'sheet.json')))
      .map((d) => path.join(LIBRARY_DIR, d.name, 'sheet.json'));

let failed = false;
for (const f of targets) {
  const parsed = SheetFile.safeParse(JSON.parse(fs.readFileSync(f, 'utf8')));
  if (!parsed.success) {
    failed = true;
    console.log(`✗ ${f}: schema`);
    for (const i of parsed.error.issues.slice(0, 20)) console.log(`   ${i.path.join('.')}: ${i.message}`);
    continue;
  }
  const issues = validateSheet(parsed.data.sheet);
  const errs = issues.filter((i) => i.severity === 'error');
  if (errs.length) failed = true;
  const s = parsed.data.sheet;
  console.log(
    `${errs.length ? '✗' : '✓'} ${path.relative(process.cwd(), f)}  (${s.parameters.length} params, ${s.tables.length} tables, ${s.curves.length} curves, ${s.patterns.length} patterns, ${s.calculators.reduce((n, c) => n + c.outputs.length, 0)} outputs)`,
  );
  for (const i of issues) console.log(`   [${i.severity}] ${i.path}: ${i.message}`);
  const dir = path.basename(path.dirname(path.resolve(f)));
  if (!path.resolve(f).startsWith(path.resolve(LIBRARY_DIR)) || dir === s.meta.id) {
    continue;
  }

  failed = true;
  console.log(`   [error] library dir "${dir}" must equal meta.id "${s.meta.id}" (the viewer routes by id)`);
}
if (!files.length) rebuildIndex();
process.exit(failed ? 1 : 0);
