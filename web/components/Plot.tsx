import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import type { Curve, Pattern } from "../../src/schema";
import { evalCurve, evalPattern, sig } from "../../src/engine";

type Data = Partial<Plotly.PlotData>;

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return { fg: v("--fg"), muted: v("--muted"), grid: v("--grid"), bg: v("--surface"), accent: v("--accent"), series: v("--series").split(",").map((s) => s.trim()) };
}

function PlotlyDiv({ data, layout, height = 340 }: { data: Data[]; layout: Partial<Plotly.Layout>; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const t = themeColors();
    const base: Partial<Plotly.Layout> = {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: t.fg, family: "inherit", size: 12 },
      margin: { l: 60, r: 16, t: 8, b: 48 },
      colorway: t.series,
      legend: { orientation: "h", y: -0.22, font: { size: 11 } },
      hoverlabel: { bgcolor: t.bg, font: { color: t.fg } },
      height,
    };
    Plotly.react(el, data as Plotly.Data[], { ...base, ...layout }, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
  }, [data, layout, height]);
  useEffect(() => () => { if (ref.current) Plotly.purge(ref.current); }, []);
  return <div ref={ref} className="plot" />;
}

const axisTitle = (a: { label: string; unit: string | null }) => (a.unit ? `${a.label} [${a.unit}]` : a.label);

export function CurvePlot({ curve, cursorX, cursorParam, fitFn }: {
  curve: Curve; cursorX: number | null; cursorParam: number | null; fitFn?: (x: number, p: number) => number;
}) {
  const t = themeColors();
  const axis = (a: Curve["xAxis"]): Partial<Plotly.LayoutAxis> => ({
    title: { text: axisTitle(a) }, type: a.scale === "log" ? "log" : "linear", gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.muted, exponentformat: "SI",
  });
  // when the operating point selects exactly one series of a family, emphasize it
  const selected = cursorParam !== null ? curve.series.findIndex((s) => s.param !== null && Math.abs(s.param - cursorParam) < 1e-9) : -1;
  const data: Data[] = curve.series.map((s, i) => ({
    x: s.x, y: s.y, name: s.label, type: "scatter", mode: s.x.length <= 6 ? "lines+markers" : "lines",
    line: { width: selected === i ? 3.5 : 2, shape: "linear" }, opacity: selected >= 0 && selected !== i ? 0.3 : 1,
    hovertemplate: `%{x:.4~g}, %{y:.4~g}<extra>${s.label}</extra>`,
  }));

  // fit overlay
  if (curve.fit && fitFn) {
    const xs = curve.series.flatMap((s) => s.x).filter(Number.isFinite);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    const log = curve.xAxis.scale === "log" && lo > 0;
    const grid = Array.from({ length: 120 }, (_, i) => (log ? lo * Math.pow(hi / lo, i / 119) : lo + ((hi - lo) * i) / 119));
    const params = curve.series.some((s) => s.param !== null) ? curve.series.map((s) => s.param ?? NaN) : [NaN];
    params.forEach((p, i) => data.push({
      x: grid, y: grid.map((x) => fitFn(x, p)), name: "fit", showlegend: i === 0, legendgroup: "fit",
      type: "scatter", mode: "lines", line: { dash: "dash", width: 1.2, color: t.muted }, hovertemplate: `%{x:.4~g}, %{y:.4~g}<extra>fit</extra>`,
    }));
  }

  const shapes: Partial<Plotly.Shape>[] = [];
  const annotations: Partial<Plotly.Annotations>[] = [];
  if (cursorX !== null && Number.isFinite(cursorX)) {
    shapes.push({ type: "line", xref: "x", yref: "paper", x0: cursorX, x1: cursorX, y0: 0, y1: 1, line: { color: t.accent, width: 1.5, dash: "dot" } });
    const p = cursorParam ?? undefined;
    const y = evalCurve(curve, cursorX, p);
    if (Number.isFinite(y)) {
      data.push({ x: [cursorX], y: [y], name: "Operating point", type: "scatter", mode: "markers", marker: { size: 11, color: t.accent, symbol: "diamond", line: { width: 1.5, color: t.bg } }, hovertemplate: "%{x:.4~g}, %{y:.4~g}<extra>operating point</extra>" });
      annotations.push({ x: curve.xAxis.scale === "log" ? Math.log10(cursorX) : cursorX, y: curve.yAxis.scale === "log" ? Math.log10(y) : y, text: `${sig(y)} ${curve.yAxis.unit ?? ""}`, showarrow: true, arrowhead: 0, ax: 30, ay: -24, font: { color: t.accent }, bgcolor: t.bg });
    } else {
      annotations.push({ xref: "paper", yref: "paper", x: 0.99, y: 0.98, xanchor: "right", showarrow: false, text: "operating point outside characterized range", font: { color: t.muted, size: 11 } });
    }
  }
  return <PlotlyDiv data={data} layout={{ xaxis: axis(curve.xAxis), yaxis: axis(curve.yAxis), shapes, annotations }} />;
}

export function PatternPlot({ pattern, angle }: { pattern: Pattern; angle: number | null }) {
  const t = themeColors();
  const all = pattern.series.flatMap((s) => s.gain).filter(Number.isFinite);
  const lo = Math.floor(Math.min(...all) / 5) * 5, hi = Math.ceil(Math.max(...all) / 5) * 5;
  const data: Data[] = pattern.series.map((s) => {
    const idx = s.angleDeg.map((_, i) => i).sort((a, b) => s.angleDeg[a] - s.angleDeg[b]);
    const th = idx.map((i) => s.angleDeg[i]), r = idx.map((i) => s.gain[i]);
    return { type: "scatterpolar", theta: [...th, th[0]], r: [...r, r[0]], name: s.label, mode: "lines", line: { width: 2 }, hovertemplate: `%{theta}°: %{r:.2f} ${pattern.unit}<extra>${s.label}</extra>` } as Data;
  });
  if (angle !== null && Number.isFinite(angle)) {
    data.push({ type: "scatterpolar", theta: [angle, angle], r: [lo, hi], mode: "lines", name: "direction", line: { color: t.accent, dash: "dot", width: 1.5 }, hoverinfo: "skip" } as Data);
    pattern.series.forEach((_, i) => {
      const g = evalPattern(pattern, i, angle);
      if (Number.isFinite(g)) data.push({ type: "scatterpolar", theta: [angle], r: [g], mode: "markers", showlegend: false, marker: { size: 9, color: t.accent, symbol: "diamond" }, hovertemplate: `%{theta}°: %{r:.2f} ${pattern.unit}<extra>${pattern.series[i].label}</extra>` } as Data);
    });
  }
  return (
    <PlotlyDiv
      height={420}
      data={data}
      layout={{
        margin: { l: 30, r: 30, t: 20, b: 20 },
        polar: {
          bgcolor: "rgba(0,0,0,0)",
          radialaxis: { range: [lo, hi], gridcolor: t.grid, linecolor: t.muted, ticksuffix: ` ${pattern.unit}`, angle: 90, tickfont: { size: 10 } },
          angularaxis: { direction: "clockwise", rotation: 90, gridcolor: t.grid, linecolor: t.muted, ticksuffix: "°" },
        },
      }}
    />
  );
}
