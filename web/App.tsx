import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../src/engine';
import type { SheetFile } from '../src/schema';
import { SheetView } from './components/SheetView';
import { importSheet, type LibraryEntry, loadLibrary, loadSheet, parseSheetFile, removeUploaded } from './store';

const routeId = () => decodeURIComponent(location.hash.replace(/^#\/?/, ''));

export function App(): JSX.Element {
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [current, setCurrent] = useState<{ entry: LibraryEntry; file: SheetFile } | null>(null);
  const [route, setRoute] = useState(routeId());
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLibrary(await loadLibrary());
  }, []);
  useEffect(() => {
    void (async () => {
      setLibrary(await loadLibrary());
    })();
  }, []);
  useEffect(() => {
    const h = () => {
      setRoute(routeId());
    };
    addEventListener('hashchange', h);
    return () => {
      removeEventListener('hashchange', h);
    };
  }, []);

  useEffect(() => {
    if (!route) return;
    const entry = library.find((e) => e.id === route);
    if (!entry) return;
    if (current?.entry.id === entry.id && current.entry.origin === entry.origin) return;
    void (async () => {
      try {
        setCurrent({ entry, file: await loadSheet(entry) });
      } catch (error_) {
        setError(errorMessage(error_));
      }
    })();
  }, [route, library]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const parsed = await Promise.allSettled(
      Array.from(files, async (f) => {
        if (!/json$/i.test(f.name) && f.type !== 'application/json') {
          throw new Error(
            `${f.name}: SheetFox opens .sheet.json files. To convert a PDF, run: npm run ingest -- "${f.name}"`,
          );
        }
        return parseSheetFile(await f.text());
      }),
    );
    let lastId: string | null = null;
    for (const result of parsed) {
      if (result.status === 'fulfilled') {
        lastId = importSheet(result.value);
      } else {
        setError(errorMessage(result.reason));
      }
    }
    if (lastId === null) return;
    await refresh();
    location.hash = `#/${encodeURIComponent(lastId)}`;
    setCurrent(null);
  };

  let content: JSX.Element;
  if (route && current) {
    content = <SheetView key={current.entry.origin + current.entry.id} file={current.file} entry={current.entry} />;
  } else if (route && library.every((e) => e.id !== route) && library.length > 0) {
    content = (
      <div className="empty">
        No sheet "{route}" in the library. <a href="#/">Back</a>
      </div>
    );
  } else {
    content = (
      <Home
        library={library}
        onOpen={() => fileInput.current?.click()}
        onRemove={(id) => {
          removeUploaded(id);
          void refresh();
        }}
      />
    );
  }

  return (
    <div
      className={`app ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void openFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <a className="brand" href="#/">
          SheetFox
        </a>
        <select
          className="picker"
          value={route}
          onChange={(e) => {
            location.hash = `#/${encodeURIComponent(e.target.value)}`;
          }}
        >
          <option value="">Library…</option>
          {library.map((e) => (
            <option key={e.origin + e.id} value={e.id}>
              {e.partNumber} — {e.title}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="btn" onClick={() => fileInput.current?.click()}>
          Open .sheet.json
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json, application/json"
          multiple
          hidden
          onChange={(e) => {
            void openFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </header>
      {error && (
        <div
          className="error-banner"
          onClick={() => {
            setError(null);
          }}
        >
          {error}
        </div>
      )}

      {content}
      {dragging && <div className="drop-hint">Drop a .sheet.json to open it</div>}
    </div>
  );
}

function Home({
  library,
  onOpen,
  onRemove,
}: {
  library: LibraryEntry[];
  onOpen: () => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  return (
    <div className="home">
      <section className="hero">
        <h1>Datasheets you can ask questions of</h1>
        <p>
          Each sheet was converted once from its PDF into a self-contained <code>.sheet.json</code>. Enter your
          operating point and the calculators, digitized graphs and editable tables answer from it, with no AI calls.
          Drop a <code>.sheet.json</code> anywhere to open it, or create one with{' '}
          <code>npm run ingest -- datasheet.pdf</code>.
        </p>
        <button className="btn primary" onClick={onOpen}>
          Open .sheet.json
        </button>
      </section>
      <div className="lib">
        {library.map((e) => (
          <a key={e.origin + e.id} className="card lib-item" href={`#/${encodeURIComponent(e.id)}`}>
            <div className="eyebrow">
              {e.manufacturer} · {e.category}
            </div>
            <h3>{e.partNumber}</h3>
            <p>{e.title}</p>
            {e.origin === 'local' && (
              <span className="local">
                uploaded{' '}
                <button
                  className="link"
                  onClick={(ev) => {
                    ev.preventDefault();
                    onRemove(e.id);
                  }}
                >
                  remove
                </button>
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
