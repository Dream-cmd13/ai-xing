import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('CentOS 7 systemd template continuously recovers with bounded restart pressure', async () => {
  const unit = await readFile(path.join(projectRoot, 'deploy', 'systemd', 'ai-xing-mcp.service.example'), 'utf8');
  assert.match(unit, /^StartLimitInterval=60$/m);
  assert.match(unit, /^StartLimitBurst=10$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=5s$/m);
  assert.match(unit, /^LimitNOFILE=65536$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/ai-xing\/mcp-server\/src\/index\.mjs$/m);
  assert.doesNotMatch(unit, /^Restart=on-failure$/m);
});

test('production environment example fixes loopback, readiness and trusted proxy boundaries', async () => {
  const example = await readFile(path.join(projectRoot, 'mcp-server', '.env.example'), 'utf8');
  assert.match(example, /^NODE_ENV=production$/m);
  assert.match(example, /^MCP_HOST=127\.0\.0\.1$/m);
  assert.match(example, /^MCP_ALLOW_NON_LOOPBACK=false$/m);
  assert.match(example, /^MCP_READINESS_TTL_MS=5000$/m);
  assert.match(example, /^MCP_TRUSTED_PROXY_ADDRESSES=127\.0\.0\.1,::1,::ffff:127\.0\.0\.1$/m);
  assert.match(example, /^MCP_ALLOWED_HOSTS=your-mcp-domain\.example\.com,127\.0\.0\.1,localhost$/m);
  assert.match(example, /^MCP_REQUIRE_HTTPS=true$/m);
  assert.doesNotMatch(example, /(?:SERVICE_ROLE|SECRET_KEY|DATABASE_URL|PASSWORD)=\S+/i);
});
