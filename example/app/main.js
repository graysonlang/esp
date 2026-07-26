// This import+export works to make sure the index.html files is copied to the dest folder
// and that the import isn't stripped out during the bundling process.
import index from './index.html';
export function getFilePaths() {
  return { index };
}

// Pull in the paths from the glob plugin invocation.
import { imagePaths } from '../src/index.js';

const animationTimerInterval = 1000;

function startAnimationTimer(callback) {
  let lastTick = performance.now();
  function tick(now) {
    if (now - lastTick >= animationTimerInterval) {
      lastTick = now;
      callback(now);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Two-state theme toggle: an explicit choice is stored and wins over the OS
// setting; with nothing stored the CSS follows prefers-color-scheme. The
// inline script in index.html replays the stored value before first paint.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return darkQuery.matches ? 'dark' : 'light';
}

function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  try {
    localStorage.setItem('esp-theme', mode);
  } catch {
    /* private mode, etc. */
  }
}

function setupTheme() {
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
  });
}

/**
 * Fill a <dl> from a list of { label, value, state } rows and return a
 * label -> <dd> map so rows that change over time can be updated in place.
 * A `state` of 'ok' | 'warn' | 'off' renders the value with a status dot.
 */
function renderRows(id, rows) {
  const dl = document.getElementById(id);
  const cells = new Map();

  dl.replaceChildren(
    ...rows.map(({ label, value, state }) => {
      const dt = document.createElement('dt');
      dt.textContent = label;

      const dd = document.createElement('dd');
      setValue(dd, value, state);
      cells.set(label, dd);

      // Each pair is wrapped so the <dl> can lay the readings out as cells;
      // a <div> around dt/dd is the spec-sanctioned way to group them.
      const row = document.createElement('div');
      row.append(dt, dd);
      return row;
    }),
  );

  return cells;
}

function setValue(dd, value, state) {
  if (state === undefined) {
    dd.textContent = value;
    return;
  }
  const span = document.createElement('span');
  span.className = 'status';
  span.dataset.state = state;
  span.textContent = value;
  dd.replaceChildren(span);
}

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Count reloads for this tab. The runner's live-reload banner calls
 * location.reload() on every successful build, so a rising count is direct
 * evidence that watch mode is wired up end to end.
 */
function countReload() {
  try {
    const count = Number(sessionStorage.getItem('esp:reloads') ?? 0) + 1;
    sessionStorage.setItem('esp:reloads', String(count));
    // The first load isn't a reload; report the count of reloads since then.
    return count - 1;
  } catch {
    // Private-mode / file:// origins can throw on storage access.
    return undefined;
  }
}

function describeServer() {
  const secure = location.protocol === 'https:';
  return [
    { label: 'origin', value: location.origin },
    { label: 'protocol', value: location.protocol.replace(':', ''), state: secure ? 'ok' : 'off' },
    { label: 'port', value: location.port || '(default)' },
    {
      label: 'secure context',
      value: isSecureContext ? 'yes' : 'no',
      state: isSecureContext ? 'ok' : 'off',
    },
    {
      label: 'cross-origin isolated',
      value: crossOriginIsolated ? 'yes' : 'no — run npm run dev:coi',
      state: crossOriginIsolated ? 'ok' : 'off',
    },
    {
      label: 'SharedArrayBuffer',
      value: typeof SharedArrayBuffer === 'undefined' ? 'unavailable' : 'available',
      state: typeof SharedArrayBuffer === 'undefined' ? 'off' : 'ok',
    },
  ];
}

/**
 * Watch the dev server's own event stream. The injected banner already has one
 * open for reloads; this second subscription exists only to report whether the
 * page is being served by esbuild at all (a static or file:// copy is not).
 */
function watchLiveReload(cell) {
  let source;
  try {
    source = new EventSource('/esbuild');
  } catch {
    setValue(cell, 'unavailable', 'off');
    return;
  }

  source.addEventListener('open', () => setValue(cell, 'connected to /esbuild', 'ok'));
  source.addEventListener('error', () => {
    setValue(cell, 'no dev server — this is a static build', 'off');
    source.close();
  });
}

/**
 * The --proxy banner injects a fixed-position toast container as a direct child
 * of <body>; the page itself only ever renders <main>, so finding one means the
 * proxy is running.
 */
function hasToastOverlay() {
  return [...document.body.children].some(
    el => el.tagName === 'DIV' && el.style.position === 'fixed' && el.style.zIndex === '9999',
  );
}

/** Load each copied asset and report what the output directory actually served. */
async function renderAssets(paths) {
  const list = document.getElementById('assets');

  list.replaceChildren(
    ...paths.map(path => {
      const item = document.createElement('li');

      const figure = document.createElement('figure');
      figure.style.margin = '0';

      const img = document.createElement('img');
      img.alt = path;
      img.loading = 'lazy';
      img.src = path;

      const caption = document.createElement('figcaption');
      caption.textContent = path;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = 'checking…';
      caption.appendChild(meta);

      figure.append(img, caption);
      item.appendChild(figure);
      item.dataset.path = path;
      return item;
    }),
  );

  await Promise.all(
    paths.map(async path => {
      const meta = list.querySelector(`li[data-path="${CSS.escape(path)}"] .meta`);
      try {
        const response = await fetch(path);
        if (!response.ok) {
          setValue(meta, `HTTP ${response.status} — not copied`, 'warn');
          return;
        }
        const blob = await response.blob();
        setValue(meta, `${blob.type || 'unknown'} · ${formatBytes(blob.size)}`, 'ok');
      } catch (error) {
        setValue(meta, `fetch failed — ${error.message}`, 'warn');
      }
    }),
  );
}

/**
 * Read this bundle back and follow its sourceMappingURL, which is the same
 * chain a debugger walks to map a stack frame onto the original source.
 */
async function inspectSourceMap(cells) {
  const bundleUrl = new URL(import.meta.url);
  cells.get('bundle').textContent = bundleUrl.pathname;

  try {
    const source = await (await fetch(bundleUrl)).text();
    const match = source.match(/\/\/# sourceMappingURL=(\S+)\s*$/);
    if (!match) {
      setValue(cells.get('source map'), 'none — build without --sourcemap', 'off');
      setValue(cells.get('maps back to'), '—');
      return;
    }

    const mapUrl = new URL(match[1], bundleUrl);
    setValue(cells.get('source map'), mapUrl.pathname.split('/').pop(), 'ok');

    const map = await (await fetch(mapUrl)).json();
    const sources = map.sources ?? [];
    const thisFile = sources.find(entry => entry.endsWith('example/app/main.js'));
    setValue(
      cells.get('maps back to'),
      thisFile ? `${thisFile} (+${sources.length - 1} more)` : `${sources.length} sources`,
      thisFile ? 'ok' : 'warn',
    );
  } catch (error) {
    setValue(cells.get('source map'), `unreadable — ${error.message}`, 'warn');
  }
}

/** Named so the frame is easy to recognize in a stack trace. */
function throwFromExampleSource() {
  throw new Error('esp source map check — this frame should resolve to example/app/main.js');
}

window.addEventListener('load', async () => {
  setupTheme();
  renderRows('server', describeServer());

  const reloads = countReload();
  const loadedAt = new Date();
  const reloadCells = renderRows('reload', [
    { label: 'live reload', value: 'connecting…', state: 'off' },
    {
      label: 'reloads this session',
      value: reloads === undefined ? 'unavailable' : String(reloads),
    },
    { label: 'loaded at', value: loadedAt.toLocaleTimeString() },
    { label: 'uptime', value: '0:00' },
  ]);
  watchLiveReload(reloadCells.get('live reload'));
  startAnimationTimer(() => {
    reloadCells.get('uptime').textContent = formatDuration(Date.now() - loadedAt.getTime());
  });

  const proxyActive = hasToastOverlay();
  renderRows('proxy', [
    {
      label: 'toast overlay',
      value: proxyActive ? 'injected' : 'not injected',
      state: proxyActive ? 'ok' : 'off',
    },
    { label: 'matched files', value: `${imagePaths.length} via virtual:glob` },
  ]);

  const sourceMapCells = renderRows('sourcemaps', [
    { label: 'bundle', value: '…' },
    { label: 'source map', value: 'checking…', state: 'off' },
    { label: 'maps back to', value: '…' },
  ]);
  document.getElementById('throw').addEventListener('click', throwFromExampleSource);

  await Promise.all([renderAssets(imagePaths), inspectSourceMap(sourceMapCells)]);
});
