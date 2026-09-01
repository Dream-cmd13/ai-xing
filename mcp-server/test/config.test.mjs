import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.mjs';

const validEnv = {
  SUPABASE_URL: 'https://project.supabase.co/',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
};

test('loads safe loopback defaults and trims the Supabase URL', () => {
  const config = loadConfig(validEnv);

  assert.equal(config.supabaseUrl, 'https://project.supabase.co');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.sessionTtlMs, 28_800_000);
  assert.equal(config.refreshWindowMs, 60_000);
  assert.equal(config.requestTimeoutMs, 15_000);
  assert.equal(config.confirmationTtlMs, 600_000);
  assert.equal(config.enableJsonResponse, true);
  assert.equal(config.sseKeepAliveMs, 15_000);
  assert.equal(config.rateLimitWindowMs, 60_000);
  assert.equal(config.rateLimitMax, 30);
  assert.equal(config.requireHttps, false);
  assert.deepEqual(config.allowedHosts, ['127.0.0.1', 'localhost']);
});

test('accepts the existing Vite Supabase variable names', () => {
  const config = loadConfig({
    VITE_SUPABASE_URL: 'https://project.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'anon-key',
  });

  assert.equal(config.supabasePublishableKey, 'anon-key');
});

test('requires a Supabase URL and a publishable or anon key', () => {
  assert.throws(() => loadConfig({ SUPABASE_PUBLISHABLE_KEY: 'key' }), /SUPABASE_URL/);
  assert.throws(() => loadConfig({ SUPABASE_URL: 'https:\/\/project.supabase.co' }), /SUPABASE_PUBLISHABLE_KEY/);
});

test('fails closed when high-privilege database or Supabase secrets enter the MCP process', () => {
  for (const name of [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_DB_PASSWORD',
    'MCP_MIGRATION_DATABASE_URL',
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
  ]) {
    assert.throws(
      () => loadConfig({ ...validEnv, [name]: 'must-not-be-loaded' }),
      new RegExp(name),
    );
  }
});

test('rejects invalid numeric and boolean settings instead of silently weakening limits', () => {
  assert.throws(() => loadConfig({ ...validEnv, MCP_PORT: '0' }), /MCP_PORT/);
  assert.throws(() => loadConfig({ ...validEnv, MCP_SESSION_TTL_MS: 'abc' }), /MCP_SESSION_TTL_MS/);
  assert.throws(() => loadConfig({ ...validEnv, MCP_RATE_LIMIT_MAX: '-1' }), /MCP_RATE_LIMIT_MAX/);
  assert.throws(() => loadConfig({ ...validEnv, MCP_REQUIRE_HTTPS: 'sometimes' }), /MCP_REQUIRE_HTTPS/);
  assert.throws(() => loadConfig({ ...validEnv, MCP_CONFIRMATION_TTL_MS: '59999' }), /MCP_CONFIRMATION_TTL_MS/);
  assert.throws(() => loadConfig({ ...validEnv, MCP_ENABLE_JSON_RESPONSE: 'sometimes' }), /MCP_ENABLE_JSON_RESPONSE/);
  assert.throws(() => loadConfig({ ...validEnv, MCP_SSE_KEEP_ALIVE_MS: '999' }), /MCP_SSE_KEEP_ALIVE_MS/);
});

test('parses explicit production overrides', () => {
  const config = loadConfig({
    ...validEnv,
    MCP_HOST: '0.0.0.0',
    MCP_PORT: '9000',
    MCP_ALLOWED_HOSTS: 'okr.example.com, localhost',
    MCP_SESSION_TTL_MS: '3600000',
    MCP_REFRESH_WINDOW_MS: '120000',
    MCP_REQUEST_TIMEOUT_MS: '10000',
    MCP_CONFIRMATION_TTL_MS: '120000',
    MCP_ENABLE_JSON_RESPONSE: 'false',
    MCP_SSE_KEEP_ALIVE_MS: '20000',
    MCP_RATE_LIMIT_WINDOW_MS: '30000',
    MCP_RATE_LIMIT_MAX: '10',
    MCP_REQUIRE_HTTPS: 'true',
  });

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 9000);
  assert.deepEqual(config.allowedHosts, ['okr.example.com', 'localhost']);
  assert.equal(config.requireHttps, true);
  assert.equal(config.confirmationTtlMs, 120_000);
  assert.equal(config.enableJsonResponse, false);
  assert.equal(config.sseKeepAliveMs, 20_000);
  assert.equal(config.initializeRateLimitMax, 10);
  assert.equal(config.readRateLimitMax, 10);
  assert.equal(config.writeRateLimitMax, 10);
});
