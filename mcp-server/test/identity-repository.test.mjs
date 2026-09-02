import test from 'node:test';
import assert from 'node:assert/strict';

import { createIdentityRepository } from '../src/identity-repository.mjs';

function fakeSupabase(result) {
  const calls = [];
  return {
    calls,
    client: {
      async rpc(name, args) {
        calls.push([name, args]);
        return result;
      },
    },
  };
}

function repository(result, context = { userId: 'user-manager', accessToken: 'access-1' }) {
  const fake = fakeSupabase(result);
  return {
    fake,
    value: createIdentityRepository({
      createUserClient: () => fake.client,
      getContext: () => context,
      requestTimeoutMs: 1000,
      logger: { error() {} },
    }),
  };
}

test('resolves a unique exact name to the minimal safe user summary', async () => {
  const repo = repository({
    data: {
      user: {
        user_id: 'user-1', name: '张三', role: 'Employee',
        department_id: 'dept-1', department_name: '市场部',
      },
    },
    error: null,
  });

  const result = await repo.value.resolveUser({ name: ' 张三 ', purpose: 'query' });

  assert.deepEqual(result, {
    userId: 'user-1', name: '张三', role: 'Employee',
    departmentId: 'dept-1', departmentName: '市场部',
  });
  assert.deepEqual(repo.fake.calls, [[
    'mcp_resolve_users_by_name',
    { p_name: '张三', p_department_name: null, p_purpose: 'query' },
  ]]);
});

test('requires a department when the name is ambiguous', async () => {
  const repo = repository({ data: null, error: { code: 'P0001', message: 'MCP_USER_NAME_AMBIGUOUS: duplicate' } });

  await assert.rejects(
    repo.value.resolveUser({ name: '张三', purpose: 'query' }),
    (error) => error.code === 'USER_NAME_AMBIGUOUS' && !error.message.includes('duplicate'),
  );
});

test('returns a stable not-found error without exposing database details', async () => {
  const repo = repository({ data: null, error: { code: 'P0001', message: 'MCP_USER_NOT_FOUND: user-1' } });

  await assert.rejects(
    repo.value.resolveUser({ name: '不存在', purpose: 'query' }),
    (error) => error.code === 'USER_NOT_FOUND'
      && !error.message.includes('user-1')
      && !error.message.includes('MCP_USER_NOT_FOUND'),
  );
});

test('resolves explicit cross-department participant and approver names', async () => {
  const repo = repository({
    data: {
      user: {
        user_id: 'user-2', name: '李四', role: 'Employee',
        department_id: 'dept-2', department_name: '研发部',
      },
    },
    error: null,
  });

  await repo.value.resolveUser({ name: '李四', departmentName: '研发部', purpose: 'participant' });
  await repo.value.resolveUser({ name: '李四', departmentName: '研发部', purpose: 'approver' });

  assert.deepEqual(repo.fake.calls.map((call) => call[1]), [
    { p_name: '李四', p_department_name: '研发部', p_purpose: 'participant' },
    { p_name: '李四', p_department_name: '研发部', p_purpose: 'approver' },
  ]);
});

test('maps department ambiguity and missing RPC without exposing database details', async () => {
  const ambiguous = repository({ data: null, error: { code: 'P0001', message: 'MCP_DEPARTMENT_NAME_AMBIGUOUS: internal rows' } });
  await assert.rejects(
    ambiguous.value.resolveUser({ name: '张三', departmentName: '研发部', purpose: 'query' }),
    (error) => error.code === 'DEPARTMENT_NAME_AMBIGUOUS' && !error.message.includes('internal rows'),
  );

  const missing = repository({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.mcp_resolve_users_by_name' } });
  await assert.rejects(
    missing.value.resolveUser({ name: '张三', purpose: 'query' }),
    (error) => error.code === 'RPC_NOT_CONFIGURED' && !error.message.includes('public.mcp_resolve_users_by_name'),
  );

  const absentDepartment = repository({ data: null, error: { code: 'P0001', message: 'MCP_DEPARTMENT_NOT_FOUND: hidden' } });
  await assert.rejects(
    absentDepartment.value.resolveUser({ name: '张三', departmentName: '不存在部门', purpose: 'query' }),
    (error) => error.code === 'DEPARTMENT_NOT_FOUND' && !error.message.includes('hidden'),
  );
});

test('rejects malformed identity rows and missing sessions', async () => {
  const malformed = repository({ data: { user: { name: '张三' } }, error: null });
  await assert.rejects(malformed.value.resolveUser({ name: '张三' }), (error) => error.code === 'DATA_ACCESS_FAILED');

  const expired = repository({ data: null, error: null }, { userId: 'user-1' });
  await assert.rejects(expired.value.resolveUser({ name: '张三' }), (error) => error.code === 'SESSION_EXPIRED');
});

test('resolves a nested department and returns safe candidates when its name is ambiguous', async () => {
  const unique = repository({
    data: {
      department: {
        id: 'operations-child', name: '运营部', parentId: 'market-root', parentName: '市场运营部',
        rootId: 'market-root', rootName: '市场运营部', depth: 1,
        path: ['market-root', 'operations-child'],
      },
      scope: 'exact',
      ids: ['operations-child'],
    },
    error: null,
  });

  const resolved = await unique.value.resolveDepartment({ name: '运营部', scope: 'auto' });

  assert.equal(resolved.id, 'operations-child');
  assert.equal(resolved.scope, 'exact');
  assert.deepEqual(unique.fake.calls, [[
    'mcp_resolve_department',
    { p_department_name: '运营部', p_department_id: null, p_scope: 'auto' },
  ]]);

  const ambiguous = repository({
    data: {
      ambiguous: true,
      candidates: [
        { id: 'operations-a', name: '运营部', parentId: 'market-a', rootId: 'market-a', rootName: '市场一部', depth: 1, path: ['market-a', 'operations-a'] },
        { id: 'operations-b', name: '运营部', parentId: 'market-b', rootId: 'market-b', rootName: '市场二部', depth: 1, path: ['market-b', 'operations-b'] },
      ],
    },
    error: null,
  });

  await assert.rejects(
    ambiguous.value.resolveDepartment({ name: '运营部' }),
    (error) => error.code === 'DEPARTMENT_NAME_AMBIGUOUS'
      && error.details?.candidates?.length === 2
      && error.details.candidates.every((candidate) => !('node' in candidate)),
  );
});
