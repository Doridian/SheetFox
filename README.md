# SheetFox

An interactive datasheet player. Datasheets are converted **once** by Claude into a self-contained
`.sheet.json`. From then on the viewer answers questions like *"at 5 V in, what's the max current?"*
or *"which PATABLE byte gives +10 dBm at 868 MHz, and what does TX draw?"* from that file alone, with no
further API calls.

```
 datasheet.pdf ──► npm run ingest ──► library/<id>/sheet.json ──► viewer (static, offline)
   (or image,       Claude Opus 5.5      ▲ download / upload ▼
    text, URL)      + validator/repair   └── your inputs & table edits travel with the file
```

## What a sheet contains

| Part | What it is | In the viewer |
|---|---|---|
| `variables` | The knobs: supply, temperature, current, band, register fields… | Sidebar inputs with sliders (log-aware) and dropdowns |
| `calculators` | [mathjs](https://mathjs.org) expressions over variables, other outputs, specs, curves and tables | Live result cards (*show formulas* reveals the math) |
| `checks` | Boolean expressions such as "V_CE > V_CEO" or "outside characterized range"; messages can embed `{expr}` values | Error/warning/info banners |
| `curves` | Digitized graphs; families carry a numeric `param` (temperature, V_GS, pulse width…), plus an optional closed-form `fit` | Plotly charts with an operating-point cursor |
| `patterns` | Antenna radiation patterns (gain vs angle) | Polar plots |
| `tables` | Datasheet tables with optional computed columns (`row.<col>`) | Editable: change a cell and every dependent calculator updates |
| `parameters` | Every min/typ/max spec with conditions and page number | Searchable spec list linking to the PDF page |

Functions available in expressions:

| Function | What it does |
|---|---|
| `curve(id, x[, p])` | Interpolates a curve (log-aware). For families, `p` blends between neighbouring series. Returns NaN outside the data, so nothing is silently extrapolated. |
| `curvefit(id, x[, p])` | Evaluates the curve's fitted formula |
| `tlookup(table, keyCol, key, valCol)` | Interpolated lookup in a table |
| `tindex(table, keyCol, key, valCol)` | Nearest-row lookup in a table |
| `pattern(id, series, angle)` | Gain from a radiation pattern at an angle |
| `patternmax(id, series)`, `patternavg(id, series)` | Peak / power-averaged gain of a pattern cut |
| `dbm2w`, `w2dbm`, `db2lin`, `lin2db`, `clamp`, `between` | Unit conversion and range helpers |

Specs are referenced as `spec.<id>.min|typ|max`.

## Usage

```sh
npm install
npm run dev                      # viewer on http://localhost:5173
npm run ingest -- datasheets/part.pdf        # PDF → library/<id>/sheet.json (needs ANTHROPIC_API_KEY)
npm run ingest -- https://…/part.pdf         # URLs, images (.png/.jpg) and text/HTML work too
npm run ingest -- part.pdf -o part.sheet.json   # write a standalone file instead
npm run validate                 # check every library sheet, rebuild library/index.json
npm run index                    # just rebuild library/index.json (dev/build do this automatically)
npm run build                    # static site in dist/ (library included)
```

Ingestion is keyed by the source file's SHA-256. Running it again on the same PDF is a no-op unless
you pass `--force`, so you never pay twice for the same sheet. `--effort low|medium|high|xhigh|max`
trades cost for thoroughness (default `high`). Set `SHEETFOX_MODEL` to use a different model.

How ingest works: the PDF is sent as a document block, and Claude returns JSON constrained to
`SheetBody` (structured outputs). The shared engine in `src/engine.ts` then compiles and evaluates
every expression at the default operating point and checks ids, array lengths, log axes and
fit-vs-data error. Any problems go back to Claude for up to two repair rounds. The PDF block is
prompt-cached, so repair rounds are cheap.

In the viewer:
- **Open .sheet.json** (or drag-and-drop anywhere) imports a sheet into this browser.
- **Download .sheet.json** exports the sheet *including* your current inputs and table edits
  (`userState`), so a colleague who opens it lands on the same operating point.
- Inputs and edits are also remembered per sheet in browser storage.

## Layout

```
src/schema.ts      data model (Zod) – the file format and Claude's output schema
src/engine.ts      expression evaluation, interpolation, validation, formatting (browser + Node)
ingest/            CLI: ingest.ts, prompt.ts, validate.ts, library.ts
web/               React + Plotly viewer (Vite)
library/           ingested sheets (<id>/sheet.json); index.json is generated
datasheets/        your local source PDFs (gitignored)
```

## Source PDFs

Datasheets are the manufacturers' copyright, so PDFs are **not** in this repository (`datasheets/`
and `library/**/*.pdf` are gitignored). Each sheet records where its PDF came from (`source.url`)
and its SHA-256. In the viewer, "Source PDF" and the per-value page links open your local copy if
`library/<id>/<fileName>` exists, and otherwise fall back to that URL. Drop the original PDF there
(ingest does this for you) to get offline page links.

## Caveats

Graph digitization is approximate. Each curve carries a `confidence` rating, and every value links
back to its PDF page. Verify anything safety-critical against the source.

## License

SheetFox's code is licensed under the [GNU AGPL v3.0 or later](LICENSE). Bundled datasheet PDFs
remain the property of their respective manufacturers.
