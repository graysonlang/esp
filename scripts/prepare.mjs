#!/usr/bin/env node
// esp imports its own runner by relative path. Consumers use the package
// subpath behind a guarded dynamic import — see the README.
import { runPrepareSteps } from '../src/prepare.js';

runPrepareSteps([
  {
    label: 'link self bin',
    args: ['./scripts/link-self-bin.mjs'],
  },
  {
    label: 'sync launch.json',
    args: ['./scripts/build.mjs', '--sync-launch'],
  },
]);
