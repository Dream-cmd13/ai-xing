import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { config as loadDotEnv } from 'dotenv';
import pg from 'pg';

import { deriveTaskWeeksFromDateRange } from '../src/task-period-defaults.mjs';

const { Client } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKFILL_LOCK_KEY = 'ai-xing:task-date-weeks:v1';

function canonicalWeeks(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((week) => typeof week === 'string'))].sort();
}

function sameWeeks(left, right) {
  return left.length === right.length && left.every((week, index) => week === right[index]);
}

function planDigest(updates) {
  const snapshot = updates.map(({ id, rowVersion, oldWeeks, expectedWeeks, startDate, dueDate }) => ({
    id, rowVersion, oldWeeks, expectedWeeks, startDate, dueDate,
  }));
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

export function planTaskPeriodBackfill(rows) {
  const updates = [];
  const exceptions = [];
  for (const row of rows ?? []) {
    const normalized = {
      id: String(row.id),
      rowVersion: Number(row.rowVersion ?? row.row_version ?? 0),
      oldWeeks: Array.isArray(row.targetWeeks ?? row.target_weeks)
        ? structuredClone(row.targetWeeks ?? row.target_weeks)
        : [],
      startDate: row.startDate ?? row.start_date,
      dueDate: row.dueDate ?? row.due_date,
    };
    if (normalized.startDate === null || normalized.startDate === undefined
      || normalized.dueDate === null || normalized.dueDate === undefined) {
      exceptions.push({ id: normalized.id, rowVersion: normalized.rowVersion, reason: 'MISSING_DATE' });
      continue;
    }
    try {
      const expectedWeeks = deriveTaskWeeksFromDateRange(
        Number(normalized.startDate),
        Number(normalized.dueDate),
      ).targetWeeks;
      if (!sameWeeks(normalized.oldWeeks, expectedWeeks)
        || !sameWeeks(canonicalWeeks(normalized.oldWeeks), expectedWeeks)) {
        updates.push({
          ...normalized,
          startDate: Number(normalized.startDate),
          dueDate: Number(normalized.dueDate),
          expectedWeeks,
        });
      }
    } catch (error) {
      exceptions.push({
        id: normalized.id,
        rowVersion: normalized.rowVersion,
        reason: /53/.test(error?.message ?? '') ? 'DATE_RANGE_TOO_LONG' : 'DATE_RANGE_INVALID',
      });
    }
  }
  updates.sort((left, right) => left.id.localeCompare(right.id));
  exceptions.sort((left, right) => left.id.localeCompare(right.id));
  return { updates, exceptions, digest: planDigest(updates) };
}

async function readPlan(client) {
  const result = await client.query(`
    SELECT id, target_weeks, start_date, due_date, row_version
    FROM public.tasks
    ORDER BY id
  `);
  return planTaskPeriodBackfill(result.rows ?? []);
}

function assertExecutionConfirmation(plan, expectedCount, expectedDigest) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || typeof expectedDigest !== 'string') {
    throw new Error('执行回填必须提供 dry-run 的确认数量和摘要。');
  }
  if (plan.updates.length !== expectedCount || plan.digest !== expectedDigest) {
    throw new Error('回填快照数量或摘要已变化，操作已取消。');
  }
}

export async function runTaskPeriodBackfill({
  client,
  execute = false,
  expectedCount,
  expectedDigest,
  logger = console,
} = {}) {
  if (!client) throw new Error('缺少数据库客户端。');
  const dryPlan = await readPlan(client);
  for (const exception of dryPlan.exceptions) {
    logger.info?.({ event: 'backfill_exception', taskId: exception.id, rowVersion: exception.rowVersion, reason: exception.reason });
  }
  const baseSummary = {
    planned: dryPlan.updates.length,
    exceptions: dryPlan.exceptions.length,
    digest: dryPlan.digest,
  };
  if (!execute) {
    const result = { ...baseSummary, executed: false, updates: dryPlan.updates, exceptionRows: dryPlan.exceptions };
    logger.info?.({ event: 'backfill_dry_run', ...baseSummary, executed: false });
    return result;
  }

  assertExecutionConfirmation(dryPlan, expectedCount, expectedDigest);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [BACKFILL_LOCK_KEY]);
    const protectedTriggers = await client.query(`
      SELECT trigger_row.tgname AS trigger_name, trigger_proc.proname AS function_name
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_proc AS trigger_proc ON trigger_proc.oid = trigger_row.tgfoid
      WHERE trigger_row.tgrelid = 'public.tasks'::regclass
        AND trigger_row.tgname IN (
          'enforce_task_owner_scope_on_tasks',
          'mcp_validate_task_row_contract_trigger'
        )
        AND NOT trigger_row.tgisinternal
    `);
    const triggerFunctions = new Map((protectedTriggers.rows ?? [])
      .map((row) => [row.trigger_name, row.function_name]));
    if (triggerFunctions.get('enforce_task_owner_scope_on_tasks') !== 'enforce_task_owner_scope'
      || triggerFunctions.get('mcp_validate_task_row_contract_trigger') !== 'mcp_validate_task_row_contract') {
      throw new Error('任务保护触发器身份不符合预期，操作已取消。');
    }
    await client.query('ALTER TABLE public.tasks DISABLE TRIGGER enforce_task_owner_scope_on_tasks');
    await client.query('ALTER TABLE public.tasks DISABLE TRIGGER mcp_validate_task_row_contract_trigger');
    const lockedPlan = await readPlan(client);
    assertExecutionConfirmation(lockedPlan, expectedCount, expectedDigest);

    let applied = 0;
    for (const update of lockedPlan.updates) {
      const result = await client.query(`
        UPDATE public.tasks
        SET target_weeks = $2::JSONB,
            row_version = row_version + 1
        WHERE id = $1
          AND row_version = $3
          AND target_weeks = $4::JSONB
          AND start_date = $5
          AND due_date = $6
      `, [
        update.id,
        JSON.stringify(update.expectedWeeks),
        update.rowVersion,
        JSON.stringify(update.oldWeeks),
        update.startDate,
        update.dueDate,
      ]);
      if (result.rowCount !== 1) throw new Error(`任务 ${update.id} 的行版本或周期快照已变化。`);
      applied += 1;
    }

    await client.query('ALTER TABLE public.tasks ENABLE TRIGGER mcp_validate_task_row_contract_trigger');
    await client.query('ALTER TABLE public.tasks ENABLE TRIGGER enforce_task_owner_scope_on_tasks');
    const postPlan = await readPlan(client);
    if (postPlan.updates.length !== 0) throw new Error('回填后仍存在日期有效的周绑定异常。');
    await client.query('COMMIT');
    const result = {
      ...baseSummary,
      executed: true,
      applied,
      remainingExceptions: postPlan.exceptions.length,
    };
    logger.info?.({ event: 'backfill_executed', ...result });
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function resolveConnectionString(env) {
  if (env.MCP_BACKFILL_DATABASE_URL) return env.MCP_BACKFILL_DATABASE_URL;
  const {
    SUPABASE_DB_HOST: host,
    SUPABASE_DB_PORT: port,
    SUPABASE_DB_NAME: name,
    SUPABASE_DB_USER: user,
    SUPABASE_DB_PASSWORD: password,
  } = env;
  if (host && name && user && password) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port || 5432}/${name}`;
  }
  throw new Error('缺少数据库连接配置。');
}

function readArgument(argv, name) {
  const prefix = `${name}=`;
  const value = argv.find((item) => item.startsWith(prefix));
  return value?.slice(prefix.length);
}

export async function main({ env = process.env, logger = console, argv = process.argv.slice(2) } = {}) {
  loadDotEnv({ path: path.resolve(projectRoot, '.env') });
  loadDotEnv({ path: path.resolve(projectRoot, 'mcp-server', '.env') });
  const execute = argv.includes('--execute');
  const expectedCountValue = readArgument(argv, '--expected-count');
  const expectedDigest = readArgument(argv, '--expected-digest');
  const expectedCount = expectedCountValue === undefined ? undefined : Number(expectedCountValue);
  const client = new Client({
    connectionString: resolveConnectionString(env),
    application_name: 'ai-xing-mcp-task-period-backfill',
  });
  await client.connect();
  try {
    return await runTaskPeriodBackfill({ client, execute, expectedCount, expectedDigest, logger });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main({ logger: { info: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) } })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ event: 'backfill_failed', message: error?.message ?? String(error) })}\n`);
      process.exitCode = 1;
    });
}
