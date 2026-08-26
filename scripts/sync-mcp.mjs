#!/usr/bin/env node
// Scaffold project-local Playwright MCP registrations so coding agents get
// browser automation without per-machine setup: the config is versioned with
// the repo, and each agent's session picks it up after the usual one-time
// approval.
//
// Claude-compatible hosts read `.mcp.json`, while Codex reads
// `.codex/config.toml`. Both registrations only say "run the project's pinned
// Playwright MCP with the project's config", so they remain stable and are
// approved once. Browser policy - headless or headed, isolated or persistent
// profile, browser choice, viewport, a CDP endpoint - lives in
// `playwright-mcp.config.json`, which the host repo edits to taste without
// touching either registration or re-approving the server. The starter config
// runs headless and isolated so automation never raises a window over the
// owner's work and every run starts from the same blank browser state.
//
// The contract mirrors `--sync-launch`'s spirit but not its mechanics: launch
// configs are regenerated from a template because they embed derived values,
// while all three files here are plain authored config a project may extend.
// So each is written only when it does not exist and never rewritten - edits
// belong to the project, and agent hosts may prompt for re-approval when a
// registration changes, which repeated regeneration would turn into noise.
// The browser config is only created when either registration refers to it, so
// a project that authored both registrations does not acquire an unused file.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const registrationPath = path.join(projectRoot, '.mcp.json');
const CODEX_CONFIG_NAME = path.join('.codex', 'config.toml');
const codexConfigPath = path.join(projectRoot, CODEX_CONFIG_NAME);
const BROWSER_CONFIG_NAME = 'playwright-mcp.config.json';
const browserConfigPath = path.join(projectRoot, BROWSER_CONFIG_NAME);

// Written as literals rather than JSON.stringify output so the emitted files
// already match the compact layout JSON formatters settle on - scaffolding
// must not leave a consumer's format gate failing.
const GENERATED_REGISTRATION = `{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "node",
      "args": ["node_modules/@playwright/mcp/cli.js", "--config", "${BROWSER_CONFIG_NAME}"]
    }
  }
}
`;

const GENERATED_CODEX_CONFIG = `[mcp_servers.playwright]
command = "node"
args = [
  "node_modules/@playwright/mcp/cli.js",
  "--config",
  "${BROWSER_CONFIG_NAME}",
]
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "approve"
`;

const GENERATED_BROWSER_CONFIG = `{
  "browser": {
    "isolated": true,
    "launchOptions": { "headless": true }
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
  let wrote = false;
  if (!existsSync(registrationPath)) {
    writeFileSync(registrationPath, GENERATED_REGISTRATION);
    console.log('sync-mcp: wrote .mcp.json with a Playwright browser server');
    wrote = true;
  }
  if (!existsSync(codexConfigPath)) {
    mkdirSync(path.dirname(codexConfigPath), { recursive: true });
    writeFileSync(codexConfigPath, GENERATED_CODEX_CONFIG);
    console.log(`sync-mcp: wrote ${CODEX_CONFIG_NAME} with a Playwright browser server`);
    wrote = true;
  }
  const registration = readFileSync(registrationPath, 'utf8');
  const codexConfig = readFileSync(codexConfigPath, 'utf8');
  if (
    (registration.includes(BROWSER_CONFIG_NAME) || codexConfig.includes(BROWSER_CONFIG_NAME)) &&
    !existsSync(browserConfigPath)
  ) {
    writeFileSync(browserConfigPath, GENERATED_BROWSER_CONFIG);
    console.log(`sync-mcp: wrote ${BROWSER_CONFIG_NAME} (headless, isolated)`);
    wrote = true;
  }
  if (wrote && !playwrightMcpResolvable()) {
    console.warn(
      'sync-mcp: @playwright/mcp is not installed; the server stays inert until you `npm install --save-dev --save-exact @playwright/mcp`',
    );
  }
} catch (error) {
  console.warn(`sync-mcp: skipped (${error instanceof Error ? error.message : String(error)})`);
}
