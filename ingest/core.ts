/**
 * The ingest pipeline shared by the CLI (ingest.ts) and the web server (server/server.ts):
 * datasheet bytes -> validated SheetFile, with up to MAX_REPAIRS repair rounds.
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { errorMessage, type Issue, validateSheet } from '../src/engine';
import { FORMAT_ID, FORMAT_VERSION, SheetBody, type SheetFile } from '../src/schema';
import { sha256 } from './library';
import { repairInstruction, SYSTEM_PROMPT, userInstruction } from './prompt';

export const MODEL = process.env.SHEETFOX_MODEL ?? 'claude-opus-5-5';
const MAX_REPAIRS = 2;
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export const EFFORTS = ['high', 'low', 'max', 'medium', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];
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

export const formatIssues = (issues: Issue[]): string =>
  issues.map((i) => `- [${i.severity}] ${i.path}: ${i.message}`).join('\n');

export async function ingest(src: SourceInput, opts: IngestOptions): Promise<IngestResult> {
  const log = opts.log ?? (() => undefined);
  const client = opts.client ?? new Anthropic();
  const format = zodOutputFormat(SheetBody);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: [sourceBlock(src.buf, src.fileName), { type: 'text', text: userInstruction(src.fileName) }],
    },
  ];

  let body: SheetBody | null = null;
  let issues: Issue[] = [];
  let inTok = 0;
  let outTok = 0;

  for (let round = 0; round <= MAX_REPAIRS; round++) {
    log(round === 0 ? `Ingesting ${src.fileName} with ${MODEL} (effort ${opts.effort})…` : `Repair round ${round}…`);
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 128_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort, format: { type: 'json_schema', schema: format.schema } },
      system: SYSTEM_PROMPT,
      messages,
    });
    let chars = 0;
    stream.on('text', (t) => {
      chars += t.length;
      opts.onProgress?.(chars);
    });
    // eslint-disable-next-line no-await-in-loop -- each repair round needs the previous round's answer
    const msg = await stream.finalMessage();
    inTok +=
      msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
    outTok += msg.usage.output_tokens;

    if (msg.stop_reason === 'refusal') throw new Error(`model declined: ${JSON.stringify(msg.stop_details)}`);
    if (msg.stop_reason === 'max_tokens') throw new Error('output hit max_tokens; datasheet too large for one pass');

    const text = msg.content.flatMap((b) => (b.type === 'text' ? b.text : [])).join('');
    messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    try {
      body = format.parse(text);
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
      usage: { inputTokens: inTok, outputTokens: outTok },
    },
    sheet: body,
    userState: null,
  };
  return { file, issues };
}
