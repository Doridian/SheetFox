import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SheetFile } from '../src/schema';

export const LIBRARY_DIR = path.resolve(process.cwd(), 'library');

export interface IndexEntry {
  id: string;
  title: string;
  partNumber: string;
  manufacturer: string;
  category: string;
  // relative to library/
  file: string;
  source: string | null;
  sha256: string | null;
}

export const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

export interface LibrarySheet {
  dir: string;
  file: SheetFile;
  path: string;
}

export function listSheets(libraryDir = LIBRARY_DIR): LibrarySheet[] {
  if (!fs.existsSync(libraryDir)) return [];
  const out: LibrarySheet[] = [];
  const dirents = fs.readdirSync(libraryDir, { withFileTypes: true });
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const p = path.join(libraryDir, d.name, 'sheet.json');
    if (!fs.existsSync(p)) continue;
    const parsed = SheetFile.safeParse(JSON.parse(fs.readFileSync(p, 'utf8')));
    if (parsed.success) out.push({ dir: d.name, file: parsed.data, path: p });
    else console.warn(`skipping ${p}: ${parsed.error.issues[0]?.message}`);
  }
  return out;
}

export function findBySha(hash: string, libraryDir = LIBRARY_DIR): LibrarySheet | undefined {
  return listSheets(libraryDir).find((s) => s.file.source.sha256 === hash);
}

/** Index entries for every sheet in a library directory, sorted by title. */
export function buildIndex(libraryDir = LIBRARY_DIR): IndexEntry[] {
  const entries: IndexEntry[] = listSheets(libraryDir).map(({ dir, file }) => {
    const src = file.source.fileName;
    return {
      id: file.sheet.meta.id,
      title: file.sheet.meta.title,
      partNumber: file.sheet.meta.partNumber,
      manufacturer: file.sheet.meta.manufacturer,
      category: file.sheet.meta.category,
      file: `${dir}/sheet.json`,
      // prefer a local copy of the PDF (not in git), else the original download URL
      source: fs.existsSync(path.join(libraryDir, dir, src)) ? `${dir}/${src}` : (file.source.url ?? null),
      sha256: file.source.sha256,
    };
  });
  entries.sort((a, b) => a.title.localeCompare(b.title));
  return entries;
}

export function rebuildIndex(libraryDir = LIBRARY_DIR): IndexEntry[] {
  const entries = buildIndex(libraryDir);
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}
