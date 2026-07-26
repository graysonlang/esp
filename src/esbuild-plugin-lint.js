// Linter-agnostic esbuild plugin.
//
// esbuild has no lint stage and no diagnostic channel for one, so the value
// here is the plumbing rather than the linting: run a linter over exactly the
// files this build touched, incrementally, and print the result in the one
// format the VS Code problem matcher in esp's tasks.json understands. That
// gives inline squiggles during `--watch` without a second process.
//
// The linter itself is a driver (see lint-driver-eslint.js and
// lint-driver-biome.js), so none of that plumbing is duplicated per linter and
// esp depends on neither. A driver is:
//
//   {
//     name: string,
//     init(): Promise<{ filter: RegExp }>,
//     lint(files: string[]): Promise<LintDiagnostic[]>,
//   }
//
// Anything satisfying that shape works, so a project can supply a driver for a
// linter esp has never heard of without patching esp.

import Freshness from './freshness.js';
import { countBySeverity, renderStylish } from './lint-diagnostics.js';

/**
 * @typedef {import('./lint-diagnostics.js').LintDiagnostic} LintDiagnostic
 *
 * @typedef {object} LintDriver
 * @property {string} name
 * @property {() => Promise<{ filter: RegExp }>} init
 * @property {(files: string[]) => Promise<LintDiagnostic[]>} lint
 */

// Dependencies are not this project's code to fix, and a bundle pulls plenty of
// them through onLoad. Skipping them here rather than per driver keeps the
// behavior uniform, because the linters disagree on it: ESLint ignores
// node_modules by default, while biome refuses the path and reports
// `internalError/fs` ("does not exist in the workspace") against every file -
// one bogus error per dependency module, and a failed build under
// `throwOnErrors`.
//
// Matching the path segment is safe for npm/pnpm workspaces: esbuild resolves
// symlinks before onLoad, so a linked workspace package arrives as its real
// path under packages/ and still gets linted. Only `preserveSymlinks: true`
// builds would see it as node_modules, which is the same thing ESLint's own
// default ignore does.
export const defaultIgnore = /[\\/]node_modules[\\/]/u;

/**
 * `RegExp.test` is stateful when the pattern carries `g` or `y`: it resumes
 * from `lastIndex` and only rewinds on a failed match, so testing a series of
 * paths alternates between matching and not. A `/node_modules/g` passed as
 * `ignore` would therefore let every second dependency file straight through -
 * silently, and in exactly the case the ignore exists to cover.
 *
 * Neither flag means anything to a predicate, so drop them. Rebuilding the
 * pattern rather than resetting `lastIndex` per call keeps this off the hot
 * path and avoids mutating an object the caller still owns. Anything that is
 * not a RegExp is passed through untouched, so a custom matcher still works.
 * @param {RegExp | null | undefined} ignore
 * @returns {RegExp | null | undefined}
 */
function withoutStatefulFlags(ignore) {
  if (ignore instanceof RegExp && /[gy]/u.test(ignore.flags)) {
    return new RegExp(ignore.source, ignore.flags.replace(/[gy]/gu, ''));
  }
  return ignore;
}

// The following code is based on:
// https://github.com/robinloeffel/esbuild-plugin-eslint/blob/main/src/index.ts
// Copyright (c) Robin Löffel

/**
 * @param {object} options
 * @param {LintDriver} options.driver
 * @param {boolean} [options.throwOnWarnings]
 * @param {boolean} [options.throwOnErrors]
 * @param {RegExp | null} [options.ignore]  Paths to never lint. `null` lints
 *   everything the driver's filter matches, dependencies included. A `g` or `y`
 *   flag is dropped, since it would make matching stateful.
 */
export default function createPlugin({
  driver,
  throwOnWarnings = false,
  throwOnErrors = false,
  ignore = defaultIgnore,
} = {}) {
  if (!driver) {
    throw new Error('esbuild-plugin-lint requires a `driver`.');
  }

  const ignorePattern = withoutStatefulFlags(ignore);

  let buildStartTime = 0;
  let lastOnLoadTime = 0;

  const _freshness = new Freshness();

  return {
    name: `lint(${driver.name})`,
    setup: async build => {
      const { filter } = await driver.init();
      const seenFiles = new Set();
      const dirtyFiles = new Set();

      build.onStart(() => {
        buildStartTime = Date.now();
        // esbuild re-runs onLoad across the whole graph on every rebuild, so
        // rebuilding this set each time keeps it equal to what the build
        // actually loaded. Letting it accumulate instead meant a file that was
        // deleted, renamed, or simply no longer imported stayed in it forever,
        // and kept being handed to the linter.
        seenFiles.clear();
      });

      build.onLoad({ filter }, ({ path }) => {
        // Filtered here rather than at lint time so ignored files never enter
        // `seenFiles`, which also keeps Freshness from hashing all of
        // node_modules on every rebuild.
        if (ignorePattern?.test(path)) return null;
        lastOnLoadTime = Date.now();
        seenFiles.add(path);
        return null;
      });

      build.onEnd(async () => {
        // If no lintable files were loaded this build, skip linting entirely.
        if (buildStartTime > lastOnLoadTime) {
          return;
        }

        const { changed, removed } = await _freshness.update(seenFiles);
        // A file that left the build must also leave the re-lint set, or every
        // later rebuild hands the linter a path that no longer exists - which
        // ESLint treats as a fatal "No files matching" and biome reports as an
        // internal error, breaking watch mode until the process is restarted.
        for (const file of removed) {
          dirtyFiles.delete(file);
        }

        // Always re-lint files that had problems last time, even if their
        // content is unchanged - a fix elsewhere may have resolved them, and
        // nothing would otherwise clear the stale squiggle.
        const filesToLint = [...new Set([...changed, ...dirtyFiles])];

        if (filesToLint.length === 0) {
          return;
        }

        const diagnostics = await driver.lint(filesToLint);

        // Recompute dirty state from this run: a file that reported nothing is
        // clean and drops out of the re-lint set.
        const nowDirty = new Set(diagnostics.map(d => d.filePath));
        for (const file of filesToLint) {
          if (nowDirty.has(file)) dirtyFiles.add(file);
          else dirtyFiles.delete(file);
        }

        const output = renderStylish(diagnostics);
        if (output.length > 0) {
          console.log(output);
        }

        const { errors, warnings } = countBySeverity(diagnostics);
        if (throwOnWarnings && warnings > 0) {
          throw new Error(`${driver.name} found ${warnings} warning${warnings === 1 ? '' : 's'}.`);
        }
        if (throwOnErrors && errors > 0) {
          throw new Error(`${driver.name} found ${errors} error${errors === 1 ? '' : 's'}.`);
        }
      });
    },
  };
}
