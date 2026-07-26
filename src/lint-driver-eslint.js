// ESLint driver for esbuild-plugin-lint.
//
// Bound late, via a dynamic import, so `eslint` is only required by projects
// that actually select this driver. esp itself does not depend on it.
//
// This driver uses ESLint's programmatic API rather than its CLI, because the
// API gives two things the adapter relies on: the set of extensions the
// project's own config claims (so the file filter matches the config instead of
// guessing), and per-file linting of an arbitrary list (so the adapter's
// incremental re-lint works).

/** @type {Promise<any> | null} */
let _eslintModulePromise = null;

async function importESLint() {
  if (!_eslintModulePromise) {
    _eslintModulePromise = import('eslint')
      .then(m => m.ESLint)
      .catch(() => {
        _eslintModulePromise = null;
        throw new Error(
          "The eslint lint driver requires 'eslint' to be installed. " +
            'Run: npm install --save-dev eslint',
        );
      });
  }
  return _eslintModulePromise;
}

export const defaultCandidateExtensions = ['js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx', 'cts', 'mts'];

/**
 * Ask ESLint which of the candidate extensions its config actually covers, and
 * build the onLoad filter from that. A project with no TypeScript config gets a
 * filter that skips .ts entirely rather than loading and ignoring those files.
 */
async function buildFilterFromEslintConfig(ESLint, eslintOptions, candidateExtensions) {
  const eslint = new ESLint(eslintOptions);
  const matched = (
    await Promise.all(
      candidateExtensions.map(async ext => {
        const config = await eslint.calculateConfigForFile(`dummy.${ext}`);
        return config ? ext : null;
      }),
    )
  ).filter(Boolean);
  return new RegExp(`\\.(?:${matched.join('|')})$`);
}

/**
 * @param {object} [options]
 * @param {string[]} [options.candidateExtensions]
 * @returns {import('./esbuild-plugin-lint.js').LintDriver}
 */
export default function createEslintDriver({
  candidateExtensions = defaultCandidateExtensions,
  ...eslintOptions
} = {}) {
  const resolved = { warnIgnored: false, ...eslintOptions };

  /** @type {any} */
  let ESLint = null;
  /** @type {any} */
  let eslint = null;

  return {
    name: 'eslint',

    async init() {
      ESLint = await importESLint();
      eslint = new ESLint(resolved);
      return {
        filter: await buildFilterFromEslintConfig(ESLint, resolved, candidateExtensions),
      };
    },

    async lint(files) {
      const results = await eslint.lintFiles(files);

      if (resolved.fix) {
        await ESLint.outputFixes(results);
      }

      /** @type {import('./lint-diagnostics.js').LintDiagnostic[]} */
      const diagnostics = [];
      for (const result of results) {
        for (const message of result.messages) {
          diagnostics.push({
            filePath: result.filePath,
            line: message.line ?? 1,
            column: message.column ?? 1,
            severity: message.severity === 2 ? 'error' : 'warning',
            message: message.message,
            ruleId: message.ruleId ?? undefined,
          });
        }
      }
      return diagnostics;
    },
  };
}
