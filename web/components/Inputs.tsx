import { type JSX, useState } from 'react';
import { sig } from '../../src/engine';
import type { Variable } from '../../src/schema';

function sliderPos(v: Variable, x: number) {
  const lo = v.min ?? 0;
  const hi = v.max ?? 1;
  return (v.scale === 'log' && lo > 0 ? Math.log(x / lo) / Math.log(hi / lo) : (x - lo) / (hi - lo)) * 1000;
}
function fromSlider(v: Variable, pos: number) {
  const lo = v.min ?? 0;
  const hi = v.max ?? 1;
  let x = v.scale === 'log' && lo > 0 ? lo * (hi / lo) ** (pos / 1000) : lo + ((hi - lo) * pos) / 1000;
  x = v.step ? Math.round(x / v.step) * v.step : Number(sig(x, 3));
  return Number(x.toPrecision(12));
}
function parseNumber(t: string): number {
  if (/^0x[0-9a-f]+$/i.test(t)) return Number.parseInt(t, 16);
  if (t === '') return NaN;
  return Number(t);
}

export function VariableInput({
  v,
  value,
  onChange,
}: {
  v: Variable;
  value: number;
  onChange: (x: number) => void;
}): JSX.Element {
  const [text, setText] = useState(String(value));
  // Re-sync the text box when the value changes from outside (slider, reset, arrow keys)
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setText(String(value));
  }
  const changed = value !== v.default;

  if (v.options) {
    const known = v.options.some((o) => o.value === value);
    return (
      <label className={`var ${changed ? 'changed' : ''}`} title={v.description ?? undefined}>
        <span className="var-label">
          {v.label}
          {v.symbol && <em> {v.symbol}</em>}
        </span>
        <select
          value={known ? value : ''}
          onChange={(e) => {
            onChange(Number(e.target.value));
          }}
        >
          {!known && <option value="">{value}</option>}
          {v.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const commit = (s: string) => {
    const t = s.trim().replace(',', '.').replaceAll(/[−–]/g, '-');
    const n = parseNumber(t);
    if (Number.isFinite(n)) onChange(n);
    else setText(String(value));
  };
  const hasRange = v.min !== null && v.max !== null && v.max > v.min;
  return (
    <label className={`var ${changed ? 'changed' : ''}`} title={v.description ?? undefined}>
      <span className="var-label">
        {v.label}
        {v.symbol && <em> {v.symbol}</em>}
      </span>
      <span className="var-row">
        <input
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onBlur={(e) => {
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit(e.currentTarget.value);
              return;
            }
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const step = v.step ?? (v.scale === 'log' ? value * 0.1 : 1);
            onChange(Number((value + (e.key === 'ArrowUp' ? step : -step)).toPrecision(12)));
          }}
        />
        {v.unit && <span className="unit">{v.unit}</span>}
      </span>
      {hasRange && (
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.max(0, Math.min(1000, sliderPos(v, value)))}
          onChange={(e) => {
            onChange(fromSlider(v, Number(e.target.value)));
          }}
        />
      )}
    </label>
  );
}

export function VariablePanel({
  variables,
  values,
  onChange,
  onReset,
}: {
  variables: Variable[];
  values: Record<string, number>;
  onChange: (id: string, x: number) => void;
  onReset: () => void;
}): JSX.Element {
  const groups = new Map<string, Variable[]>();
  for (const v of variables) {
    const g = v.group ?? 'Inputs';
    const list = groups.get(g);
    if (list) list.push(v);
    else groups.set(g, [v]);
  }
  const anyChanged = variables.some((v) => (values[v.id] ?? v.default) !== v.default);
  return (
    <aside className="inputs">
      <div className="inputs-head">
        <h2>Operating point</h2>
        {anyChanged && (
          <button className="link" onClick={onReset}>
            reset
          </button>
        )}
      </div>
      {[...groups].map(([g, vs]) => (
        <fieldset key={g}>
          <legend>{g}</legend>
          {vs.map((v) => (
            <VariableInput
              key={v.id}
              v={v}
              value={values[v.id] ?? v.default}
              onChange={(x) => {
                onChange(v.id, x);
              }}
            />
          ))}
        </fieldset>
      ))}
    </aside>
  );
}
