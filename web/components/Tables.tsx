import { type JSX, useMemo, useState } from 'react';
import { formatValue, sig } from '../../src/engine';
import type { Cell, Parameter, Table } from '../../src/schema';
import { parseCell } from '../store';

const fmtCell = (c: Cell): string => {
  if (c === null) return '';
  return typeof c === 'number' ? sig(c, 6) : c;
};
const fmtSpec = (v: number | null): string => (v === null ? '' : sig(v, 5));

export function EditableTable({
  table,
  rows,
  values,
  edited,
  onEdit,
  onReset,
  pageLink,
}: {
  table: Table;
  /** Data rows (possibly user-edited) */
  rows: Cell[][];
  /** Evaluated rows (data + computed) */
  values: Cell[][];
  edited: boolean;
  onEdit: (rows: Cell[][]) => void;
  onReset: () => void;
  pageLink: (p: number | null) => string | null;
}): JSX.Element {
  const setCell = (ri: number, ci: number, text: string) => {
    const next = rows.map((r) => [...r]);
    next[ri][ci] = parseCell(text);
    if (fmtCell(next[ri][ci]) !== fmtCell(rows[ri][ci])) onEdit(next);
  };
  const addRow = () => {
    onEdit([...rows.map((r) => [...r]), table.columns.map(() => null)]);
  };
  const delRow = (ri: number) => {
    onEdit(rows.filter((_, i) => i !== ri));
  };
  const link = pageLink(table.page);
  return (
    <section className="card table-card">
      <header>
        <h3>{table.title}</h3>
        <span className="meta">
          {link && (
            <a href={link} target="_blank" rel="noreferrer">
              p. {table.page}
            </a>
          )}
          {edited && (
            <>
              <span className="badge">edited</span>
              <button className="link" onClick={onReset}>
                revert
              </button>
            </>
          )}
        </span>
      </header>
      {table.description && <p className="desc">{table.description}</p>}
      <div className="scroll-x">
        <table className="data">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c.id} className={c.kind} title={c.expr ? `= ${c.expr}` : undefined}>
                  {c.label}
                  {c.unit && <span className="unit"> [{c.unit}]</span>}
                </th>
              ))}
              <th className="tools" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {table.columns.map((c, ci) =>
                  c.kind === 'computed' ? (
                    <td key={c.id} className="computed num">
                      {formatValue(values[ri]?.[ci], null, c.format)}
                    </td>
                  ) : (
                    <td
                      key={c.id + fmtCell(r[ci])}
                      className={typeof r[ci] === 'number' ? 'num' : ''}
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => {
                        setCell(ri, ci, e.currentTarget.textContent);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') {
                          return;
                        }

                        e.preventDefault();
                        e.currentTarget.blur();
                      }}
                    >
                      {fmtCell(r[ci])}
                    </td>
                  ),
                )}
                <td className="tools">
                  <button
                    className="icon"
                    title="Delete row"
                    onClick={() => {
                      delRow(ri);
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="link add-row" onClick={addRow}>
        + add row
      </button>
    </section>
  );
}

const CAT_LABEL: Record<string, string> = {
  absolute_max: 'Absolute max',
  recommended: 'Recommended',
  electrical: 'Electrical',
  rf: 'RF',
  optical: 'Optical',
  thermal: 'Thermal',
  timing: 'Timing',
  mechanical: 'Mechanical',
  environmental: 'Environmental',
  other: 'Other',
};

export function SpecTable({
  params,
  pageLink,
}: {
  params: Parameter[];
  pageLink: (p: number | null) => string | null;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const cats = useMemo(() => [...new Set(params.map((p) => p.category))], [params]);
  const ql = q.toLowerCase();
  const shown = params.filter(
    (p) =>
      (!cat || p.category === cat) &&
      (!ql || `${p.label} ${p.symbol ?? ''} ${p.conditions ?? ''} ${p.id}`.toLowerCase().includes(ql)),
  );
  return (
    <section className="card">
      <header className="spec-filter">
        <input
          type="search"
          placeholder="Filter specs…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
        />
        <select
          value={cat}
          onChange={(e) => {
            setCat(e.target.value);
          }}
        >
          <option value="">All categories</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {CAT_LABEL[c] ?? c}
            </option>
          ))}
        </select>
      </header>
      <div className="scroll-x">
        <table className="data specs">
          <thead>
            <tr>
              <th>Parameter</th>
              <th className="num">Min</th>
              <th className="num">Typ</th>
              <th className="num">Max</th>
              <th>Unit</th>
              <th>Conditions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const link = pageLink(p.page);
              return (
                <tr key={p.id} className={p.category === 'absolute_max' ? 'absmax' : ''}>
                  <td>
                    {p.label}
                    {p.symbol && <em className="sym"> {p.symbol}</em>}
                    <div className="id" title="Use in expressions as spec.<id>.min/typ/max">
                      {p.id}
                    </div>
                  </td>
                  {p.textValue ? (
                    <td colSpan={3}>{p.textValue}</td>
                  ) : (
                    <>
                      <td className="num">{fmtSpec(p.min)}</td>
                      <td className="num">{fmtSpec(p.typ)}</td>
                      <td className="num">{fmtSpec(p.max)}</td>
                    </>
                  )}
                  <td>{p.unit}</td>
                  <td className="cond">
                    {p.conditions}
                    {p.notes && <div className="note">{p.notes}</div>}
                  </td>
                  <td>
                    {link && (
                      <a href={link} target="_blank" rel="noreferrer">
                        p.{p.page}
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
