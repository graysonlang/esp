#!/usr/bin/env node
// This repo's `prepare` steps — dev conveniences only, and never worth failing
// an install over. The runner lives in src/prepare.js; this file is just the
// list. See that module for why every step is its own child process and every
// failure is a warning.
//
// esp imports its own copy by relative path. A consumer would use the package
// subpath instead, guarded, because `prepare` still runs under
// `npm install --omit=dev` where esp is not installed:
//
//   try {
//     const { runPrepareSteps } = await import('@graysonlang/esp/prepare');
//     runPrepareSteps(steps);
//   } catch (error) {
//     console.warn(`prepare: skipped (${error.message})`);
//   }

import { runPrepareSteps } from '../src/prepare.js';

runPrepareSteps([
  // Symlink esp's own bin so `esp-generate-dev-cert` resolves in this checkout.
  { label: 'link self bin', args: ['./scripts/link-self-bin.mjs'] },
  // Render .vscode/launch.json from its template, with this checkout's ports.
  { label: 'sync launch.json', args: ['./scripts/build.mjs', '--sync-launch'] },
]);
