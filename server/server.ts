/**
 * SheetFox server: serves the static viewer plus an ingest API, so datasheets can be uploaded
 * and converted in the browser instead of with `npm run ingest`.
 *
 * Bring your own key: every ingest request carries the user's Anthropic API key in the X-Anthropic-Api-Key header. It is only kept in memory for that job, never stored or returned.
 *
 * The server does no authentication; run it behind a proxy that does. If the proxy sets X-Preferred-Username (and always overwrites it), jobs show who started them.
 *
 *   GET  /api/me             -> { user }
 *   POST /api/ingest         body = file bytes, ?name=<fileName>  (or ?url=<http(s) url>, empty body)
 *                            &effort=<low..max>&force=1 -> 202 { job } | 200 { existing }
 *   GET  /api/jobs           -> Job[] (newest first)
 *   GET  /api/jobs/<id>      -> Job
 *   GET  /index.json         bundled library + server library, server wins on equal ids
 *   GET  /<id>/<file>        server library first, then the static build
 *
 * Environment:
 *   SHEETFOX_LISTEN       host:port, default 127.0.0.1:8080
 *   SHEETFOX_STATIC_DIR   built viewer (dist/), default ./dist
 *   SHEETFOX_DATA_DIR     writable state; sheets go to <data>/library, default ./data
 *   SHEETFOX_MAX_JOBS     ingest jobs running at once (across all users), default 3
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { type Effort, ingest, isEffort, loadInput, MAX_SOURCE_BYTES, MODEL, type SourceInput } from '../ingest/core';
import { buildIndex, findBySha, type IndexEntry, sha256 } from '../ingest/library';
import { errorMessage } from '../src/engine';
import type { SheetFile } from '../src/schema';

const { env } = process;
const [listenHost, listenPort] = (() => {
  const l = env.SHEETFOX_LISTEN ?? '127.0.0.1:8080';
  const i = l.lastIndexOf(':');
  return [l.slice(0, i).replaceAll(/^\[|\]$/g, ''), Number(l.slice(i + 1))] as const;
})();
const STATIC_DIR = path.resolve(env.SHEETFOX_STATIC_DIR ?? 'dist');
const DATA_LIBRARY = path.resolve(env.SHEETFOX_DATA_DIR ?? 'data', 'library');
const MAX_RUNNING = Math.max(1, Number(env.SHEETFOX_MAX_JOBS ?? 3));
const KEEP_JOBS = 50;

fs.mkdirSync(DATA_LIBRARY, { recursive: true });

class HttpError extends Error {
  public readonly status: number;

  public constructor(message: string, options: { cause?: unknown; status: number }) {
    super(message, options);
    this.name = 'HttpError';
    this.status = options.status;
  }
}

// ---------------------------------------------------------------- library

// The static build is immutable: index the sheets bundled into it once
const BUNDLED: IndexEntry[] = buildIndex(STATIC_DIR);

function mergedIndex(): IndexEntry[] {
  const server = buildIndex(DATA_LIBRARY);
  const ids = new Set(server.map((e) => e.id));
  return [...server, ...BUNDLED.filter((e) => !ids.has(e.id))].toSorted((a, b) => a.title.localeCompare(b.title));
}

function findExisting(hash: string): string | null {
  const own = findBySha(hash, DATA_LIBRARY);
  return own ? own.file.sheet.meta.id : (BUNDLED.find((e) => e.sha256 === hash)?.id ?? null);
}

const safeId = (id: string): string =>
  id
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, '-')
    .replaceAll(/^-+|-+$/g, '') || 'sheet';
const safeFileName = (name: string): string => path.basename(name).replaceAll(/[^\w.+-]+/g, '_') || 'datasheet';

/** Write a sheet (and its source) into the server library atomically. */
function store(src: SourceInput, sheet: SheetFile): string {
  const id = safeId(sheet.sheet.meta.id);
  sheet.sheet.meta.id = id;
  const fileName = safeFileName(src.fileName);
  sheet.source.fileName = fileName;
  const tmp = fs.mkdtempSync(path.join(DATA_LIBRARY, '.tmp-'));
  fs.writeFileSync(path.join(tmp, fileName), src.buf);
  fs.writeFileSync(path.join(tmp, 'sheet.json'), `${JSON.stringify(sheet, null, 1)}\n`);
  const dest = path.join(DATA_LIBRARY, id);
  const old = `${dest}.old-${Date.now()}`;
  if (fs.existsSync(dest)) fs.renameSync(dest, old);
  fs.renameSync(tmp, dest);
  fs.rmSync(old, { recursive: true, force: true });
  return id;
}

// ---------------------------------------------------------------- jobs

type JobStatus = 'done' | 'error' | 'queued' | 'running';
interface Job {
  id: string;
  status: JobStatus;
  fileName: string;
  user: string | null;
  effort: Effort;
  createdAt: string;
  log: string[];
  receivedKiB: number;
  sheetId: string | null;
  error: string | null;
}

/** insertion-ordered, oldest first */
const jobs = new Map<string, Job>();

// Each user pays for their own jobs, so they run in parallel up to MAX_RUNNING (server memory/CPU)
const pool = { running: 0, waiting: new Set<() => void>() };
async function acquire(): Promise<void> {
  if (pool.running < MAX_RUNNING) {
    pool.running++;
    return;
  }
  await new Promise<void>((resolve) => {
    pool.waiting.add(resolve);
  });
}
function release(): void {
  // Hand the slot straight to the oldest waiter, so a new job can't jump the queue
  const next = pool.waiting.values().next();
  if (next.done) {
    pool.running--;
  } else {
    pool.waiting.delete(next.value);
    next.value();
  }
}

type Source = SourceInput | (() => Promise<SourceInput>);

async function runJob(job: Job, source: Source, client: Anthropic): Promise<Partial<Job>> {
  try {
    const src = typeof source === 'function' ? await source() : source;
    job.fileName = src.fileName;
    const { file, issues } = await ingest(src, {
      client,
      effort: job.effort,
      log: (line) => {
        job.log.push(line);
      },
      onProgress: (chars) => {
        job.receivedKiB = Math.round(chars / 1024);
      },
    });
    const sheetId = store(src, file);
    const u = file.generator.usage;
    const tokens = u ? ` (${u.inputTokens} input / ${u.outputTokens} output tokens)` : '';
    job.log.push(...issues.map((i) => `[${i.severity}] ${i.path}: ${i.message}`), `Saved as ${sheetId}${tokens}`);
    return { status: 'done', sheetId };
  } catch (error) {
    const message =
      error instanceof Anthropic.APIError ? `API error ${error.status}: ${error.message}` : errorMessage(error);
    return { status: 'error', error: message };
  }
}

function addJob(job: Job, source: Source, client: Anthropic): void {
  jobs.set(job.id, job);
  for (const id of jobs.keys()) {
    if (jobs.size <= KEEP_JOBS) break;
    jobs.delete(id);
  }
  void (async () => {
    await acquire();
    try {
      job.status = 'running';
      Object.assign(job, await runJob(job, source, client));
    } finally {
      release();
    }
    console.log(
      `job ${job.id} (${job.fileName}, ${job.user ?? '?'}): ${job.status}${job.error ? `: ${job.error}` : ''}`,
    );
  })();
}

/** A client for the user's own key, checked with a free API call so a bad key fails right away. */
async function clientFor(req: http.IncomingMessage): Promise<Anthropic> {
  const header = req.headers['x-anthropic-api-key'];
  const apiKey = typeof header === 'string' ? header.trim() : '';
  if (!apiKey) throw new HttpError('enter your Anthropic API key to ingest', { status: 400 });
  const client = new Anthropic({ apiKey });
  try {
    await client.models.retrieve(MODEL);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError)
      throw new HttpError('Anthropic rejected this API key', { status: 400, cause: error });
    if (error instanceof Anthropic.APIError)
      throw new HttpError(`could not use this API key: ${error.message}`, { status: 400, cause: error });
    throw error;
  }
  return client;
}

// ---------------------------------------------------------------- http

function userOf(req: http.IncomingMessage): string | null {
  const user = req.headers['x-preferred-username'];
  return typeof user === 'string' && user ? user : null;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(`upload larger than ${limit / 1024 / 1024} MiB`, { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const TYPES: Partial<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Resolve a URL path inside root, or null if it escapes or does not exist as a file. */
function inside(root: string, urlPath: string): string | null {
  const p = path.resolve(root, `.${urlPath}`);
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // dot-files (.tmp-*, .old-*) in the data library are never served
  if (rel.split('/').some((s) => s.startsWith('.'))) rel = '/.';
  const p = (rel.split('/').length > 2 ? inside(DATA_LIBRARY, rel) : null) ?? inside(STATIC_DIR, rel);
  if (!p) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(p).pipe(res);
}

async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const effortParam = url.searchParams.get('effort') ?? 'high';
  if (!isEffort(effortParam)) {
    json(res, 400, { error: `bad effort ${effortParam}` });
    return;
  }
  const force = url.searchParams.get('force') === '1';
  const srcUrl = url.searchParams.get('url');

  const now = new Date();
  const job: Job = {
    id: crypto.randomUUID(),
    status: 'queued',
    fileName: '',
    user: userOf(req),
    effort: effortParam,
    createdAt: now.toISOString(),
    log: [],
    receivedKiB: 0,
    sheetId: null,
    error: null,
  };

  if (srcUrl) {
    if (!/^https?:\/\//.test(srcUrl)) {
      json(res, 400, { error: 'url must be http(s)' });
      return;
    }
    const client = await clientFor(req);
    job.fileName = srcUrl;
    addJob(
      job,
      async () => {
        const src = await loadInput(srcUrl);
        if (src.buf.length > MAX_SOURCE_BYTES) throw new Error('download larger than 30 MiB');
        const existing = force ? null : findExisting(sha256(src.buf));
        if (existing) throw new Error(`already ingested as ${existing} (use force to re-run)`);
        return src;
      },
      client,
    );
    json(res, 202, { job });
    return;
  }

  const name = url.searchParams.get('name');
  if (!name) {
    json(res, 400, { error: 'missing ?name= or ?url=' });
    return;
  }
  const buf = await readBody(req, MAX_SOURCE_BYTES);
  if (buf.length === 0) {
    json(res, 400, { error: 'empty upload' });
    return;
  }
  const existing = force ? null : findExisting(sha256(buf));
  if (existing) {
    json(res, 200, { existing });
    return;
  }
  const client = await clientFor(req);
  job.fileName = name;
  addJob(job, { buf, fileName: name, url: null }, client);
  json(res, 202, { job });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/me' && req.method === 'GET') {
    json(res, 200, { user: userOf(req) });
    return;
  }
  if (p === '/api/ingest' && req.method === 'POST') {
    await handleIngest(req, res, url);
    return;
  }
  if (p === '/api/jobs' && req.method === 'GET') {
    json(res, 200, Array.from(jobs.values()).toReversed());
    return;
  }
  if (p.startsWith('/api/jobs/') && req.method === 'GET') {
    const job = jobs.get(p.slice('/api/jobs/'.length));
    if (job) json(res, 200, job);
    else json(res, 404, { error: 'no such job' });
    return;
  }
  if (p.startsWith('/api/')) {
    json(res, 404, { error: 'not found' });
    return;
  }
  if (p === '/index.json') {
    json(res, 200, mergedIndex());
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }
  serveFile(req, res, p);
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      await handle(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) res.destroy();
      else json(res, status, { error: errorMessage(error) });
    }
  })();
});
// Large PDF uploads on slow links
server.requestTimeout = 0;
server.listen(listenPort, listenHost, () => {
  console.log(`SheetFox listening on ${listenHost}:${listenPort} (static ${STATIC_DIR}, data ${DATA_LIBRARY})`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
