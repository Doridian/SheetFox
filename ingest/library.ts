import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SheetFile } from "../src/schema";

export const LIBRARY_DIR = path.resolve(process.cwd(), "library");

export interface IndexEntry {
  id: string;
  title: string;
  partNumber: string;
  manufacturer: string;
  category: string;
  file: string; // relative to library/
  source: string | null;
  sha256: string | null;
}

export const sha256 = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");

export function listSheets(): { dir: string; file: SheetFile; path: string }[] {
  if (!fs.existsSync(LIBRARY_DIR)) return [];
  const out: { dir: string; file: SheetFile; path: string }[] = [];
  for (const d of fs.readdirSync(LIBRARY_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(LIBRARY_DIR, d.name, "sheet.json");
    if (!fs.existsSync(p)) continue;
    const parsed = SheetFile.safeParse(JSON.parse(fs.readFileSync(p, "utf8")));
    if (parsed.success) out.push({ dir: d.name, file: parsed.data, path: p });
    else console.warn(`skipping ${p}: ${parsed.error.issues[0]?.message}`);
  }
  return out;
}

export function findBySha(hash: string) {
  return listSheets().find((s) => s.file.source.sha256 === hash);
}

export function rebuildIndex() {
  const entries: IndexEntry[] = listSheets().map(({ dir, file }) => {
    const src = file.source.fileName;
    return {
      id: file.sheet.meta.id,
      title: file.sheet.meta.title,
      partNumber: file.sheet.meta.partNumber,
      manufacturer: file.sheet.meta.manufacturer,
      category: file.sheet.meta.category,
      file: `${dir}/sheet.json`,
      // prefer a local copy of the PDF (not in git), else the original download URL
      source: fs.existsSync(path.join(LIBRARY_DIR, dir, src)) ? `${dir}/${src}` : file.source.url ?? null,
      sha256: file.source.sha256,
    };
  });
  entries.sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(path.join(LIBRARY_DIR, "index.json"), JSON.stringify(entries, null, 2) + "\n");
  return entries;
}
