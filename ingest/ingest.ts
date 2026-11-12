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
import { DEFAULT_EFFORT, type Effort, EFFORTS, formatIssues, ingest, isEffort, loadInput } from './core';
import { findBySha, LIBRARY_DIR, rebuildIndex, sha256 } from './library';

interface Args {
  input: string;
  out: string | null;
  force: boolean;
  effort: Effort;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { input: '', out: null, force: false, effort: DEFAULT_EFFORT };
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
    console.error('usage: npm run ingest -- <file.pdf|image|txt|url> [-o out.json] [--force] [--effort medium]');
    process.exit(2);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = await loadInput(args.input);

  const cached = findBySha(sha256(src.buf));
  if (cached && !args.force) {
    console.log(
      `Already ingested as ${path.relative(process.cwd(), cached.path)} (sha256 match). Use --force to re-run.`,
    );
    return;
  }

  const tty = process.stderr.isTTY;
  const progress = { receiving: false };
  const { file, issues } = await ingest(src, {
    effort: args.effort,
    log: (line) => {
      if (progress.receiving) process.stderr.write('\n');
      progress.receiving = false;
      console.log(line);
    },
    onProgress: (chars) => {
      if (!tty) return;
      progress.receiving = true;
      process.stderr.write(`\r  received ${(chars / 1024).toFixed(0)} KiB of JSON`);
    },
  });
  if (progress.receiving) process.stderr.write('\n');
  if (issues.length) console.log(formatIssues(issues));

  let outPath = args.out;
  if (!outPath) {
    const dir = path.join(LIBRARY_DIR, file.sheet.meta.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, src.fileName), src.buf);
    outPath = path.join(dir, 'sheet.json');
  }
  fs.writeFileSync(outPath, `${JSON.stringify(file, null, 1)}\n`);
  if (!args.out) rebuildIndex();
  const { inputTokens, outputTokens } = file.generator.usage ?? { inputTokens: 0, outputTokens: 0 };
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}  (${inputTokens} input / ${outputTokens} output tokens)`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Anthropic.APIError ? `API error ${error.status}: ${error.message}` : error);
  process.exit(1);
}
