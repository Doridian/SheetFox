#!/usr/bin/env -S npx tsx
/**
 * SheetFox ingester: datasheet (PDF / image / text / URL) -> library/<id>/sheet.json
 *
 *   npm run ingest -- datasheets/cc1101.pdf
 *   npm run ingest -- https://example.com/part.pdf --force
 *   npm run ingest -- sheet.png -o out.sheet.json
 *
 * Runs once per datasheet. The result is cached by the source file's SHA-256:
 * re-ingesting the same file is a no-op unless --force is given.
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { errorMessage, type Issue, validateSheet } from '../src/engine';
import { FORMAT_ID, FORMAT_VERSION, SheetBody, type SheetFile } from '../src/schema';
import { findBySha, LIBRARY_DIR, rebuildIndex, sha256 } from './library';
import { repairInstruction, SYSTEM_PROMPT, userInstruction } from './prompt';

const MODEL = process.env.SHEETFOX_MODEL ?? 'claude-opus-5-5';
const MAX_REPAIRS = 2;

const EFFORTS = ['high', 'low', 'max', 'medium', 'xhigh'] as const;
type Effort = (typeof EFFORTS)[number];
const isEffort = (s: string): s is Effort => (EFFORTS as readonly string[]).includes(s);

interface Args {
  input: string;
  out: string | null;
  force: boolean;
  effort: Effort;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { input: '', out: null, force: false, effort: 'high' };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    switch (s) {
      case '-o':
      case '--out': {
        a.out = argv[++i];
        continue;
      }
      case '--force':
      case '-f': {
        a.force = true;
        continue;
      }
      case '--effort': {
        const effort = argv[++i];
        if (!isEffort(effort)) throw new Error(`--effort must be one of ${EFFORTS.join(', ')}`);
        a.effort = effort;
        continue;
      }
      default: {
        if (a.input) throw new Error(`unexpected argument ${s}`);
        a.input = s;
      }
    }
  }
  if (!a.input) {
    console.error('usage: npm run ingest -- <file.pdf|image|txt|url> [-o out.json] [--force] [--effort high]');
    process.exit(2);
  }
  return a;
}

async function loadInput(input: string): Promise<{ buf: Buffer; fileName: string; url: string | null }> {
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
    if (buf.length > 30 * 1024 * 1024) throw new Error('PDF larger than ~30 MB; split it first');
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

const formatIssues = (issues: Issue[]): string =>
  issues.map((i) => `- [${i.severity}] ${i.path}: ${i.message}`).join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { buf, fileName, url } = await loadInput(args.input);
  const hash = sha256(buf);

  const cached = findBySha(hash);
  if (cached && !args.force) {
    console.log(
      `Already ingested as ${path.relative(process.cwd(), cached.path)} (sha256 match). Use --force to re-run.`,
    );
    return;
  }

  const client = new Anthropic();
  const format = zodOutputFormat(SheetBody);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: [sourceBlock(buf, fileName), { type: 'text', text: userInstruction(fileName) }] },
  ];

  let body: SheetBody | null = null;
  let issues: Issue[] = [];
  let inTok = 0;
  let outTok = 0;

  for (let round = 0; round <= MAX_REPAIRS; round++) {
    console.log(
      round === 0 ? `Ingesting ${fileName} with ${MODEL} (effort ${args.effort})…` : `Repair round ${round}…`,
    );
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 128_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: args.effort, format: { type: 'json_schema', schema: format.schema } },
      system: SYSTEM_PROMPT,
      messages,
    });
    let chars = 0;
    stream.on('text', (t) => {
      chars += t.length;
      if (process.stderr.isTTY) process.stderr.write(`\r  received ${(chars / 1024).toFixed(0)} KiB of JSON`);
    });
    // eslint-disable-next-line no-await-in-loop -- each repair round needs the previous round's answer
    const msg = await stream.finalMessage();
    if (process.stderr.isTTY) process.stderr.write('\n');
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
    console.log(`  ${errors.length} errors, ${issues.length - errors.length} warnings`);
    if (errors.length === 0) break;
    if (round < MAX_REPAIRS) messages.push({ role: 'user', content: repairInstruction(formatIssues(issues)) });
  }
  if (!body) throw new Error(`no valid model produced:\n${formatIssues(issues)}`);
  if (issues.length) console.log(formatIssues(issues));

  const now = new Date();
  const createdAt = now.toISOString();
  const file: SheetFile = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    source: { fileName, sha256: hash, pages: null, url },
    generator: {
      tool: 'sheetfox-ingest',
      model: MODEL,
      createdAt,
      usage: { inputTokens: inTok, outputTokens: outTok },
    },
    sheet: body,
    userState: null,
  };

  let outPath = args.out;
  if (!outPath) {
    const dir = path.join(LIBRARY_DIR, body.meta.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), buf);
    outPath = path.join(dir, 'sheet.json');
  }
  fs.writeFileSync(outPath, `${JSON.stringify(file, null, 1)}\n`);
  if (!args.out) rebuildIndex();
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}  (${inTok} input / ${outTok} output tokens)`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Anthropic.APIError ? `API error ${error.status}: ${error.message}` : error);
  process.exit(1);
}
