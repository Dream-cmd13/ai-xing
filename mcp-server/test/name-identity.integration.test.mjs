import test from 'node:test';
import assert from 'node:assert/strict';

import { createReadRepository } from '../src/repository.mjs';
import { createIdentityRepository } from '../src/identity-repository.mjs';

function fakeClient(result) {
  const calls = [];
  return {
    calls,
    client: {
      async rpc(name, args) {
        calls.push({ name, args });
        return typeof result === 'function' ? result(name, args) : result;
      },
    },
  };
}

for (const role of ['Employee', 'Manager', 'Admin']) {
  test(`${role} name query uses the authenticated JWT and never trusts caller role fields`, async () => {
    const fake = fakeClient((name) => name === 'mcp_get_task_people' ? {
      data: { tasks: [{
        task_id: 'task-1',
        owner: { id: 'target-user', name: '张三', department_id: 'dept-1', department_name: '市场部' },
        participants: [{ id: 'hidden-user', name: '李四', department_id: 'dept-1', department_name: '市场部' }],
        approvers: [{ id: 'hidden-approver', name: '王五', department_id: 'dept-1', department_name: '市场部' }],
      }] },
      error: null,
    } : {
      data: {
        user: { user_id: 'target-user', name: '张三', role: 'Employee', department_id: 'dept-1', department_name: '市场部' },
        tasks: [{
          id: 'task-1', title: '安全查询', status: 'draft', owner_id: 'target-user',
          owner_name: '张三', owner_department_name: '市场部', department_name: '市场部', participant_ids: ['hidden-user'],
          approver_ids: ['hidden-approver'], relation_matches: ['owner'],
        }], total: 1, limit: 20, offset: 0, hasMore: false,
      },
      error: null,
    });
    const context = { userId: `${role.toLowerCase()}-caller`, role, accessToken: `${role}-jwt` };
    const repository = createReadRepository({
      createUserClient: (token) => {
        assert.equal(token, context.accessToken);
        return fake.client;
      },
      getContext: () => context,
      requestTimeoutMs: 1000,
      identityRepository: {
        async resolveUser() {
          return { userId: 'target-user', name: '张三', role: 'Employee', departmentId: 'dept-1', departmentName: '市场部' };
        },
      },
    });

    const result = await repository.searchPadTasks({
      userName: '张三', role: 'Admin', currentUserId: 'attacker', relation: 'owner',
    });
    const query = fake.calls.find((call) => call.name === 'mcp_query_user_tasks');
    assert.equal(query.args.p_user_id, 'target-user');
    assert.equal(Object.hasOwn(query.args, 'role'), false);
    assert.equal(Object.hasOwn(query.args, 'currentUserId'), false);
    assert.equal(result.user.userId, undefined);
    assert.equal(result.tasks[0].ownerId, 'target-user');
    assert.equal(result.tasks[0].ownerName, '张三');
    assert.equal(result.tasks[0].departmentName, '市场部');
    assert.deepEqual(result.tasks[0].participantIds, ['hidden-user']);
    assert.deepEqual(result.tasks[0].approverIds, ['hidden-approver']);
    assert.equal(result.tasks[0].participants[0].name, '李四');
    assert.equal(result.tasks[0].approvers[0].name, '王五');
    assert.deepEqual(result.tasks[0].relationMatches, ['owner']);
  });
}

test('identity resolution itself is scoped to the authenticated client and returns only safe fields', async () => {
  const fake = fakeClient({
    data: { user: {
      user_id: 'u1', name: '李四', role: 'Employee', department_id: 'd1', department_name: '研发部',
      auth_id: 'must-not-pass', password: 'must-not-pass', custom_permissions: { secret: true },
    } },
    error: null,
  });
  const repository = createIdentityRepository({
    createUserClient: () => fake.client,
    getContext: () => ({ userId: 'manager-1', role: 'Manager', accessToken: 'jwt-1' }),
    requestTimeoutMs: 1000,
    logger: { error() {} },
  });
  const result = await repository.resolveUser({ name: '李四', purpose: 'query' });
  assert.deepEqual(result, {
    userId: 'u1', name: '李四', role: 'Employee', departmentId: 'd1', departmentName: '研发部',
  });
  assert.deepEqual(fake.calls[0], {
    name: 'mcp_resolve_users_by_name',
    args: { p_name: '李四', p_department_name: null, p_purpose: 'query' },
  });
});
