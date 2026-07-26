// Biome driver for esbuild-plugin-lint.
//
// Bound the same way esbuild-plugin-emcc binds emcc: by running an executable
// found at a configurable path, never by importing a package. Biome ships as a
// platform-specific binary and its JSON reporter is a stable contract, so there
// is nothing to gain from a programmatic import - and doing it this way keeps
// `@biomejs/biome` out of esp's dependency graph entirely. A project that has
// biome installed locally works with no configuration; a project that does not
// gets a clear error naming the fix.

import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Biome's own supported set. Unlike ESLint there is no per-project config to
// interrogate, so this is a static list. Narrow it with `extensions` if a
// project only wants a subset linted at build time.
export const defaultExtensions = [
  'js',
  'jsx',
  'cjs',
  'mjs',
  'ts',
  'tsx',
  'cts',
  'mts',
  'json',
  'jsonc',
  'css',
  'graphql',
  'gql',
  'vue',
  'svelte',
  'astro',
];

// What npm actually writes into node_modules/.bin. On Windows that is a `.cmd`
// shim - there is no `biome.exe` there, the real executable lives inside the
// platform package - so looking only for `.exe` misses every local install and
// silently falls through to PATH. `.exe` stays in the list after `.cmd` in case
// a project links the platform binary directly, since running it needs no
// shell.
const BIN_NAMES = process.platform === 'win32' ? ['biome.cmd', 'biome.exe'] : ['biome'];

/**
 * Walk up from `startDir` looking for a locally installed biome binary, then
 * fall back to whatever is on PATH. Mirrors how npm resolves a bin, so a
 * workspace or hoisted install is found without configuration.
 * @param {string} startDir
 * @returns {string}
 */
function resolveBiomePath(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const binName of BIN_NAMES) {
      const candidate = path.join(dir, 'node_modules', '.bin', binName);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'biome';
}

/**
 * A `.cmd` shim is a batch script, so Windows can only run it through cmd.exe;
 * a real `.exe` is spawned directly. Nothing else needs a shell.
 * @param {string} executable
 * @returns {boolean}
 */
function needsShell(executable) {
  if (process.platform !== 'win32') return false;
  return executable.toLowerCase().endsWith('.cmd') || !path.isAbsolute(executable);
}

/**
 * With `shell: true` Node hands cmd.exe one flat command string and quotes
 * nothing, so an unquoted argument breaks on the first space - which any
 * install under `C:\Users\First Last\` produces, before considering file paths.
 * Wrapping in double quotes covers spaces and the metacharacters cmd.exe would
 * otherwise expand.
 *
 * A literal `"` is dropped rather than escaped: cmd.exe has no dependable
 * escape for one inside a quoted string, and Windows forbids `"` in filenames,
 * so this can only be reached through caller-supplied `biomeArgs`.
 * @param {string} value
 * @returns {string}
 */
function quoteForCmd(value) {
  return /[\s&|<>^()"]/u.test(value) ? `"${value.replace(/"/gu, '')}"` : value;
}

// Biome's diagnostic severities, mapped onto the three the problem matcher
// knows. Spelled out rather than "error, info, else warning", because the
// fallback silently downgraded `fatal` to a warning - which would let it slip
// past `throwOnErrors` - and upgraded `hint` to one, which could trip
// `throwOnWarnings` over a suggestion.
const BIOME_SEVERITY = {
  fatal: 'error',
  error: 'error',
  warning: 'warning',
  // Biome's suggestions, which are not problems: the matcher's third severity
  // rather than a fourth of our own.
  information: 'info',
  info: 'info',
  hint: 'info',
};

/**
 * Biome reports a whole-file problem (a formatter diff, most often) at 0:0, but
 * the VS Code problem matcher and editors are 1-based, so a 0 would land the
 * squiggle nowhere. Clamp.
 * @param {unknown} value
 * @returns {number}
 */
function toPosition(value) {
  return typeof value === 'number' && value > 0 ? value : 1;
}

/**
 * `location.path` has been both a bare string and a `{ file }` object across
 * biome releases. Accept either rather than breaking on an upgrade.
 * @param {any} location
 * @returns {string | null}
 */
function locationPath(location) {
  const raw = typeof location?.path === 'string' ? location.path : location?.path?.file;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Async rather than `spawnSync`: under `--serve --watch` the runner hosts the
 * dev server and log proxy on this same event loop, so a synchronous lint would
 * stall every open connection for the duration of each rebuild.
 * @param {string} executable
 * @param {string[]} args
 * @param {{ cwd: string, shell: boolean }} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runBiome(executable, args, { cwd, shell }) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(executable, args, { cwd, shell });
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    // 'error' means the process never ran (ENOENT and friends). Note that with
    // a shell it never fires - the shell itself starts fine and reports the
    // failure on stderr - which is why the missing-biome hint below also has to
    // cope with a run that "succeeded" but produced no JSON.
    child.on('error', reject);
    // 'close' rather than 'exit', so both pipes have flushed.
    child.on('close', () => resolve({ stdout: stdout.join(''), stderr: stderr.join('') }));
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.biomePath]  Explicit path to the biome executable.
 * @param {'check' | 'lint'} [options.command]
 * @param {string[]} [options.extensions]
 * @param {string[]} [options.biomeArgs]  Extra CLI flags.
 * @param {string} [options.cwd]
 * @returns {import('./esbuild-plugin-lint.js').LintDriver}
 */
export default function createBiomeDriver({
  biomePath,
  // `check` rather than `lint` by default, so the build surfaces exactly what
  // `biome check` surfaces in CI. A build that runs only `lint` reports green
  // on formatting drift and then CI fails on it, which is the worse failure.
  command = 'check',
  extensions = defaultExtensions,
  biomeArgs = [],
  cwd = process.cwd(),
} = {}) {
  const executable = biomePath ?? resolveBiomePath(cwd);

  return {
    name: 'biome',

    async init() {
      return { filter: new RegExp(`\\.(?:${extensions.join('|')})$`) };
    },

    async lint(files) {
      // TODO(TODO.md): chunk `files`. A large first build can outgrow the
      // command-line length limit - 8191 chars through cmd.exe on Windows,
      // which is only about 100 paths.
      const args = [command, '--reporter=json', '--colors=off', ...biomeArgs, ...files];
      const shell = needsShell(executable);

      const missingHint =
        executable === 'biome'
          ? "The biome lint driver could not run 'biome'. " +
            'Run: npm install --save-dev @biomejs/biome'
          : `The biome lint driver could not run '${executable}'.`;

      let result;
      try {
        result = await runBiome(
          shell ? quoteForCmd(executable) : executable,
          shell ? args.map(quoteForCmd) : args,
          { cwd, shell },
        );
      } catch (error) {
        throw new Error(`${missingHint} (${error.message})`);
      }

      // Biome exits non-zero whenever it reports anything, so the exit code
      // says nothing about whether the run itself worked. Trust the JSON on
      // stdout instead, and only treat unparseable output as a real failure.
      let report;
      try {
        report = JSON.parse(result.stdout);
      } catch {
        const detail = (result.stderr || result.stdout || '').trim();
        let reason;
        if (result.stdout.trim()) {
          reason = "The biome lint driver could not parse biome's JSON output.";
        } else if (detail) {
          // Biome ran and explained itself on stderr - an invalid biome.json or
          // an unknown flag in biomeArgs. Leading with the install hint here
          // would send the user to fix an install that is fine.
          reason = 'The biome lint driver got no output from biome.';
        } else {
          // Nothing on either pipe. With a shell (Windows) a missing executable
          // looks like this, because the shell starts fine and swallows it.
          reason = missingHint;
        }
        throw new Error(`${reason}\n${detail}`);
      }

      /** @type {import('./lint-diagnostics.js').LintDiagnostic[]} */
      const diagnostics = [];
      for (const d of report.diagnostics ?? []) {
        const relPath = locationPath(d.location);
        if (relPath === null) continue;
        diagnostics.push({
          filePath: path.resolve(cwd, relPath),
          line: toPosition(d.location?.start?.line),
          column: toPosition(d.location?.start?.column),
          severity: BIOME_SEVERITY[d.severity] ?? 'warning',
          message: typeof d.message === 'string' ? d.message : String(d.message ?? ''),
          ruleId: d.category ?? undefined,
        });
      }
      return diagnostics;
    },
  };
}
