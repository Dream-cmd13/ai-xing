import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import {
  EXPECTED_MANIFEST_DIGEST,
  RELEASE_ID,
} from '../src/release-contract.mjs';

const { Client } = pg;

export { EXPECTED_MANIFEST_DIGEST, RELEASE_ID };
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BASELINE_VERSION = 'aab58c6';
export const MIGRATION_MANIFEST = Object.freeze([
  '2026-08-21_mcp_write_infra_tables.sql',
  '2026-08-21_mcp_write_rpc.sql',
  '2026-08-25_mcp_name_identity_queries.sql',
  '2026-08-25_mcp_task_defaults_people_submit.sql',
  '2026-08-25_mcp_task_review_sync_rpc.sql',
  '2026-08-26_fix_task_users_timeout.sql',
  '2026-08-26_mcp_p1_hardening.sql',
  '2026-08-27_mcp_migration_control.sql',
  '2026-08-27_mcp_review_slot_hardening.sql',
  '2026-08-27_mcp_task_pagination.sql',
  '2026-08-27_mcp_readiness.sql',
  '2026-08-27_mcp_task_indexes.sql',
  '2026-08-28_web_task_load_p0_p1.sql',
  '2026-08-28_mcp_okr_queries.sql',
  '2026-08-29_nested_department_scope.sql',
  '2026-08-29_nested_department_permission_alignment.sql',
  '2026-08-29_department_tree_peer_read_visibility.sql',
  '2026-08-29_department_tree_peer_read_performance.sql',
  '2026-08-29_department_scope_task_read_performance.sql',
  '2026-08-29_nested_department_task_write_trigger_alignment.sql',
  '2026-08-30_mcp_department_okr_periods_fix.sql',
  '2026-08-31_mcp_okr_contract_hardening.sql',
  '2026-08-31_mcp_okr_task_attachment_fix.sql',
  '2026-08-31_mcp_okr_task_attachment_json_fallback.sql',
  '2026-08-31_mcp_okr_readiness_gate.sql',
  '2026-08-31_web_task_center_scoped_pagination.sql',
  '2026-09-01_mcp_task_validation_and_people_security.sql',
  '2026-09-01_mcp_release_contract.sql',
  '2026-09-01_web_child_department_review_contract.sql',
  '2026-09-01_web_child_department_review_readiness_gate.sql',
  '2026-09-01_task_date_derived_week_binding_contract.sql',
  '2026-09-01_task_date_derived_week_binding_readiness_gate.sql',
  '2026-09-03_mcp_task_title_unbounded.sql',
]);

const NON_TRANSACTIONAL = new Set(['2026-08-27_mcp_task_indexes.sql']);
// This checksummed migration predates the transaction-envelope convention.
// The runner still wraps it in its own transaction; every later transactional
// migration must carry and pass the strict outer-envelope validation.
const LEGACY_UNWRAPPED_TRANSACTIONAL = new Set(['2026-08-27_mcp_readiness.sql']);
const RELEASE_CONTRACT_FILE = '2026-09-03_mcp_task_title_unbounded.sql';
const LOCK_KEY = 'ai-xing:mcp:migrations:v1';
const LEGACY_ADOPTION_CHECKS = Object.freeze({
  '2026-08-21_mcp_write_infra_tables': [
    ['table', 'public.mcp_write_log'],
    ['table', 'public.mcp_audit_log'],
  ],
  '2026-08-21_mcp_write_rpc': [
    ['function', 'public.mcp_create_pad_task(jsonb,text)'],
    ['function', 'public.mcp_update_pad_task(text,jsonb,bigint,text)'],
    ['function', 'public.mcp_submit_pad_task(text,bigint,text)'],
    ['function', 'public.mcp_save_review_record(text,text,jsonb,bigint,text)'],
    ['function_contains', 'public.mcp_create_pad_task(jsonb,text)', 'mcp_write_log'],
    ['function_contains', 'public.mcp_update_pad_task(text,jsonb,bigint,text)', 'row_version'],
  ],
  '2026-08-25_mcp_name_identity_queries': [
    ['function', 'public.mcp_resolve_users_by_name(text,text,text)'],
    ['function', 'public.mcp_query_user_tasks(text,text,bigint,bigint,text,text,text,integer,integer)'],
    ['function', 'public.mcp_get_weekly_review_gaps(text,text,integer,integer)'],
  ],
  '2026-08-25_mcp_task_defaults_people_submit': [
    ['function', 'public.mcp_get_task_people(text[])'],
  ],
  '2026-08-25_mcp_task_review_sync_rpc': [
    ['function', 'public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)'],
    ['function_contains', 'public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)', 'mcp_audit_log'],
    ['function_contains', 'public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)', 'FOR UPDATE'],
  ],
  '2026-08-26_fix_task_users_timeout': [
    ['function', 'public.get_current_user_task_users_for_tasks(text[])'],
  ],
  '2026-08-26_mcp_p1_hardening': [
    ['function', 'public.mcp_review_entry_has_task_fields(jsonb)'],
    ['function', 'public.mcp_save_review_record_impl_20260826(text,text,jsonb,bigint,text)'],
    ['function_contains', 'public.mcp_save_review_record(text,text,jsonb,bigint,text)', 'mcp_review_entry_has_task_fields'],
    ['function_contains', 'public.mcp_save_review_record(text,text,jsonb,bigint,text)', 'mcp_save_review_record_impl_20260826'],
    ['function_privilege', 'public.mcp_save_review_record(text,text,jsonb,bigint,text)', 'authenticated', true],
    ['function_privilege', 'public.mcp_save_review_record_impl_20260826(text,text,jsonb,bigint,text)', 'authenticated', false],
  ],
});

export function checksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

function migrationEnvelopeError() {
  const error = new Error('事务型迁移必须且只能包含一个顶层 BEGIN/COMMIT 外壳。');
  error.code = 'MIGRATION_ENVELOPE_INVALID';
  return error;
}

function topLevelSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let mode = 'normal';
  let dollarTag = '';
  let blockDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (mode === 'line-comment') {
      if (current === '\n') mode = 'normal';
      continue;
    }
    if (mode === 'block-comment') {
      if (current === '/' && next === '*') {
        blockDepth += 1;
        index += 1;
      } else if (current === '*' && next === '/') {
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) mode = 'normal';
      }
      continue;
    }
    if (mode === 'single-quote') {
      if (current === "'" && next === "'") index += 1;
      else if (current === "'") mode = 'normal';
      continue;
    }
    if (mode === 'double-quote') {
      if (current === '"' && next === '"') index += 1;
      else if (current === '"') mode = 'normal';
      continue;
    }
    if (mode === 'dollar-quote') {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        mode = 'normal';
      }
      continue;
    }

    if (current === '-' && next === '-') {
      mode = 'line-comment';
      index += 1;
    } else if (current === '/' && next === '*') {
      mode = 'block-comment';
      blockDepth = 1;
      index += 1;
    } else if (current === "'") {
      mode = 'single-quote';
    } else if (current === '"') {
      mode = 'double-quote';
    } else if (current === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        mode = 'dollar-quote';
        index += dollarTag.length - 1;
      }
    } else if (current === ';') {
      statements.push({ start, end: index + 1, text: sql.slice(start, index + 1) });
      start = index + 1;
    }
  }
  if (mode !== 'normal' && mode !== 'line-comment') throw migrationEnvelopeError();
  if (start < sql.length) statements.push({ start, end: sql.length, text: sql.slice(start) });
  return statements;
}

function stripSqlComments(sql) {
  return sql
    .replace(/--[^\r\n]*(?:\r?\n|$)/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
}

export function unwrapTransaction(sql) {
  const statements = topLevelSqlStatements(sql)
    .map((statement) => ({ ...statement, executable: stripSqlComments(statement.text) }))
    .filter((statement) => statement.executable.length > 0);
  if (statements.length < 2) throw migrationEnvelopeError();
  const transactionStatements = statements.filter((statement) => /^(?:BEGIN|COMMIT)\s*;$/i.test(statement.executable));
  const first = statements[0];
  const last = statements.at(-1);
  if (!/^BEGIN\s*;$/i.test(first.executable)
    || !/^COMMIT\s*;$/i.test(last.executable)
    || transactionStatements.length !== 2) {
    throw migrationEnvelopeError();
  }
  const body = sql.slice(first.end, last.start).trim();
  if (!body) throw migrationEnvelopeError();
  return body;
}

function splitNonTransactionalSql(sql) {
  const withoutComments = sql.replace(/^\s*--.*$/gm, '').trim();
  const statements = withoutComments.split(';').map((statement) => statement.trim()).filter(Boolean);
  if (statements.length === 0
    || statements.some((statement) => !/^CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\b/i.test(statement))) {
    throw new Error('非事务迁移只能包含 CREATE INDEX CONCURRENTLY IF NOT EXISTS 语句。');
  }
  return statements;
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : 'MIGRATION_FAILED';
}

async function readManifest(root = projectRoot) {
  return Promise.all(MIGRATION_MANIFEST.map(async (fileName) => {
    const sql = await readFile(path.join(root, 'sql', fileName), 'utf8');
    return {
      version: fileName.replace(/\.sql$/i, ''), fileName, sql, checksum: checksum(sql),
      transactional: !NON_TRANSACTIONAL.has(fileName),
      requiresEnvelope: !NON_TRANSACTIONAL.has(fileName) && !LEGACY_UNWRAPPED_TRANSACTIONAL.has(fileName),
    };
  }));
}

export function releaseManifestDigest(entries) {
  const requiredEntries = entries.filter((entry) => entry.transactional && entry.fileName !== RELEASE_CONTRACT_FILE);
  return checksum(requiredEntries.map((entry) => `${entry.version}:${entry.checksum}`).join('\n'));
}

async function recordReleaseContract(client, entries, knownVersions) {
  const requiredEntries = entries.filter((entry) => entry.transactional && entry.fileName !== RELEASE_CONTRACT_FILE);
  if (!requiredEntries.every((entry) => knownVersions.has(entry.version))) {
    throw new Error('发布契约记录失败：必需事务迁移尚未全部成功。');
  }
  const requiredVersions = requiredEntries.map((entry) => entry.version);
  const manifestDigest = releaseManifestDigest(entries);
  if (manifestDigest !== EXPECTED_MANIFEST_DIGEST) {
    const error = new Error('发布 manifest 摘要与代码中的 release contract 不一致。');
    error.code = 'RELEASE_CONTRACT_MISMATCH';
    throw error;
  }
  const deferredIndexes = Object.fromEntries(entries
    .filter((entry) => !entry.transactional)
    .map((entry) => [entry.version, knownVersions.has(entry.version) ? 'ready' : 'pending']));

  await client.query('BEGIN');
  try {
    const existing = await client.query(
      'SELECT release_id, manifest_digest, required_versions FROM mcp_internal.release_contracts WHERE release_id = $1',
      [RELEASE_ID],
    );
    const row = existing.rows?.[0];
    if (row && (row.manifest_digest !== manifestDigest
      || JSON.stringify(row.required_versions) !== JSON.stringify(requiredVersions))) {
      const error = new Error('发布契约不一致，拒绝覆盖既有记录。');
      error.code = 'RELEASE_CONTRACT_MISMATCH';
      throw error;
    }
    if (row) {
      await client.query(
        'UPDATE mcp_internal.release_contracts SET deferred_indexes = $2::jsonb, verified_at = clock_timestamp() WHERE release_id = $1',
        [RELEASE_ID, JSON.stringify(deferredIndexes)],
      );
    } else {
      await client.query(
        `INSERT INTO mcp_internal.release_contracts
           (release_id, manifest_digest, required_versions, deferred_indexes)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
        [RELEASE_ID, manifestDigest, JSON.stringify(requiredVersions), JSON.stringify(deferredIndexes)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function databaseObjectMatches(client, [kind, name, expected, expectedValue]) {
  if (kind === 'function_contains') {
    const result = await client.query(
      `SELECT to_regprocedure($1) IS NOT NULL
        AND position(lower($2) IN lower(COALESCE(pg_get_functiondef(to_regprocedure($1)), ''))) > 0 AS present`,
      [name, expected],
    );
    return result.rows?.[0]?.present === true;
  }
  if (kind === 'function_privilege') {
    const result = await client.query(
      'SELECT has_function_privilege($2::name, to_regprocedure($1), \'EXECUTE\') = $3::boolean AS present',
      [name, expected, expectedValue],
    );
    return result.rows?.[0]?.present === true;
  }
  const resolver = kind === 'table' ? 'to_regclass' : 'to_regprocedure';
  const result = await client.query(`SELECT ${resolver}($1) IS NOT NULL AS present`, [name]);
  return result.rows?.[0]?.present === true;
}

async function adoptLegacyMigrations(client, entries, knownVersions, logger) {
  const candidates = entries.filter((entry) => (
    LEGACY_ADOPTION_CHECKS[entry.version] && !knownVersions.has(entry.version)
  ));
  for (const entry of candidates) {
    const checks = LEGACY_ADOPTION_CHECKS[entry.version];
    const present = await Promise.all(checks.map((check) => databaseObjectMatches(client, check)));
    if (!present.every(Boolean)) {
      throw new Error(`无法接管既有迁移：${entry.fileName} 的对象或关键函数定义不符合预期。`);
    }
  }
  if (candidates.length === 0) return;

  await client.query('BEGIN');
  try {
    for (const entry of candidates) {
      await client.query(
        `INSERT INTO mcp_internal.schema_migrations
           (version, file_name, checksum, status, duration_ms, error_code, source_kind)
         VALUES ($1, $2, $3, 'success', 0, 'ADOPTED_VERIFIED', 'adopted')`,
        [entry.version, entry.fileName, entry.checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  for (const entry of candidates) {
    knownVersions.add(entry.version);
    logger.info?.({ event: 'migration_adopted', version: entry.version });
  }
}

function assertBaselineResult(result) {
  const row = result?.rows?.[0] ?? {};
  if (!row.tasks || !row.departments || !row.users || !row.strategy) {
    throw new Error(`数据库基线检查失败，要求已执行提交 ${BASELINE_VERSION} 的核心表结构。`);
  }
}

function assertKnownHistory(entries, rows) {
  const entryByVersion = new Map(entries.map((entry) => [entry.version, entry]));
  for (const row of rows) {
    const entry = entryByVersion.get(row.version);
    if (!entry) continue;
    if (row.file_name !== entry.fileName) {
      throw new Error(`迁移文件名不一致：${entry.fileName}。`);
    }
    if (row.checksum !== entry.checksum) {
      throw new Error(`迁移校验和不一致：${entry.fileName}。`);
    }
    if (row.status !== 'success') {
      throw new Error(`迁移之前失败，需人工处理后再继续：${entry.fileName}。`);
    }
  }
}

export async function runMigrations({
  client, root = projectRoot, logger = console, adoptExisting = false, includeIndexes = false,
} = {}) {
  if (!client) throw new Error('缺少数据库客户端。');
  const entries = await readManifest(root);
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
  const results = [];
  try {
    assertBaselineResult(await client.query(
      "SELECT to_regclass('public.tasks') AS tasks, to_regclass('public.departments') AS departments, to_regclass('public.users') AS users, to_regclass('public.strategy') AS strategy",
    ));
    await client.query('CREATE SCHEMA IF NOT EXISTS mcp_internal');
    await client.query('REVOKE ALL ON SCHEMA mcp_internal FROM PUBLIC, anon, authenticated, service_role');
    await client.query(`CREATE TABLE IF NOT EXISTS mcp_internal.schema_migrations (
      version TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
      error_code TEXT,
      source_kind TEXT NOT NULL DEFAULT 'applied' CHECK (source_kind IN ('applied', 'adopted')),
      installed_by TEXT NOT NULL DEFAULT current_user
    )`);
    await client.query(`ALTER TABLE mcp_internal.schema_migrations
      ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'applied'
      CHECK (source_kind IN ('applied', 'adopted'))`);
    await client.query('REVOKE ALL ON TABLE mcp_internal.schema_migrations FROM PUBLIC, anon, authenticated, service_role');
    const knownHistory = await client.query(
      'SELECT version, file_name, checksum, status FROM mcp_internal.schema_migrations',
    );
    const historyRows = knownHistory.rows ?? [];
    assertKnownHistory(entries, historyRows);
    const knownVersions = new Set(historyRows.map((row) => row.version));
    if (adoptExisting) {
      await adoptLegacyMigrations(client, entries, knownVersions, logger);
    }

    for (const [entryIndex, entry] of entries.entries()) {
      if (!entry.transactional && !includeIndexes) {
        results.push({ version: entry.version, status: 'deferred' });
        logger.info?.({ event: 'migration_deferred', version: entry.version });
        continue;
      }
      const existing = await client.query(
        'SELECT version, file_name, checksum, status FROM mcp_internal.schema_migrations WHERE version = $1',
        [entry.version],
      );
      const row = existing.rows?.[0];
      if (row) {
        if (row.checksum !== entry.checksum) {
          throw new Error(`迁移校验和不一致：${entry.fileName}。`);
        }
        if (row.status !== 'success') {
          throw new Error(`迁移之前失败，需人工处理后再继续：${entry.fileName}。`);
        }
        results.push({ version: entry.version, status: 'skipped' });
        logger.info?.({ event: 'migration_skipped', version: entry.version });
        continue;
      }
      const laterApplied = entry.transactional && entries
        .slice(entryIndex + 1)
        .some((later) => knownVersions.has(later.version));
      if (laterApplied) {
        throw new Error(`迁移顺序错误：${entry.fileName} 之前的迁移尚未完成。`);
      }

      const startedAt = Date.now();
      let inTransaction = false;
      try {
        if (entry.transactional) {
          await client.query('BEGIN');
          inTransaction = true;
          await client.query(entry.requiresEnvelope ? unwrapTransaction(entry.sql) : entry.sql);
        } else {
          for (const statement of splitNonTransactionalSql(entry.sql)) {
            await client.query(statement);
          }
        }
        await client.query(
          `INSERT INTO mcp_internal.schema_migrations
             (version, file_name, checksum, status, duration_ms, error_code)
           VALUES ($1, $2, $3, 'success', $4, NULL)`,
          [entry.version, entry.fileName, entry.checksum, Date.now() - startedAt],
        );
        if (inTransaction) await client.query('COMMIT');
        results.push({ version: entry.version, status: 'applied' });
        knownVersions.add(entry.version);
        logger.info?.({ event: 'migration_applied', version: entry.version });
      } catch (error) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        await client.query(
          `INSERT INTO mcp_internal.schema_migrations
             (version, file_name, checksum, status, duration_ms, error_code)
           VALUES ($1, $2, $3, 'failed', $4, $5)
           ON CONFLICT (version) DO UPDATE SET status = 'failed', error_code = EXCLUDED.error_code,
             duration_ms = EXCLUDED.duration_ms, applied_at = clock_timestamp()`,
          [entry.version, entry.fileName, entry.checksum, Date.now() - startedAt, safeErrorCode(error)],
        ).catch(() => {});
        throw new Error(`迁移执行失败：${entry.fileName}。`, { cause: error });
      }
    }
    if (knownVersions.has(RELEASE_CONTRACT_FILE.replace(/\.sql$/i, ''))) {
      await recordReleaseContract(client, entries, knownVersions);
    }
    return results;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
  }
}

export async function main({ env = process.env, logger = console, argv = process.argv.slice(2) } = {}) {
  const connectionString = env.MCP_MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('仅受控迁移通道可执行：缺少 MCP_MIGRATION_DATABASE_URL。');
  const client = new Client({ connectionString, application_name: 'ai-xing-mcp-migrator' });
  await client.connect();
  try {
    return await runMigrations({
      client,
      logger,
      adoptExisting: argv.includes('--adopt-existing'),
      includeIndexes: argv.includes('--include-indexes'),
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main({ logger: { info: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) } })
    .catch(() => { process.exitCode = 1; });
}
