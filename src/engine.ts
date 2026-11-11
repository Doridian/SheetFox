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
import { create, all, type MathJsInstance, type EvalFunction, type MathNode } from "mathjs";
import type { Cell, Curve, Pattern, SheetBody, Table } from "./schema";

export type Scope = Record<string, unknown>;

export interface EvalResult {
  outputs: Record<string, number>;
  errors: Record<string, string>;
  checks: { id: string; severity: string; message: string; active: boolean; error?: string }[];
  tableValues: Record<string, Cell[][]>; // data + computed cells
}

const toNum = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v && typeof v === "object" && "toNumber" in v && typeof (v as { toNumber: unknown }).toNumber === "function") {
    return (v as { toNumber(): number }).toNumber();
  }
  return NaN;
};

const tf = (v: number, log: boolean) => (log ? (v > 0 ? Math.log10(v) : NaN) : v);
const itf = (v: number, log: boolean) => (log ? Math.pow(10, v) : v);

/** 1-D interpolation over ascending xs. NaN outside [x0, xn] (with a small tolerance). */
export function interp1(xs: number[], ys: number[], x: number, xlog = false, ylog = false): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0 || !Number.isFinite(x)) return NaN;
  if (n === 1) return Math.abs(xs[0] - x) <= 1e-9 * Math.max(1, Math.abs(x)) ? ys[0] : NaN;
  const tx = tf(x, xlog);
  const lo = tf(xs[0], xlog), hi = tf(xs[n - 1], xlog);
  const tol = 1e-6 * Math.max(1e-12, Math.abs(hi - lo));
  if (tx < lo - tol || tx > hi + tol) return NaN;
  for (let i = 0; i < n - 1; i++) {
    const a = tf(xs[i], xlog), b = tf(xs[i + 1], xlog);
    if (tx <= b + tol || i === n - 2) {
      const ya = tf(ys[i], ylog), yb = tf(ys[i + 1], ylog);
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
  const xlog = c.xAxis.scale === "log", ylog = c.yAxis.scale === "log";
  const series = sortedSeries(c);
  if (series.length === 0) return NaN;
  if (typeof p === "string") {
    const s = series.find((s) => s.label === p);
    return s ? interp1(s.x, s.y, x, xlog, ylog) : NaN;
  }
  if (p === undefined || series.length === 1) {
    if (series.length === 1 || p === undefined) return interp1(series[0].x, series[0].y, x, xlog, ylog);
  }
  const fam = series.filter((s) => s.param !== null).sort((a, b) => (a.param as number) - (b.param as number));
  if (fam.length === 0) return interp1(series[0].x, series[0].y, x, xlog, ylog);
  const plog = c.paramScale === "log";
  const params = fam.map((s) => s.param as number);
  const vals = fam.map((s) => interp1(s.x, s.y, x, xlog, ylog));
  if (fam.length === 1) return Math.abs(params[0] - (p as number)) < 1e-9 ? vals[0] : NaN;
  // blend between bracketing series (in transformed y space)
  return interp1(params, vals, p as number, plog, ylog);
}

/** Circular interpolation of a pattern series. */
export function evalPattern(pt: Pattern, series: number | string, angle: number): number {
  const s = typeof series === "string" ? pt.series.find((s) => s.label === series) : pt.series[series];
  if (!s || s.angleDeg.length === 0) return NaN;
  const pts = s.angleDeg.map((a, i) => [((a % 360) + 360) % 360, s.gain[i]] as const).sort((a, b) => a[0] - b[0]);
  const a = ((angle % 360) + 360) % 360;
  const xs = [pts[pts.length - 1][0] - 360, ...pts.map((p) => p[0]), pts[0][0] + 360];
  const ys = [pts[pts.length - 1][1], ...pts.map((p) => p[1]), pts[0][1]];
  return interp1(xs, ys, a);
}

function cellNum(c: Cell): number {
  if (typeof c === "number") return c;
  if (typeof c === "string") {
    const s = c.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    const v = Number(s);
    return s !== "" && Number.isFinite(v) ? v : NaN;
  }
  return NaN;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["spec", "row", "x", "p", "e", "pi", "i", "true", "false"]);

export class SheetEngine {
  readonly math: MathJsInstance;
  private compiled = new Map<string, EvalFunction>();
  private curves: Map<string, Curve>;
  private patterns: Map<string, Pattern>;
  private tables = new Map<string, Table>();
  private tableRows = new Map<string, Cell[][]>();
  private scope: Scope = {};
  private rowCache = new Map<string, Cell>();
  private computing = new Set<string>();

  constructor(private sheet: SheetBody) {
    this.math = create(all, {});
    this.curves = new Map(sheet.curves.map((c) => [c.id, c]));
    this.patterns = new Map(sheet.patterns.map((p) => [p.id, p]));
    for (const t of sheet.tables) {
      this.tables.set(t.id, t);
      this.tableRows.set(t.id, t.rows);
    }
    const self = this;
    const fns = {
      curve(id: string, x: unknown, p?: unknown) {
        const c = self.curves.get(id);
        if (!c) throw new Error(`curve(): unknown curve '${id}'`);
        return evalCurve(c, toNum(x), typeof p === "string" ? p : p === undefined ? undefined : toNum(p));
      },
      curvefit(id: string, x: unknown, p?: unknown) {
        const c = self.curves.get(id);
        if (!c?.fit) throw new Error(`curvefit(): curve '${id}' has no fit`);
        return toNum(self.compile(c.fit.expr).evaluate({ ...self.scope, x: toNum(x), p: p === undefined ? NaN : toNum(p) }));
      },
      tlookup(tableId: string, keyCol: string, key: unknown, valCol: string) {
        const { xs, ys } = self.tableColumnPairs(tableId, keyCol, valCol);
        return interp1(xs, ys, toNum(key));
      },
      tindex(tableId: string, keyCol: string, key: unknown, valCol: string) {
        const { xs, ys } = self.tableColumnPairs(tableId, keyCol, valCol);
        const k = toNum(key);
        let best = -1, bd = Infinity;
        xs.forEach((x, i) => { const d = Math.abs(x - k); if (d < bd) { bd = d; best = i; } });
        return best < 0 ? NaN : ys[best];
      },
      pattern(id: string, series: unknown, angle: unknown) {
        const p = self.patterns.get(id);
        if (!p) throw new Error(`pattern(): unknown pattern '${id}'`);
        return evalPattern(p, typeof series === "string" ? series : toNum(series), toNum(angle));
      },
      patternmax(id: string, series: unknown) {
        const s = self.patternSeries(id, series);
        return s.length ? Math.max(...s) : NaN;
      },
      /** Average gain in dB of the linear power average over the cut's sample points */
      patternavg(id: string, series: unknown) {
        const s = self.patternSeries(id, series);
        return s.length ? 10 * Math.log10(s.reduce((a, g) => a + Math.pow(10, g / 10), 0) / s.length) : NaN;
      },
      dbm2w: (v: unknown) => Math.pow(10, toNum(v) / 10) / 1000,
      w2dbm: (v: unknown) => 10 * Math.log10(toNum(v) * 1000),
      db2lin: (v: unknown) => Math.pow(10, toNum(v) / 10),
      lin2db: (v: unknown) => 10 * Math.log10(toNum(v)),
      clamp: (v: unknown, lo: unknown, hi: unknown) => Math.min(toNum(hi), Math.max(toNum(lo), toNum(v))),
      between: (v: unknown, lo: unknown, hi: unknown) => toNum(v) >= toNum(lo) && toNum(v) <= toNum(hi),
    };
    this.math.import(fns, { override: true });
  }

  compile(expr: string): EvalFunction {
    let c = this.compiled.get(expr);
    if (!c) {
      c = this.math.compile(expr);
      this.compiled.set(expr, c);
    }
    return c;
  }

  symbolsOf(expr: string): string[] {
    const node: MathNode = this.math.parse(expr);
    const out = new Set<string>();
    node.traverse((n, _path, parent) => {
      if ((n as { isSymbolNode?: boolean }).isSymbolNode) {
        const isFnName = parent && (parent as { isFunctionNode?: boolean }).isFunctionNode && (parent as unknown as { fn: MathNode }).fn === n;
        if (!isFnName) out.add((n as unknown as { name: string }).name);
      }
    });
    return [...out];
  }

  private patternSeries(id: string, series: unknown): number[] {
    const p = this.patterns.get(id);
    if (!p) throw new Error(`unknown pattern '${id}'`);
    const s = typeof series === "string" ? p.series.find((x) => x.label === series) : p.series[toNum(series)];
    return (s?.gain ?? []).filter(Number.isFinite);
  }

  /** Expand "{expr}" placeholders in a check message with live values. */
  renderMessage(msg: string): string {
    return msg.replace(/\{([^{}]+)\}/g, (_, e: string) => {
      const v = this.evalExpr(e);
      return Number.isFinite(v) ? sig(v) : "—";
    });
  }

  setTableRows(tableId: string, rows: Cell[][]) {
    this.tableRows.set(tableId, rows);
  }

  private tableColumnPairs(tableId: string, keyCol: string, valCol: string) {
    const t = this.tables.get(tableId);
    if (!t) throw new Error(`unknown table '${tableId}'`);
    const ki = t.columns.findIndex((c) => c.id === keyCol);
    const vi = t.columns.findIndex((c) => c.id === valCol);
    if (ki < 0) throw new Error(`table '${tableId}' has no column '${keyCol}'`);
    if (vi < 0) throw new Error(`table '${tableId}' has no column '${valCol}'`);
    const rows = this.tableRows.get(tableId) ?? [];
    const pairs: [number, number][] = [];
    rows.forEach((r, ri) => {
      const k = cellNum(r[ki]);
      const v = t.columns[vi].kind === "computed" ? cellNum(this.rowCell(t, ri, vi)) : cellNum(r[vi]);
      if (Number.isFinite(k) && Number.isFinite(v)) pairs.push([k, v]);
    });
    pairs.sort((a, b) => a[0] - b[0]);
    return { xs: pairs.map((p) => p[0]), ys: pairs.map((p) => p[1]) };
  }

  private rowCell(t: Table, ri: number, ci: number): Cell {
    const col = t.columns[ci];
    const rows = this.tableRows.get(t.id) ?? [];
    const r = rows[ri] ?? [];
    if (col.kind !== "computed" || !col.expr) return r[ci] ?? null;
    const key = `${t.id}:${ri}:${ci}`;
    if (this.rowCache.has(key)) return this.rowCache.get(key)!;
    if (this.computing.has(key)) throw new Error(`circular reference in ${t.id}.${col.id}`);
    this.computing.add(key);
    try {
      const row: Record<string, unknown> = {};
      t.columns.forEach((c, i) => {
        Object.defineProperty(row, c.id, {
          enumerable: true,
          get: () => {
            const v = c.kind === "computed" ? this.rowCell(t, ri, i) : r[i];
            const n = cellNum(v ?? null);
            return Number.isFinite(n) ? n : v;
          },
        });
      });
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
      try { deps.set(id, this.symbolsOf(e).filter((s) => exprs.has(s) && s !== id)); }
      catch { deps.set(id, []); }
    }
    const order: string[] = [], state = new Map<string, number>(), cyc: string[] = [];
    const visit = (id: string) => {
      const s = state.get(id);
      if (s === 2) return;
      if (s === 1) { cyc.push(id); return; }
      state.set(id, 1);
      for (const d of deps.get(id) ?? []) visit(d);
      state.set(id, 2);
      order.push(id);
    };
    for (const id of exprs.keys()) visit(id);
    return { order, exprs, cyc };
  }

  evaluate(values: Record<string, number>): EvalResult {
    const spec: Record<string, { min: number; typ: number; max: number }> = {};
    for (const p of this.sheet.parameters) spec[p.id] = { min: p.min ?? NaN, typ: p.typ ?? NaN, max: p.max ?? NaN };
    this.scope = { spec };
    for (const v of this.sheet.variables) this.scope[v.id] = values[v.id] ?? v.default;
    this.rowCache.clear();

    const outputs: Record<string, number> = {}, errors: Record<string, string> = {};
    const { order, exprs, cyc } = this.outputOrder();
    for (const id of cyc) errors[id] = "circular dependency";
    for (const id of order) {
      if (errors[id]) { this.scope[id] = NaN; outputs[id] = NaN; continue; }
      try {
        const v = this.compile(exprs.get(id)!).evaluate({ ...this.scope });
        outputs[id] = toNum(v);
      } catch (e) {
        outputs[id] = NaN;
        errors[id] = (e as Error).message;
      }
      this.scope[id] = outputs[id];
    }

    const tableValues: Record<string, Cell[][]> = {};
    for (const t of this.sheet.tables) {
      const rows = this.tableRows.get(t.id) ?? [];
      tableValues[t.id] = rows.map((r, ri) => t.columns.map((c, ci) => (c.kind === "computed" ? this.rowCell(t, ri, ci) : r[ci] ?? null)));
    }

    const checks = this.sheet.checks.map((c) => {
      try {
        const v = this.compile(c.when).evaluate({ ...this.scope });
        const active = !!(typeof v === "boolean" ? v : toNum(v));
        return { id: c.id, severity: c.severity, message: active ? this.renderMessage(c.message) : c.message, active };
      } catch (e) {
        return { id: c.id, severity: c.severity, message: c.message, active: false, error: (e as Error).message };
      }
    });
    return { outputs, errors, checks, tableValues };
  }

  /** Evaluate a stand-alone expression (e.g. a curve cursor) against the last scope. */
  evalExpr(expr: string): number {
    try { return toNum(this.compile(expr).evaluate({ ...this.scope })); } catch { return NaN; }
  }
}

/* ------------------------------------------------------------------ */
/* Validation (used by the ingester's repair loop and `npm run validate`) */

export interface Issue { path: string; severity: "error" | "warning"; message: string }

export function validateSheet(sheet: SheetBody): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, severity: "error", message });
  const warn = (path: string, message: string) => issues.push({ path, severity: "warning", message });

  const globalIds = new Map<string, string>();
  const claim = (id: string, path: string) => {
    if (!IDENT.test(id)) err(path, `id '${id}' is not a valid identifier`);
    if (RESERVED.has(id)) err(path, `id '${id}' is reserved`);
    const prev = globalIds.get(id);
    if (prev) err(path, `id '${id}' already used at ${prev}`);
    else globalIds.set(id, path);
  };
  sheet.variables.forEach((v, i) => {
    claim(v.id, `variables[${i}]`);
    if (v.min !== null && v.max !== null && v.min > v.max) err(`variables[${i}]`, "min > max");
    if (v.scale === "log" && (v.min ?? 1) <= 0) err(`variables[${i}]`, "log-scale variable needs min > 0");
  });
  sheet.calculators.forEach((c, i) => c.outputs.forEach((o, j) => claim(o.id, `calculators[${i}].outputs[${j}]`)));

  const ids = (arr: { id: string }[], kind: string) => {
    const seen = new Set<string>();
    arr.forEach((x, i) => {
      if (seen.has(x.id)) err(`${kind}[${i}]`, `duplicate ${kind} id '${x.id}'`);
      seen.add(x.id);
    });
  };
  ids(sheet.parameters, "parameters");
  ids(sheet.tables, "tables");
  ids(sheet.curves, "curves");
  ids(sheet.patterns, "patterns");
  sheet.parameters.forEach((p, i) => {
    if (!IDENT.test(p.id)) err(`parameters[${i}]`, `id '${p.id}' is not a valid identifier`);
    if (p.min === null && p.typ === null && p.max === null && !p.textValue) warn(`parameters[${i}]`, "no value");
  });

  sheet.tables.forEach((t, i) => {
    t.columns.forEach((c, j) => {
      if (!IDENT.test(c.id)) err(`tables[${i}].columns[${j}]`, `column id '${c.id}' is not a valid identifier`);
      if (c.kind === "computed" && !c.expr) err(`tables[${i}].columns[${j}]`, "computed column without expr");
    });
    t.rows.forEach((r, j) => {
      if (r.length !== t.columns.length) err(`tables[${i}].rows[${j}]`, `row has ${r.length} cells, expected ${t.columns.length}`);
    });
  });
  sheet.curves.forEach((c, i) => {
    if (c.series.length === 0) err(`curves[${i}]`, "no series");
    c.series.forEach((s, j) => {
      const p = `curves[${i}].series[${j}]`;
      if (s.x.length !== s.y.length) err(p, `x has ${s.x.length} points, y has ${s.y.length}`);
      if (s.x.length < 2) err(p, "needs at least 2 points");
      if (c.xAxis.scale === "log" && s.x.some((v) => v <= 0)) err(p, "x <= 0 on log axis");
      if (c.yAxis.scale === "log" && s.y.some((v) => v <= 0)) err(p, "y <= 0 on log axis");
    });
    if (c.series.length > 1 && c.series.some((s) => s.param === null))
      warn(`curves[${i}]`, "family of curves without numeric param on every series; curve(id, x, p) blending will not work");
  });
  sheet.patterns.forEach((pt, i) =>
    pt.series.forEach((s, j) => {
      if (s.angleDeg.length !== s.gain.length) err(`patterns[${i}].series[${j}]`, "angleDeg/gain length mismatch");
    }),
  );

  // compile + evaluate everything at defaults
  let engine: SheetEngine;
  try {
    engine = new SheetEngine(sheet);
  } catch (e) {
    err("engine", (e as Error).message);
    return issues;
  }
  const known = new Set([...globalIds.keys(), "spec", "row", "x", "p", "pi", "e", "true", "false", "Infinity", "NaN"]);
  const checkExpr = (expr: string, path: string, extra: string[] = []) => {
    try {
      engine.compile(expr);
      for (const s of engine.symbolsOf(expr)) {
        if (!known.has(s) && !extra.includes(s) && !(s in (engine.math as unknown as Record<string, unknown>)))
          err(path, `unknown symbol '${s}' in: ${expr}`);
      }
    } catch (e) {
      err(path, `does not parse: ${(e as Error).message} in: ${expr}`);
    }
  };
  sheet.calculators.forEach((c, i) => {
    c.inputs.forEach((v) => { if (!sheet.variables.some((x) => x.id === v)) err(`calculators[${i}].inputs`, `unknown variable '${v}'`); });
    c.outputs.forEach((o, j) => checkExpr(o.expr, `calculators[${i}].outputs[${j}]`));
  });
  sheet.checks.forEach((c, i) => checkExpr(c.when, `checks[${i}]`));
  sheet.tables.forEach((t, i) => t.columns.forEach((c, j) => c.expr && checkExpr(c.expr, `tables[${i}].columns[${j}]`)));
  sheet.curves.forEach((c, i) => {
    if (c.fit) checkExpr(c.fit.expr, `curves[${i}].fit`, ["x", "p"]);
    if (c.cursorX) checkExpr(c.cursorX, `curves[${i}].cursorX`);
    if (c.cursorParam) checkExpr(c.cursorParam, `curves[${i}].cursorParam`);
  });
  if (issues.some((i) => i.severity === "error")) return issues;

  const res = engine.evaluate({});
  for (const [id, m] of Object.entries(res.errors)) err(`output '${id}'`, `evaluation error at defaults: ${m}`);
  for (const [id, v] of Object.entries(res.outputs))
    if (!res.errors[id] && !Number.isFinite(v)) warn(`output '${id}'`, "is NaN/infinite at default variable values (out of characterized range?)");
  for (const c of res.checks) if (c.error) err(`check '${c.id}'`, c.error);
  // fits should roughly match their data
  sheet.curves.forEach((c, i) => {
    if (!c.fit) return;
    let worst = 0;
    for (const s of c.series) for (let k = 0; k < s.x.length; k++) {
      const f = engine.evalExpr(`curvefit("${c.id}", ${s.x[k]}, ${s.param ?? "NaN"})`);
      const rel = Math.abs(f - s.y[k]) / Math.max(1e-30, Math.abs(s.y[k]));
      if (Number.isFinite(rel)) worst = Math.max(worst, rel);
      else worst = Infinity;
    }
    if (worst > 0.35) warn(`curves[${i}].fit`, `fit deviates from digitized data by up to ${(worst * 100).toFixed(0)}%`);
  });
  return issues;
}

/* ------------------------------------------------------------------ */
/* Formatting */

const SI = [
  [1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"],
] as const;
const PREFIX: Record<string, number> = { T: 1e12, G: 1e9, M: 1e6, k: 1e3, "": 1, m: 1e-3, µ: 1e-6, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
// order matters: "mA" must match A before m
const BASE_UNITS = ["Hz", "V", "A", "W", "s", "F", "H", "Ω", "ohm", "J", "Wh", "Ah", "Baud", "baud", "bps", "S", "g", "m"];

function splitUnit(unit: string): [number, string] | null {
  for (const b of BASE_UNITS) {
    if (unit === b) return [1, b];
    if (unit.endsWith(b)) {
      const pre = unit.slice(0, -b.length);
      if (pre in PREFIX) return [PREFIX[pre], b];
    }
  }
  return null;
}

export function sig(v: number, digits = 4): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(digits - 1).replace(/\.?0+e/, "e");
  const s = v.toPrecision(digits);
  return s.includes(".") && !s.includes("e") ? s.replace(/\.?0+$/, "") : s;
}

export function formatValue(v: number | string | null | undefined, unit: string | null, format: string | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (format === "bool") return v ? "yes" : "no";
  if (!Number.isFinite(v)) return "—";
  const u = unit ? ` ${unit}` : "";
  if (format === "hex") return "0x" + Math.round(v).toString(16).toUpperCase().padStart(2, "0");
  if (format === "int") return `${Math.round(v)}${u}`;
  if (format === "sci") return `${v.toExponential(3)}${u}`;
  const fm = format?.match(/^fixed(\d)$/);
  if (fm) return `${v.toFixed(Number(fm[1]))}${u}`;
  if (format === "si" && unit) {
    const sp = splitUnit(unit);
    if (sp) {
      const base = v * sp[0];
      const a = Math.abs(base);
      const [f, p] = SI.find(([f]) => a >= f * 0.9995) ?? SI[SI.length - 1];
      return `${sig(base / f)} ${p}${sp[1]}`;
    }
  }
  return `${sig(v)}${u}`;
}
