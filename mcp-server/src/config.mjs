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

const FORBIDDEN_SECRET_ENV_KEYS = Object.freeze([
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
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

  return Object.freeze({
    supabaseUrl,
    supabasePublishableKey,
    host: (env.MCP_HOST || '127.0.0.1').trim(),
    port,
    sessionTtlMs: positiveInteger(env, 'MCP_SESSION_TTL_MS', 8 * 60 * 60 * 1000),
    refreshWindowMs: positiveInteger(env, 'MCP_REFRESH_WINDOW_MS', 60 * 1000),
    requestTimeoutMs: positiveInteger(env, 'MCP_REQUEST_TIMEOUT_MS', 15 * 1000),
    rateLimitWindowMs: positiveInteger(env, 'MCP_RATE_LIMIT_WINDOW_MS', 60 * 1000),
    rateLimitMax: positiveInteger(env, 'MCP_RATE_LIMIT_MAX', 30),
    requireHttps: booleanValue(env, 'MCP_REQUIRE_HTTPS', false),
    allowedHosts: csv(env.MCP_ALLOWED_HOSTS, '127.0.0.1,localhost'),
  });
}
