// These tests drive the plugin through a real esbuild build with a stub driver,
// so they assert the thing that actually broke - which files the plugin hands a
// linter - without needing biome or eslint installed.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import esbuild from 'esbuild';
import createPlugin, { defaultIgnore } from '../src/esbuild-plugin-lint.js';

/**
 * A driver that records what it was asked to lint. `diagnose` decides which of
 * those files report a problem, which is what puts them in the plugin's re-lint
 * set on subsequent builds.
 * @param {(files: string[]) => string[]} [diagnose]
 */
function createRecordingDriver(diagnose = () => []) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    driver: {
      name: 'recording',
      async init() {
        // No `u` flag: esbuild compiles onLoad filters with Go's regexp, which
        // rejects the `(?u)` it would translate to. Both real drivers build
        // their filters unflagged for the same reason.
        return { filter: /\.m?js$/ };
      },
      async lint(files) {
        calls.push([...files].sort());
        return diagnose(files).map(filePath => ({
          filePath,
          line: 1,
          column: 1,
          severity: 'error',
          message: 'problem',
        }));
      },
    },
  };
}

let dir;

before(async () => {
  // Realpath it: on macOS os.tmpdir() is /var/..., a symlink to /private/var,
  // and esbuild reports resolved paths - so the raw temp path would never match
  // what the driver is handed.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'esp-lint-test-')));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'node_modules', 'dep', 'package.json'),
    '{"name":"dep","version":"1.0.0","main":"index.js"}\n',
  );
  await fs.writeFile(
    path.join(dir, 'node_modules', 'dep', 'index.js'),
    'export const helper = () => 1;\n',
  );
  await fs.writeFile(
    path.join(dir, 'src', 'entry.js'),
    "import { helper } from 'dep';\nexport default helper();\n",
  );
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** @returns {Promise<string[][]>} the file lists the driver was handed */
async function buildWith(pluginOptions) {
  const { calls, driver } = createRecordingDriver();
  await esbuild.build({
    entryPoints: [path.join(dir, 'src', 'entry.js')],
    bundle: true,
    write: false,
    absWorkingDir: dir,
    plugins: [createPlugin({ driver, ...pluginOptions })],
  });
  return calls;
}

/** A rebuildable context over `entry`, plus the driver's call log. */
async function watchWith(entry, diagnose) {
  const { calls, driver } = createRecordingDriver(diagnose);
  const ctx = await esbuild.context({
    entryPoints: [entry],
    bundle: true,
    write: false,
    absWorkingDir: dir,
    plugins: [createPlugin({ driver })],
  });
  return { calls, ctx };
}

describe('esbuild-plugin-lint file selection', () => {
  it('does not hand dependencies to the linter', async () => {
    // Regression: without this, biome reports internalError/fs ("does not exist
    // in the workspace") against every bundled dependency module, which fails
    // the build outright under throwOnErrors.
    const calls = await buildWith({});
    assert.equal(calls.length, 1, 'linted once');
    assert.deepEqual(calls[0], [path.join(dir, 'src', 'entry.js')]);
  });

  it('lints dependencies when the ignore is disabled', async () => {
    // Proves the exclusion is the ignore doing its job, not the filter or the
    // bundler quietly declining to load the dependency.
    const calls = await buildWith({ ignore: null });
    assert.deepEqual(calls[0], [
      path.join(dir, 'node_modules', 'dep', 'index.js'),
      path.join(dir, 'src', 'entry.js'),
    ]);
  });

  it('skips linting entirely when every loaded file is ignored', async () => {
    const calls = await buildWith({ ignore: /\.js$/ });
    assert.deepEqual(calls, [], 'driver.lint is never called');
  });

  it('ignores consistently when the pattern carries a stateful flag', async () => {
    // RegExp.test resumes from lastIndex when the pattern has `g` or `y`, so
    // testing a series of paths alternates between matching and not. Untreated,
    // a /node_modules/g here would let every second dependency through — which
    // needs more than one dependency file to show up at all.
    const root = path.join(dir, 'statefulflag');
    await fs.mkdir(path.join(root, 'node_modules', 'multi'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'node_modules', 'multi', 'package.json'),
      '{"name":"multi","version":"1.0.0","main":"a.js"}\n',
    );
    for (const [file, contents] of [
      ['a.js', "import './b.js';\nexport const a = 1;\n"],
      ['b.js', "import './c.js';\nexport const b = 1;\n"],
      ['c.js', "import './d.js';\nexport const c = 1;\n"],
      ['d.js', 'export const d = 1;\n'],
    ]) {
      await fs.writeFile(path.join(root, 'node_modules', 'multi', file), contents);
    }
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const entry = path.join(root, 'src', 'entry.js');
    await fs.writeFile(entry, "import 'multi';\nexport default 1;\n");

    const { calls, driver } = createRecordingDriver();
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      absWorkingDir: root,
      plugins: [createPlugin({ driver, ignore: /[\\/]node_modules[\\/]/gu })],
    });

    assert.deepEqual(calls[0], [entry], `dependencies leaked through: ${JSON.stringify(calls)}`);
  });
});

describe('esbuild-plugin-lint across rebuilds', () => {
  /** A watch-mode fixture with its own entry, isolated per test. */
  async function scenario(name, files) {
    const root = path.join(dir, name);
    await fs.mkdir(root, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(root, file), contents);
    }
    return root;
  }

  it('stops linting a file that was deleted after reporting a problem', async () => {
    // Regression: the deleted file stayed in the re-lint set forever, so every
    // later rebuild handed the linter a path that no longer existed. ESLint
    // treats that as fatal ("No files matching ... were found") and throws out
    // of onEnd, breaking watch mode until the process restarts.
    const root = await scenario('deleted', {
      'entry.js': "import './doomed.js';\nexport const a = 1;\n",
      'doomed.js': 'export const b = 1;\n',
    });
    const doomed = path.join(root, 'doomed.js');
    const { calls, ctx } = await watchWith(path.join(root, 'entry.js'), files =>
      files.filter(f => f === doomed),
    );

    await ctx.rebuild();
    assert.ok(calls[0].includes(doomed), 'doomed.js linted and reported a problem');

    await fs.rm(doomed);
    await fs.writeFile(path.join(root, 'entry.js'), 'export const a = 1;\n');

    await ctx.rebuild();
    await ctx.rebuild();
    await ctx.dispose();

    const afterDelete = calls.slice(1).flat();
    assert.ok(
      !afterDelete.includes(doomed),
      `deleted file was still linted: ${JSON.stringify(calls.slice(1))}`,
    );
  });

  it('stops linting a file that is no longer imported, even when it changes', async () => {
    // The set of loaded files is rebuilt per build rather than accumulated, so
    // dropping an import drops the file. esbuild re-runs onLoad over the whole
    // graph every rebuild, which is what makes that safe.
    //
    // Editing the dropped file afterwards is the part that matters: an
    // accumulated set would still hold it, see the content change, and lint a
    // file this build never loaded. Leaving it untouched proves nothing, since
    // an unchanged file is skipped either way.
    const root = await scenario('dropped', {
      'entry.js': "import './leaf.js';\nexport const a = 1;\n",
      'leaf.js': 'export const b = 1;\n',
    });
    const leaf = path.join(root, 'leaf.js');
    const { calls, ctx } = await watchWith(path.join(root, 'entry.js'));

    await ctx.rebuild();
    assert.ok(calls[0].includes(leaf), 'leaf.js linted while imported');

    // Still on disk — only the import goes away.
    await fs.writeFile(path.join(root, 'entry.js'), 'export const a = 2;\n');
    await ctx.rebuild();

    await fs.writeFile(leaf, 'export const b = 2;\n');
    await ctx.rebuild();
    await ctx.dispose();

    assert.ok(
      !calls.slice(1).flat().includes(leaf),
      `unimported file was still linted: ${JSON.stringify(calls.slice(1))}`,
    );
  });
});

describe('defaultIgnore', () => {
  it('matches nested and scoped dependency paths on both path separators', () => {
    for (const p of [
      '/proj/node_modules/dep/index.js',
      '/proj/node_modules/@scope/dep/index.js',
      '/proj/packages/a/node_modules/dep/index.js',
      'C:\\proj\\node_modules\\dep\\index.js',
    ]) {
      assert.ok(defaultIgnore.test(p), `expected to ignore ${p}`);
    }
  });

  it('does not match project source that merely mentions the name', () => {
    // A workspace package resolves through a symlink, but esbuild reports the
    // real path, so linked source under packages/ must still be linted.
    for (const p of [
      '/proj/src/node_modules_helper.js',
      '/proj/packages/node_modules_shim/index.js',
      '/proj/packages/a/src/index.js',
    ]) {
      assert.ok(!defaultIgnore.test(p), `expected to lint ${p}`);
    }
  });
});
