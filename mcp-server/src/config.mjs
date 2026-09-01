function required(env, names, label) {
  const value = names.map((name) => env[name]).find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (!value) throw new Error(`缺少环境变量 ${label}`);
  return value.trim();
}

function positiveInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是正整数`);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

function boundedPositiveInteger(env, name, fallback, minimum) {
  const value = positiveInteger(env, name, fallback);
  if (value < minimum) throw new Error(`${name} 必须大于或等于 ${minimum}`);
  return value;
}

function booleanValue(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function csv(value, fallback) {
  const items = (value ?? fallback)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) throw new Error('MCP_ALLOWED_HOSTS 至少需要一个主机名');
  return [...new Set(items)];
}

function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

const FORBIDDEN_SECRET_ENV_KEYS = Object.freeze([
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'MCP_MIGRATION_DATABASE_URL',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
]);

function rejectHighPrivilegeSecrets(env) {
  for (const name of FORBIDDEN_SECRET_ENV_KEYS) {
    if (typeof env[name] === 'string' && env[name].trim()) {
      throw new Error(`MCP 进程禁止设置高权限环境变量 ${name}`);
    }
  }
}

export function loadConfig(env = process.env) {
  rejectHighPrivilegeSecrets(env);
  const supabaseUrl = required(env, ['SUPABASE_URL', 'VITE_SUPABASE_URL'], 'SUPABASE_URL').replace(/\/+$/, '');
  const supabasePublishableKey = required(
    env,
    [
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_ANON_KEY',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
      'VITE_SUPABASE_ANON_KEY',
    ],
    'SUPABASE_PUBLISHABLE_KEY 或 SUPABASE_ANON_KEY',
  );

  try {
    const parsedUrl = new URL(supabaseUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    throw new Error('SUPABASE_URL 必须是合法的 HTTP/HTTPS URL');
  }

  const port = positiveInteger(env, 'MCP_PORT', 8787);
  if (port > 65_535) throw new Error('MCP_PORT 必须小于或等于 65535');

  const rateLimitWindowMs = positiveInteger(env, 'MCP_RATE_LIMIT_WINDOW_MS', 60 * 1000);
  const rateLimitMax = positiveInteger(env, 'MCP_RATE_LIMIT_MAX', 30);
  const trustedProxyAddresses = csv(env.MCP_TRUSTED_PROXY_ADDRESSES, '127.0.0.1,::1,::ffff:127.0.0.1');
  const host = (env.MCP_HOST || '127.0.0.1').trim();
  const nodeEnv = (env.NODE_ENV || 'development').trim().toLowerCase();
  const allowNonLoopback = booleanValue(env, 'MCP_ALLOW_NON_LOOPBACK', false);
  if (!host) throw new Error('MCP_HOST 不能为空');
  if (!isLoopbackHost(host) && (nodeEnv === 'production' || !allowNonLoopback)) {
    throw new Error('MCP_HOST 只能绑定 loopback；非生产诊断必须显式启用 MCP_ALLOW_NON_LOOPBACK');
  }
  if (nodeEnv === 'production' && trustedProxyAddresses.some((address) => !isLoopbackHost(address))) {
    throw new Error('生产环境 MCP_TRUSTED_PROXY_ADDRESSES 只能包含 loopback 地址');
  }
  const requireHttps = booleanValue(env, 'MCP_REQUIRE_HTTPS', false);
  if (nodeEnv === 'production' && !requireHttps) {
    throw new Error('生产环境必须启用 MCP_REQUIRE_HTTPS');
  }
  return Object.freeze({
    supabaseUrl,
    supabasePublishableKey,
    host,
    nodeEnv,
    allowNonLoopback,
    port,
    sessionTtlMs: positiveInteger(env, 'MCP_SESSION_TTL_MS', 8 * 60 * 60 * 1000),
    refreshWindowMs: positiveInteger(env, 'MCP_REFRESH_WINDOW_MS', 60 * 1000),
    requestTimeoutMs: positiveInteger(env, 'MCP_REQUEST_TIMEOUT_MS', 15 * 1000),
    readinessTtlMs: positiveInteger(env, 'MCP_READINESS_TTL_MS', 5 * 1000),
    confirmationTtlMs: boundedPositiveInteger(env, 'MCP_CONFIRMATION_TTL_MS', 10 * 60 * 1000, 60 * 1000),
    enableJsonResponse: booleanValue(env, 'MCP_ENABLE_JSON_RESPONSE', true),
    sseKeepAliveMs: boundedPositiveInteger(env, 'MCP_SSE_KEEP_ALIVE_MS', 15 * 1000, 1000),
    rateLimitWindowMs,
    rateLimitMax,
    initializeRateLimitMax: positiveInteger(env, 'MCP_INITIALIZE_RATE_LIMIT_MAX', rateLimitMax),
    readRateLimitMax: positiveInteger(env, 'MCP_READ_RATE_LIMIT_MAX', rateLimitMax),
    writeRateLimitMax: positiveInteger(env, 'MCP_WRITE_RATE_LIMIT_MAX', rateLimitMax),
    drainTimeoutMs: positiveInteger(env, 'MCP_DRAIN_TIMEOUT_MS', 10 * 1000),
    requireHttps,
    allowedHosts: csv(env.MCP_ALLOWED_HOSTS, '127.0.0.1,localhost'),
    trustedProxyAddresses,
  });
}
