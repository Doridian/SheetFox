import { SheetFile, FORMAT_ID, FORMAT_VERSION, type Cell, type UserState } from "../src/schema";

export interface LibraryEntry {
  id: string;
  title: string;
  partNumber: string;
  manufacturer: string;
  category: string;
  file: string;
  source: string | null;
  /** "library" = bundled in library/, "local" = uploaded into this browser */
  origin: "library" | "local";
}

const LOCAL_KEY = "sheetfox:uploaded";
const STATE_KEY = (id: string) => `sheetfox:state:${id}`;

const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* quota/private mode */ } };
const lsDel = (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

export async function loadLibrary(): Promise<LibraryEntry[]> {
  let lib: LibraryEntry[] = [];
  try {
    const res = await fetch("index.json", { cache: "no-cache" });
    if (res.ok) lib = ((await res.json()) as Omit<LibraryEntry, "origin">[]).map((e) => ({ ...e, origin: "library" as const }));
  } catch { /* static hosting without library */ }
  const local = Object.values(uploadedSheets()).map(
    (f): LibraryEntry => ({
      id: f.sheet.meta.id, title: f.sheet.meta.title, partNumber: f.sheet.meta.partNumber,
      manufacturer: f.sheet.meta.manufacturer, category: f.sheet.meta.category, file: "", source: f.source.url ?? null, origin: "local",
    }),
  );
  const ids = new Set(local.map((l) => l.id));
  return [...local, ...lib.filter((l) => !ids.has(l.id))];
}

function uploadedSheets(): Record<string, SheetFile> {
  try { return JSON.parse(lsGet(LOCAL_KEY) ?? "{}"); } catch { return {}; }
}

export function removeUploaded(id: string) {
  const all = uploadedSheets();
  delete all[id];
  lsSet(LOCAL_KEY, JSON.stringify(all));
}

export async function loadSheet(entry: LibraryEntry): Promise<SheetFile> {
  if (entry.origin === "local") {
    const f = uploadedSheets()[entry.id];
    if (!f) throw new Error("uploaded sheet not found");
    return f;
  }
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`failed to load ${entry.file}: ${res.status}`);
  return parseSheetFile(await res.text());
}

export function parseSheetFile(text: string): SheetFile {
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`Not JSON: ${(e as Error).message}`); }
  const r = SheetFile.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`Not a valid SheetFox file (${i.path.join(".")}: ${i.message})`);
  }
  if (r.data.format !== FORMAT_ID) throw new Error("Not a SheetFox file");
  if (r.data.formatVersion > FORMAT_VERSION) throw new Error(`File format v${r.data.formatVersion} is newer than this viewer (v${FORMAT_VERSION})`);
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
  try { return JSON.parse(lsGet(STATE_KEY(id)) ?? "null"); } catch { return null; }
}
export function saveState(id: string, s: UserState) { lsSet(STATE_KEY(id), JSON.stringify(s)); }
export function clearState(id: string) { lsDel(STATE_KEY(id)); }

export function downloadSheet(file: SheetFile, state: UserState | null) {
  const out: SheetFile = { ...file, userState: state && (Object.keys(state.variables ?? {}).length || Object.keys(state.tables ?? {}).length) ? state : null };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${file.sheet.meta.id}.sheet.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function parseCell(text: string): Cell {
  const t = text.trim();
  if (t === "" || t === "-" || t === "—") return null;
  if (/^0x[0-9a-f]+$/i.test(t)) return t;
  const n = Number(t.replace(/^\+/, "").replace(/[−–]/g, "-"));
  return Number.isFinite(n) ? n : t;
}
