// Freshness decides what incremental work happens, so a failure here is silent
// by nature: nothing errors, work just quietly stops being done.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import Freshness, { computeFileHash, computeFileHashes } from '../src/freshness.js';

let dir;

before(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'esp-freshness-test-')));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** @returns {Promise<string>} */
async function write(name, contents) {
  const file = path.join(dir, name);
  await fs.writeFile(file, contents);
  return file;
}

describe('Freshness.update', () => {
  it('keeps tracking the rest of the set when one file has vanished', async () => {
    // Regression: one try wrapped the whole loop, so the first ENOENT aborted
    // it and every file after the missing one stopped being hashed. Nothing
    // failed — incremental work just stopped happening for the rest of the
    // session.
    const a = await write('a.js', 'a1');
    const gone = await write('gone.js', 'g1');
    const z = await write('z.js', 'z1');

    const freshness = new Freshness();
    await freshness.update(new Set([a, gone, z]));

    await fs.rm(gone);
    await fs.writeFile(z, 'z2');

    const { changed, removed } = await freshness.update(new Set([a, gone, z]));

    assert.ok(removed.has(gone), 'the vanished file is reported as removed');
    assert.ok(changed.has(z), 'a file after the vanished one is still detected as changed');
    assert.ok(!changed.has(a), 'an untouched file is not reported as changed');
  });

  it('forgets a vanished file, so it is not re-reported on the next pass', async () => {
    const a = await write('b.js', 'b1');
    const gone = await write('gone2.js', 'g1');

    const freshness = new Freshness();
    await freshness.update(new Set([a, gone]));
    await fs.rm(gone);

    const first = await freshness.update(new Set([a, gone]));
    assert.ok(first.removed.has(gone));

    // Callers drop removed files from their own sets; a caller that does not
    // must still not see it reported as changed.
    const second = await freshness.update(new Set([a]));
    assert.equal(second.changed.size, 0);
    assert.equal(second.removed.size, 0);
  });

  it('reports files dropped from the set as removed', async () => {
    const a = await write('c.js', 'c1');
    const b = await write('d.js', 'd1');

    const freshness = new Freshness();
    await freshness.update(new Set([a, b]));

    const { removed } = await freshness.update(new Set([a]));
    assert.deepEqual([...removed], [b]);
  });
});

describe('hash helpers', () => {
  it('allow the requested algorithm to be passed as the second argument', async () => {
    const file = await write('hash.txt', 'contents');

    const hash = await computeFileHash(file, 'sha256');
    const hashes = await computeFileHashes([file], 'sha256');

    assert.equal(hash.length, 64);
    assert.equal(hashes.get(file).length, 64);
  });
});
