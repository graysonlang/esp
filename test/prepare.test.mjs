// The contract here is "never fail the install". `prepare` fires during a
// consumer's git-dependency install too, so a step that dies must not take
// somebody else's `npm install` down with it — these tests pin that, since the
// failure mode is invisible until it happens to someone else.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPrepareSteps } from '../src/prepare.js';

/** Collects warnings instead of printing them. */
function recorder() {
  const warnings = [];
  return { warnings, logger: { warn: message => warnings.push(message) } };
}

const ok = label => ({ label, args: ['-e', 'process.exit(0)'] });
const fails = (label, code = 1) => ({ label, args: ['-e', `process.exit(${code})`] });

describe('runPrepareSteps', () => {
  it('defaults to the running Node, so steps need no command', () => {
    const { logger } = recorder();
    const result = runPrepareSteps([ok('a')], { logger });
    assert.deepEqual(result, { completed: ['a'], warned: [] });
  });

  it('warns on a failing step instead of throwing', () => {
    const { warnings, logger } = recorder();
    const result = runPrepareSteps([fails('boom', 3)], { logger });
    assert.deepEqual(result, { completed: [], warned: ['boom'] });
    assert.match(warnings[0], /prepare: boom exited with 3/u);
  });

  it('keeps going after a failure, so later steps still run', () => {
    // The reason this exists: `a && b` in package.json silently skips b.
    const { warnings, logger } = recorder();
    const result = runPrepareSteps([fails('first'), ok('second')], { logger });
    assert.deepEqual(result.completed, ['second']);
    assert.deepEqual(result.warned, ['first']);
    assert.equal(warnings.length, 1);
  });

  it('warns rather than throwing when the executable does not exist', () => {
    const { warnings, logger } = recorder();
    const result = runPrepareSteps([{ label: 'missing', command: 'definitely-not-a-binary' }], {
      logger,
    });
    assert.deepEqual(result.warned, ['missing']);
    assert.match(warnings[0], /prepare: missing skipped/u);
  });

  it('runs steps in the order given', () => {
    const { logger } = recorder();
    const result = runPrepareSteps([ok('one'), ok('two'), ok('three')], { logger });
    assert.deepEqual(result.completed, ['one', 'two', 'three']);
  });

  it('appends a step’s hint to its warning, so the message says how to recover', () => {
    // For a load-bearing step — one whose output a git install has no other way
    // to get — "it failed" is not enough; the warning has to say what to run.
    const { warnings, logger } = recorder();
    runPrepareSteps([{ ...fails('build board'), hint: 'Run `npm run dist` to fix it.' }], {
      logger,
    });
    assert.match(warnings[0], /prepare: build board exited with 1\n {2}Run `npm run dist`/u);
  });

  it('omits the hint line entirely when a step has none', () => {
    const { warnings, logger } = recorder();
    runPrepareSteps([fails('plain')], { logger });
    assert.equal(warnings[0].includes('\n'), false);
  });

  it('accepts an empty list', () => {
    assert.deepEqual(runPrepareSteps([]), { completed: [], warned: [] });
  });

  it('rejects malformed input loudly, since that is an authoring bug', () => {
    // A step with no label would produce unattributable warnings, and a
    // non-array is a typo — neither is a runtime condition to be tolerated.
    assert.throws(() => runPrepareSteps(null), TypeError);
    assert.throws(() => runPrepareSteps([{ args: ['-e', ''] }]), TypeError);
  });
});
