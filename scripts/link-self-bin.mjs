#!/usr/bin/env node
// Dev-only: link this package's own bin into node_modules/.bin so the
// `esp-generate-dev-cert` invocation resolves while developing esp itself.
//
// npm only links a package's `bin` into node_modules/.bin when the package is
// installed as a *dependency* of another project — not within the package
// itself. This lets the repo's own `cert:dev` script use the same bin-name
// invocation that downstream consumers use, instead of a divergent
// `node ./scripts/...` path. Runs via the `prepare` lifecycle hook, which fires
// on local `npm install`/publish but never on a consumer's dependency install.
import { mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

try {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bin = pkg.bin ?? {};

  const binDir = path.join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });

  for (const [name, target] of Object.entries(bin)) {
    const linkPath = path.join(binDir, name);
    // Relative target keeps the link valid regardless of where the repo lives.
    const relativeTarget = path.relative(binDir, path.resolve(root, target));
    rmSync(linkPath, { force: true });
    symlinkSync(relativeTarget, linkPath);
  }
} catch (error) {
  // Never fail an install over this dev convenience (e.g. Windows symlink perms).
  console.warn(`link-self-bin: skipped (${error.message})`);
}
