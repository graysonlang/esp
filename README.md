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

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `node ./scripts/build.mjs --lint --minify` | One-shot production build (linted, minified) |
| `serve` | `node ./scripts/build.mjs --lint --sourcemap --watch --serve` | Watch + dev server with live reload |
| `serve:https` | `ESP_DEV_CERT_NAME=$npm_package_config_esp_dev_cert_name npm run serve -- --host=0.0.0.0 --port=8443` | HTTPS watch + dev server using the configured development cert |
| `dev` | `npm run serve -- --proxy --launch` | Watch + dev server with proxy toasts and Chrome launch |
| `dev:https` | `npm run serve:https -- --proxy --launch` | HTTPS watch + dev server with proxy toasts and Chrome launch |
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
| `--launch` | | `false` | Launch a dedicated Chrome instance when the dev server starts |
| `--vscode` | | `false` | Emit VS Code problem matcher output and print `[esbuild-ready] <url>` when ready |
| `--reuse` | | `false` | Open/reload an existing Chrome tab instead of launching a dedicated instance |
| `--verbose` | `-v` | `false` | Enable verbose logging |
| `--certfile` | | | Explicit HTTPS certificate path |
| `--keyfile` | | | Explicit HTTPS private key path |
| `--host` | | `127.0.0.1` | Dev server host |
| `--port` | | `8000` | Dev server port |

Any unrecognized flags are forwarded to esbuild as build options (e.g. `--sourcemap`).

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
    ...args, // spreads minify, banner (live-reload), etc.
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

When `--launch` is set, the runner opens a dedicated Chrome instance using a temporary profile. When `--reuse` is also set, it instead opens or reloads an existing Chrome tab. When `--vscode` is set, the runner prints `[esbuild-ready] <url>` once the server is ready — a signal VS Code tasks can use as a `background.endsPattern`.

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

1. Attach `esbuild-plugin-vscode-problem-matcher`, which formats build errors/warnings so VS Code can parse them and surface them in the Problems panel.
2. Print `[esbuild-ready] <url>` to stdout once the dev server is ready. VS Code uses this as the `background.endsPattern` to know the server is up before launching the debugger.

### `.vscode/tasks.json`

Four tasks are defined:

- **`build`** — one-shot build (`vscode:build` script). Configured as the default build task (`Ctrl+Shift+B` / `Cmd+Shift+B`). Uses an inline problem matcher that parses esbuild's `> file:line:col: error: message` format.
- **`debug`** — HTTP watch-mode server (`vscode:debug` script). Runs in the background. The `background` problem matcher waits for `[esbuild-ready] <url>` before signaling readiness to the launch configuration.
- **`debug:https`** — HTTPS watch-mode server (`vscode:debug:https` script). Uses the same readiness signal as `debug` and serves `https://localhost:8443`.
- **`Kill debug server`** — sends `SIGTERM` to the watch process. Runs as the `postDebugTask` so the server shuts down when the debug session ends.

### `.vscode/launch.json`

Two Chrome launch configurations are provided:

- **"Debug in Chrome"** launches `http://localhost:8000` after running the `debug` task.
- **"Debug in Chrome (https)"** launches `https://localhost:8443` after running the `debug:https` task.
- Both configurations set `postDebugTask` to `Kill debug server`, point `webRoot` at the source directory, and use `outFiles` for source map resolution.

**Usage:** open the Run & Debug panel, choose the HTTP or HTTPS Chrome configuration, and press **Start Debugging (F5)**. VS Code starts the matching watch server, waits for `[esbuild-ready]`, launches Chrome with the debugger attached, and tears the server down when you stop.
