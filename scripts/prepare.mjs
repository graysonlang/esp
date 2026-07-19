#!/usr/bin/env node
// Runs the repo's `prepare` steps — dev conveniences only (self bin symlink,
// launch.json render) — and always exits 0.
//
// `prepare` fires on local `npm install`/publish, and also when a consumer
// installs esp as a *git* dependency (npm builds those from a temp clone).
// None of these steps are worth failing an install over, in any of those
// contexts — and each child process is a boundary, so even a step that dies
// on import (e.g. esbuild's platform binary missing in a consumer's temp
// build) is contained here instead of aborting the consumer's install.
// Failures are reported as warnings; a broken step surfaces the next time the
// build is run directly.
import { spawnSync } from 'node:child_process';

const steps = [
  ['./scripts/link-self-bin.mjs'],
  ['./scripts/build.mjs', '--sync-launch'],
];

for (const step of steps) {
  try {
    const result = spawnSync(process.execPath, step, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`prepare: ${step.join(' ')} exited with ${result.status ?? result.signal ?? result.error?.message}`);
    }
  } catch (error) {
    console.warn(`prepare: ${step.join(' ')} skipped (${error.message})`);
  }
}
