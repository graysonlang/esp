// Both generated files are authored config once they exist: the scaffolder
// writes each only when missing and must never rewrite a project's edits,
// because MCP hosts re-prompt for approval on every `.mcp.json` change. The
// browser config is created only when `.mcp.json` refers to it, so a project
// with its own registration never acquires an unused file. These tests pin
// every half of that contract.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../scripts/sync-mcp.mjs', import.meta.url));
const BROWSER_CONFIG = 'playwright-mcp.config.json';

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
    return { browserConfig: read(BROWSER_CONFIG), registration: read('.mcp.json'), result };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe('sync-mcp', () => {
  it('writes a Playwright registration and browser config when both are missing', () => {
    const { browserConfig, registration, result } = runInTempProject();
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(registration).mcpServers.playwright, {
      type: 'stdio',
      command: 'node',
      args: ['node_modules/@playwright/mcp/cli.js', '--config', BROWSER_CONFIG],
    });
    assert.deepEqual(JSON.parse(browserConfig), {
      browser: { isolated: true, launchOptions: { headless: true } },
    });
  });

  it('emits a layout that already satisfies a JSON format gate', () => {
    // Compact arrays and objects, two-space indent, trailing newline.
    const { browserConfig, registration } = runInTempProject();
    assert.match(
      registration,
      /"args": \["node_modules\/@playwright\/mcp\/cli\.js", "--config", "playwright-mcp\.config\.json"\]/,
    );
    assert.ok(registration.endsWith('}\n'));
    assert.match(browserConfig, /"launchOptions": \{ "headless": true \}/);
    assert.ok(browserConfig.endsWith('}\n'));
  });

  it('warns about the missing @playwright/mcp pin without failing', () => {
    const { result } = runInTempProject();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /@playwright\/mcp is not installed/);
  });

  it('leaves an existing .mcp.json untouched and adds no unreferenced config', () => {
    const authored = '{"mcpServers":{"custom":{"type":"stdio","command":"node","args":[]}}}\n';
    const { browserConfig, registration, result } = runInTempProject(root => {
      writeFileSync(path.join(root, '.mcp.json'), authored);
    });
    assert.equal(result.status, 0);
    assert.equal(registration, authored);
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
});
