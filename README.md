# @graysonlang/esp

A collection of esbuild plugins and utilities.

## Installation

```sh
npm install @graysonlang/esp
```

Peer dependencies vary by plugin — install only what you need:

```sh
npm install --save-dev esbuild            # required by all plugins
npm install --save-dev @biomejs/biome     # to lint with biome
npm install --save-dev eslint             # to lint with eslint
```

Both linters are optional peer dependencies, and `esp` depends on neither. Pick one — [`esbuild-plugin-lint`](#esbuild-plugin-lint) takes a driver, and the driver you don't use is never loaded.

### Upgrading to 2.0

`esbuild-plugin-eslint` is gone. Linting is now one plugin plus a driver, so biome and ESLint go through the same code path and print the same output:

```js
// before (1.x)
import createEslintPlugin from '@graysonlang/esp/esbuild-plugin-eslint';
createEslintPlugin({ throwOnErrors: true, fix: false });

// after (2.x)
import createLintPlugin from '@graysonlang/esp/esbuild-plugin-lint';
import createEslintDriver from '@graysonlang/esp/lint-driver-eslint';
createLintPlugin({ throwOnErrors: true, driver: createEslintDriver({ fix: false }) });
```

Plugin-level options (`throwOnErrors`, `throwOnWarnings`) stay on the plugin; everything ESLint-specific (`candidateExtensions`, `warnIgnored`, and any [ESLint constructor option](https://eslint.org/docs/latest/integrate/nodejs-api#-new-eslintoptions)) moves to the driver.

Two behavior changes come with it:

- Diagnostics are rendered by `esp` rather than ESLint's own stylish formatter. The layout the VS Code problem matcher parses is unchanged, and output is still colored when the terminal takes it.
- Files under `node_modules` are no longer linted. Pass `ignore: null` to restore the old behavior.

Projects using `runBuild` with `--lint` and no `lintPlugin` override need no change.

## Template project

[graysonlang/esp-template](https://github.com/graysonlang/esp-template) is a minimal but complete project using `@graysonlang/esp` in an independent repo. It is a GitHub template — click **Use this template** to start a new project from it.

It includes a working `scripts/build.mjs`, the full set of recommended `package.json` scripts, the `.vscode/tasks.json` and `.vscode/launch_template.json` files described in the [VS Code Integration](#vs-code-integration) section below, and CI / GitHub Pages workflows.

## Example app

`example/` is this repo's own build, driven by [`scripts/build.mjs`](scripts/build.mjs). Run it with:

```sh
npm run dev          # watch + dev server + proxy toasts + Chrome
npm run dev:coi      # same, cross-origin isolated
```

The page it serves is a status board for the dev environment, and each panel is measured live rather than described:

- **Dev server** — origin, protocol, [derived port](#dev-server-ports), secure context, and whether the page is [cross-origin isolated](#cross-origin-isolation) with `SharedArrayBuffer` available.
- **Watch & live reload** — whether the runner's `/esbuild` event stream is connected, plus a reload counter that ticks up every time watch mode rebuilds. Edit `example/app/main.js` and save to watch it move.
- **Copied assets** — the paths [`esbuild-plugin-glob-copy`](#esbuild-plugin-glob-copy) exported from `virtual:glob`, each fetched back from the output directory to confirm the copy landed.
- **Build toasts** — whether the `--proxy` banner injected its toast overlay, so terminal-side plugin logs surface in the browser.
- **Source maps** — follows this bundle's own `sourceMappingURL` and reports which original sources it resolves to, with a button that throws from a known line for checking stacks and breakpoints.

So a fresh clone answers "is my setup working?" by loading one page.

## Output directory convention

Two output directories, with fixed meanings across esp-based projects:

- **`www/`** — the built web content: the demo/app page, what the dev server serves and what deploys to GitHub Pages. This is what `scripts/build.mjs` emits via `outdir`, and it is never published to npm.
- **`dist/`** — the source distribution: a packaged library bundle plus type declarations, pointed at by `main`/`types`/`exports` and listed in `files`. Emitted by a separate `scripts/dist.mjs` using esbuild and `tsc` directly, not by esp's runner.

Keeping them distinct means a project can grow a publishable library without its web output and its npm payload contending for the same directory. Gitignore both, and exclude them from linting — `"files": { "includes": ["**", "!dist", "!www"] }` in `biome.jsonc`, or `ignores: ['dist/**', 'www/**']` in `eslint.config.js`.

esp itself only produces `www/` (for its `example/`); its npm payload is the unbundled `src/` tree listed in `files`, so it has no `dist/`.

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
| `lint` | `biome check .` | Lint source files |
| `lint:fix` | `biome check --write .` | Lint and apply fixes |

### Runner CLI flags

`runBuild` parses CLI flags from `process.argv` automatically. All flags are optional:

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--minify` | | `false` | Minify output |
| `--lint` | | `false` | Lint loaded source files after each build (biome or ESLint — see [driver selection](#esbuild-runner)) |
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

Compiles C/C++ source files via [Emscripten](https://emscripten.org/) (`emcc`) during an esbuild build. Dependency paths, content hashes, and mtimes are persisted under `node_modules/.cache/@graysonlang/esp/emcc`, so an unchanged one-shot build skips both the `emcc -MM` dependency scans and compilation. Changes to the compiler version, relevant Emscripten environment, source list, output path, or compiler options invalidate the cache.

On a cold or invalidated cache, the plugin prints a single progress line before dependency discovery begins. Warm cache hits stay quiet unless `verbose` is enabled.

```js
import createEmccPlugin from '@graysonlang/esp/esbuild-plugin-emcc';

await esbuild.build({
  plugins: [createEmccPlugin({ emccPath: 'emcc', emccOptions: ['-sSINGLE_FILE=1'] })],
});
```

**Options:** `emccPath`, `emccOptions`, `cacheDirectory`, `verbose`, `logger`

Set `cacheDirectory` to a custom path to relocate the cache, or to `null` to keep freshness state in memory only.

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

### `esbuild-plugin-lint`

Lints the source files a build loaded, at the end of each build. Only re-lints files that changed since the last build, plus any that reported a problem last time — so a fix elsewhere clears a stale squiggle. Files under `node_modules` are skipped.

The linter itself is a *driver*, so the plugin is the same whichever one you use:

```js
import createLintPlugin from '@graysonlang/esp/esbuild-plugin-lint';
import createBiomeDriver from '@graysonlang/esp/lint-driver-biome';

await esbuild.build({
  plugins: [createLintPlugin({ driver: createBiomeDriver(), throwOnErrors: true })],
});
```

**Options:** `driver` (required), `throwOnWarnings`, `throwOnErrors`, `ignore`.

Output is colored when stdout is a terminal, honoring `NO_COLOR` and `FORCE_COLOR`. That is safe for the Problems panel because VS Code strips ANSI escapes before running a problem matcher over task output — so one stream reads well in the integrated terminal and still populates the panel.

#### `lint-driver-biome`

Runs the `biome` executable and reads its JSON reporter. Resolves a locally installed binary by walking up to `node_modules/.bin`, falling back to `PATH`; `@biomejs/biome` is never imported, so it stays out of the module graph.

**Options:** `biomePath`, `command` (`'check'` by default, so a build surfaces what `biome check` surfaces in CI — including formatting drift — rather than reporting green and failing CI later), `extensions`, `biomeArgs`, `cwd`.

#### `lint-driver-eslint`

Uses ESLint's programmatic API. `eslint` is imported lazily, only once this driver runs. The file filter is built from the extensions your own ESLint config claims, so a project with no TypeScript config never loads `.ts` files just to ignore them.

**Options:** `candidateExtensions`, plus any [ESLint constructor options](https://eslint.org/docs/latest/integrate/nodejs-api#-new-eslintoptions).

#### Custom drivers

A driver is any object of this shape, so a linter `esp` has never heard of works without patching `esp`:

```js
{
  name: string,
  init(): Promise<{ filter: RegExp }>,   // filter is compiled by Go's regexp — no `u` flag
  lint(files: string[]): Promise<LintDiagnostic[]>,
}
```

`LintDiagnostic` is `{ filePath, line, column, severity, message, ruleId? }` with an absolute path, 1-based position, and a severity of `error`, `warning`, or `info`. Rendering is shared, so every driver produces output the same problem matcher parses.

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
    outdir: 'www',
    plugins: [
      pluginGlobCopy({ logger }),
    ],
    ...args, // spreads minify, live-reload banner for watch/serve, etc.
  };
}

runBuild(getOptions);
```

The runner automatically adds `esbuild-plugin-lint` (when `--lint`) and `esbuild-plugin-vscode-problem-matcher` (when `--vscode`) to the plugin list.

Under `--lint` the driver is chosen from the project: a `biome.json` or `biome.jsonc` in the working directory selects biome, and anything else falls back to ESLint. Neither package is a dependency of `esp`, so this never forces an install — it only decides which one an opted-in project meant.

`runBuild` accepts an optional second argument to override the injected plugins:

```js
runBuild(getOptions, {
  lintPlugin: () => myCustomLintPlugin(),  // replace the auto-selected lint plugin
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

const freshness = new Freshness({
  cacheFile: 'node_modules/.cache/my-plugin/freshness.json',
  cacheKey: 'options-and-toolchain-signature',
});
const previouslyTrackedFiles = await freshness.trackedFiles();
const isUpToDate = await freshness.check(filePathSet);
const { changed, removed } = await freshness.update(fileMapOrSet);
```

Both constructor options are optional; without `cacheFile`, freshness state remains in memory. `cacheKey` lets callers invalidate otherwise valid persisted state when non-file inputs change.

### `glglob`

A lightweight async glob implementation with `**`, `*`, `?`, and `{a,b}` expansion. No external dependencies.

```js
import glob from '@graysonlang/esp/glglob';

const files = await glob('src/**/*.js');
```

### `helpers`

Internal utilities: `computeUrlSafeBase64Digest`, `consolidateDirs`, `parsePathsString`.

### `prepare`

Runs a project's `prepare` steps. Each runs as its own child process, in order, and **every failure is a warning** — `prepare` fires on local `npm install`, on publish, and when someone installs the project as a *git* dependency, where npm builds it from a temp clone. The steps projects want there are developer conveniences; none is worth failing an install over, least of all somebody else's. A child process is also a hard boundary, so a step that dies on import is contained rather than taking the install down.

A project's `scripts/prepare.mjs` is then just the list:

```js
#!/usr/bin/env node
try {
  const { runPrepareSteps } = await import('@graysonlang/esp/prepare');
  runPrepareSteps([
    {
      label: 'sync launch.json',
      args: ['./scripts/build.mjs', '--sync-launch'],
    },
  ]);
} catch (error) {
  console.warn(`prepare: skipped (${error.message})`);
}
```

**Step fields:** `label` (required — named in any warning), `command` (defaults to the running Node), `args`, and `hint` — extra text appended to the warning, worth setting on a load-bearing step whose output a git install has no other way to obtain, so the message says how to recover.

Two details that look like noise but aren't:

- **The import is dynamic and guarded.** `prepare` still runs under `npm install --omit=dev`, where `esp` is not installed. A bare top-level import would fail the very install this exists not to disturb.
- **Each step object is written expanded**, one field per line. Biome and Prettier both keep an object broken up when the source has a newline between the `{` and the first key, so adding a step or a field stays a one-line diff instead of reflowing its neighbours.

Prefer this over chaining in `package.json`. `a && b` silently skips `b` when `a` fails, `a || echo ...` swallows which step broke, and neither can carry a comment or avoid the platform's shell.

## VS Code Integration

The repository includes example `.vscode/` configuration files that demonstrate a full VS Code debug workflow built on `esbuild-runner`.

### How it works

The `--vscode` flag tells the runner to:

1. Attach `esbuild-plugin-vscode-problem-matcher`, which formats build errors/warnings so VS Code can parse them and surface them in the Problems panel. When `--lint` is also set, lint findings are surfaced too — via a companion problem matcher in `tasks.json` (see below).
2. Print `[esbuild-ready] <url>` to stdout once the dev server is ready. VS Code uses this as the `background.endsPattern` to know the server is up before launching the debugger.

### `.vscode/tasks.json`

Four tasks are defined:

- **`build`** — one-shot build (`vscode:build` script). Configured as the default build task (`Ctrl+Shift+B` / `Cmd+Shift+B`). Carries **two** inline problem matchers: one parses esbuild's `> file:line:col: error: message` output, the other parses the *stylish* layout emitted by `esbuild-plugin-lint` under `--lint`. Both `debug` tasks carry the same pair.
- **`debug`** — HTTP watch-mode server (`vscode:debug` script). Runs in the background. The `background` problem matcher waits for `[esbuild-ready] <url>` before signaling readiness to the launch configuration.
- **`debug:https`** — HTTPS watch-mode server (`vscode:debug:https` script). Uses the same readiness signal as `debug`, and serves HTTPS on this checkout's derived port.
- **`Kill debug server`** — sends `SIGTERM` to the watch process. Runs as the `postDebugTask` so the server shuts down when the debug session ends.

The two matchers coexist because esbuild and the linters print errors in different shapes. The lint matcher uses VS Code's multi-line (`loop`) pattern to read the stylish "file header + indented findings" layout, and reports with `fileLocation: "absolute"` — the same approach as VS Code's built-in `$eslint-stylish` matcher. Because VS Code strips ANSI escapes before matching, the colored terminal output is preserved while still populating the Problems panel.

It reports under the `esp-lint` owner rather than `eslint`, which is both accurate when the driver is biome and keeps the task from clearing diagnostics the ESLint extension owns. Existing `tasks.json` files keep working either way — the pattern is unchanged, only the label differs.

Holding that layout is the reason the driver seam is worth having: swap the linter underneath and VS Code keeps showing inline squiggles with no change to `tasks.json`. Two constraints follow from the matcher, and [`test/lint-diagnostics.test.mjs`](test/lint-diagnostics.test.mjs) pins both — paths are absolute, and at least two spaces separate the rule id from the message.

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
...
"outFiles": ["${workspaceFolder}/{{outdir}}/*.js"]
```

The runner renders it to `.vscode/launch.json`, substituting `{{http}}`, `{{https}}` and `{{debug}}`, plus `{{outdir}}` — the build's output directory (the `outdir` in `scripts/build.mjs`), so `outFiles` points at wherever this build actually writes its bundles. That happens on `npm install` (via `prepare`, so the config is right before the first debug session in a fresh clone) and on every serve/watch, and can be forced with `npm run sync:launch`. Because the ports are a pure function of the build script's path, rendering is idempotent — identical output every run, and the file is left untouched when nothing changed.

`{{outdir}}` requires esp 1.8.0 or newer. An older runner leaves it unsubstituted, producing a literal `{{outdir}}` path segment that matches nothing — breaking source map resolution with no error.

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

## Coding-agent browser support

MCP-aware coding agents (Claude Code among them) can drive a real browser for validation — navigate to the dev server, read the accessibility tree, click controls, and inspect console output — when the project registers a browser-automation MCP server.
`esp-sync-mcp` scaffolds that registration once per project:

```sh
npx esp-sync-mcp
```

It writes two files at the project root.
`.mcp.json` registers [Playwright MCP](https://github.com/microsoft/playwright-mcp) as a stdio server and says nothing else — run the project's pinned server with the project's config:

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "node",
      "args": ["node_modules/@playwright/mcp/cli.js", "--config", "playwright-mcp.config.json"]
    }
  }
}
```

`playwright-mcp.config.json` holds the browser policy, seeded with defaults suited to validation:

```json
{
  "browser": {
    "isolated": true,
    "launchOptions": { "headless": true }
  }
}
```

The split is deliberate.
Agent hosts re-prompt for approval whenever `.mcp.json` changes, so the registration stays minimal and is approved once, while everything a host repo may want to tune — headed for debugging, a persistent profile, another browser, a viewport, a CDP endpoint to a running Chrome — lives in the config file and can be edited freely; the server reads it at startup and validates it against [Playwright MCP's schema](https://github.com/microsoft/playwright-mcp#configuration-file).
The defaults run headless so automation never raises a window over the developer's work, and isolated so every run starts from the same blank browser state rather than whatever a previous run left behind.

Invoking the cli directly with node runs whatever `@playwright/mcp` version the project pins in `devDependencies` — install it with `npm install --save-dev --save-exact @playwright/mcp` — and a missing pin fails loudly at agent-session start instead of silently floating to latest; a bare `npx` runner is avoided because it can intercept flags meant for the server, and its registry fallback would fetch an unpinned version.

Each file is written only when missing and never regenerated: unlike `launch.json` they embed no derived values, and both are authored config a project may extend.
The browser config is created only when `.mcp.json` refers to it, so a project with its own registration never acquires an unused file.
Commit both; each collaborator approves the registration once in their agent host.

To keep fresh clones provisioned, add it to the project's prepare steps:

```js
runPrepareSteps([
  { label: 'sync launch.json', args: ['./scripts/build.mjs', '--sync-launch'] },
  { label: 'sync .mcp.json', args: ['./node_modules/@graysonlang/esp/scripts/sync-mcp.mjs'] },
]);
```

Agents should validate against their own isolated preview (`node scripts/build.mjs --serve --port=<reserved> --sourcemap`) rather than the developer's `npm run dev` server, then navigate the Playwright browser to the exact emitted URL.
