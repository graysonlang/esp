import http from 'node:http';
import path from 'node:path';
import { exec, execSync, spawn } from 'node:child_process';
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

export function openDedicatedChrome(url, { verbose = false, userDataDir } = {}) {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  const child = spawn(
    chromePath,
    [
      '--new-window',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      url,
    ],
    {
      stdio: 'ignore',
    },
  );

  child.on('error', (err) => {
    console.error('Failed to launch dedicated Chrome instance:', err);
  });

  if (verbose) {
    console.log(`Launched dedicated Chrome instance with profile: ${userDataDir}`);
  }

  return child;
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

const RUNNER_FLAGS = new Set(
  [
    'host',
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
  ]
);

async function run(getOptions, { lintPlugin, vscodePlugin } = {}) {
  const args = parseArgs({
    allowNegative: true,
    strict: false,
    options: {
      verbose: { type: 'boolean', short: 'v', default: false },

      lint: { type: 'boolean', default: false },
      proxy: { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
      launch: { type: 'boolean', default: false },
      reuse: { type: 'boolean', default: false },
      vscode: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },

      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8000' },
    },
  });

  const esbuildOverrides = Object.fromEntries(
    Object.entries(args.values)
      .filter(([key]) => !RUNNER_FLAGS.has(key))
      .map(([key, val]) => [key, val === 'true' ? true : val === 'false' ? false : val]),
  );

  const verbose = args.values.verbose;

  const debug = !args.values.minify;
  const lint = args.values.lint;
  const proxy = args.values.proxy;
  const serve = args.values.serve;
  const vscode = args.values.vscode;
  const watch = args.values.watch;
  const launch = args.values.launch;
  const reuse = args.values.reuse;

  const host = args.values.host;
  const userPort = Number(args.values.port);
  // Port 0 lets the OS pick a random available port for the internal esbuild
  // server; the proxy then claims the user-facing port.
  const mainPort = proxy ? 0 : userPort;

  let messageQueue = [];
  let sseClient = null;

  function sendLogToBrowser(message, type = 'log') {
    const event = `event: ${type}\ndata: ${message}\n\n`;
    if (sseClient) {
      sseClient.write(event);
    } else {
      messageQueue.push(event);
    }
  }

  const options = getOptions(
    {
      minify: !debug,
      banner: { js: getBanner(proxy) },
      ...esbuildOverrides,
    },
    verbose,
    (proxy ? sendLogToBrowser : undefined),
  );

  const effectiveLintPlugin = lintPlugin === undefined ? () => pluginEslint() : lintPlugin;
  const effectiveVscodePlugin = vscodePlugin === undefined ? () => pluginVscodeProblemMatcher() : vscodePlugin;

  if (lint && effectiveLintPlugin) {
    options.plugins.push(effectiveLintPlugin());
  }
  if (vscode && effectiveVscodePlugin) {
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
      host: host,
      port: mainPort,
      servedir: options.outdir || path.dirname(options.outfile),
    });

    if (proxy) {
      http.createServer((req, res) => {
        if (req.url === '/esbuild' && req.headers.accept === 'text/event-stream') {
          const proxyReq = http.request({
            hostname: hosts[0],
            port,
            path: '/esbuild',
            method: 'GET',
            headers: req.headers,
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
          hostname: hosts[0],
          port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        };

        const proxyReq = http.request(proxyOptions, (proxyRes) => {
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

    const portString = (userPort === 80 ? '' : (':' + userPort));
    const url = `http://${hosts[0]}${portString}`;

    // Signal to VS Code that esbuild is ready so the task can proceed (e.g. launch Chrome).
    if (vscode) {
      console.log(`[esbuild-ready] ${url}`);
    }

    if (launch) {
      if (reuse) {
        openOrReuseChromeTab(url, { verbose });
      } else {
        const safeProjectName = path.basename(process.cwd()).replace(/[^a-zA-Z0-9._-]/g, '_');
        const userDataDir = path.join('/tmp', `esbuild-dev-chrome-${safeProjectName}`);
        const chromeProcess = openDedicatedChrome(url, { verbose, userDataDir });

        chromeProcess.on('exit', () => {
          if (verbose) {
            console.log('Dedicated Chrome exited. Shutting down esbuild...');
          }
          shutdown(0);
        });
      }
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
