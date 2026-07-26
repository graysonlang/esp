import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { exec, execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import esbuild from 'esbuild';
import { printErrorsAndWarnings } from './esbuild-problem-format.js';
import pluginLint from './esbuild-plugin-lint.js';
import createBiomeDriver from './lint-driver-biome.js';
import createEslintDriver from './lint-driver-eslint.js';
import pluginVscodeProblemMatcher from './esbuild-plugin-vscode-problem-matcher.js';
import {
  DEBUG_PORT_RANGE,
  SERVE_PORT_RANGE,
  derivePort,
  isPortFree,
  resolvePort,
} from './ports.js';

export function openOrReuseChromeTab(url, { verbose = false } = {}) {
  const isChromeRunning = () => {
    try {
      const output = execSync('pgrep -x "Google Chrome"');
      return !!output.toString().trim();
    } catch {
      return false;
    }
  };

  if (!isChromeRunning()) {
    exec(`open ${url}`);
    if (verbose) console.log('Chrome not running. Opened URL using macOS open command.');
    return;
  }

  const script = `
tell application "Google Chrome"
  set foundTab to missing value
  set foundWindow to missing value
  set windowCount to 0
  repeat with win in windows
    set windowCount to windowCount + 1
    set tabList to tabs of win
    repeat with i from 1 to count of tabList
      set t to item i of tabList
      if URL of t starts with "${url}" then
        set foundTab to i
        set foundWindow to win
        exit repeat
      end if
    end repeat
    if foundTab is not missing value then exit repeat
  end repeat
  if foundTab is not missing value then
    set active tab index of foundWindow to foundTab
    reload (tabs of foundWindow whose URL contains "${url}")
    set index of win to 1
    activate
  else if windowCount > 0 then
    tell window 1 to make new tab with properties {URL:"${url}"}
  else
    make new window
    open location "${url}"
  end if
  activate
end tell
  `.trim();

  try {
    execSync(`osascript <<EOF\n${script}\nEOF`);
    if (verbose) console.log('Opened or reused Chrome tab with AppleScript.');
  } catch {
    console.warn('Failed to reuse Chrome tab. Falling back to open.');
    exec(`open ${url}`);
  }
}

// Default Chrome/Chromium install locations per platform, highest priority
// first: stable before Canary (a normal dev wants their everyday browser),
// Chromium last. CHROME_PATH overrides everything — the escape hatch for the
// non-standard installs a static list can't catch (e.g. ~/Applications, a custom
// dir, a mounted volume). This intentionally trades the exhaustive discovery of
// chrome-launcher (lsregister/.desktop scanning/WSL) for zero dependencies.
function chromeCandidates() {
  const home = os.homedir();
  const env = process.env;
  switch (process.platform) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ];
    case 'win32': {
      const prefixes = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(
        Boolean,
      );
      const suffixes = [
        '\\Google\\Chrome\\Application\\chrome.exe',
        '\\Google\\Chrome SxS\\Application\\chrome.exe', // Canary
      ];
      return prefixes.flatMap(prefix => suffixes.map(suffix => prefix + suffix));
    }
    default: // linux & friends
      return [
        '/opt/google/chrome/chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ];
  }
}

export function findChrome(explicit) {
  const override = explicit || process.env.CHROME_PATH;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`Chrome not found at "${override}" (from CHROME_PATH).`);
  }
  for (const candidate of chromeCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find Chrome. Set CHROME_PATH to your Chrome/Chromium binary.');
}

export function openDedicatedChrome(
  url,
  { verbose = false, userDataDir, debugPort = 0, chromeArgs = [], chromePath } = {},
) {
  chromePath = chromePath ?? findChrome();

  const flags = [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
  ];

  if (debugPort) {
    if (verbose) {
      console.log(`Chrome launched with debug port: ${debugPort}`);
    }
    flags.push(`--remote-debugging-port=${debugPort}`);
  }

  // Caller-supplied passthrough flags. Appended to the end so they can extend
  // or override the defaults above.
  for (const arg of chromeArgs) {
    if (arg) flags.push(arg);
  }

  flags.push(url);

  const child = spawn(chromePath, flags, { stdio: 'ignore' });

  child.on('error', err => {
    console.error('Failed to launch dedicated Chrome instance:', err);
  });

  if (verbose) {
    console.log(`Launched dedicated Chrome instance with profile: ${userDataDir}`);
  }

  return child;
}

function waitForChromeDebugPort(port, { timeout = 10000, interval = 150 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, res => {
        res.resume();
        resolve();
      });
      req.setTimeout(500, () => req.destroy());
      req.on('error', () => {
        if (Date.now() - start >= timeout) {
          reject(new Error(`Chrome debug port ${port} not ready after ${timeout}ms`));
        } else {
          setTimeout(attempt, interval);
        }
      });
    }
    attempt();
  });
}

const proxyScript = `
  const toastRoot = document.createElement('div');
  toastRoot.style.position = 'fixed';
  toastRoot.style.bottom = '32px';
  toastRoot.style.right = '32px';
  toastRoot.style.zIndex = '9999';
  toastRoot.style.display = 'flex';
  toastRoot.style.flexDirection = 'column';
  toastRoot.style.gap = '8px';
  document.body.appendChild(toastRoot);

  const colors = {
    log:    { bg: '#333', color: '#fff' },
    info:   { bg: '#39f', color: '#fff' },
    warn:   { bg: '#fc0', color: '#000' },
    error:  { bg: '#f63', color: '#fff' },
    toast:  { bg: '#3c6', color: '#fff' },
  };

  function showToast(msg, type = 'log') {
  const style = colors[type] || colors.log;
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.padding = '8px 12px';
  el.style.background = style.bg;
  el.style.color = style.color;
  el.style.fontSize = '16px';
  el.style.borderRadius = '4px';
  el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
  el.style.opacity = '0';
  el.style.cursor = 'pointer';
  el.style.transform = 'translateY(50px)';
  el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';

  const timeout = setTimeout(() => dismiss(), 3000);
  function dismiss() {
    clearTimeout(timeout);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-50px)';
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  }

  el.addEventListener('click', dismiss);
    toastRoot.appendChild(el);

    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateX(0)';
    });
  }

  ['log', 'info', 'warn', 'error', 'toast'].forEach(type => {
    s.addEventListener(type, e => {
      const method = type === 'warn' ? 'warn' : type === 'error' ? 'error' : 'log';
      console[method]('[Proxy]', e.data);
      showToast(e.data, type);
    });
});
`;

function getBanner(proxy) {
  return (
    `(() => {
    if (typeof window === 'undefined') { return; }
    const s = new EventSource('/esbuild');
    s.addEventListener('change', () => location.reload());
    s.addEventListener('error', () => s.close());` +
    (proxy ? proxyScript : '') +
    `})();`
  );
}

function formatUrlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function resolveDevCertPaths() {
  const certName = process.env.ESP_DEV_CERT_NAME;
  if (!certName) return {};

  const certDir = path.resolve(process.cwd(), process.env.ESP_DEV_CERTS_DIR ?? '.esp_dev_certs');
  return {
    certfile: path.join(certDir, `${certName}.pem`),
    keyfile: path.join(certDir, `${certName}-key.pem`),
  };
}

/**
 * Identify the project by the absolute, symlink-resolved path of the build
 * script that invoked the runner (e.g. /path/to/project/scripts/build.mjs).
 *
 * Ports are derived from this, so two checkouts or worktrees of the same repo
 * get different ports, while a given checkout keeps the same port across runs.
 */
function resolveBuildIdentity() {
  const entry = process.argv[1];
  if (!entry) return process.cwd();

  const absolute = path.resolve(entry);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export const LAUNCH_TEMPLATE_FILE = '.vscode/launch_template.json';
export const LAUNCH_FILE = '.vscode/launch.json';

/**
 * Render .vscode/launch_template.json into .vscode/launch.json, substituting the
 * ports derived for this checkout.
 *
 * VS Code cannot compute a value for a launch config on its own: ${config:}
 * resolves only registered settings, ${env:} reads VS Code's own environment,
 * and ${input:command} needs a command some extension registered. So rather than
 * have launch.json read a port at debug time, the port is baked in ahead of
 * time. Ports are a pure function of the build script's path, so this is
 * idempotent — it writes identical output every run and never churns. The
 * generated launch.json is checkout-specific; keep it out of version control and
 * edit the template instead.
 */
function renderLaunchTemplate(derived, outdir, verbose = false) {
  const templatePath = path.resolve(process.cwd(), LAUNCH_TEMPLATE_FILE);
  // Projects that don't use VS Code simply don't ship a template.
  if (!existsSync(templatePath)) return;

  // The build's output directory travels with the ports so a template's
  // outFiles can point at the right location regardless of whether this build
  // targets dist, www, or anywhere else.
  const substitutions = { ...derived, outdir };

  const outputPath = path.resolve(process.cwd(), LAUNCH_FILE);
  try {
    const banner = [
      '  // GENERATED FILE — DO NOT EDIT.',
      `  // Rendered from ${LAUNCH_TEMPLATE_FILE} with the ports derived for this`,
      '  // checkout; edit the template and re-run `npm run sync:launch`.',
    ].join('\n');

    const rendered = readFileSync(templatePath, 'utf8')
      // Lines marked //! document the template itself and don't belong in the output.
      .replace(/^[ \t]*\/\/!.*\n/gm, '')
      .replace(/^\{\n/, `{\n${banner}\n`)
      .replace(/\{\{(http|https|debug|outdir)\}\}/g, (_, key) => String(substitutions[key]));

    // Skip the write when nothing changed, so an open editor isn't touched and
    // file watchers stay quiet on every rebuild.
    if (existsSync(outputPath) && readFileSync(outputPath, 'utf8') === rendered) return;

    writeFileSync(outputPath, rendered);
    if (verbose) {
      console.log(
        `Wrote ${LAUNCH_FILE} (http=${derived.http} https=${derived.https} debug=${derived.debug})`,
      );
    }
  } catch (error) {
    // A read-only checkout shouldn't be fatal; the server still runs, only the
    // launch config goes stale.
    console.warn(`Could not write ${LAUNCH_FILE} (${error.message}).`);
  }
}

/** Return `port`, or throw if something is already listening on it. */
async function requirePort(port, host) {
  if (await isPortFree(port, host)) return port;
  throw new Error(
    `Port ${port} is already in use. It is this project's derived port, so another ` +
      'server (or a second copy of this one) is on it. Stop that server, or pass an ' +
      'explicit --port.',
  );
}

const RUNNER_FLAGS = new Set([
  'certfile',
  'chrome-arg',
  'cross-origin-isolation',
  'debug-port',
  'host',
  'keyfile',
  'launch',
  'lint',
  'minify',
  'port',
  'print-port',
  'sync-launch',
  'proxy',
  'reuse',
  'serve',
  'verbose',
  'vscode',
  'watch',
]);

// Biome's config file names, in the order biome itself resolves them.
const BIOME_CONFIG_FILES = ['biome.json', 'biome.jsonc'];

/**
 * Pick the lint driver for `--lint` when the project has not named one.
 *
 * A biome config in the project root selects biome; anything else falls back to
 * ESLint, which is what every existing consumer already gets. Neither package
 * is a dependency of esp - the eslint driver imports `eslint` only when it
 * runs, and the biome driver shells out to a binary - so this never forces an
 * install, it only decides which of the two an opted-in project meant.
 *
 * Projects that want the other one, or a linter esp does not ship a driver for,
 * pass `lintPlugin` to runBuild. Passing `null` disables build-time linting.
 */
async function defaultLintPlugin(cwd = process.cwd()) {
  const hasBiomeConfig = BIOME_CONFIG_FILES.some(name => existsSync(path.join(cwd, name)));
  return hasBiomeConfig
    ? () => pluginLint({ driver: createBiomeDriver({ cwd }) })
    : () => pluginLint({ driver: createEslintDriver() });
}

async function run(getOptions, { lintPlugin, vscodePlugin } = {}) {
  const args = parseArgs({
    allowNegative: true,
    strict: false,
    options: {
      verbose: { type: 'boolean', short: 'v', default: false },

      lint: { type: 'boolean', default: false },
      proxy: { type: 'boolean', default: false },
      // Add COOP/COEP to proxied responses so the page is cross-origin isolated
      // (crossOriginIsolated === true) and SharedArrayBuffer is available.
      'cross-origin-isolation': { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
      launch: { type: 'boolean', default: false },
      reuse: { type: 'boolean', default: false },
      vscode: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      // Print the ports this project derives, then exit. Prints the derived
      // ports rather than the ones a running server would land on, so the
      // output is stable enough to paste into a launch config.
      'print-port': { type: 'boolean', default: false },
      // Render .vscode/launch.json from its template without building. Intended
      // for a `prepare` script, so the launch config is correct before the first
      // debug session in a fresh clone or worktree.
      'sync-launch': { type: 'boolean', default: false },

      certfile: { type: 'string' },
      keyfile: { type: 'string' },

      host: { type: 'string', default: '127.0.0.1' },
      // Omitted --port derives a stable per-project port; an explicit --port is
      // used verbatim.
      port: { type: 'string' },
      // A number, or 'auto' to derive a stable per-project Chrome debug port.
      'debug-port': { type: 'string', default: '' },
      // Extra flags forwarded verbatim to the dedicated Chrome launched by
      // --launch (repeatable).
      'chrome-arg': { type: 'string', multiple: true },
    },
  });

  // In non-strict mode parseArgs stores `--flag=false` as the string 'false';
  // coerce 'true'/'false' values to booleans so flags negate as expected.
  for (const [key, val] of Object.entries(args.values)) {
    if (val === 'true' || val === 'false') {
      args.values[key] = val === 'true';
    }
  }

  const esbuildOverrides = Object.fromEntries(
    Object.entries(args.values).filter(([key]) => !RUNNER_FLAGS.has(key)),
  );

  const verbose = args.values.verbose;

  const debug = !args.values.minify;
  const lint = args.values.lint;
  const proxy = args.values.proxy;
  const crossOriginIsolation = args.values['cross-origin-isolation'];
  const serve = args.values.serve;
  const vscode = args.values.vscode;
  const watch = args.values.watch;
  const launch = args.values.launch;
  const reuse = args.values.reuse;

  const hasExplicitCertPath = args.values.certfile || args.values.keyfile;
  const devCertPaths = hasExplicitCertPath ? {} : resolveDevCertPaths();
  const certfile = args.values.certfile ?? devCertPaths.certfile;
  const host = args.values.host;
  const keyfile = args.values.keyfile ?? devCertPaths.keyfile;
  const protocol = keyfile || certfile ? 'https' : 'http';

  if ((keyfile && !certfile) || (!keyfile && certfile)) {
    throw new Error('Both --keyfile and --certfile are required to serve HTTPS.');
  }

  // Derive every port this project could use, not just the ones this run needs,
  // so the rendered launch config is complete no matter which script wrote it.
  //
  // The scheme is part of the identity so a project's http and https servers get
  // distinct ports and can run side by side. They are separate browser origins
  // regardless, so sharing a number would buy nothing.
  const buildIdentity = resolveBuildIdentity();
  const derived = {
    http: derivePort(`${buildIdentity}\nhttp`, SERVE_PORT_RANGE),
    https: derivePort(`${buildIdentity}\nhttps`, SERVE_PORT_RANGE),
    debug: derivePort(`${buildIdentity}\ndebug`, DEBUG_PORT_RANGE),
  };
  const derivedPort = derived[protocol];

  let messageQueue = [];
  let sseClient = null;

  function sendLogToBrowser(message, type = 'log') {
    const data = String(message)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => `data: ${line}`)
      .join('\n');
    const event = `event: ${type}\n${data}\n\n`;
    if (sseClient) {
      sseClient.write(event);
    } else {
      messageQueue.push(event);
    }
  }

  // Resolved up front (rather than just before the build) so the output
  // directory is available for the launch template on the --sync-launch path,
  // which renders and returns without ever building.
  const options = getOptions(
    {
      minify: !debug,
      ...(serve || watch ? { banner: { js: getBanner(proxy) } } : {}),
      ...esbuildOverrides,
    },
    verbose,
    proxy ? sendLogToBrowser : undefined,
  );

  // The directory esbuild writes to, resolved the same way as the dev server's
  // servedir so the launch config's outFiles match wherever this build lands.
  const outdir = options.outdir || (options.outfile ? path.dirname(options.outfile) : undefined);

  if (args.values['print-port'] || args.values['sync-launch']) {
    if (args.values['sync-launch']) {
      renderLaunchTemplate(derived, outdir, verbose);
    }
    if (args.values['print-port']) {
      console.log(`http=${derived.http}`);
      console.log(`https=${derived.https}`);
      console.log(`debug=${derived.debug}`);
    }
    return;
  }

  const explicitPort = args.values.port !== undefined ? Number(args.values.port) : undefined;

  // Only probe ports when a server will actually bind one; a plain build must
  // not fail — or waste probes — just because the dev server already holds the
  // derived port (e.g. the VS Code build task running alongside `npm run dev`).
  //
  // Under --vscode the launch config points at the derived port, so quietly
  // moving to the next free one would aim the debugger at whatever else is
  // already listening there. Fail loudly instead.
  const userPort =
    explicitPort ??
    (!serve
      ? derivedPort
      : vscode
        ? await requirePort(derivedPort, host)
        : await resolvePort(derivedPort, host, { range: SERVE_PORT_RANGE }));

  const debugPortArg = args.values['debug-port'];
  const debugPort =
    debugPortArg === 'auto' || debugPortArg === true
      ? await resolvePort(derived.debug, '127.0.0.1', { range: DEBUG_PORT_RANGE })
      : debugPortArg
        ? Number(debugPortArg)
        : 0;

  // Refreshed on every run so a fresh clone or worktree self-heals: the ports
  // are a pure function of the build script's path, so this is idempotent.
  if (serve || watch) renderLaunchTemplate(derived, outdir, verbose);

  // Port 0 lets the OS pick a random available port for the internal esbuild
  // server; the proxy then claims the user-facing port.
  const mainPort = proxy ? 0 : userPort;

  const effectiveLintPlugin = lintPlugin === undefined ? await defaultLintPlugin() : lintPlugin;
  const effectiveVscodePlugin =
    vscodePlugin === undefined ? () => pluginVscodeProblemMatcher() : vscodePlugin;

  if (lint && effectiveLintPlugin) {
    options.plugins ??= [];
    options.plugins.push(effectiveLintPlugin());
  }
  if (vscode && effectiveVscodePlugin) {
    options.plugins ??= [];
    options.plugins.push(effectiveVscodePlugin());
  }

  if (!(serve || watch)) {
    await esbuild.build(options);
    return;
  }

  const ctx = await esbuild.context(options);

  let shuttingDown = false;

  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await ctx.dispose();
    } catch (err) {
      console.error('Error while disposing esbuild context:', err);
      code = 1;
    }

    process.exit(code);
  }

  process.on('SIGINT', () => {
    shutdown(0);
  });

  process.on('SIGTERM', () => {
    shutdown(0);
  });

  process.on('uncaughtException', err => {
    console.error(err);
    shutdown(1);
  });

  process.on('unhandledRejection', err => {
    console.error(err);
    shutdown(1);
  });

  if (watch) {
    await ctx.watch();
  }

  if (serve) {
    const { hosts, port } = await ctx.serve({
      certfile,
      host: host,
      keyfile,
      port: mainPort,
      servedir: options.outdir || path.dirname(options.outfile),
    });

    if (proxy) {
      const proxyServerOptions =
        keyfile && certfile ? { cert: readFileSync(certfile), key: readFileSync(keyfile) } : {};
      const createProxyServer = keyfile && certfile ? https.createServer : http.createServer;
      const request = keyfile && certfile ? https.request : http.request;
      const proxyTargetHost = hosts[0] === '0.0.0.0' ? '127.0.0.1' : hosts[0];

      createProxyServer(proxyServerOptions, (req, res) => {
        // Opt-in cross-origin isolation: COOP/COEP make crossOriginIsolated true
        // so SharedArrayBuffer is available. Set on every response (incl. the SSE
        // and 404 paths below) before any writeHead.
        if (crossOriginIsolation) {
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        }

        if (req.url === '/esbuild' && req.headers.accept?.includes('text/event-stream')) {
          const proxyReq = request(
            {
              hostname: proxyTargetHost,
              port,
              path: '/esbuild',
              method: 'GET',
              headers: req.headers,
              rejectUnauthorized: false,
            },
            proxyRes => {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'private',
                Connection: 'keep-alive',
              });

              sseClient = res;
              for (const msg of messageQueue) {
                res.write(msg);
              }
              messageQueue = [];
              proxyRes.on('data', chunk => res.write(chunk));
              proxyRes.on('end', () => res.end());
              req.on('close', () => {
                sseClient = null;
              });
            },
          );

          proxyReq.on('error', err => {
            res.writeHead(500);
            res.end(`Proxy error: ${err.message}`);
          });

          proxyReq.end();
          return;
        }

        const proxyOptions = {
          hostname: proxyTargetHost,
          port,
          path: req.url,
          method: req.method,
          headers: req.headers,
          rejectUnauthorized: false,
        };

        const proxyReq = request(proxyOptions, proxyRes => {
          if (proxyRes.statusCode === 404) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>Custom 404 page</h1>');
            return;
          }

          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        });

        req.pipe(proxyReq, { end: true });
      }).listen(userPort);
    }

    const servedHost = host === '0.0.0.0' ? 'localhost' : hosts[0];
    const portString =
      (userPort === 80 && protocol === 'http') || (userPort === 443 && protocol === 'https')
        ? ''
        : `:${userPort}`;
    const url = `${protocol}://${formatUrlHost(servedHost)}${portString}`;

    // The port is derived rather than fixed, so always say where it landed.
    console.log(`Serving ${url}`);

    if (launch) {
      // --reuse relies on AppleScript/osascript to focus an existing tab, so it
      // only works on macOS. Elsewhere, fall back to a dedicated instance.
      const canReuse = reuse && process.platform === 'darwin';
      if (reuse && !canReuse) {
        console.warn('--reuse is only supported on macOS; launching a dedicated Chrome instead.');
      }
      if (canReuse) {
        openOrReuseChromeTab(url, { verbose });
      } else {
        const safeProjectName = path.basename(process.cwd()).replace(/[^a-zA-Z0-9._-]/g, '_');
        const userDataDir = path.join(os.tmpdir(), `esbuild-dev-chrome-${safeProjectName}`);
        const chromeArgs = args.values['chrome-arg'] ?? [];
        const chromeProcess = openDedicatedChrome(url, {
          verbose,
          userDataDir,
          debugPort,
          chromeArgs,
        });

        chromeProcess.on('exit', () => {
          if (verbose) {
            console.log('Dedicated Chrome exited. Shutting down esbuild...');
          }
          shutdown(0);
        });

        if (debugPort) {
          await waitForChromeDebugPort(debugPort);
        }
      }
    }

    // Signal to VS Code that esbuild is ready so the task can proceed.
    // E.g. launch or attach to Chrome.
    if (vscode) {
      console.log(`[esbuild-ready] ${url}`);
    }
  }
}

export async function runBuild(getOptions, plugins = {}) {
  try {
    await run(getOptions, plugins);
  } catch (err) {
    if (err.errors || err.warnings) {
      printErrorsAndWarnings(err);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}
