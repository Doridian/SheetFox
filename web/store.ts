import { z } from 'zod';
import { errorMessage } from '../src/engine';
import { type Cell, FORMAT_VERSION, SheetFile, UserState } from '../src/schema';

export interface LibraryEntry {
  id: string;
  title: string;
  partNumber: string;
  manufacturer: string;
  category: string;
  file: string;
  source: string | null;
  /** "library" = bundled in library/, "local" = uploaded into this browser */
  origin: 'library' | 'local';
}

const LOCAL_KEY = 'sheetfox:uploaded';
const stateKey = (id: string): string => `sheetfox:state:${id}`;

const LibraryIndex = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    partNumber: z.string(),
    manufacturer: z.string(),
    category: z.string(),
    file: z.string(),
    source: z.string().nullable(),
  }),
);
// Already validated by parseSheetFile() before being stored
const UploadedSheets = z.record(z.string(), z.custom<SheetFile>());

function parseStored<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (raw === null) return null;
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* quota/private mode */
  }
};
const lsDel = (k: string): void => {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
};

export async function loadLibrary(): Promise<LibraryEntry[]> {
  let lib: LibraryEntry[] = [];
  try {
    const res = await fetch('index.json', { cache: 'no-cache' });
    if (res.ok) lib = LibraryIndex.parse(await res.json()).map((e) => ({ ...e, origin: 'library' as const }));
  } catch {
    /* static hosting without library */
  }
  const local = Object.values(uploadedSheets())
    .filter((f) => f !== undefined)
    .map((f): LibraryEntry => ({
      id: f.sheet.meta.id,
      title: f.sheet.meta.title,
      partNumber: f.sheet.meta.partNumber,
      manufacturer: f.sheet.meta.manufacturer,
      category: f.sheet.meta.category,
      file: '',
      source: f.source.url ?? null,
      origin: 'local',
    }));
  const ids = new Set(local.map((l) => l.id));
  return [...local, ...lib.filter((l) => !ids.has(l.id))];
}

function uploadedSheets(): Partial<Record<string, SheetFile>> {
  return parseStored(UploadedSheets, lsGet(LOCAL_KEY)) ?? {};
}

export function removeUploaded(id: string): void {
  const remaining = Object.entries(uploadedSheets()).filter(([k]) => k !== id);
  lsSet(LOCAL_KEY, JSON.stringify(Object.fromEntries(remaining)));
}

export async function loadSheet(entry: LibraryEntry): Promise<SheetFile> {
  if (entry.origin === 'local') {
    const f = uploadedSheets()[entry.id];
    if (!f) throw new Error('uploaded sheet not found');
    return f;
  }
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`failed to load ${entry.file}: ${res.status}`);
  return parseSheetFile(await res.text());
}

export function parseSheetFile(text: string): SheetFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Not JSON: ${errorMessage(error)}`, { cause: error });
  }
  const r = SheetFile.safeParse(json);
  if (!r.success) {
    const [issue] = r.error.issues;
    throw new Error(`Not a valid SheetFox file (${issue.path.join('.')}: ${issue.message})`);
  }
  if (r.data.formatVersion > FORMAT_VERSION)
    throw new Error(`File format v${r.data.formatVersion} is newer than this viewer (v${FORMAT_VERSION})`);
  return r.data;
}

/** Store an uploaded file in this browser and return its library entry id. */
export function importSheet(file: SheetFile): string {
  const all = uploadedSheets();
  all[file.sheet.meta.id] = { ...file, userState: null };
  lsSet(LOCAL_KEY, JSON.stringify(all));
  if (file.userState) saveState(file.sheet.meta.id, file.userState);
  return file.sheet.meta.id;
}

export function loadState(id: string): UserState | null {
  return parseStored(UserState, lsGet(stateKey(id)));
}
export function saveState(id: string, s: UserState): void {
  lsSet(stateKey(id), JSON.stringify(s));
}
export function clearState(id: string): void {
  lsDel(stateKey(id));
}

export function downloadSheet(file: SheetFile, state: UserState | null): void {
  const out: SheetFile = {
    ...file,
    userState:
      state && (Object.keys(state.variables ?? {}).length || Object.keys(state.tables ?? {}).length) ? state : null,
  };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${file.sheet.meta.id}.sheet.json`;
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
  }, 1000);
}

export function parseCell(text: string): Cell {
  const t = text.trim();
  if (['', '-', '—'].includes(t)) return null;
  if (/^0x[0-9a-f]+$/i.test(t)) return t;
  const n = Number(t.replace(/^\+/, '').replaceAll(/[−–]/g, '-'));
  return Number.isFinite(n) ? n : t;
}
