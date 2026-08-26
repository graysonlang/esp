// All generated files are authored config once they exist: the scaffolder
// writes each only when missing and must never rewrite a project's edits,
// because MCP hosts may re-prompt for approval when a registration changes.
// The browser config is created only when at least one registration refers to
// it, so a project with its own registrations never acquires an unused file.
// These tests pin every half of that contract.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../scripts/sync-mcp.mjs', import.meta.url));
const BROWSER_CONFIG = 'playwright-mcp.config.json';
const CODEX_CONFIG = path.join('.codex', 'config.toml');

function runInTempProject(setup) {
  const root = mkdtempSync(path.join(tmpdir(), 'esp-sync-mcp-'));
  try {
    writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}\n');
    setup?.(root);
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const read = name => {
      const file = path.join(root, name);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    };
    return {
      browserConfig: read(BROWSER_CONFIG),
      codexConfig: read(CODEX_CONFIG),
      registration: read('.mcp.json'),
      result,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe('sync-mcp', () => {
  it('writes Playwright registrations and browser config when all are missing', () => {
    const { browserConfig, codexConfig, registration, result } = runInTempProject();
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(registration).mcpServers.playwright, {
      type: 'stdio',
      command: 'node',
      args: ['node_modules/@playwright/mcp/cli.js', '--config', BROWSER_CONFIG],
    });
    assert.deepEqual(JSON.parse(browserConfig), {
      browser: { isolated: true, launchOptions: { headless: true } },
    });
    assert.match(codexConfig, /^\[mcp_servers\.playwright\]\n/);
    assert.match(codexConfig, /command = "node"/);
    assert.match(codexConfig, /"node_modules\/@playwright\/mcp\/cli\.js"/);
    assert.match(codexConfig, /"playwright-mcp\.config\.json"/);
    assert.match(codexConfig, /startup_timeout_sec = 30/);
    assert.match(codexConfig, /tool_timeout_sec = 120/);
    assert.match(codexConfig, /default_tools_approval_mode = "approve"/);
    assert.doesNotMatch(codexConfig, /enabled\s*=/);
  });

  it('emits a layout that already satisfies a JSON format gate', () => {
    // Compact arrays and objects, two-space indent, trailing newline.
    const { browserConfig, codexConfig, registration } = runInTempProject();
    assert.match(
      registration,
      /"args": \["node_modules\/@playwright\/mcp\/cli\.js", "--config", "playwright-mcp\.config\.json"\]/,
    );
    assert.ok(registration.endsWith('}\n'));
    assert.match(browserConfig, /"launchOptions": \{ "headless": true \}/);
    assert.ok(browserConfig.endsWith('}\n'));
    assert.ok(codexConfig.endsWith('\n'));
  });

  it('warns about the missing @playwright/mcp pin without failing', () => {
    const { result } = runInTempProject();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /@playwright\/mcp is not installed/);
  });

  it('leaves existing registrations untouched and adds no unreferenced browser config', () => {
    const authoredRegistration =
      '{"mcpServers":{"custom":{"type":"stdio","command":"node","args":[]}}}\n';
    const authoredCodexConfig = '[mcp_servers.custom]\ncommand = "custom"\n';
    const { browserConfig, codexConfig, registration, result } = runInTempProject(root => {
      writeFileSync(path.join(root, '.mcp.json'), authoredRegistration);
      mkdirSync(path.join(root, '.codex'));
      writeFileSync(path.join(root, CODEX_CONFIG), authoredCodexConfig);
    });
    assert.equal(result.status, 0);
    assert.equal(registration, authoredRegistration);
    assert.equal(codexConfig, authoredCodexConfig);
    assert.equal(browserConfig, null);
  });

  it('supplies the browser config when an authored .mcp.json refers to it', () => {
    const authored = `{"mcpServers":{"playwright":{"type":"stdio","command":"node","args":["node_modules/@playwright/mcp/cli.js","--config","${BROWSER_CONFIG}"]}}}\n`;
    const { browserConfig, registration } = runInTempProject(root => {
      writeFileSync(path.join(root, '.mcp.json'), authored);
    });
    assert.equal(registration, authored);
    assert.deepEqual(JSON.parse(browserConfig).browser.launchOptions, { headless: true });
  });

  it('leaves an existing browser config untouched', () => {
    const authored = '{"browser":{"launchOptions":{"headless":false}}}\n';
    const { browserConfig, result } = runInTempProject(root => {
      writeFileSync(path.join(root, BROWSER_CONFIG), authored);
    });
    assert.equal(result.status, 0);
    assert.equal(browserConfig, authored);
  });

  it('leaves an existing Codex config untouched', () => {
    const authored = '[mcp_servers.playwright]\nenabled = true\n';
    const { codexConfig, result } = runInTempProject(root => {
      mkdirSync(path.join(root, '.codex'));
      writeFileSync(path.join(root, CODEX_CONFIG), authored);
    });
    assert.equal(result.status, 0);
    assert.equal(codexConfig, authored);
  });
});
