import { useEffect, useMemo, useState } from "react";
import type { Calculator, Cell, SheetFile, UserState, Variable } from "../../src/schema";
import { SheetEngine, formatValue } from "../../src/engine";
import { clearState, downloadSheet, loadState, saveState, type LibraryEntry } from "../store";
import { VariablePanel } from "./Inputs";
import { EditableTable, SpecTable } from "./Tables";
import { CurvePlot, PatternPlot } from "./Plot";

type Tab = "calc" | "graphs" | "tables" | "specs" | "patterns" | "about";

export function SheetView({ file, entry }: { file: SheetFile; entry: LibraryEntry }) {
  const sheet = file.sheet;
  const id = sheet.meta.id;
  const engine = useMemo(() => new SheetEngine(sheet), [sheet]);

  const initial = useMemo<UserState>(() => loadState(id) ?? file.userState ?? {}, [id, file]);
  const [values, setValues] = useState<Record<string, number>>(initial.variables ?? {});
  const [tableEdits, setTableEdits] = useState<Record<string, Cell[][]>>(initial.tables ?? {});
  const [tab, setTab] = useState<Tab>("calc");
  const [showExpr, setShowExpr] = useState(false);

  useEffect(() => {
    const s = loadState(id) ?? file.userState ?? {};
    setValues(s.variables ?? {});
    setTableEdits(s.tables ?? {});
  }, [id, file]);
  useEffect(() => saveState(id, { variables: values, tables: tableEdits }), [id, values, tableEdits]);

  const result = useMemo(() => {
    for (const t of sheet.tables) engine.setTableRows(t.id, tableEdits[t.id] ?? t.rows);
    const r = engine.evaluate(values);
    const cursors = Object.fromEntries(sheet.curves.map((c) => [c.id, {
      x: c.cursorX ? engine.evalExpr(c.cursorX) : null,
      p: c.cursorParam ? engine.evalExpr(c.cursorParam) : null,
    }]));
    return { ...r, cursors };
  }, [engine, sheet, values, tableEdits]);

  const varById = useMemo(() => new Map(sheet.variables.map((v) => [v.id, v])), [sheet]);
  // page anchors only work when the source is an actual PDF (not e.g. a manual-hosting web page)
  const isPdf = !!entry.source && /\.pdf($|[?#])/i.test(entry.source);
  const pageLink = (p: number | null) => (isPdf && p ? `${entry.source}#page=${p}` : null);
  const angleVar = sheet.variables.find((v) => /angle|azimuth|theta|phi|direction|bearing/i.test(v.id));
  const fitFn = (curveId: string) => (x: number, p: number) => engine.evalExpr(`curvefit("${curveId}", ${x}, ${Number.isFinite(p) ? p : "NaN"})`);

  const active = result.checks.filter((c) => c.active);
  const tabs: [Tab, string, number][] = [
    ["calc", "Calculators", sheet.calculators.length],
    ["graphs", "Graphs", sheet.curves.length],
    ["patterns", "Patterns", sheet.patterns.length],
    ["tables", "Tables", sheet.tables.length],
    ["specs", "Specs", sheet.parameters.length],
    ["about", "About", 1],
  ];

  return (
    <div className="sheet">
      <header className="sheet-head">
        <div>
          <div className="eyebrow">{sheet.meta.manufacturer} · {sheet.meta.category}</div>
          <h1>{sheet.meta.title}</h1>
          <p className="summary">{sheet.meta.summary}</p>
        </div>
        <div className="actions">
          {entry.source && <a className="btn" href={entry.source} target="_blank" rel="noreferrer">{isPdf ? "Source PDF" : "Source"}</a>}
          <button className="btn" onClick={() => downloadSheet(file, { variables: values, tables: tableEdits })} title="Download this sheet including your inputs and table edits">Download .sheet.json</button>
        </div>
      </header>

      <div className="layout">
        <VariablePanel variables={sheet.variables} values={values} onChange={(k, x) => setValues((s) => ({ ...s, [k]: x }))} onReset={() => setValues({})} />

        <main>
          {active.length > 0 && (
            <ul className="checks">
              {active.map((c) => <li key={c.id} className={c.severity}>{c.message}</li>)}
            </ul>
          )}
          <nav className="tabs">
            {tabs.filter(([, , n]) => n > 0).map(([k, label, n]) => (
              <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                {label}{k !== "about" && <span className="count">{n}</span>}
              </button>
            ))}
            {tab === "calc" && <label className="toggle"><input type="checkbox" checked={showExpr} onChange={(e) => setShowExpr(e.target.checked)} /> show formulas</label>}
          </nav>

          {tab === "calc" && (
            <div className="grid">
              {sheet.calculators.map((c) => <CalcCard key={c.id} calc={c} varById={varById} values={values} result={result} showExpr={showExpr} pageLink={pageLink} />)}
            </div>
          )}

          {tab === "graphs" && (
            <div className="grid wide">
              {sheet.curves.map((c) => {
                const link = pageLink(c.page);
                return (
                  <section key={c.id} className="card">
                    <header>
                      <h3>{c.title}</h3>
                      <span className="meta">
                        {c.figure && <span>{c.figure}</span>}
                        {link && <a href={link} target="_blank" rel="noreferrer">p. {c.page}</a>}
                        <span className={`badge conf-${c.confidence}`} title="Digitization confidence">{c.confidence}</span>
                      </span>
                    </header>
                    <CurvePlot curve={c} cursorX={result.cursors[c.id]?.x ?? null} cursorParam={result.cursors[c.id]?.p ?? null} fitFn={c.fit ? fitFn(c.id) : undefined} />
                    {c.fit && <p className="desc"><code>{c.fit.expr}</code> — {c.fit.description}</p>}
                    {c.notes && <p className="desc">{c.notes}</p>}
                  </section>
                );
              })}
            </div>
          )}

          {tab === "patterns" && (
            <div className="grid wide">
              {sheet.patterns.map((p) => (
                <section key={p.id} className="card">
                  <header><h3>{p.title}</h3><span className="meta">{p.frequencyMHz && <span>{p.frequencyMHz} MHz</span>}{pageLink(p.page) && <a href={pageLink(p.page)!} target="_blank" rel="noreferrer">p. {p.page}</a>}</span></header>
                  <PatternPlot pattern={p} angle={angleVar ? values[angleVar.id] ?? angleVar.default : null} />
                  {p.notes && <p className="desc">{p.notes}</p>}
                </section>
              ))}
            </div>
          )}

          {tab === "tables" && (
            <div className="stack">
              {sheet.tables.map((t) => (
                <EditableTable
                  key={t.id} table={t} rows={tableEdits[t.id] ?? t.rows} values={result.tableValues[t.id] ?? []}
                  edited={!!tableEdits[t.id]}
                  onEdit={(rows) => setTableEdits((s) => ({ ...s, [t.id]: rows }))}
                  onReset={() => setTableEdits((s) => { const n = { ...s }; delete n[t.id]; return n; })}
                  pageLink={pageLink}
                />
              ))}
            </div>
          )}

          {tab === "specs" && <SpecTable params={sheet.parameters} pageLink={pageLink} />}

          {tab === "about" && (
            <section className="card about">
              {sheet.notes.length > 0 && <><h3>Notes</h3><ul>{sheet.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
              <h3>Provenance</h3>
              <dl>
                <dt>Part</dt><dd>{sheet.meta.partNumber}{sheet.meta.revision && ` — ${sheet.meta.revision}`}</dd>
                <dt>Source file</dt><dd>{file.source.fileName}{file.source.pages && ` (${file.source.pages} pages)`}</dd>
                {file.source.url && <><dt>Source URL</dt><dd><a href={file.source.url} target="_blank" rel="noreferrer">{file.source.url}</a></dd></>}
                {file.source.sha256 && <><dt>SHA-256</dt><dd><code>{file.source.sha256}</code></dd></>}
                <dt>Generated by</dt><dd>{file.generator.tool}{file.generator.model && ` · ${file.generator.model}`} · {new Date(file.generator.createdAt).toLocaleDateString()}</dd>
                {file.generator.usage && <><dt>Ingest cost</dt><dd>{file.generator.usage.inputTokens.toLocaleString()} input / {file.generator.usage.outputTokens.toLocaleString()} output tokens (one time)</dd></>}
              </dl>
              <p className="desc">Values come from an automated extraction, and graphs are digitized. Verify anything critical against the source datasheet.</p>
              <button className="link" onClick={() => { clearState(id); setValues({}); setTableEdits({}); }}>Clear my saved inputs &amp; edits for this sheet</button>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function CalcCard({ calc, varById, values, result, showExpr, pageLink }: {
  calc: Calculator; varById: Map<string, Variable>; values: Record<string, number>;
  result: { outputs: Record<string, number>; errors: Record<string, string> }; showExpr: boolean;
  pageLink: (p: number | null) => string | null;
}) {
  const link = pageLink(calc.page);
  return (
    <section className="card calc">
      <header>
        <h3>{calc.title}</h3>
        {link && <span className="meta"><a href={link} target="_blank" rel="noreferrer">p. {calc.page}</a></span>}
      </header>
      {calc.description && <p className="desc">{calc.description}</p>}
      {calc.inputs.length > 0 && (
        <div className="chips">
          {calc.inputs.map((id) => {
            const v = varById.get(id);
            if (!v) return null;
            const x = values[id] ?? v.default;
            const opt = v.options?.find((o) => o.value === x);
            return <span key={id} className="chip">{v.symbol ?? v.label} = {opt ? opt.label : formatValue(x, v.unit, null)}</span>;
          })}
        </div>
      )}
      <dl className="outputs">
        {calc.outputs.map((o) => {
          const err = result.errors[o.id];
          const v = result.outputs[o.id];
          return (
            <div key={o.id} className={`out ${err ? "err" : ""} ${!err && !Number.isFinite(v) ? "nan" : ""}`} title={o.description ?? undefined}>
              <dt>{o.label}</dt>
              <dd>{err ? "error" : formatValue(v, o.unit, o.format)}</dd>
              {showExpr && <code className="expr">{o.id} = {o.expr}</code>}
              {showExpr && err && <div className="errmsg">{err}</div>}
            </div>
          );
        })}
      </dl>
    </section>
  );
}
