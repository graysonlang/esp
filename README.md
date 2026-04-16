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
