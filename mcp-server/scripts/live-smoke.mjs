import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const EXPECTED_TOOLS = [
  'get_organization_info',
  'get_department_weekly_pad',
  'search_pad_tasks',
  'get_personal_workbench',
  'get_process_sipoc',
];

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value) throw new Error(`缺少 ${name}`);
  return value;
}

export function loadLiveSmokeConfig(env = process.env) {
  const url = new URL(required(env, 'MCP_TEST_URL'));
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) {
    throw new Error('真实 MCP 测试必须使用 HTTPS；只有本机回环地址允许 HTTP');
  }
  const username = required(env, 'MCP_TEST_USERNAME');
  const password = required(env, 'MCP_TEST_PASSWORD');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  return Object.freeze({ url, authorization });
}

export async function runLiveSmoke(config) {
  const transport = new StreamableHTTPClientTransport(config.url, {
    requestInit: { headers: { Authorization: config.authorization } },
  });
  const client = new Client({ name: 'ai-xing-phase-one-live-smoke', version: '0.1.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const expected of EXPECTED_TOOLS) {
      if (!names.includes(expected)) throw new Error('工具列表不完整');
    }
    const workbench = await client.callTool({
      name: 'get_personal_workbench',
      arguments: { limit: 5 },
    });
    if (workbench.isError) throw new Error('个人工作台调用失败');
    await transport.terminateSession();
    return { status: 'passed', toolCount: names.length, personalWorkbench: 'passed' };
  } finally {
    await client.close().catch(() => {});
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryUrl === import.meta.url) {
  try {
    const result = await runLiveSmoke(loadLiveSmokeConfig(process.env));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: 'LIVE_SMOKE_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
