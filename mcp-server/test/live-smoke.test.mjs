import test from 'node:test';
import assert from 'node:assert/strict';

import { loadLiveSmokeConfig } from '../scripts/live-smoke.mjs';

test('requires an explicit URL, username and password for live tests', () => {
  assert.throws(() => loadLiveSmokeConfig({}), /MCP_TEST_URL/);
  assert.throws(() => loadLiveSmokeConfig({ MCP_TEST_URL: 'https:\/\/okr.example.com\/mcp' }), /MCP_TEST_USERNAME/);
  assert.throws(() => loadLiveSmokeConfig({
    MCP_TEST_URL: 'https://okr.example.com/mcp', MCP_TEST_USERNAME: 'alice',
  }), /MCP_TEST_PASSWORD/);
});

test('requires HTTPS except for loopback development URLs', () => {
  const credentials = { MCP_TEST_USERNAME: 'alice', MCP_TEST_PASSWORD: 'secret' };
  assert.throws(() => loadLiveSmokeConfig({
    ...credentials, MCP_TEST_URL: 'http://okr.example.com/mcp',
  }), /HTTPS/);
  assert.doesNotThrow(() => loadLiveSmokeConfig({
    ...credentials, MCP_TEST_URL: 'http://127.0.0.1:8787/mcp',
  }));
});

test('builds the Basic header without retaining the clear-text password in the result', () => {
  const result = loadLiveSmokeConfig({
    MCP_TEST_URL: 'https://okr.example.com/mcp',
    MCP_TEST_USERNAME: 'Alice',
    MCP_TEST_PASSWORD: 'p:a:ss',
  });

  assert.equal(result.url.href, 'https://okr.example.com/mcp');
  assert.equal(result.authorization, `Basic ${Buffer.from('Alice:p:a:ss').toString('base64')}`);
  assert.equal('password' in result, false);
});
