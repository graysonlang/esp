// `.mcp.json` is authored config once it exists: the scaffolder writes it only
// when missing and must never rewrite a project's edits, because MCP hosts
// re-prompt for approval on every content change. These tests pin both halves
// of that contract.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../scripts/sync-mcp.mjs', import.meta.url));

function runInTempProject(setup) {
  const root = mkdtempSync(path.join(tmpdir(), 'esp-sync-mcp-'));
  try {
    writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}\n');
    setup?.(root);
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const configPath = path.join(root, '.mcp.json');
    const config = readFileSync(configPath, 'utf8');
    return { config, result };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe('sync-mcp', () => {
  it('writes a Playwright server entry when .mcp.json is missing', () => {
    const { config, result } = runInTempProject();
    assert.equal(result.status, 0);
    const parsed = JSON.parse(config);
    assert.deepEqual(parsed.mcpServers.playwright, {
      type: 'stdio',
      command: 'node',
      args: ['node_modules/@playwright/mcp/cli.js', '--isolated'],
    });
    // The emitted layout must already satisfy a consumer's JSON format gate:
    // compact arrays, two-space indent, trailing newline.
    assert.match(config, /"args": \["node_modules\/@playwright\/mcp\/cli\.js", "--isolated"\]/);
    assert.ok(config.endsWith('}\n'));
  });

  it('warns about the missing @playwright/mcp pin without failing', () => {
    const { result } = runInTempProject();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /@playwright\/mcp is not installed/);
  });

  it('leaves an existing .mcp.json untouched', () => {
    const authored = '{"mcpServers":{"custom":{"type":"stdio","command":"node","args":[]}}}\n';
    const { config, result } = runInTempProject(root => {
      writeFileSync(path.join(root, '.mcp.json'), authored);
    });
    assert.equal(result.status, 0);
    assert.equal(config, authored);
  });
});
