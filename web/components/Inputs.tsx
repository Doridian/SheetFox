import { useEffect, useState } from "react";
import type { Variable } from "../../src/schema";
import { sig } from "../../src/engine";

function sliderPos(v: Variable, x: number) {
  const lo = v.min ?? 0, hi = v.max ?? 1;
  if (v.scale === "log" && lo > 0) return (Math.log(x / lo) / Math.log(hi / lo)) * 1000;
  return ((x - lo) / (hi - lo)) * 1000;
}
function fromSlider(v: Variable, pos: number) {
  const lo = v.min ?? 0, hi = v.max ?? 1;
  let x = v.scale === "log" && lo > 0 ? lo * Math.pow(hi / lo, pos / 1000) : lo + ((hi - lo) * pos) / 1000;
  if (v.step) x = Math.round(x / v.step) * v.step;
  else x = Number(sig(x, 3));
  return Number(x.toPrecision(12));
}

export function VariableInput({ v, value, onChange }: { v: Variable; value: number; onChange: (x: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const changed = value !== v.default;

  if (v.options) {
    const known = v.options.some((o) => o.value === value);
    return (
      <label className={`var ${changed ? "changed" : ""}`} title={v.description ?? undefined}>
        <span className="var-label">{v.label}{v.symbol && <em> {v.symbol}</em>}</span>
        <select value={known ? value : ""} onChange={(e) => onChange(Number(e.target.value))}>
          {!known && <option value="">{value}</option>}
          {v.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    );
  }
  const commit = (s: string) => {
    const t = s.trim().replace(",", ".").replace(/[−–]/g, "-");
    const n = /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : t === "" ? NaN : Number(t);
    if (Number.isFinite(n)) onChange(n);
    else setText(String(value));
  };
  const hasRange = v.min !== null && v.max !== null && v.max > v.min;
  return (
    <label className={`var ${changed ? "changed" : ""}`} title={v.description ?? undefined}>
      <span className="var-label">{v.label}{v.symbol && <em> {v.symbol}</em>}</span>
      <span className="var-row">
        <input
          type="text" inputMode="decimal" value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const step = v.step ?? (v.scale === "log" ? value * 0.1 : 1);
              onChange(Number((value + (e.key === "ArrowUp" ? step : -step)).toPrecision(12)));
            }
          }}
        />
        {v.unit && <span className="unit">{v.unit}</span>}
      </span>
      {hasRange && (
        <input type="range" min={0} max={1000} value={Math.max(0, Math.min(1000, sliderPos(v, value)))} onChange={(e) => onChange(fromSlider(v, Number(e.target.value)))} />
      )}
    </label>
  );
}

export function VariablePanel({ variables, values, onChange, onReset }: {
  variables: Variable[]; values: Record<string, number>; onChange: (id: string, x: number) => void; onReset: () => void;
}) {
  const groups = new Map<string, Variable[]>();
  for (const v of variables) {
    const g = v.group ?? "Inputs";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(v);
  }
  const anyChanged = variables.some((v) => (values[v.id] ?? v.default) !== v.default);
  return (
    <aside className="inputs">
      <div className="inputs-head">
        <h2>Operating point</h2>
        {anyChanged && <button className="link" onClick={onReset}>reset</button>}
      </div>
      {[...groups].map(([g, vs]) => (
        <fieldset key={g}>
          <legend>{g}</legend>
          {vs.map((v) => <VariableInput key={v.id} v={v} value={values[v.id] ?? v.default} onChange={(x) => onChange(v.id, x)} />)}
        </fieldset>
      ))}
    </aside>
  );
}
