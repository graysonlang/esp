#!/usr/bin/env node
// Scaffold a project's `.mcp.json` so MCP-aware coding agents (Claude Code and
// friends) get a Playwright browser-automation server without per-machine
// setup: the config is versioned with the repo, and the agent's session picks
// it up after the usual one-time approval.
//
// The contract mirrors `--sync-launch`'s spirit but not its mechanics: launch
// configs are regenerated from a template because they embed derived values,
// while `.mcp.json` is plain authored config a project may extend with other
// servers. So this writes the file only when it does not exist and never
// rewrites one that does — edits belong to the project, and agent hosts prompt
// for re-approval on every content change, which repeated regeneration would
// turn into noise.
//
// esp deliberately has no runtime dependencies, so the server itself is not
// bundled here. The generated entry runs the *project's* own `@playwright/mcp`
// by invoking its cli directly with node: the version is whatever the consumer
// pins in devDependencies, and a missing pin fails loudly at session start
// instead of silently floating to latest. A bare `npx` runner is deliberately
// avoided - it can intercept flags meant for the server, and its registry
// fallback would fetch an unpinned version when the local install is missing.
//
// Run it as a prepare step; like every prepare step, a failure here must never
// take an install down, so anything unexpected warns and exits 0.
//
//   runPrepareSteps([
//     { label: 'sync .mcp.json', args: ['./node_modules/@graysonlang/esp/scripts/sync-mcp.mjs'] },
//   ]);

import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const configPath = path.join(projectRoot, '.mcp.json');

// Written as a literal rather than JSON.stringify output so the emitted file
// already matches the compact-array layout JSON formatters settle on -
// scaffolding must not leave a consumer's format gate failing.
const GENERATED_CONFIG = `{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "node",
      "args": ["node_modules/@playwright/mcp/cli.js", "--isolated"]
    }
  }
}
`;

function playwrightMcpResolvable() {
  try {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    require.resolve('@playwright/mcp/package.json');
    return true;
  } catch {
    // Package exports may hide package.json; fall back to the direct path.
    return existsSync(path.join(projectRoot, 'node_modules', '@playwright', 'mcp', 'package.json'));
  }
}

try {
  if (existsSync(configPath)) {
    process.exit(0);
  }
  writeFileSync(configPath, GENERATED_CONFIG);
  console.log('sync-mcp: wrote .mcp.json with a Playwright browser server');
  if (!playwrightMcpResolvable()) {
    console.warn(
      'sync-mcp: @playwright/mcp is not installed; the server stays inert until you `npm install --save-dev --save-exact @playwright/mcp`',
    );
  }
} catch (error) {
  console.warn(`sync-mcp: skipped (${error instanceof Error ? error.message : String(error)})`);
}
