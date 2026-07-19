# @graysonlang/esp

A collection of esbuild plugins and utilities.

## Installation

```sh
npm install @graysonlang/esp
```

Peer dependencies vary by plugin — install only what you need:

```sh
npm install --save-dev esbuild          # required by all plugins
npm install --save-dev eslint           # required by esbuild-plugin-eslint
npm install --save-dev @stylistic/eslint-plugin  # optional, for stylistic rules
```

## Example project

[graysonlang/esd](https://github.com/graysonlang/esd) is a minimal but complete example of using `@graysonlang/esp` in an independent repo. It includes a working `scripts/build.mjs`, the full set of recommended `package.json` scripts, and the `.vscode/tasks.json` / `.vscode/launch.json` files described in the [VS Code Integration](#vs-code-integration) section below. Use it as a boilerplate when starting a new project.

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `ports` | `node ./scripts/build.mjs --print-port` | Print this checkout's derived dev server ports |
| `sync:launch` | `node ./scripts/build.mjs --sync-launch` | Render `.vscode/launch.json` from `.vscode/launch_template.json` |
| `build` | `node ./scripts/build.mjs --lint --minify` | One-shot production build (linted, minified) |
| `serve` | `node ./scripts/build.mjs --lint --sourcemap --watch --serve` | Watch + dev server with live reload |
| `serve:https` | `ESP_DEV_CERT_NAME=$npm_package_config_esp_dev_cert_name npm run serve -- --host=0.0.0.0` | HTTPS watch + dev server using the configured development cert |
| `dev` | `npm run serve -- --proxy --launch` | Watch + dev server with proxy toasts and Chrome launch |
| `dev:coi` | `npm run dev -- --cross-origin-isolation` | Same as `dev`, but cross-origin isolated (`SharedArrayBuffer` enabled) |
| `dev:https` | `npm run serve:https -- --proxy --launch` | HTTPS watch + dev server with proxy toasts and Chrome launch |
| `dev:https:coi` | `npm run dev:https -- --cross-origin-isolation` | Same as `dev:https`, but cross-origin isolated (`SharedArrayBuffer` enabled) |
| `vscode:build` | `npm run build -- --vscode` | One-shot build with VS Code problem matcher output |
| `vscode:debug` | `npm run serve -- --vscode` | Watch + dev server with VS Code problem matcher output |
| `vscode:debug:https` | `npm run serve:https -- --vscode` | HTTPS watch + dev server with VS Code problem matcher output |
| `cert:dev` | `ESP_DEV_CERT_NAME=$npm_package_config_esp_dev_cert_name esp-generate-dev-cert` | Generate a trusted HTTPS development certificate |
| `lint` | `eslint . --ignore-pattern 'dist'` | Lint source files |

### Runner CLI flags

`runBuild` parses CLI flags from `process.argv` automatically. All flags are optional:

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--minify` | | `false` | Minify output |
| `--lint` | | `false` | Run ESLint after each build |
| `--serve` | | `false` | Start esbuild's dev server |
| `--watch` | | `false` | Rebuild on file changes |
| `--proxy` | | `false` | Run a proxy server that forwards console logs to the browser as toasts |
| `--cross-origin-isolation` | | `false` | Add COOP/COEP/CORP headers to proxied responses so the page is cross-origin isolated (`SharedArrayBuffer` available). Requires `--proxy` |
| `--launch` | | `false` | Launch a dedicated Chrome instance when the dev server starts |
| `--vscode` | | `false` | Emit VS Code problem matcher output and print `[esbuild-ready] <url>` when ready |
| `--reuse` | | `false` | Open/reload an existing Chrome tab instead of launching a dedicated instance (macOS only — see [Browser launching](#browser-launching)) |
| `--verbose` | `-v` | `false` | Enable verbose logging |
| `--certfile` | | | Explicit HTTPS certificate path |
| `--keyfile` | | | Explicit HTTPS private key path |
| `--host` | | `127.0.0.1` | Dev server host |
| `--port` | | *derived* | Dev server port. Omit it to use the port derived for this checkout (see [Dev server ports](#dev-server-ports)); pass one to pin it |
| `--debug-port` | | | Chrome remote debugging port for the instance launched by `--launch`. Pass a number, or `auto` to derive one for this checkout |
| `--print-port` | | `false` | Print this checkout's derived ports and exit |
| `--sync-launch` | | `false` | Render `.vscode/launch.json` from its template and exit (intended for a `prepare` script) |
| `--chrome-arg` | | | Extra flag forwarded to the dedicated Chrome launched by `--launch` (repeatable) |

Any unrecognized flags are forwarded to esbuild as build options (e.g. `--sourcemap`).

### Dev server ports

Without `--port`, the runner derives its port from the absolute, symlink-resolved path of the build script that invoked it (e.g. `/Users/me/projects/app/scripts/build.mjs`), hashed into the range `8000–8899`. The Chrome debug port used by `--debug-port=auto` is derived the same way, from `9300–9899`.

This means:

- **Two projects never collide**, because they have different paths — no coordination, no state, no scanning in the common case.
- **Two worktrees of the same repo never collide**, because their build scripts live at different paths.
- **A given checkout keeps the same port across runs**, so its origin is stable: `localStorage`, service workers, and bookmarks all survive a restart, and a launch config can point at it.

The scheme is part of the hash, so a project's HTTP and HTTPS servers get different ports and can run side by side. If the derived port is already taken (a hash collision, or a second copy of the same server), the runner scans upward for the next free port — except under `--vscode`, where it fails instead, since the launch config is pointed at the derived port and drifting would aim the debugger at somebody else's server.

Pass `--port` to opt out and pin a port explicitly; it is then used verbatim.

Print the ports for the current checkout with:

```sh
npm run ports
# http=8561
# https=8089
# debug=9609
```

These ports are baked into `.vscode/launch.json`, which the runner renders from a committed template — see [Ports in `launch.json`](#ports-in-launchjson).

### Browser launching

`--launch` works on macOS, Windows, and Linux. The runner locates a Chrome/Chromium binary by checking the standard install locations for the platform (including Chrome Canary, and Chromium on Linux). If your browser is installed somewhere non-standard — or you want to pin a specific build — set the `CHROME_PATH` environment variable to the executable:

```sh
# macOS
CHROME_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium" npm run dev

# Windows (PowerShell)
$env:CHROME_PATH="C:\Program Files\Google\Chrome Beta\Application\chrome.exe"; npm run dev

# Linux
CHROME_PATH=/usr/bin/brave-browser npm run dev
```

If no browser is found, the runner exits with a message telling you to set `CHROME_PATH`.

The launched instance uses a throwaway profile under the OS temp directory, so it won't touch your everyday Chrome session. Forward extra Chrome flags with `--chrome-arg` (repeatable).

`--reuse` (focus/reload an already-open tab instead of launching a dedicated instance) relies on AppleScript and is **macOS only**. On Windows and Linux it logs a notice and falls back to launching a dedicated instance.

## HTTPS Development

The package includes a certificate helper (`esp-generate-dev-cert`) for running esbuild's dev server over HTTPS locally — useful when testing on iOS/iPadOS or when a browser feature requires a secure context. It creates a server certificate under `.esp_dev_certs/` using `mkcert` and uses mkcert's configured CA root directly.

Add these scripts to your project's `package.json`:

```json
{
  "cert:dev": "ESP_DEV_CERT_NAME=<project>-dev esp-generate-dev-cert",
  "serve": "node ./scripts/build.mjs --watch --serve",
  "serve:https": "ESP_DEV_CERT_NAME=<project>-dev npm run serve -- --host=0.0.0.0 --port=8443",
  "vscode:debug": "npm run serve -- --vscode",
  "vscode:debug:https": "npm run serve:https -- --vscode"
}
```

By default, generated cert files live in `.esp_dev_certs/`. For certificates you want to
keep across repo cleanup commands such as `git clean`, set `ESP_DEV_CERTS_DIR` to a
stable location outside the repository in your shell environment, for example in
`.zshrc`. The certificate helper and runner both use `ESP_DEV_CERTS_DIR` when it is
set.

When a certificate is generated, the helper also trusts the mkcert CA. On macOS it adds the CA from `mkcert -CAROOT` to the login keychain; on other platforms it runs `mkcert -install`. Pass `--skip-trust` to generate without changing local trust, or `--trust` to retrust an existing CA. Set `ESP_DEV_CERT_FORCE=1` to regenerate an existing certificate (e.g. when your LAN IP changes). Pass `ESP_DEV_CERT_NAME` to the runner to enable HTTPS with the matching generated certificate:

```sh
ESP_DEV_CERT_NAME=<project>-dev node ./scripts/build.mjs --watch --serve --host=0.0.0.0 --port=8443
```

See [docs/https-development-certificates.md](docs/https-development-certificates.md) for the full setup guide, including iOS/iPadOS installation, all CLI flags and environment variables, and troubleshooting.

## Cross-Origin Isolation

Some browser APIs — most notably `SharedArrayBuffer` (used by threaded WASM and `pthreads`-compiled Emscripten output) — are only available when the page is [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated). A page becomes isolated when it is served with the right COOP/COEP response headers, at which point `crossOriginIsolated === true` in the browser.

esbuild's own dev server can't set these headers, so the `--cross-origin-isolation` flag works through the runner's proxy server. When enabled, the proxy adds the following headers to every response it forwards:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Because the headers are applied by the proxy, **`--cross-origin-isolation` requires `--proxy`** — on its own it has no effect.

The recommended way to enable it is via the dedicated dev scripts, which already include `--proxy`:

```sh
npm run dev:coi          # HTTP, cross-origin isolated
npm run dev:https:coi    # HTTPS, cross-origin isolated
```

These compose on the existing `dev` / `dev:https` scripts:

```json
{
  "dev": "npm run serve -- --proxy --launch",
  "dev:coi": "npm run dev -- --cross-origin-isolation",
  "dev:https": "npm run serve:https -- --proxy --launch",
  "dev:https:coi": "npm run dev:https -- --cross-origin-isolation"
}
```

> **Note:** With COEP set to `require-corp`, every cross-origin subresource (scripts, images, fonts, etc.) must itself opt in via `Cross-Origin-Resource-Policy` or CORS, or the browser will block it. If subresources fail to load after enabling isolation, this is usually why.

## Plugins

### `esbuild-plugin-emcc`

Compiles C/C++ source files via [Emscripten](https://emscripten.org/) (`emcc`) during an esbuild build. Skips recompilation when sources are unchanged using content-hash freshness tracking.

```js
import createEmccPlugin from '@graysonlang/esp/esbuild-plugin-emcc';

await esbuild.build({
  plugins: [createEmccPlugin({ emccPath: 'emcc', emccOptions: ['-sSINGLE_FILE=1'] })],
});
```

**Options:** `emccPath`, `emccOptions`, `verbose`, `logger`

---

### `esbuild-plugin-eslint`

Runs ESLint on loaded source files at the end of each build. Only re-lints files that have changed since the last build.

```js
import createEslintPlugin from '@graysonlang/esp/esbuild-plugin-eslint';

await esbuild.build({
  plugins: [createEslintPlugin({ fix: false, throwOnErrors: true })],
});
```

**Options:** `candidateExtensions`, `throwOnWarnings`, `throwOnErrors`, `warnIgnored`, plus any [ESLint constructor options](https://eslint.org/docs/latest/integrate/nodejs-api#-new-eslintoptions).

---

### `esbuild-plugin-glob-copy`

Resolves `virtual:glob` imports and copies matched files to the output directory.

```js
import 'virtual:glob' with { pattern: 'assets/**', baseDir: 'src' };
```

```js
import createGlobCopyPlugin from '@graysonlang/esp/esbuild-plugin-glob-copy';

await esbuild.build({
  plugins: [createGlobCopyPlugin({ verbose: true })],
});
```

**Options:** `sideEffects`, `verbose`, `logger`

---

### `esbuild-plugin-imp`

Copies a single file to the output directory via a `virtual:copy` import.

```js
import 'virtual:copy' with { path: './assets/logo.png', dest: 'images/' };
```

```js
import createImpPlugin from '@graysonlang/esp/esbuild-plugin-imp';

await esbuild.build({
  plugins: [createImpPlugin()],
});
```

**Options:** `verbose`, `logger`

---

### `esbuild-plugin-vscode-problem-matcher`

Emits `[watch] build started` and formats esbuild errors/warnings in a format compatible with VS Code's problem matcher.

```js
import createVSCodePlugin from '@graysonlang/esp/esbuild-plugin-vscode-problem-matcher';

await esbuild.build({
  plugins: [createVSCodePlugin()],
});
```

## Utilities

### `esbuild-runner`

The `runBuild` helper wraps esbuild context management, CLI flag parsing, dev server setup, live reload, and browser launching in a single call. Your build script provides a `getOptions` factory; the runner injects resolved flags and wires up plugins automatically.

```js
import { runBuild } from '@graysonlang/esp/esbuild-runner';

function getOptions(args, verbose, logger) {
  return {
    bundle: true,
    entryPoints: ['src/index.js'],
    outdir: 'dist',
    plugins: [
      pluginGlobCopy({ logger }),
    ],
    ...args, // spreads minify, live-reload banner for watch/serve, etc.
  };
}

runBuild(getOptions);
```

The runner automatically adds `esbuild-plugin-eslint` (when `--lint`) and `esbuild-plugin-vscode-problem-matcher` (when `--vscode`) to the plugin list.

`runBuild` accepts an optional second argument to override the injected plugins:

```js
runBuild(getOptions, {
  lintPlugin: () => myCustomLintPlugin(),  // replace the default eslint plugin
  vscodePlugin: null,                      // null/falsy disables the plugin entirely
});
```

When `--launch` is set, the runner opens a dedicated Chrome instance using a temporary profile, discovering the browser binary cross-platform (override with `CHROME_PATH` — see [Browser launching](#browser-launching)). When `--reuse` is also set, it instead opens or reloads an existing Chrome tab (macOS only; falls back to a dedicated instance elsewhere). When `--vscode` is set, the runner prints `[esbuild-ready] <url>` once the server is ready — a signal VS Code tasks can use as a `background.endsPattern`.

---

### `esbuild-problem-format`

Formats esbuild diagnostics into VS Code problem matcher output.

```js
import { formatDiagnostic, printErrorsAndWarnings } from '@graysonlang/esp/esbuild-problem-format';
```

### `freshness`

Tracks file content changes using SHA-1 hashes and mtimes to detect when files have actually changed.

```js
import Freshness from '@graysonlang/esp/freshness';

const freshness = new Freshness();
const isUpToDate = await freshness.check(filePathSet);
const { changed, removed } = await freshness.update(fileMapOrSet);
```

### `glglob`

A lightweight async glob implementation with `**`, `*`, `?`, and `{a,b}` expansion. No external dependencies.

```js
import glob from '@graysonlang/esp/glglob';

const files = await glob('src/**/*.js');
```

### `helpers`

Internal utilities: `computeUrlSafeBase64Digest`, `consolidateDirs`, `parsePathsString`.

## VS Code Integration

The repository includes example `.vscode/` configuration files that demonstrate a full VS Code debug workflow built on `esbuild-runner`.

### How it works

The `--vscode` flag tells the runner to:

1. Attach `esbuild-plugin-vscode-problem-matcher`, which formats build errors/warnings so VS Code can parse them and surface them in the Problems panel. When `--lint` is also set, ESLint findings are surfaced too — via a companion problem matcher in `tasks.json` (see below).
2. Print `[esbuild-ready] <url>` to stdout once the dev server is ready. VS Code uses this as the `background.endsPattern` to know the server is up before launching the debugger.

### `.vscode/tasks.json`

Four tasks are defined:

- **`build`** — one-shot build (`vscode:build` script). Configured as the default build task (`Ctrl+Shift+B` / `Cmd+Shift+B`). Carries **two** inline problem matchers: one parses esbuild's `> file:line:col: error: message` output, the other parses ESLint's default *stylish* formatter output (emitted by `esbuild-plugin-eslint` under `--lint`). Both `debug` tasks carry the same pair.
- **`debug`** — HTTP watch-mode server (`vscode:debug` script). Runs in the background. The `background` problem matcher waits for `[esbuild-ready] <url>` before signaling readiness to the launch configuration.
- **`debug:https`** — HTTPS watch-mode server (`vscode:debug:https` script). Uses the same readiness signal as `debug`, and serves HTTPS on this checkout's derived port.
- **`Kill debug server`** — sends `SIGTERM` to the watch process. Runs as the `postDebugTask` so the server shuts down when the debug session ends.

The two matchers coexist because esbuild and ESLint print errors in different shapes. The ESLint matcher uses VS Code's multi-line (`loop`) pattern to read the stylish formatter's "file header + indented findings" layout, and reports under the `eslint` owner with `fileLocation: "absolute"` (ESLint emits absolute paths), keeping it distinct from esbuild's matcher. Because VS Code strips ANSI escape codes before matching, ESLint's colored terminal output is preserved while still populating the Problems panel — the same approach as VS Code's built-in `$eslint-stylish` matcher.

### `.vscode/launch.json`

Three Chrome configurations are provided:

- **"Debug in Chrome"** launches this checkout's derived HTTP URL after running the `debug` task.
- **"Debug in Chrome (https)"** launches its derived HTTPS URL after running the `debug:https` task.
- **"Attach to Chrome"** attaches to the dedicated Chrome that `npm run dev` launches, on this checkout's derived debug port.
- The two launch configurations set `postDebugTask` to `Kill debug server` and use `outFiles` for source map resolution.
- All three set `webRoot` to `"${workspaceFolder}"` plus a `sourceMapPathOverrides` rule so breakpoints bind against esbuild's spec-correct (outdir-relative) source maps. See [Source maps & VS Code breakpoints](docs/sourcemaps-and-vscode.md) for the full rationale and trade-offs.

#### Ports in `launch.json`

Because [dev server ports are derived per checkout](#dev-server-ports), `launch.json` cannot hardcode one — a second worktree would inherit the committed number and point at the wrong server. And VS Code has no way to compute a value for a launch config: `${config:}` resolves only *registered* settings, `${env:}` reads VS Code's own environment, and `${input:command}` can only invoke a command that some extension registered ([variables reference](https://code.visualstudio.com/docs/reference/variables-reference)). A native `variables` section [was requested and declined](https://github.com/microsoft/vscode/issues/267100).

So rather than have `launch.json` *look up* a port at debug time, the port is baked in ahead of time. `.vscode/launch_template.json` is the committed source of truth:

```jsonc
"url": "http://localhost:{{http}}",
...
"port": {{debug}},
```

The runner renders it to `.vscode/launch.json`, substituting `{{http}}`, `{{https}}` and `{{debug}}`. That happens on `npm install` (via `prepare`, so the config is right before the first debug session in a fresh clone) and on every serve/watch, and can be forced with `npm run sync:launch`. Because the ports are a pure function of the build script's path, rendering is idempotent — identical output every run, and the file is left untouched when nothing changed.

**Edit the template, not `launch.json`.** The generated file carries a `GENERATED FILE — DO NOT EDIT` banner and is **gitignored**; each clone and worktree renders its own.

This costs no extensions and keeps the task-based flow — and with it the Problems panel — intact.

**Launch usage:** open the Run & Debug panel, choose the HTTP or HTTPS Chrome configuration, and press **Start Debugging (F5)**. VS Code starts the matching watch server, waits for `[esbuild-ready]`, launches Chrome with the debugger attached, and tears the server down when you stop.

**Attach usage:** Chrome must be running with remote debugging enabled. Quit any existing Chrome instance first, then relaunch it with the flag:

```sh
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

Then start `npm run dev` (or `npm run serve`), navigate Chrome to the dev server URL, select **"Attach to Chrome"** in the Run & Debug panel, and press **F5**. VS Code attaches to the open tab without managing the server lifecycle.
