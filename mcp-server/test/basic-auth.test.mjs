import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError, toPublicError } from '../src/errors.mjs';
import { parseBasicAuthorization } from '../src/basic-auth.mjs';

const basic = (value) => `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;

test('maps a normalized system username to the existing app.local account', () => {
  const credentials = parseBasicAuthorization(basic(' ZhangSan :secret'));

  assert.deepEqual(credentials, {
    username: 'zhangsan',
    email: 'zhangsan@app.local',
    password: 'secret',
  });
});

test('preserves colons inside the password', () => {
  assert.equal(parseBasicAuthorization(basic('alice:p:a:ss')).password, 'p:a:ss');
});

test('accepts the internal app.local email without appending the suffix twice', () => {
  assert.equal(parseBasicAuthorization(basic('ALICE@app.local:secret')).email, 'alice@app.local');
});

test('requires Basic authentication', () => {
  for (const header of [undefined, '', 'Bearer token']) {
    assert.throws(() => parseBasicAuthorization(header), (error) => {
      assert.equal(error.code, 'AUTHENTICATION_REQUIRED');
      assert.equal(error.status, 401);
      return true;
    });
  }
});

test('rejects malformed, empty or unsupported credentials with one stable error', () => {
  for (const header of ['Basic !!!', basic(':secret'), basic('alice:'), basic('alice@example.com:secret')]) {
    assert.throws(() => parseBasicAuthorization(header), (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      assert.equal(error.status, 401);
      return true;
    });
  }
});

test('converts internal errors to a stable response without secrets or stack traces', () => {
  const internal = new Error('Supabase rejected jwt=secret-token');
  internal.stack = 'stack contains secret-token';
  const payload = toPublicError(internal);

  assert.deepEqual(payload, { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' });
  assert.equal(JSON.stringify(payload).includes('secret-token'), false);

  const known = toPublicError(new AppError('INVALID_ARGUMENT', '查询条件无效。', 400));
  assert.deepEqual(known, { code: 'INVALID_ARGUMENT', message: '查询条件无效。' });
});
