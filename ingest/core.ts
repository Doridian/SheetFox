/**
 * The ingest pipeline shared by the CLI (ingest.ts) and the web server (server/server.ts):
 * datasheet bytes -> validated SheetFile, with up to MAX_REPAIRS repair rounds.
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { errorMessage, type Issue, validateSheet } from '../src/engine';
import { FORMAT_ID, FORMAT_VERSION, SheetBody, type SheetFile } from '../src/schema';
import { sha256 } from './library';
import { continueInstruction, repairInstruction, SYSTEM_PROMPT, userInstruction } from './prompt';

export const MODEL = process.env.SHEETFOX_MODEL ?? 'claude-opus-5-5';
const MAX_REPAIRS = 2;
/** Opus 5.5's output limit; there is no way to raise it. The env var can only lower it (for testing continuations). */
const MAX_OUTPUT_TOKENS = Math.min(128_000, Number(process.env.SHEETFOX_MAX_OUTPUT_TOKENS ?? 128_000) || 128_000);
/** follow-up requests per round when a reply is cut off at MAX_OUTPUT_TOKENS */
const MAX_CONTINUATIONS = 3;
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export const EFFORTS = ['high', 'low', 'max', 'medium', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = 'medium';
export const isEffort = (s: string): s is Effort => (EFFORTS as readonly string[]).includes(s);

export interface SourceInput {
  buf: Buffer;
  fileName: string;
  url: string | null;
}

export interface IngestResult {
  file: SheetFile;
  issues: Issue[];
}

export interface IngestOptions {
  effort: Effort;
  /** progress lines ("Repair round 1…") */
  log?: (line: string) => void;
  /** called with the number of JSON characters received so far in the current round */
  onProgress?: (chars: number) => void;
  client?: Anthropic;
}

export async function loadInput(input: string): Promise<SourceInput> {
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { pathname } = new URL(input);
    const last = pathname.split('/').at(-1);
    const name = decodeURIComponent(last === undefined || last === '' ? 'datasheet.pdf' : last);
    return { buf, fileName: name, url: input };
  }
  return { buf: fs.readFileSync(input), fileName: path.basename(input), url: null };
}

function sourceBlock(buf: Buffer, fileName: string): Anthropic.Beta.BetaContentBlockParam {
  const ext = path.extname(fileName).toLowerCase();
  const cache = { cache_control: { type: 'ephemeral' as const } };
  if (ext === '.pdf' || buf.subarray(0, 4).toString() === '%PDF') {
    if (buf.length > MAX_SOURCE_BYTES) throw new Error('PDF larger than ~30 MB; split it first');
    return {
      type: 'document',
      // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array#toBase64 has no TS lib typings yet
      source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
      title: fileName,
      ...cache,
    };
  }
  const img: Partial<Record<string, 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mediaType = img[ext];
  if (mediaType)
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array#toBase64 has no TS lib typings yet
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') }, ...cache };
  // anything else: treat as text (html, md, txt, csv…)
  return {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: buf.toString('utf8') },
    title: fileName,
    ...cache,
  };
}

/**
 * The SheetBody schema is too big for grammar-constrained decoding (the API rejects it with
 * "compiled grammar is too large"), so the model gets the JSON Schema as instructions instead,
 * and its answer is checked by zod; parse/shape errors go through the normal repair rounds.
 */
const SCHEMA_PROMPT = `## Output JSON Schema\n\nReply with a single JSON object (no prose, no code fences) that validates against this schema. Every property is required; use null where the schema allows it.\n\n${JSON.stringify(z.toJSONSchema(SheetBody, { target: 'draft-2020-12' }))}`;

function parseBody(text: string): SheetBody {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('reply contains no JSON object');
  return SheetBody.parse(JSON.parse(text.slice(start, end + 1)));
}

export const formatIssues = (issues: Issue[]): string =>
  issues.map((i) => `- [${i.severity}] ${i.path}: ${i.message}`).join('\n');

/**
 * One model reply as text, appended to `messages`. Opus 5.5's output limit is a hard cap, so a reply
 * cut off there is continued in follow-up turns and the pieces are joined (the model does not accept
 * assistant prefill, so it is asked to resume where it stopped).
 */
async function generate(
  client: Anthropic,
  messages: Anthropic.Beta.BetaMessageParam[],
  opts: IngestOptions,
  log: (line: string) => void,
  usage: { inputTokens: number; outputTokens: number },
): Promise<string> {
  let text = '';
  let chars = 0;
  const onText = (t: string) => {
    chars += t.length;
    opts.onProgress?.(chars);
  };
  for (let part = 0; part <= MAX_CONTINUATIONS; part++) {
    if (part > 0) {
      log(`  Output hit the ${MAX_OUTPUT_TOKENS}-token cap, continuing (${part}/${MAX_CONTINUATIONS})…`);
      messages.push({ role: 'user', content: continueInstruction });
    }
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort },
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        { type: 'text', text: SCHEMA_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages,
    });
    stream.on('text', onText);
    // eslint-disable-next-line no-await-in-loop -- each continuation needs the previous part
    const msg = await stream.finalMessage();
    usage.inputTokens +=
      msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
    usage.outputTokens += msg.usage.output_tokens;

    if (msg.stop_reason === 'refusal') throw new Error(`model declined: ${JSON.stringify(msg.stop_details)}`);
    text += msg.content.flatMap((b) => (b.type === 'text' ? b.text : [])).join('');
    messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (msg.stop_reason !== 'max_tokens') return text;
  }
  throw new Error(`output still unfinished after ${MAX_CONTINUATIONS} continuations; datasheet too large`);
}

export async function ingest(src: SourceInput, opts: IngestOptions): Promise<IngestResult> {
  const log = opts.log ?? (() => undefined);
  const client = opts.client ?? new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: [sourceBlock(src.buf, src.fileName), { type: 'text', text: userInstruction(src.fileName) }],
    },
  ];

  let body: SheetBody | null = null;
  let issues: Issue[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let round = 0; round <= MAX_REPAIRS; round++) {
    log(round === 0 ? `Ingesting ${src.fileName} with ${MODEL} (effort ${opts.effort})…` : `Repair round ${round}…`);
    // eslint-disable-next-line no-await-in-loop -- each repair round needs the previous round's answer
    const text = await generate(client, messages, opts, log, usage);

    try {
      body = parseBody(text);
    } catch (error) {
      issues = [{ path: '$', severity: 'error', message: errorMessage(error) }];
      messages.push({ role: 'user', content: repairInstruction(formatIssues(issues)) });
      continue;
    }
    issues = validateSheet(body);
    const errors = issues.filter((i) => i.severity === 'error');
    log(`  ${errors.length} errors, ${issues.length - errors.length} warnings`);
    if (errors.length === 0) break;
    if (round < MAX_REPAIRS) messages.push({ role: 'user', content: repairInstruction(formatIssues(issues)) });
  }
  if (!body) throw new Error(`no valid model produced:\n${formatIssues(issues)}`);

  const now = new Date();
  const file: SheetFile = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    source: { fileName: src.fileName, sha256: sha256(src.buf), pages: null, url: src.url },
    generator: {
      tool: 'sheetfox-ingest',
      model: MODEL,
      createdAt: now.toISOString(),
      usage,
    },
    sheet: body,
    userState: null,
  };
  return { file, issues };
}
