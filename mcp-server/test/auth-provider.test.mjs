import test from 'node:test';
import assert from 'node:assert/strict';

import { createSupabaseAuthProvider } from '../src/auth-provider.mjs';
import { EXPECTED_MANIFEST_DIGEST, RELEASE_ID } from '../src/release-contract.mjs';

const config = {
  supabaseUrl: 'https://project.supabase.co',
  supabasePublishableKey: 'publishable-key',
};

function profileQuery(result) {
  const calls = [];
  const builder = {
    select(fields) {
      calls.push(['select', fields]);
      return builder;
    },
    eq(field, value) {
      calls.push(['eq', field, value]);
      return builder;
    },
    async maybeSingle() {
      calls.push(['maybeSingle']);
      return result;
    },
  };
  return { builder, calls };
}

function createFakeClient({ signIn, refresh, profile }) {
  const query = profileQuery(profile);
  return {
    client: {
      auth: {
        signInWithPassword: async (input) => signIn(input),
        refreshSession: async (input) => refresh(input),
      },
      from(table) {
        assert.equal(table, 'users');
        return query.builder;
      },
    },
    query,
  };
}

test('logs in and binds the Supabase auth UUID to the business user', async () => {
  const fake = createFakeClient({
    signIn: async (input) => {
      assert.deepEqual(input, { email: 'zhangsan@app.local', password: 'secret' });
      return {
        data: {
          user: { id: 'auth-1' },
          session: {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_at: 2000,
          },
        },
        error: null,
      };
    },
    refresh: async () => ({ data: {}, error: null }),
    profile: {
      data: {
        id: 'user-1', auth_id: 'auth-1', username: 'zhangsan', name: '张三',
        role: 'Employee', department_id: 'dept-1',
      },
      error: null,
    },
  });
  const provider = createSupabaseAuthProvider({
    config,
    createClient: () => fake.client,
    now: () => 100,
  });

  const context = await provider.authenticate({
    username: 'zhangsan', email: 'zhangsan@app.local', password: 'secret',
  });

  assert.deepEqual(context, {
    authUserId: 'auth-1',
    userId: 'user-1',
    username: 'zhangsan',
    name: '张三',
    role: 'Employee',
    departmentId: 'dept-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenExpiresAt: 2_000_000,
  });
  assert.deepEqual(fake.query.calls[1], ['eq', 'auth_id', 'auth-1']);
  assert.equal(JSON.stringify(context).includes('secret'), false);
});

test('converts password login failures to one authentication error', async () => {
  const fake = createFakeClient({
    signIn: async () => ({ data: { user: null, session: null }, error: new Error('Invalid login credentials') }),
    refresh: async () => ({ data: {}, error: null }),
    profile: { data: null, error: null },
  });
  const provider = createSupabaseAuthProvider({ config, createClient: () => fake.client });

  await assert.rejects(
    provider.authenticate({ username: 'alice', email: 'alice@app.local', password: 'wrong' }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && !error.message.includes('Supabase'),
  );
});

test('rejects a login when no correctly bound business user exists', async () => {
  const fake = createFakeClient({
    signIn: async () => ({
      data: { user: { id: 'auth-1' }, session: { access_token: 'a', refresh_token: 'r', expires_at: 2000 } },
      error: null,
    }),
    refresh: async () => ({ data: {}, error: null }),
    profile: { data: { id: 'user-1', auth_id: 'another-auth' }, error: null },
  });
  const provider = createSupabaseAuthProvider({ config, createClient: () => fake.client });

  await assert.rejects(
    provider.authenticate({ username: 'alice', email: 'alice@app.local', password: 'secret' }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});

test('refreshes an authenticated context without changing the business identity', async () => {
  const fake = createFakeClient({
    signIn: async () => ({ data: {}, error: null }),
    refresh: async (input) => {
      assert.deepEqual(input, { refresh_token: 'refresh-1' });
      return {
        data: { session: { access_token: 'access-2', refresh_token: 'refresh-2', expires_at: 3000 } },
        error: null,
      };
    },
    profile: { data: null, error: null },
  });
  const provider = createSupabaseAuthProvider({ config, createClient: () => fake.client });
  const original = {
    userId: 'user-1', role: 'Employee', departmentId: 'dept-1',
    accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: 2000,
  };

  const refreshed = await provider.refresh(original);

  assert.equal(refreshed.userId, 'user-1');
  assert.equal(refreshed.accessToken, 'access-2');
  assert.equal(refreshed.refreshToken, 'refresh-2');
  assert.equal(refreshed.tokenExpiresAt, 3_000_000);
});

test('deletes the effective session by returning SESSION_EXPIRED when refresh fails', async () => {
  const fake = createFakeClient({
    signIn: async () => ({ data: {}, error: null }),
    refresh: async () => ({ data: { session: null }, error: new Error('expired') }),
    profile: { data: null, error: null },
  });
  const provider = createSupabaseAuthProvider({ config, createClient: () => fake.client });

  await assert.rejects(
    provider.refresh({ refreshToken: 'refresh-1' }),
    (error) => error.code === 'SESSION_EXPIRED',
  );
});

test('creates RLS clients with only the publishable key and the current user JWT', () => {
  const calls = [];
  const provider = createSupabaseAuthProvider({
    config,
    createClient: (...args) => {
      calls.push(args);
      return { auth: {}, from() {} };
    },
  });

  provider.createUserClient('user-jwt');

  assert.equal(calls[0][0], config.supabaseUrl);
  assert.equal(calls[0][1], 'publishable-key');
  assert.equal(calls[0][2].global.headers.Authorization, 'Bearer user-jwt');
  assert.equal(JSON.stringify(calls).includes('service'), false);
});

test('fails readiness closed unless the complete release contract matches the code', async () => {
  const responses = [
    { status: 'ready', releaseId: RELEASE_ID, manifestDigest: 'wrong', requiredMigrations: true, functionPrivileges: true },
    { status: 'ready', releaseId: 'old-release', manifestDigest: EXPECTED_MANIFEST_DIGEST, requiredMigrations: true, functionPrivileges: true },
    {
      status: 'ready', releaseId: RELEASE_ID, manifestDigest: EXPECTED_MANIFEST_DIGEST,
      requiredMigrations: true, functionPrivileges: true,
      taskDateWeekFunction: true, taskDateWeekTrigger: true, taskPeriodDataConsistent: true,
    },
  ];
  for (const [index, responseData] of responses.entries()) {
    const provider = createSupabaseAuthProvider({
      config,
      createClient: () => ({ rpc: async () => ({ data: responseData, error: null }) }),
    });
    const readiness = await provider.checkReadiness();
    if (index < responses.length - 1) {
      assert.deepEqual(readiness, { status: 'degraded', reason: 'RELEASE_CONTRACT_MISMATCH' });
    } else {
      assert.deepEqual(readiness, responseData);
    }
  }
});
