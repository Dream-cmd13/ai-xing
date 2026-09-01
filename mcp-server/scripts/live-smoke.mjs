import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const EXPECTED_TOOLS = [
  'get_organization_info',
  'get_department_weekly_pad',
  'search_pad_tasks',
  'get_weekly_review_gaps',
  'get_personal_workbench',
  'get_process_sipoc',
  'get_company_okrs',
  'get_department_okrs',
  'prepare_create_pad_task',
  'commit_create_pad_task',
  'prepare_update_pad_task',
  'commit_update_pad_task',
  'submit_pad_task',
  'save_review_record',
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
  const client = new Client({ name: 'ai-xing-phase-two-live-smoke', version: '0.2.0' });
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
    const call = async (name, arguments_) => {
      const result = await client.callTool({ name, arguments: arguments_ });
      return result;
    };
    const errorCode = (result) => {
      try { return JSON.parse(result.content?.[0]?.text ?? '{}').code; } catch { return undefined; }
    };
    const createPayload = { title: `MCP-SMOKE-${Date.now()}`, priority: 'medium' };
    const preparedCreate = await call('prepare_create_pad_task', { payload: createPayload });
    if (preparedCreate.isError) throw new Error('创建预览失败');
    const createPreview = preparedCreate.structuredContent;
    const createRequestId = `smoke-create-${Date.now()}`;
    const commitCreateArgs = {
      ...createPayload,
      confirmationToken: createPreview.confirmationToken,
      requestId: createRequestId,
    };
    const firstCreate = await call('commit_create_pad_task', commitCreateArgs);
    if (firstCreate.isError) throw new Error('创建提交失败');
    const secondCreate = await call('commit_create_pad_task', commitCreateArgs);
    const thirdCreate = await call('commit_create_pad_task', commitCreateArgs);
    if (!secondCreate.structuredContent?.replayed || !thirdCreate.structuredContent?.replayed) {
      throw new Error('创建幂等重放失败');
    }
    const task = firstCreate.structuredContent?.task;
    const taskId = task?.id;
    if (!taskId) throw new Error('创建结果缺少任务 ID');

    const preparedA = await call('prepare_update_pad_task', { taskId, changes: { title: `${createPayload.title}-A` } });
    const preparedB = await call('prepare_update_pad_task', { taskId, changes: { title: `${createPayload.title}-B` } });
    if (preparedA.isError || preparedB.isError) throw new Error('更新预览失败');
    const previewB = preparedB.structuredContent;
    const updateB = await call('commit_update_pad_task', {
      taskId,
      changes: { title: `${createPayload.title}-B` },
      expectedRowVersion: previewB.expectedRowVersion,
      confirmationToken: previewB.confirmationToken,
      requestId: `smoke-update-b-${Date.now()}`,
    });
    if (updateB.isError) throw new Error('更新提交失败');
    const previewA = preparedA.structuredContent;
    const conflict = await call('commit_update_pad_task', {
      taskId,
      changes: { title: `${createPayload.title}-A` },
      expectedRowVersion: previewA.expectedRowVersion,
      confirmationToken: previewA.confirmationToken,
      requestId: `smoke-update-a-${Date.now()}`,
    });
    if (errorCode(conflict) !== 'VERSION_CONFLICT') throw new Error('版本冲突未被拒绝');

    const forbidden = await call('prepare_update_pad_task', { taskId, changes: { departmentId: 'forbidden' } });
    if (errorCode(forbidden) !== 'INVALID_ARGUMENT') throw new Error('禁止部门移动未被拒绝');

    const preparedSubmit = await call('submit_pad_task', { taskId });
    if (preparedSubmit.isError) throw new Error('提交预览失败');
    const submitPreview = preparedSubmit.structuredContent;
    const submitted = await call('submit_pad_task', {
      taskId,
      confirmationToken: submitPreview.confirmationToken,
      requestId: `smoke-submit-${Date.now()}`,
    });
    if (submitted.isError) throw new Error('提交任务失败');

    const missingToken = await call('commit_create_pad_task', { ...createPayload, requestId: `smoke-missing-${Date.now()}` });
    if (errorCode(missingToken) !== 'CONFIRMATION_INVALID') throw new Error('缺少令牌未被拒绝');
    await transport.terminateSession();
    return { status: 'passed', toolCount: names.length, personalWorkbench: 'passed', writes: 'passed', taskId };
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
