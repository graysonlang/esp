import Freshness from './freshness.js';

let _eslintModulePromise = null;

async function importESLint() {
  if (!_eslintModulePromise) {
    _eslintModulePromise = import('eslint').then(m => m.ESLint).catch(() => {
      _eslintModulePromise = null;
      throw new Error(
        'esbuild-plugin-eslint requires \'eslint\' to be installed. '
        + 'Run: npm install --save-dev eslint',
      );
    });
  }
  return _eslintModulePromise;
}

export const defaultCandidateExtensions = [
  'js', 'jsx', 'cjs', 'mjs',
  'ts', 'tsx', 'cts', 'mts',
];

async function buildFilterFromEslintConfig(ESLint, eslintOptions, candidateExtensions) {
  const eslint = new ESLint(eslintOptions);
  const matched = (await Promise.all(
    candidateExtensions.map(async (ext) => {
      const config = await eslint.calculateConfigForFile(`dummy.${ext}`);
      return config ? ext : null;
    }),
  )).filter(Boolean);
  return new RegExp(`\\.(?:${matched.join('|')})$`);
}

// The following code is based on:
// https://github.com/robinloeffel/esbuild-plugin-eslint/blob/main/src/index.ts
// Copyright (c) Robin Löffel

export default ({
  candidateExtensions = defaultCandidateExtensions,
  throwOnWarnings = false,
  throwOnErrors = false,
  warnIgnored = false,
  ...eslintOptions
} = {}) => {
  let buildStartTime = 0;
  let lastOnLoadTime = 0;

  const _freshness = new Freshness();

  return {
    name: 'eslint',
    setup: async (build) => {
      const ESLint = await importESLint();
      const eslint = new ESLint({ warnIgnored, ...eslintOptions });
      const filter = await buildFilterFromEslintConfig(ESLint, { warnIgnored, ...eslintOptions }, candidateExtensions);
      const seenFiles = new Set();
      const dirtyFiles = new Set();

      build.onStart(() => {
        buildStartTime = Date.now();
      });

      build.onLoad({ filter }, ({ path }) => {
        lastOnLoadTime = Date.now();
        seenFiles.add(path);
        return null;
      });

      build.onEnd(async () => {
        // If no lintable files were loaded this build, skip linting entirely.
        if (buildStartTime > lastOnLoadTime) {
          return;
        }

        const { changed } = await _freshness.update(seenFiles);
        // Always re-lint files that had errors/warnings last time, even if
        // their content is unchanged — a dependency fix may have resolved them.
        const filesToLint = [...new Set([...changed, ...dirtyFiles])];

        if (filesToLint.length === 0) {
          return;
        }

        const results = await eslint.lintFiles(filesToLint);
        const formatter = await eslint.loadFormatter();
        const output = await formatter.format(results);

        const warnings = results.reduce((count, result) => count + result.warningCount, 0);
        const errors = results.reduce((count, result) => count + result.errorCount, 0);

        for (const result of results) {
          if (result.warningCount > 0 || result.errorCount > 0) {
            dirtyFiles.add(result.filePath);
          } else {
            dirtyFiles.delete(result.filePath);
          }
        }

        if (eslintOptions.fix) {
          await ESLint.outputFixes(results);
        }

        if (output.length > 0) {
          console.log(output);
        }

        if (throwOnWarnings && warnings > 0) {
          throw new Error(`ESLint found ${warnings} warning${warnings === 1 ? '' : 's'}.`);
        }
        if (throwOnErrors && errors > 0) {
          throw new Error(`ESLint found ${errors} error${errors === 1 ? '' : 's'}.`);
        }
      });
    },
  };
};
