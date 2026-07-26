// Drivers are the version-sensitive part of the lint stack: each one reads
// another tool's output format and normalizes it to LintDiagnostic. These tests
// run the real biome binary and the real ESLint API against fixture files, so a
// tool upgrade that changes a field name fails here rather than silently
// producing zero diagnostics in every consumer's build.
//
// Both linters are devDependencies of esp, so this needs no extra setup.

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { renderStylish } from '../src/lint-diagnostics.js';
import createBiomeDriver from '../src/lint-driver-biome.js';
import createEslintDriver from '../src/lint-driver-eslint.js';

// Copied from tasks.json, same as in lint-diagnostics.test.mjs, so a driver's
// real output is checked against the matcher rather than against our own idea
// of what it should look like.
const PROBLEM_PATTERN = /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.*?)(?:\s{2,}(\S+))?\s*$/;

function parseAsProblemMatcher(output) {
  return output
    .split('\n')
    .map(line => PROBLEM_PATTERN.exec(line))
    .filter(Boolean)
    .map(m => ({ line: Number(m[1]), severity: m[3], message: m[4], code: m[5] }));
}

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const biomePath = path.join(repoRoot, 'node_modules', '.bin', 'biome');

let dir;

before(async () => {
  // Realpath: on macOS os.tmpdir() is a symlink, and the drivers report
  // resolved paths.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'esp-driver-test-')));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** @returns {Promise<string>} absolute path to the written fixture */
async function fixture(name, contents) {
  const file = path.join(dir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}

const byLine = diagnostics => [...diagnostics].sort((a, b) => a.line - b.line);

/** Whether a bare command name resolves on PATH, so tests can skip rather than
 * assume the machine running them lacks a global install. */
function onPath(command) {
  return new Promise(resolve => {
    const probe = childProcess.spawn(command, ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', code => resolve(code === 0));
  });
}

describe('lint-driver-biome', () => {
  let projectDir;

  before(async () => {
    projectDir = path.join(dir, 'biome-project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'biome.json'),
      JSON.stringify({
        // Pin the formatter so a fixture's own quoting cannot produce an
        // incidental `format` diagnostic and make these assertions drift.
        formatter: { enabled: true, indentStyle: 'space', indentWidth: 2 },
        javascript: { formatter: { quoteStyle: 'single', semicolons: 'always' } },
        linter: {
          enabled: true,
          rules: {
            recommended: false,
            suspicious: { noDoubleEquals: 'error', noDebugger: 'warn' },
          },
        },
      }),
    );
  });

  const driver = () => createBiomeDriver({ biomePath, cwd: projectDir });

  it('normalizes severity, position and rule id from biome JSON', async () => {
    const file = await fixture(
      'biome-project/src/a.js',
      'const x = 1;\nif (x == 1) {\n  debugger;\n}\n',
    );
    const diagnostics = byLine(await driver().lint([file]));

    assert.deepEqual(diagnostics, [
      {
        filePath: file,
        line: 2,
        column: 7,
        severity: 'error',
        message: 'Using == may be unsafe if you are relying on type coercion.',
        ruleId: 'lint/suspicious/noDoubleEquals',
      },
      {
        filePath: file,
        line: 3,
        column: 3,
        severity: 'warning',
        message: 'This is an unexpected use of the debugger statement.',
        ruleId: 'lint/suspicious/noDebugger',
      },
    ]);
  });

  it('reports absolute paths even though biome is given a relative one', async () => {
    const file = await fixture('biome-project/src/rel.js', 'const y = 1;\nif (y == 1) {\n}\n');
    const [diagnostic] = await driver().lint(['src/rel.js']);

    assert.equal(diagnostic.filePath, file, 'resolved against cwd');
    assert.ok(path.isAbsolute(diagnostic.filePath));
  });

  it('clamps the 0:0 biome reports for whole-file problems', async () => {
    // Formatter diagnostics have no position. A 0 would put the squiggle
    // nowhere, since the problem matcher and editors are both 1-based.
    const file = await fixture('biome-project/src/fmt.js', 'const z    =    1;\n');
    const diagnostics = await driver().lint([file]);

    const format = diagnostics.find(d => d.ruleId === 'format');
    assert.ok(format, `expected a format diagnostic, got ${JSON.stringify(diagnostics)}`);
    assert.equal(format.line, 1);
    assert.equal(format.column, 1);
  });

  it('returns nothing for a clean file', async () => {
    const file = await fixture('biome-project/src/clean.js', 'const ok = 1;\n');
    assert.deepEqual(await driver().lint([file]), []);
  });

  it('renders biome’s empty-message diagnostic without losing the category', async () => {
    // Biome reports a file over files.maxSize with message:"" and no advices,
    // so the category is the only thing left to show. It must not end up in the
    // message column, or the matcher reads it as the message and drops the code.
    const projectRoot = path.join(dir, 'biome-maxsize');
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'biome.json'), '{"files":{"maxSize":16}}');
    const file = path.join(projectRoot, 'src', 'big.js');
    await fs.writeFile(file, 'export const someLongIdentifier = 1234567890;\n');

    const diagnostics = await createBiomeDriver({ biomePath, cwd: projectRoot }).lint([file]);
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.equal(diagnostics[0].message, '', 'biome really does give us nothing');

    const [parsed] = parseAsProblemMatcher(renderStylish(diagnostics, { color: false }));
    assert.equal(parsed.message, '(no message)');
    assert.equal(parsed.code, 'check');
  });

  it('maps every biome severity onto the three the matcher knows', async t => {
    // Biome will not emit `fatal` or `hint` on demand, so this drives the real
    // parsing path with a stub that prints the reporter's JSON shape. Folding
    // them into `warning` — the old fallback — let a fatal slip past
    // throwOnErrors and let a hint trip throwOnWarnings.
    if (process.platform === 'win32') {
      t.skip('stub executable is a POSIX shell script');
      return;
    }
    const severities = ['fatal', 'error', 'warning', 'information', 'info', 'hint', 'novel'];
    const report = {
      diagnostics: severities.map((severity, i) => ({
        severity,
        message: `${severity} diagnostic`,
        category: `lint/${severity}`,
        location: { path: 'src/a.js', start: { line: i + 1, column: 1 } },
      })),
    };
    const stub = path.join(dir, 'fake-biome.sh');
    await fs.writeFile(stub, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(report)}\nJSON\n`);
    await fs.chmod(stub, 0o755);

    const diagnostics = await createBiomeDriver({ biomePath: stub, cwd: projectDir }).lint(['x']);
    assert.deepEqual(Object.fromEntries(severities.map((s, i) => [s, diagnostics[i].severity])), {
      fatal: 'error',
      error: 'error',
      warning: 'warning',
      information: 'info',
      info: 'info',
      hint: 'info',
      novel: 'warning', // anything unrecognized stays a warning
    });
  });

  it('builds an onLoad filter Go can compile', async () => {
    const { filter } = await driver().init();
    // esbuild compiles onLoad filters with Go's regexp, which rejects the
    // `(?u)` a `u`-flagged RegExp translates to.
    assert.equal(filter.flags, '');
    assert.ok(filter.test('/p/a.ts'));
    assert.ok(!filter.test('/p/a.txt'));
  });

  it('names the configured path, without an install hint, when it cannot be run', async () => {
    // An explicit biomePath that is missing is a misconfiguration, not a
    // missing install, so telling the user to npm install would misdirect.
    const missing = createBiomeDriver({ biomePath: 'definitely-not-biome', cwd: projectDir });
    await assert.rejects(
      () => missing.lint(['a.js']),
      err => {
        assert.match(err.message, /could not run 'definitely-not-biome'/u);
        assert.doesNotMatch(err.message, /npm install/u);
        return true;
      },
    );
  });

  it('suggests installing the package when the PATH fallback cannot be run', async t => {
    // `biome` as the literal executable is the state resolveBiomePath lands in
    // when no local install was found anywhere up the tree.
    if (await onPath('biome')) {
      t.skip('biome is on PATH — the fallback-failure path cannot be exercised');
      return;
    }
    const fallback = createBiomeDriver({ biomePath: 'biome', cwd: projectDir });
    await assert.rejects(() => fallback.lint(['a.js']), /npm install --save-dev @biomejs\/biome/u);
  });

  it('fails loudly when the executable is not biome', async () => {
    const notBiome = createBiomeDriver({ biomePath: '/bin/echo', cwd: projectDir });
    await assert.rejects(() => notBiome.lint(['a.js']), /could not parse biome's JSON output/u);
  });

  it('surfaces biome’s own complaint instead of an install hint', async () => {
    // Regression: a failure biome reports only on stderr - a bad flag, or an
    // invalid biome.json - produced no stdout, which was read as "biome could
    // not run" and sent the user to reinstall a perfectly good install.
    const badArgs = createBiomeDriver({
      biomePath,
      cwd: projectDir,
      biomeArgs: ['--nonsense-flag'],
    });
    await assert.rejects(
      () => badArgs.lint(['a.js']),
      err => {
        // Assert the headline, not the whole message: biome's stderr is
        // appended either way, so matching anywhere would pass even when the
        // driver leads with "could not run biome".
        const [headline] = err.message.split('\n');
        assert.match(headline, /got no output from biome/u);
        assert.doesNotMatch(headline, /could not run|npm install/u);
        assert.match(err.message, /--nonsense-flag/u, "biome's own error is still shown");
        return true;
      },
    );
  });
});

describe('lint-driver-eslint', () => {
  let projectDir;

  before(async () => {
    projectDir = path.join(dir, 'eslint-project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'eslint.config.js'),
      'export default [{ rules: { eqeqeq: "error", "no-unused-vars": "warn" } }];\n',
    );
    await fs.writeFile(path.join(projectDir, 'package.json'), '{"type":"module"}\n');
  });

  // `resolvePluginsRelativeTo` is not needed, but cwd is: it is how ESLint
  // finds the fixture's flat config instead of the one in the process cwd.
  const driver = () => createEslintDriver({ cwd: projectDir });

  it('maps ESLint severity numbers and keeps the rule id', async () => {
    const file = await fixture(
      'eslint-project/src/a.js',
      'const unused = 2;\nexport const eq = (a, b) => a == b;\n',
    );
    const d = driver();
    await d.init();
    const diagnostics = byLine(await d.lint([file]));

    assert.deepEqual(
      diagnostics.map(({ filePath, line, severity, ruleId }) => ({
        filePath,
        line,
        severity,
        ruleId,
      })),
      [
        { filePath: file, line: 1, severity: 'warning', ruleId: 'no-unused-vars' },
        { filePath: file, line: 2, severity: 'error', ruleId: 'eqeqeq' },
      ],
    );
    assert.ok(diagnostics.every(x => path.isAbsolute(x.filePath) && x.column >= 1));
  });

  it('returns nothing for a clean file', async () => {
    const file = await fixture('eslint-project/src/clean.js', 'export const ok = 1;\n');
    const d = driver();
    await d.init();
    assert.deepEqual(await d.lint([file]), []);
  });

  it('builds the filter from the extensions the config actually covers', async () => {
    const { filter } = await driver().init();
    assert.equal(filter.flags, '', 'no `u` flag — esbuild compiles this with Go regexp');
    assert.ok(filter.test('/p/a.js'));
    assert.ok(filter.test('/p/a.mjs'));
    assert.ok(!filter.test('/p/a.txt'));
  });

  it('names the missing package when eslint cannot be imported', async t => {
    // Only meaningful when eslint really is absent; here it is a devDependency,
    // so assert the message exists rather than forcing a failed import.
    try {
      require.resolve('eslint');
    } catch {
      await assert.rejects(() => driver().init(), /npm install --save-dev eslint/u);
      return;
    }
    t.skip('eslint is installed — the missing-package path cannot be exercised');
  });
});
