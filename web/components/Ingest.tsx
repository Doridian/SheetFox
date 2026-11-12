import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../src/engine';
import { type IngestJob, listJobs, loadApiKey, rememberApiKey, startIngest } from '../store';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ACCEPT = '.pdf, .png, .jpg, .jpeg, .gif, .webp, .txt, .md, .html, .csv, application/pdf, image/*';

/** Upload a datasheet to the server and follow the ingest jobs. Only rendered when served by the SheetFox server. */
export function IngestPanel({
  apiKey,
  onApiKeyChange,
  refreshKey,
  onDone,
}: {
  /** the user's own Anthropic API key (bring your own key) */
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  /** bump to re-fetch the job list (e.g. after the app submitted dropped files) */
  refreshKey: number;
  /** a job finished while this page was open: refresh the library */
  onDone: () => void;
}): JSX.Element {
  const [remember, setRemember] = useState(() => loadApiKey() !== '');
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [url, setUrl] = useState('');
  const [effort, setEffort] = useState('high');
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // done jobs already seen; the first poll only records them so old jobs don't trigger onDone
  const finished = useRef<Set<string> | null>(null);

  const applyJobs = useCallback(
    (list: IngestJob[]) => {
      setJobs(list);
      const seen = finished.current;
      const next = new Set(seen);
      for (const j of list) if (j.status === 'done') next.add(j.id);
      finished.current = next;
      if (seen && next.size > seen.size) onDone();
    },
    [onDone],
  );
  const poll = useCallback(async () => {
    try {
      applyJobs(await listJobs());
    } catch {
      /* transient */
    }
  }, [applyJobs]);

  useEffect(() => {
    void (async () => {
      try {
        applyJobs(await listJobs());
      } catch {
        /* transient */
      }
    })();
  }, [refreshKey, applyJobs]);

  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      clearInterval(t);
    };
  }, [active, poll]);

  const submit = useCallback(
    async (srcs: (File | string)[]) => {
      setError(null);
      setNotice(null);
      for (const src of srcs) {
        try {
          // eslint-disable-next-line no-await-in-loop -- keep submission order = queue order
          const r = await startIngest(src, { apiKey, effort, force });
          if ('existing' in r) {
            setNotice(
              `${typeof src === 'string' ? src : src.name} is already in the library as "${r.existing}". Tick "re-run" to ingest it again.`,
            );
          }
        } catch (error_) {
          setError(`${typeof src === 'string' ? src : src.name}: ${errorMessage(error_)}`);
        }
      }
      await poll();
    },
    [apiKey, effort, force, poll],
  );
  const hasKey = apiKey.trim() !== '';

  return (
    <section className="card ingest">
      <h2>Ingest a datasheet</h2>
      <p className="muted">
        Upload a PDF (or image / text) or paste a link. Claude converts it into a sheet on the server and adds it to the
        library for everyone; this takes a few minutes. It runs on your own Anthropic API key (typically a few dollars
        per datasheet at high effort), and a file that is already in the library is not converted again.
      </p>
      <div className="ingest-row">
        <label className="ingest-key">
          Anthropic API key{' '}
          <input
            type="password"
            autoComplete="off"
            placeholder="sk-ant-…"
            value={apiKey}
            onChange={(e) => {
              onApiKeyChange(e.target.value);
              if (remember) rememberApiKey(e.target.value.trim() || null);
            }}
          />
        </label>
        <label className="muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked);
              rememberApiKey(e.target.checked ? apiKey.trim() || null : null);
            }}
          />{' '}
          remember on this device
        </label>
        <a className="muted" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          get a key
        </a>
      </div>
      <p className="muted ingest-key-note">
        The key is sent to this server only to run your jobs and is never stored there.
      </p>
      <div className="ingest-row">
        <button className="btn primary" disabled={!hasKey} onClick={() => fileInput.current?.click()}>
          Upload file…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void submit(files);
          }}
        />
        <form
          className="ingest-url"
          onSubmit={(e) => {
            e.preventDefault();
            const u = url.trim();
            if (!u || !hasKey) return;
            setUrl('');
            void submit([u]);
          }}
        >
          <input
            type="url"
            placeholder="https://…/datasheet.pdf"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
          />
          <button className="btn" type="submit" disabled={!hasKey || !url.trim()}>
            Ingest URL
          </button>
        </form>
      </div>
      <div className="ingest-row muted">
        <label>
          Effort{' '}
          <select
            value={effort}
            onChange={(e) => {
              setEffort(e.target.value);
            }}
          >
            {EFFORTS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => {
              setForce(e.target.checked);
            }}
          />{' '}
          re-run even if already ingested
        </label>
        <span>…or drop files anywhere on the page.</span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {jobs.length > 0 && (
        <ul className="jobs">
          {jobs.map((j) => (
            <li key={j.id} className={`job job-${j.status}`}>
              <details open={j.status !== 'done'}>
                <summary>
                  <span className="job-status">{j.status}</span> {j.fileName}
                  {j.status === 'running' && j.receivedKiB > 0 && <span className="muted"> · {j.receivedKiB} KiB</span>}
                  {j.user && <span className="muted"> · {j.user}</span>}
                  {j.sheetId && (
                    <>
                      {' '}
                      · <a href={`#/${encodeURIComponent(j.sheetId)}`}>open</a>
                    </>
                  )}
                </summary>
                {(j.log.length > 0 || j.error) && (
                  <pre className="job-log">
                    {j.log.join('\n')}
                    {j.error ? `${j.log.length ? '\n' : ''}Error: ${j.error}` : ''}
                  </pre>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
