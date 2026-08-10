import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import * as esbuild from 'esbuild';

import createPlugin from '../src/esbuild-plugin-emcc.js';

let dir;

before(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'esp-emcc-test-')));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readEvents(logFile) {
  const contents = await fs.readFile(logFile, 'utf8');
  return contents.trim().split('\n').filter(Boolean);
}

function count(events, expected) {
  return events.filter(event => event === expected).length;
}

describe('esbuild-plugin-emcc', () => {
  it('persists dependency hashes across independent esbuild invocations', {
    skip: process.platform === 'win32',
  }, async context => {
    const consoleLog = context.mock.method(console, 'log', () => {});
    const progressLogCount = () =>
      consoleLog.mock.calls.filter(call =>
        call.arguments[0]?.includes('Compiling WebAssembly payload'),
      ).length;
    const cacheDirectory = path.join(dir, 'cache');
    const logFile = path.join(dir, 'emcc.log');
    const fakeEmcc = path.join(dir, 'fake-emcc.mjs');
    const source = path.join(dir, 'runtime.c');

    const fakeCompilerSource = [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `const logFile = ${JSON.stringify(logFile)};`,
      'const args = process.argv.slice(2);',
      "const record = event => fs.appendFileSync(logFile, event + '\\n');",
      "if (args.includes('--version')) {",
      "  record('version');",
      "  console.log('fake emcc 1.0');",
      '  process.exit(0);',
      '}',
      "if (args.includes('-MM')) {",
      "  record('dependencies');",
      "  const source = args[args.indexOf('-MM') + 1];",
      "  const target = args.find(arg => arg.startsWith('-MT')).slice(3);",
      "  process.stdout.write(target + ': ' + source + '\\n' + source + ':\\n');",
      '  process.exit(0);',
      '}',
      "record('compile');",
      "const output = path.resolve(args[args.indexOf('-o') + 1]);",
      'fs.mkdirSync(path.dirname(output), { recursive: true });',
      "fs.writeFileSync(output, 'export default async function createModule() { return {}; }\\n');",
      "if (!args.includes('-sSINGLE_FILE=1')) {",
      "  fs.writeFileSync(output.replace(/\\.mjs$/u, '.wasm'), new Uint8Array());",
      '}',
    ].join('\n');

    await fs.writeFile(fakeEmcc, fakeCompilerSource, { mode: 0o755 });
    await fs.writeFile(logFile, '');
    await fs.writeFile(source, 'int answer() { return 42; }\n');
    await fs.writeFile(
      path.join(dir, 'entry.js'),
      "import createModule from './runtime.c';\nexport default createModule;\n",
    );

    const build = emccOptions =>
      esbuild.build({
        absWorkingDir: dir,
        entryPoints: ['entry.js'],
        bundle: true,
        format: 'esm',
        logLevel: 'silent',
        outdir: 'www',
        plugins: [createPlugin({ cacheDirectory, emccOptions, emccPath: fakeEmcc })],
      });

    await build([]);
    let events = await readEvents(logFile);
    assert.equal(count(events, 'dependencies'), 1);
    assert.equal(count(events, 'compile'), 1);
    assert.equal((await fs.readdir(cacheDirectory)).length, 1);
    assert.equal(progressLogCount(), 1, 'a cold build reports WebAssembly progress');

    await build([]);
    events = await readEvents(logFile);
    assert.equal(count(events, 'dependencies'), 1, 'a cache hit skips emcc -MM');
    assert.equal(count(events, 'compile'), 1, 'a cache hit skips compilation');
    assert.equal(progressLogCount(), 1, 'a warm build does not report compilation');

    await fs.writeFile(source, 'int answer() { return 43; }\n');
    const future = new Date(Date.now() + 2_000);
    await fs.utimes(source, future, future);
    await build([]);
    events = await readEvents(logFile);
    assert.equal(count(events, 'dependencies'), 2);
    assert.equal(count(events, 'compile'), 2);
    assert.equal(progressLogCount(), 2, 'a changed source reports compilation');

    await build(['-O3']);
    events = await readEvents(logFile);
    assert.equal(count(events, 'dependencies'), 3, 'changed options invalidate the cache');
    assert.equal(count(events, 'compile'), 3, 'changed options trigger compilation');
    assert.equal(progressLogCount(), 3, 'changed options report compilation');
  });
});
