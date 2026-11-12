/**
 * Evaluation engine shared by the viewer and the ingest validator.
 *
 * Expressions are mathjs. The scope contains:
 *   - every variable by id (number, in the variable's unit)
 *   - every calculator output by id
 *   - spec.<parameterId>.min / .typ / .max  (NaN when not given)
 *   - row.<columnId> inside table computed columns
 * plus these functions:
 *   curve(id, x[, p])        interpolate digitized curve (family: blend between series by param p,
 *                            or pick a series by label string). NaN outside the characterized range.
 *   curvefit(id, x[, p])     evaluate the curve's closed-form fit
 *   tlookup(tableId, keyCol, key, valueCol)  interpolate a numeric table column (NaN out of range)
 *   tindex(tableId, keyCol, key, valueCol)   exact/nearest-row lookup (no interpolation)
 *   pattern(id, series, angleDeg)            interpolate a radiation pattern (series = index or label)
 *   patternmax(id, series), patternavg(id, series)  peak / power-averaged gain of a cut
 *   dbm2w(dBm), w2dbm(W), db2lin(dB), lin2db(x), clamp(x, lo, hi), between(x, lo, hi)
 */
import { all, create, type EvalFunction, type MathJsInstance, type MathNode } from 'mathjs';
import type { Cell, Curve, Pattern, SheetBody, Table } from './schema';

export type Scope = Record<string, unknown>;

export interface EvalResult {
  outputs: Record<string, number>;
  errors: Record<string, string>;
  checks: { id: string; severity: string; message: string; active: boolean; error?: string }[];
  /** Data + computed cells */
  tableValues: Record<string, Cell[][]>;
}

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object' && 'toNumber' in v && typeof v.toNumber === 'function') {
    const n: unknown = Reflect.apply(v.toNumber, v, []);
    return typeof n === 'number' ? n : NaN;
  }
  return NaN;
};

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Optional curve family argument: a series label, a numeric parameter, or absent. */
const optParam = (p: unknown): number | string | undefined => {
  if (typeof p === 'string') return p;
  if (p === undefined) return undefined;
  return toNum(p);
};

const tf = (v: number, log: boolean) => (log ? (v > 0 ? Math.log10(v) : NaN) : v);
const itf = (v: number, log: boolean) => (log ? 10 ** v : v);

/** 1-D interpolation over ascending xs. NaN outside [x0, xn] (with a small tolerance). */
export function interp1(xs: number[], ys: number[], x: number, xlog = false, ylog = false): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0 || !Number.isFinite(x)) return NaN;
  if (n === 1) return Math.abs(xs[0] - x) <= 1e-9 * Math.max(1, Math.abs(x)) ? ys[0] : NaN;
  const tx = tf(x, xlog);
  const lo = tf(xs[0], xlog);
  const hi = tf(xs[n - 1], xlog);
  const tol = 1e-6 * Math.max(1e-12, Math.abs(hi - lo));
  if (tx < lo - tol || tx > hi + tol) return NaN;
  for (let i = 0; i < n - 1; i++) {
    const a = tf(xs[i], xlog);
    const b = tf(xs[i + 1], xlog);
    if (tx <= b + tol || i === n - 2) {
      const ya = tf(ys[i], ylog);
      const yb = tf(ys[i + 1], ylog);
      const t = b === a ? 0 : (tx - a) / (b - a);
      return itf(ya + Math.min(1, Math.max(0, t)) * (yb - ya), ylog);
    }
  }
  return NaN;
}

function sortedSeries(c: Curve) {
  return c.series.map((s) => {
    const idx = s.x.map((_, i) => i).filter((i) => Number.isFinite(s.x[i]) && Number.isFinite(s.y[i]));
    idx.sort((a, b) => s.x[a] - s.x[b]);
    return { ...s, x: idx.map((i) => s.x[i]), y: idx.map((i) => s.y[i]) };
  });
}

export function evalCurve(c: Curve, x: number, p?: number | string): number {
  const xlog = c.xAxis.scale === 'log';
  const ylog = c.yAxis.scale === 'log';
  const series = sortedSeries(c);
  if (series.length === 0) return NaN;
  if (typeof p === 'string') {
    const match = series.find((s) => s.label === p);
    return match ? interp1(match.x, match.y, x, xlog, ylog) : NaN;
  }
  if (p === undefined || series.length === 1) return interp1(series[0].x, series[0].y, x, xlog, ylog);
  const fam = series
    .filter((s): s is (typeof series)[number] & { param: number } => s.param !== null)
    .toSorted((a, b) => a.param - b.param);
  if (fam.length === 0) return interp1(series[0].x, series[0].y, x, xlog, ylog);
  const plog = c.paramScale === 'log';
  const params = fam.map((s) => s.param);
  const vals = fam.map((s) => interp1(s.x, s.y, x, xlog, ylog));
  if (fam.length === 1) return Math.abs(params[0] - p) < 1e-9 ? vals[0] : NaN;
  // blend between bracketing series (in transformed y space)
  return interp1(params, vals, p, plog, ylog);
}

/** Circular interpolation of a pattern series. */
export function evalPattern(pt: Pattern, series: number | string, angle: number): number {
  const s = typeof series === 'string' ? pt.series.find((cut) => cut.label === series) : pt.series[series];
  if (!s || s.angleDeg.length === 0) return NaN;
  const pts = s.angleDeg.map((a, i) => [((a % 360) + 360) % 360, s.gain[i]] as const).toSorted((a, b) => a[0] - b[0]);
  const [first] = pts;
  const last = pts.at(-1) ?? first;
  const a = ((angle % 360) + 360) % 360;
  const xs = [last[0] - 360, ...pts.map((p) => p[0]), first[0] + 360];
  const ys = [last[1], ...pts.map((p) => p[1]), first[1]];
  return interp1(xs, ys, a);
}

function cellNum(c: Cell): number {
  if (typeof c === 'number') return c;
  if (typeof c === 'string') {
    const s = c.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s, 16);
    const v = Number(s);
    return s !== '' && Number.isFinite(v) ? v : NaN;
  }
  return NaN;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['spec', 'row', 'x', 'p', 'e', 'pi', 'i', 'true', 'false']);

export class SheetEngine {
  private readonly math: MathJsInstance;
  private readonly compiled = new Map<string, EvalFunction>();
  private readonly curves: Map<string, Curve>;
  private readonly patterns: Map<string, Pattern>;
  private readonly tables = new Map<string, Table>();
  private readonly tableRows = new Map<string, Cell[][]>();
  private scope: Scope = {};
  private readonly rowCache = new Map<string, Cell>();
  private readonly computing = new Set<string>();

  public constructor(private readonly sheet: SheetBody) {
    this.math = create(all, {});
    this.curves = new Map(sheet.curves.map((c) => [c.id, c]));
    this.patterns = new Map(sheet.patterns.map((p) => [p.id, p]));
    for (const t of sheet.tables) {
      this.tables.set(t.id, t);
      this.tableRows.set(t.id, t.rows);
    }
    const fns = {
      curve: (id: string, x: unknown, p?: unknown) => {
        const c = this.curves.get(id);
        if (!c) throw new Error(`curve(): unknown curve '${id}'`);
        return evalCurve(c, toNum(x), optParam(p));
      },
      curvefit: (id: string, x: unknown, p?: unknown) => {
        const c = this.curves.get(id);
        if (!c?.fit) throw new Error(`curvefit(): curve '${id}' has no fit`);
        return toNum(
          this.compile(c.fit.expr).evaluate({ ...this.scope, x: toNum(x), p: p === undefined ? NaN : toNum(p) }),
        );
      },
      tlookup: (tableId: string, keyCol: string, key: unknown, valCol: string) => {
        const { xs, ys } = this.tableColumnPairs(tableId, keyCol, valCol);
        return interp1(xs, ys, toNum(key));
      },
      tindex: (tableId: string, keyCol: string, key: unknown, valCol: string) => {
        const { xs, ys } = this.tableColumnPairs(tableId, keyCol, valCol);
        const k = toNum(key);
        let best = -1;
        let bd = Infinity;
        for (const [i, x] of xs.entries()) {
          const d = Math.abs(x - k);
          if (!(d < bd)) {
            continue;
          }

          bd = d;
          best = i;
        }
        return best < 0 ? NaN : ys[best];
      },
      pattern: (id: string, series: unknown, angle: unknown) => {
        const p = this.patterns.get(id);
        if (!p) throw new Error(`pattern(): unknown pattern '${id}'`);
        return evalPattern(p, typeof series === 'string' ? series : toNum(series), toNum(angle));
      },
      patternmax: (id: string, series: unknown) => {
        const s = this.patternSeries(id, series);
        return s.length ? Math.max(...s) : NaN;
      },
      /** Average gain in dB of the linear power average over the cut's sample points */
      patternavg: (id: string, series: unknown) => {
        const s = this.patternSeries(id, series);
        return s.length ? 10 * Math.log10(s.reduce((a, g) => a + 10 ** (g / 10), 0) / s.length) : NaN;
      },
      dbm2w: (v: unknown) => 10 ** (toNum(v) / 10) / 1000,
      w2dbm: (v: unknown) => 10 * Math.log10(toNum(v) * 1000),
      db2lin: (v: unknown) => 10 ** (toNum(v) / 10),
      lin2db: (v: unknown) => 10 * Math.log10(toNum(v)),
      clamp: (v: unknown, lo: unknown, hi: unknown) => Math.min(toNum(hi), Math.max(toNum(lo), toNum(v))),
      between: (v: unknown, lo: unknown, hi: unknown) => toNum(v) >= toNum(lo) && toNum(v) <= toNum(hi),
    };
    this.math.import(fns, { override: true });
  }

  public compile(expr: string): EvalFunction {
    let c = this.compiled.get(expr);
    if (!c) {
      c = this.math.compile(expr);
      this.compiled.set(expr, c);
    }
    return c;
  }

  /** Whether `name` is a function or constant known to mathjs (including the SheetFox helpers). */
  public hasBuiltin(name: string): boolean {
    return name in this.math;
  }

  public symbolsOf(expr: string): string[] {
    const node: MathNode = this.math.parse(expr);
    const out = new Set<string>();
    node.traverse((n, _path, parent) => {
      if (!this.math.isSymbolNode(n)) {
        return;
      }

      // `parent` is null at the root despite the typings
      const isFnName = this.math.isFunctionNode(parent) && parent.fn === n;
      if (!isFnName) out.add(n.name);
    });
    return [...out];
  }

  /** Expand "{expr}" placeholders in a check message with live values. */
  public renderMessage(msg: string): string {
    return msg.replaceAll(/\{([^{}]+)\}/g, (_, e: string) => {
      const v = this.evalExpr(e);
      return Number.isFinite(v) ? sig(v) : '—';
    });
  }

  public setTableRows(tableId: string, rows: Cell[][]): void {
    this.tableRows.set(tableId, rows);
  }

  public evaluate(values: Record<string, number>): EvalResult {
    const spec: Record<string, { min: number; typ: number; max: number }> = {};
    for (const p of this.sheet.parameters) spec[p.id] = { min: p.min ?? NaN, typ: p.typ ?? NaN, max: p.max ?? NaN };
    this.scope = { spec };
    for (const v of this.sheet.variables) this.scope[v.id] = values[v.id] ?? v.default;
    this.rowCache.clear();

    const outputs: Record<string, number> = {};
    const errors: Record<string, string> = {};
    const { order, exprs, cyc } = this.outputOrder();
    for (const id of cyc) errors[id] = 'circular dependency';
    for (const id of order) {
      const expr = exprs.get(id);
      if (errors[id] || expr === undefined) {
        this.scope[id] = NaN;
        outputs[id] = NaN;
        continue;
      }
      try {
        const v: unknown = this.compile(expr).evaluate({ ...this.scope });
        outputs[id] = toNum(v);
      } catch (error) {
        outputs[id] = NaN;
        errors[id] = errorMessage(error);
      }
      this.scope[id] = outputs[id];
    }

    const tableValues: Record<string, Cell[][]> = {};
    for (const t of this.sheet.tables) {
      const rows = this.tableRows.get(t.id) ?? [];
      tableValues[t.id] = rows.map((r, ri) =>
        t.columns.map((c, ci) => (c.kind === 'computed' ? this.rowCell(t, ri, ci) : (r[ci] ?? null))),
      );
    }

    const checks = this.sheet.checks.map((c) => {
      try {
        const v: unknown = this.compile(c.when).evaluate({ ...this.scope });
        const active = !!(typeof v === 'boolean' ? v : toNum(v));
        return { id: c.id, severity: c.severity, message: active ? this.renderMessage(c.message) : c.message, active };
      } catch (error) {
        return { id: c.id, severity: c.severity, message: c.message, active: false, error: errorMessage(error) };
      }
    });
    return { outputs, errors, checks, tableValues };
  }

  /** Evaluate a stand-alone expression (e.g. a curve cursor) against the last scope. */
  public evalExpr(expr: string): number {
    try {
      return toNum(this.compile(expr).evaluate({ ...this.scope }));
    } catch {
      return NaN;
    }
  }

  private patternSeries(id: string, series: unknown): number[] {
    const p = this.patterns.get(id);
    if (!p) throw new Error(`unknown pattern '${id}'`);
    const s = typeof series === 'string' ? p.series.find((x) => x.label === series) : p.series[toNum(series)];
    return (s?.gain ?? []).filter(Number.isFinite);
  }

  private tableColumnPairs(tableId: string, keyCol: string, valCol: string): { xs: number[]; ys: number[] } {
    const t = this.tables.get(tableId);
    if (!t) throw new Error(`unknown table '${tableId}'`);
    const ki = t.columns.findIndex((c) => c.id === keyCol);
    if (ki === -1) throw new Error(`table '${tableId}' has no column '${keyCol}'`);
    const vi = t.columns.findIndex((c) => c.id === valCol);
    if (vi === -1) throw new Error(`table '${tableId}' has no column '${valCol}'`);
    const rows = this.tableRows.get(tableId) ?? [];
    const pairs: [number, number][] = [];
    for (const [ri, r] of rows.entries()) {
      const k = cellNum(r[ki]);
      const v = cellNum(t.columns[vi].kind === 'computed' ? this.rowCell(t, ri, vi) : r[vi]);
      if (Number.isFinite(k) && Number.isFinite(v)) pairs.push([k, v]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    return { xs: pairs.map((p) => p[0]), ys: pairs.map((p) => p[1]) };
  }

  private rowCell(t: Table, ri: number, ci: number): Cell {
    const col = t.columns[ci];
    const rows = this.tableRows.get(t.id) ?? [];
    const r = rows[ri] ?? [];
    if (col.kind !== 'computed' || !col.expr) return r[ci] ?? null;
    const key = `${t.id}:${ri}:${ci}`;
    const cached = this.rowCache.get(key);
    if (cached !== undefined) return cached;
    if (this.computing.has(key)) throw new Error(`circular reference in ${t.id}.${col.id}`);
    this.computing.add(key);
    try {
      const row: Record<string, unknown> = {};
      for (const [i, c] of t.columns.entries()) {
        Object.defineProperty(row, c.id, {
          enumerable: true,
          get: () => {
            const v = c.kind === 'computed' ? this.rowCell(t, ri, i) : r[i];
            const n = cellNum(v ?? null);
            return Number.isFinite(n) ? n : v;
          },
        });
      }
      const v = toNum(this.compile(col.expr).evaluate({ ...this.scope, row }));
      this.rowCache.set(key, v);
      return v;
    } catch {
      this.rowCache.set(key, NaN);
      return NaN;
    } finally {
      this.computing.delete(key);
    }
  }

  /** Order all calculator outputs so dependencies are evaluated first. */
  private outputOrder(): { order: string[]; exprs: Map<string, string>; cyc: string[] } {
    const exprs = new Map<string, string>();
    for (const c of this.sheet.calculators) for (const o of c.outputs) exprs.set(o.id, o.expr);
    const deps = new Map<string, string[]>();
    for (const [id, e] of exprs) {
      try {
        deps.set(
          id,
          this.symbolsOf(e).filter((s) => exprs.has(s) && s !== id),
        );
      } catch {
        deps.set(id, []);
      }
    }
    const order: string[] = [];
    const state = new Map<string, number>();
    const cyc: string[] = [];
    const visit = (id: string) => {
      const s = state.get(id);
      if (s === 2) return;
      if (s === 1) {
        cyc.push(id);
        return;
      }
      state.set(id, 1);
      const ds = deps.get(id);
      if (ds) for (const d of ds) visit(d);
      state.set(id, 2);
      order.push(id);
    };
    for (const id of exprs.keys()) visit(id);
    return { order, exprs, cyc };
  }
}

/* ------------------------------------------------------------------ */
/* Validation (used by the ingester's repair loop and `npm run validate`) */

export interface Issue {
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

type Report = (path: string, message: string) => void;
interface Reporter {
  err: Report;
  warn: Report;
}

/** Variables and calculator outputs share one namespace; returns id -> path of first use. */
function validateGlobalIds(sheet: SheetBody, { err }: Reporter): Map<string, string> {
  const globalIds = new Map<string, string>();
  const claim = (id: string, path: string) => {
    if (!IDENT.test(id)) err(path, `id '${id}' is not a valid identifier`);
    if (RESERVED.has(id)) err(path, `id '${id}' is reserved`);
    const prev = globalIds.get(id);
    if (prev) err(path, `id '${id}' already used at ${prev}`);
    else globalIds.set(id, path);
  };
  for (const [i, v] of sheet.variables.entries()) {
    claim(v.id, `variables[${i}]`);
    if (v.min !== null && v.max !== null && v.min > v.max) err(`variables[${i}]`, 'min > max');
    if (v.scale === 'log' && (v.min ?? 1) <= 0) err(`variables[${i}]`, 'log-scale variable needs min > 0');
  }
  for (const [i, c] of sheet.calculators.entries())
    for (const [j, o] of c.outputs.entries()) claim(o.id, `calculators[${i}].outputs[${j}]`);
  return globalIds;
}

function validateUniqueIds(arr: { id: string }[], kind: string, { err }: Reporter): void {
  const seen = new Set<string>();
  for (const [i, x] of arr.entries()) {
    if (seen.has(x.id)) err(`${kind}[${i}]`, `duplicate ${kind} id '${x.id}'`);
    seen.add(x.id);
  }
}

function validateParametersAndTables(sheet: SheetBody, { err, warn }: Reporter): void {
  for (const [i, p] of sheet.parameters.entries()) {
    if (!IDENT.test(p.id)) err(`parameters[${i}]`, `id '${p.id}' is not a valid identifier`);
    if (p.min === null && p.typ === null && p.max === null && !p.textValue) warn(`parameters[${i}]`, 'no value');
  }
  for (const [i, t] of sheet.tables.entries()) {
    for (const [j, c] of t.columns.entries()) {
      if (!IDENT.test(c.id)) err(`tables[${i}].columns[${j}]`, `column id '${c.id}' is not a valid identifier`);
      if (c.kind === 'computed' && !c.expr) err(`tables[${i}].columns[${j}]`, 'computed column without expr');
    }
    for (const [j, r] of t.rows.entries()) {
      if (r.length !== t.columns.length)
        err(`tables[${i}].rows[${j}]`, `row has ${r.length} cells, expected ${t.columns.length}`);
    }
  }
}

function validateCurvesAndPatterns(sheet: SheetBody, { err, warn }: Reporter): void {
  for (const [i, c] of sheet.curves.entries()) {
    if (c.series.length === 0) err(`curves[${i}]`, 'no series');
    for (const [j, s] of c.series.entries()) {
      const p = `curves[${i}].series[${j}]`;
      if (s.x.length !== s.y.length) err(p, `x has ${s.x.length} points, y has ${s.y.length}`);
      if (s.x.length < 2) err(p, 'needs at least 2 points');
      if (c.xAxis.scale === 'log' && s.x.some((v) => v <= 0)) err(p, 'x <= 0 on log axis');
      if (c.yAxis.scale === 'log' && s.y.some((v) => v <= 0)) err(p, 'y <= 0 on log axis');
    }
    if (c.series.length > 1 && c.series.some((s) => s.param === null))
      warn(
        `curves[${i}]`,
        'family of curves without numeric param on every series; curve(id, x, p) blending will not work',
      );
  }
  for (const [i, pt] of sheet.patterns.entries())
    for (const [j, s] of pt.series.entries()) {
      if (s.angleDeg.length !== s.gain.length) err(`patterns[${i}].series[${j}]`, 'angleDeg/gain length mismatch');
    }
}

function validateExpressions(
  sheet: SheetBody,
  engine: SheetEngine,
  globalIds: Map<string, string>,
  { err }: Reporter,
): void {
  const known = new Set([...globalIds.keys(), 'spec', 'row', 'x', 'p', 'pi', 'e', 'true', 'false', 'Infinity', 'NaN']);
  const checkExpr = (expr: string, path: string, extra: string[] = []) => {
    try {
      engine.compile(expr);
      for (const s of engine.symbolsOf(expr)) {
        if (!known.has(s) && !extra.includes(s) && !engine.hasBuiltin(s))
          err(path, `unknown symbol '${s}' in: ${expr}`);
      }
    } catch (error) {
      err(path, `does not parse: ${errorMessage(error)} in: ${expr}`);
    }
  };
  for (const [i, c] of sheet.calculators.entries()) {
    for (const v of c.inputs) {
      if (sheet.variables.every((x) => x.id !== v)) err(`calculators[${i}].inputs`, `unknown variable '${v}'`);
    }
    for (const [j, o] of c.outputs.entries()) checkExpr(o.expr, `calculators[${i}].outputs[${j}]`);
  }
  for (const [i, c] of sheet.checks.entries()) checkExpr(c.when, `checks[${i}]`);
  for (const [i, t] of sheet.tables.entries())
    for (const [j, c] of t.columns.entries()) if (c.expr) checkExpr(c.expr, `tables[${i}].columns[${j}]`);
  for (const [i, c] of sheet.curves.entries()) {
    if (c.fit) checkExpr(c.fit.expr, `curves[${i}].fit`, ['x', 'p']);
    if (c.cursorX) checkExpr(c.cursorX, `curves[${i}].cursorX`);
    if (c.cursorParam) checkExpr(c.cursorParam, `curves[${i}].cursorParam`);
  }
}

function validateDefaults(sheet: SheetBody, engine: SheetEngine, { err, warn }: Reporter): void {
  const res = engine.evaluate({});
  for (const [id, m] of Object.entries(res.errors)) err(`output '${id}'`, `evaluation error at defaults: ${m}`);
  for (const [id, v] of Object.entries(res.outputs))
    if (!res.errors[id] && !Number.isFinite(v))
      warn(`output '${id}'`, 'is NaN/infinite at default variable values (out of characterized range?)');
  for (const c of res.checks) if (c.error) err(`check '${c.id}'`, c.error);
  // fits should roughly match their data
  for (const [i, c] of sheet.curves.entries()) {
    if (!c.fit) continue;
    let worst = 0;
    for (const s of c.series)
      for (let k = 0; k < s.x.length; k++) {
        const f = engine.evalExpr(`curvefit("${c.id}", ${s.x[k]}, ${s.param ?? 'NaN'})`);
        const rel = Math.abs(f - s.y[k]) / Math.max(1e-30, Math.abs(s.y[k]));
        worst = Number.isFinite(rel) ? Math.max(worst, rel) : Infinity;
      }
    if (worst > 0.35)
      warn(`curves[${i}].fit`, `fit deviates from digitized data by up to ${(worst * 100).toFixed(0)}%`);
  }
}

export function validateSheet(sheet: SheetBody): Issue[] {
  const issues: Issue[] = [];
  const reporter: Reporter = {
    err: (path, message) => {
      issues.push({ path, severity: 'error', message });
    },
    warn: (path, message) => {
      issues.push({ path, severity: 'warning', message });
    },
  };

  const globalIds = validateGlobalIds(sheet, reporter);
  validateUniqueIds(sheet.parameters, 'parameters', reporter);
  validateUniqueIds(sheet.tables, 'tables', reporter);
  validateUniqueIds(sheet.curves, 'curves', reporter);
  validateUniqueIds(sheet.patterns, 'patterns', reporter);
  validateParametersAndTables(sheet, reporter);
  validateCurvesAndPatterns(sheet, reporter);

  // compile + evaluate everything at defaults
  let engine: SheetEngine;
  try {
    engine = new SheetEngine(sheet);
  } catch (error) {
    reporter.err('engine', errorMessage(error));
    return issues;
  }
  validateExpressions(sheet, engine, globalIds, reporter);
  if (issues.some((i) => i.severity === 'error')) return issues;
  validateDefaults(sheet, engine, reporter);
  return issues;
}

/* ------------------------------------------------------------------ */
/* Formatting */

const SI_SMALLEST = [1e-15, 'f'] as const;
const SI = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  SI_SMALLEST,
] as const;
const PREFIX: Record<string, number> = {
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  '': 1,
  m: 1e-3,
  µ: 1e-6,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};
// order matters: "mA" must match A before m
const BASE_UNITS = [
  'Hz',
  'V',
  'A',
  'W',
  's',
  'F',
  'H',
  'Ω',
  'ohm',
  'J',
  'Wh',
  'Ah',
  'Baud',
  'baud',
  'bps',
  'S',
  'g',
  'm',
];

function splitUnit(unit: string): [number, string] | null {
  for (const b of BASE_UNITS) {
    if (unit === b) return [1, b];
    if (!unit.endsWith(b)) continue;
    const pre = unit.slice(0, -b.length);
    if (pre in PREFIX) return [PREFIX[pre], b];
  }
  return null;
}

export function sig(v: number, digits = 4): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(digits - 1).replace(/\.?0+e/, 'e');
  const s = v.toPrecision(digits);
  return s.includes('.') && !s.includes('e') ? s.replace(/\.?0+$/, '') : s;
}

export function formatValue(v: number | string | null | undefined, unit: string | null, format: string | null): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (format === 'bool') return v ? 'yes' : 'no';
  if (!Number.isFinite(v)) return '—';
  if (format === 'hex') return `0x${Math.round(v).toString(16).toUpperCase().padStart(2, '0')}`;
  const u = unit ? ` ${unit}` : '';
  if (format === 'int') return `${Math.round(v)}${u}`;
  if (format === 'sci') return `${v.toExponential(3)}${u}`;
  const fm = format?.match(/^fixed(\d)$/);
  if (fm) return `${v.toFixed(Number(fm[1]))}${u}`;
  if (format === 'si' && unit) {
    const sp = splitUnit(unit);
    if (sp) {
      const base = v * sp[0];
      const a = Math.abs(base);
      const [factor, prefix] = SI.find(([f]) => a >= f * 0.9995) ?? SI_SMALLEST;
      return `${sig(base / factor)} ${prefix}${sp[1]}`;
    }
  }
  return `${sig(v)}${u}`;
}
