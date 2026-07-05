import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { exec, execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import esbuild from 'esbuild';
import { printErrorsAndWarnings } from './esbuild-problem-format.js';
import pluginEslint from './esbuild-plugin-eslint.js';
import pluginVscodeProblemMatcher from './esbuild-plugin-vscode-problem-matcher.js';

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
  } catch (err) {
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
      const prefixes = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
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

  child.on('error', (err) => {
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
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
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
  return `(() => {
    if (typeof window === 'undefined') { return; }
    const s = new EventSource('/esbuild');
    s.addEventListener('change', () => location.reload());
    s.addEventListener('error', () => s.close());`
    + (proxy ? proxyScript : '')
    + `})();`;
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

const RUNNER_FLAGS = new Set(
  [
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
    'proxy',
    'reuse',
    'serve',
    'verbose',
    'vscode',
    'watch',
  ],
);

async function run(getOptions, { lintPlugin, vscodePlugin } = {}) {
  const args = parseArgs({
    allowNegative: true,
    strict: false,
    options: {
      'verbose': { type: 'boolean', short: 'v', default: false },

      'lint': { type: 'boolean', default: false },
      'proxy': { type: 'boolean', default: false },
      // Add COOP/COEP to proxied responses so the page is cross-origin isolated
      // (crossOriginIsolated === true) and SharedArrayBuffer is available.
      'cross-origin-isolation': { type: 'boolean', default: false },
      'serve': { type: 'boolean', default: false },
      'launch': { type: 'boolean', default: false },
      'reuse': { type: 'boolean', default: false },
      'vscode': { type: 'boolean', default: false },
      'watch': { type: 'boolean', default: false },

      'certfile': { type: 'string' },
      'keyfile': { type: 'string' },

      'host': { type: 'string', default: '127.0.0.1' },
      'port': { type: 'string', default: '8000' },
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
  const userPort = Number(args.values.port);
  // Port 0 lets the OS pick a random available port for the internal esbuild
  // server; the proxy then claims the user-facing port.
  const mainPort = proxy ? 0 : userPort;

  if ((keyfile && !certfile) || (!keyfile && certfile)) {
    throw new Error('Both --keyfile and --certfile are required to serve HTTPS.');
  }

  let messageQueue = [];
  let sseClient = null;

  function sendLogToBrowser(message, type = 'log') {
    const data = String(message).replace(/\r\n?/g, '\n').split('\n').map(line => `data: ${line}`).join('\n');
    const event = `event: ${type}\n${data}\n\n`;
    if (sseClient) {
      sseClient.write(event);
    } else {
      messageQueue.push(event);
    }
  }

  const options = getOptions(
    {
      minify: !debug,
      ...(serve || watch ? { banner: { js: getBanner(proxy) } } : {}),
      ...esbuildOverrides,
    },
    verbose,
    (proxy ? sendLogToBrowser : undefined),
  );

  const effectiveLintPlugin = lintPlugin === undefined ? () => pluginEslint() : lintPlugin;
  const effectiveVscodePlugin = vscodePlugin === undefined ? () => pluginVscodeProblemMatcher() : vscodePlugin;

  if (lint && effectiveLintPlugin) {
    (options.plugins ??= []).push(effectiveLintPlugin());
  }
  if (vscode && effectiveVscodePlugin) {
    (options.plugins ??= []).push(effectiveVscodePlugin());
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

  process.on('uncaughtException', (err) => {
    console.error(err);
    shutdown(1);
  });

  process.on('unhandledRejection', (err) => {
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
      const proxyServerOptions = keyfile && certfile
        ? { cert: readFileSync(certfile), key: readFileSync(keyfile) }
        : {};
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
          const proxyReq = request({
            hostname: proxyTargetHost,
            port,
            path: '/esbuild',
            method: 'GET',
            headers: req.headers,
            rejectUnauthorized: false,
          }, (proxyRes) => {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'private',
              'Connection': 'keep-alive',
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
          });

          proxyReq.on('error', (err) => {
            res.writeHead(500);
            res.end('Proxy error: ' + err.message);
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

        const proxyReq = request(proxyOptions, (proxyRes) => {
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
    const portString = (userPort === 80 && protocol === 'http')
      || (userPort === 443 && protocol === 'https')
      ? ''
      : (':' + userPort);
    const url = `${protocol}://${formatUrlHost(servedHost)}${portString}`;
    const debugPort = args.values['debug-port'] ? Number(args.values['debug-port']) : 0;

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
        const chromeProcess = openDedicatedChrome(url, { verbose, userDataDir, debugPort, chromeArgs });

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
