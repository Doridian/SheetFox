# SheetFox

An interactive datasheet player. Datasheets are converted **once** by Claude into a self-contained
`.sheet.json`. From then on the viewer answers questions like _"at 5 V in, what's the max current?"_
or _"which PATABLE byte gives +10 dBm at 868 MHz, and what does TX draw?"_ from that file alone, with no
further API calls.

```
 datasheet.pdf ──► upload in the viewer ──► <data>/library/<id>/ ──► viewer
   (or image,       or npm run ingest         sheet.json + the PDF     ▲ download / upload ▼
    text, URL)      Claude Opus 5.5                                    └── your inputs & table edits travel with the file
                    + validator/repair
```

SheetFox ships with no sheets: the library is whatever has been ingested on your server (or, locally,
with the CLI into `library/`).

## What a sheet contains

| Part          | What it is                                                                                                               | In the viewer                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `variables`   | The knobs: supply, temperature, current, band, register fields…                                                          | Sidebar inputs with sliders (log-aware) and dropdowns          |
| `calculators` | [mathjs](https://mathjs.org) expressions over variables, other outputs, specs, curves and tables                         | Live result cards (_show formulas_ reveals the math)           |
| `checks`      | Boolean expressions such as "V_CE > V_CEO" or "outside characterized range"; messages can embed `{expr}` values          | Error/warning/info banners                                     |
| `curves`      | Digitized graphs; families carry a numeric `param` (temperature, V_GS, pulse width…), plus an optional closed-form `fit` | Plotly charts with an operating-point cursor                   |
| `patterns`    | Antenna radiation patterns (gain vs angle)                                                                               | Polar plots                                                    |
| `tables`      | Datasheet tables with optional computed columns (`row.<col>`)                                                            | Editable: change a cell and every dependent calculator updates |
| `parameters`  | Every min/typ/max spec with conditions and page number                                                                   | Searchable spec list linking to the PDF page                   |

Functions available in expressions:

| Function                                                 | What it does                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curve(id, x[, p])`                                      | Interpolates a curve (log-aware). For families, `p` blends between neighbouring series. Returns NaN outside the data, so nothing is silently extrapolated. |
| `curvefit(id, x[, p])`                                   | Evaluates the curve's fitted formula                                                                                                                       |
| `tlookup(table, keyCol, key, valCol)`                    | Interpolated lookup in a table                                                                                                                             |
| `tindex(table, keyCol, key, valCol)`                     | Nearest-row lookup in a table                                                                                                                              |
| `pattern(id, series, angle)`                             | Gain from a radiation pattern at an angle                                                                                                                  |
| `patternmax(id, series)`, `patternavg(id, series)`       | Peak / power-averaged gain of a pattern cut                                                                                                                |
| `dbm2w`, `w2dbm`, `db2lin`, `lin2db`, `clamp`, `between` | Unit conversion and range helpers                                                                                                                          |

Specs are referenced as `spec.<id>.min|typ|max`.

## Usage

```sh
npm install
npm run dev                      # viewer on http://localhost:5173
npm run ingest -- datasheets/part.pdf        # PDF → library/<id>/sheet.json (needs ANTHROPIC_API_KEY)
npm run ingest -- https://…/part.pdf         # URLs, images (.png/.jpg) and text/HTML work too
npm run ingest -- part.pdf -o part.sheet.json   # write a standalone file instead
npm run validate                 # check every library sheet, rebuild library/index.json
npm run index                    # just rebuild library/index.json (dev does this automatically)
npm run build                    # static viewer in dist/ (no sheets; npm run dev serves the local library/)
```

Ingestion is keyed by the source file's SHA-256. Running it again on the same PDF is a no-op unless
you pass `--force`, so you never pay twice for the same sheet. `--effort low|medium|high|xhigh|max`
trades cost for thoroughness (default `medium`). Set `SHEETFOX_MODEL` to use a different model.

How ingest works: the PDF is sent as a document block, and Claude returns JSON matching
`SheetBody`, whose JSON Schema is part of the system prompt (it is too large for grammar-constrained
structured outputs), and zod checks the reply. The shared engine in `src/engine.ts` then compiles and evaluates
every expression at the default operating point and checks ids, array lengths, log axes and
fit-vs-data error. Any problems go back to Claude for up to two repair rounds. The PDF block is
prompt-cached, so repair rounds are cheap. A reply that hits the model's 128k output-token limit is continued in
up to three follow-up turns and joined (`SHEETFOX_MAX_OUTPUT_TOKENS` lowers the limit, to test this).

In the viewer:

- **Open .sheet.json** (or drag-and-drop anywhere) imports a sheet into this browser.
- **Download .sheet.json** exports the sheet _including_ your current inputs and table edits
  (`userState`), so a colleague who opens it lands on the same operating point.
- Inputs and edits are also remembered per sheet in browser storage.

## Server (upload & ingest from the browser)

`server/server.ts` serves the viewer plus a small ingest API, so datasheets can be uploaded in the browser and converted on the server. It is **bring your own key**: each user enters their Anthropic API key in the
viewer, it is sent with each ingest request and only kept in memory for that job (never stored, logged or shown in the
job list). Each finished sheet is stored in `$SHEETFOX_DATA_DIR/library/<id>/` together with its source file and appears
in the library for everyone. Uploads are deduplicated by SHA-256 just like the CLI, so nobody pays twice for the same
file. Starting with an empty data dir gives an empty library.

```sh
npm run build && npm run server   # http://127.0.0.1:8080
npm run build:server              # bundle into dist-server/server.mjs (only needs node)
nix build .#sheetfox              # static site in share/sheetfox, bin/sheetfox-server
```

The server does no authentication itself; run it behind a proxy that does. If the proxy sets (and always overwrites)
`X-Preferred-Username`, jobs show who started them.

| Variable              | Default           |                                                    |
| --------------------- | ----------------- | -------------------------------------------------- |
| `SHEETFOX_LISTEN`     | `127.0.0.1:8080`  | listen address                                     |
| `SHEETFOX_STATIC_DIR` | `dist`            | built viewer                                       |
| `SHEETFOX_DATA_DIR`   | `data`            | writable state (ingested sheets and their sources) |
| `SHEETFOX_MAX_JOBS`   | `3`               | ingest jobs running at once, across all users      |
| `SHEETFOX_MODEL`      | `claude-opus-5-5` | model used for ingest                              |

## Layout

```
src/schema.ts      data model (Zod) – the file format and Claude's output schema
src/engine.ts      expression evaluation, interpolation, validation, formatting (browser + Node)
ingest/            CLI: ingest.ts, core.ts (shared pipeline), prompt.ts, validate.ts, library.ts
server/            web server: static viewer + ingest API
web/               React + Plotly viewer (Vite)
library/           local CLI output (<id>/sheet.json + source); gitignored, index.json is generated
datasheets/        your local source PDFs (gitignored)
```

## Source PDFs

The source file is stored next to the sheet it produced (`<id>/<fileName>` beside `<id>/sheet.json`), on the server
and by the CLI. In the viewer, "Source" and the per-value page links open that copy; a sheet whose source is missing
falls back to `source.url`. Each sheet also records the source's SHA-256. Datasheets are the manufacturers' copyright,
so none are in this repository.

## Caveats

Graph digitization is approximate. Each curve carries a `confidence` rating, and every value links
back to its PDF page. Verify anything safety-critical against the source.

## License

SheetFox's code is licensed under the [GNU AGPL v3.0 or later](LICENSE). Datasheets remain the property of their
respective manufacturers.
