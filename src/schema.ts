/**
 * SheetFox data model.
 *
 * `SheetBody` is what Claude produces from a datasheet (it doubles as the
 * structured-output schema, so it obeys the API's JSON-schema subset: every
 * object is strict, no records/tuples, "optional" is expressed as nullable).
 *
 * `SheetFile` is the self-contained file the viewer loads, downloads and
 * uploads. Once a datasheet is ingested, the file is all you need: no further
 * API calls.
 */
import { z } from 'zod';

const str = z.string();
const nstr = z.string().nullable();
const nnum = z.number().nullable();

export const AxisScale = z.enum(['linear', 'log']);

export const Meta = z.strictObject({
  id: str.describe("Short kebab-case id, e.g. 'cc1101' or '2n2222a-onsemi'"),
  title: str.describe("Human title, e.g. 'CC1101 Low-Power Sub-1 GHz RF Transceiver'"),
  partNumber: str,
  manufacturer: str,
  category: str.describe("Device class, e.g. 'RF transceiver', 'NPN BJT', 'LDO regulator', 'Fiber laser', 'Antenna'"),
  summary: str.describe(
    '2-4 sentence plain-language summary of what this part is and what matters when designing with it',
  ),
  revision: nstr.describe('Datasheet revision/date if printed'),
});

export const VariableOption = z.strictObject({ value: z.number(), label: str });

export const Variable = z.strictObject({
  id: str.describe('Identifier usable in expressions: [a-zA-Z_][a-zA-Z0-9_]*'),
  label: str,
  symbol: nstr.describe("Datasheet symbol, e.g. 'V_CE', 'f_XOSC'"),
  unit: nstr.describe(
    "Unit of the value the user types, e.g. 'V', 'mA', 'MHz', 'dBm'. Expressions see the raw number in this unit.",
  ),
  default: z.number(),
  min: nnum,
  max: nnum,
  step: nnum,
  scale: AxisScale.describe("Use 'log' for quantities spanning decades (currents, frequencies) – affects the slider"),
  options: z
    .array(VariableOption)
    .nullable()
    .describe('If set, the variable is a dropdown of these numeric values (e.g. band selection, register enum)'),
  group: nstr.describe("UI group heading, e.g. 'Operating point', 'Register settings'"),
  description: nstr,
});

export const ParamCategory = z.enum([
  'absolute_max',
  'recommended',
  'electrical',
  'rf',
  'optical',
  'thermal',
  'timing',
  'mechanical',
  'environmental',
  'other',
]);

export const Parameter = z.strictObject({
  id: str.describe('Identifier, referenced in expressions as spec.<id>.min / .typ / .max'),
  label: str,
  symbol: nstr,
  category: ParamCategory,
  min: nnum,
  typ: nnum,
  max: nnum,
  unit: nstr,
  textValue: nstr.describe("For non-numeric specs ('Air-cooled', 'Random', 'TO-92'); otherwise null"),
  conditions: nstr.describe('Test conditions exactly as stated (temperature, supply, frequency…)'),
  page: z.number().int().nullable().describe('1-based PDF page the value came from'),
  notes: nstr,
});

export const ColumnKind = z.enum(['data', 'computed']);

export const TableColumn = z.strictObject({
  id: str.describe('Identifier; computed columns reference other cells as row.<columnId>'),
  label: str,
  unit: nstr,
  kind: ColumnKind,
  expr: nstr.describe(
    'For computed columns: expression using row.<colId>, variables, spec.*, outputs. Null for data columns.',
  ),
  format: nstr.describe("Output format for computed columns: 'si', 'fixed2', 'hex', 'int', 'sci'; null = auto"),
});

export const Table = z.strictObject({
  id: str,
  title: str,
  page: z.number().int().nullable(),
  description: nstr,
  columns: z.array(TableColumn),
  rows: z
    .array(z.array(z.union([z.number(), z.string(), z.null()])))
    .describe(
      "Row-major cells aligned with columns. Numbers as numbers (no units). Use null for empty/'-'. Computed columns get null.",
    ),
});

export const Series = z.strictObject({
  label: str.describe("Legend label, e.g. 'T_A = 25 °C' or 'I_B = 1 mA'"),
  param: nnum.describe(
    'Numeric value of the family parameter for this series (e.g. 25 for 25 °C). Required for curve families.',
  ),
  x: z.array(z.number()),
  y: z.array(z.number()),
});

export const Axis = z.strictObject({ label: str, unit: nstr, scale: AxisScale });

export const Curve = z.strictObject({
  id: str,
  title: str,
  page: z.number().int().nullable(),
  figure: nstr.describe('Figure number/name in the datasheet'),
  xAxis: Axis,
  yAxis: Axis,
  paramLabel: nstr.describe("Name of the family parameter if series differ by a parameter (e.g. 'Temperature')"),
  paramUnit: nstr,
  paramScale: AxisScale,
  series: z
    .array(Series)
    .describe('Digitized points, x ascending. 8-40 points per series, denser where curvature is high.'),
  fit: z
    .strictObject({
      expr: str.describe(
        'Closed-form approximation in terms of x (and p for the family parameter). Same units as the axes.',
      ),
      description: str.describe('What the fit represents and its accuracy/validity range'),
    })
    .nullable(),
  cursorX: nstr.describe('Expression for an x position to mark on the plot (usually a variable id), or null'),
  cursorParam: nstr.describe('Expression selecting the family parameter for the cursor readout, or null'),
  confidence: z.enum(['high', 'medium', 'low']).describe('How accurately the graph could be digitized'),
  notes: nstr,
});

export const PatternSeries = z.strictObject({
  label: str.describe("e.g. 'E-plane 868 MHz', 'Azimuth (XY)'"),
  angleDeg: z.array(z.number()),
  gain: z.array(z.number()),
});

export const Pattern = z.strictObject({
  id: str,
  title: str,
  page: z.number().int().nullable(),
  unit: str.describe("Usually 'dBi' or 'dB' (normalized)"),
  frequencyMHz: nnum,
  series: z.array(PatternSeries),
  notes: nstr,
});

export const CalcOutput = z.strictObject({
  id: str.describe('Identifier; other expressions can reference it'),
  label: str,
  unit: nstr,
  expr: str.describe('mathjs expression. See system prompt for available functions.'),
  format: nstr.describe("'si' (SI prefixes on unit), 'fixed<N>', 'hex', 'int', 'sci', 'bool'; null = auto"),
  description: nstr,
});

export const Calculator = z.strictObject({
  id: str,
  title: str,
  description: nstr,
  inputs: z.array(str).describe('Variable ids this calculator is driven by (shown next to it)'),
  outputs: z.array(CalcOutput),
  page: z.number().int().nullable(),
});

export const Check = z.strictObject({
  id: str,
  severity: z.enum(['error', 'warning', 'info']),
  when: str.describe('Boolean expression; the message shows while it is true'),
  message: str,
});

export const SheetBody = z.strictObject({
  meta: Meta,
  variables: z.array(Variable),
  parameters: z.array(Parameter),
  tables: z.array(Table),
  curves: z.array(Curve),
  patterns: z.array(Pattern),
  calculators: z.array(Calculator),
  checks: z.array(Check),
  notes: z.array(str).describe('Important caveats, errata, or design notes from the datasheet'),
});

export const FORMAT_ID = 'sheetfox';
export const FORMAT_VERSION = 1;

export const UserState = z.object({
  variables: z.record(z.string(), z.number()).optional(),
  /** tableId -> rows (full replacement of the data cells) */
  tables: z.record(z.string(), z.array(z.array(z.union([z.number(), z.string(), z.null()])))).optional(),
});

export const SheetFile = z.object({
  format: z.literal(FORMAT_ID),
  formatVersion: z.number().int(),
  source: z.object({
    fileName: z.string(),
    sha256: z.string().nullable(),
    pages: z.number().int().nullable(),
    url: z.string().nullable().optional(),
  }),
  generator: z.object({
    tool: z.string(),
    model: z.string().nullable(),
    createdAt: z.string(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable().optional(),
  }),
  sheet: SheetBody,
  userState: UserState.nullable().optional(),
});

export type SheetBody = z.infer<typeof SheetBody>;
export type SheetFile = z.infer<typeof SheetFile>;
export type Variable = z.infer<typeof Variable>;
export type Parameter = z.infer<typeof Parameter>;
export type Table = z.infer<typeof Table>;
export type TableColumn = z.infer<typeof TableColumn>;
export type Curve = z.infer<typeof Curve>;
export type Series = z.infer<typeof Series>;
export type Pattern = z.infer<typeof Pattern>;
export type Calculator = z.infer<typeof Calculator>;
export type CalcOutput = z.infer<typeof CalcOutput>;
export type Check = z.infer<typeof Check>;
export type UserState = z.infer<typeof UserState>;
export type Cell = number | string | null;
