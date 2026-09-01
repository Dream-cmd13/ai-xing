import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { config as loadDotEnv } from 'dotenv';
import pg from 'pg';

import { getIsoWeekRange } from '../src/task-period-defaults.mjs';

const { Client } = pg;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 把查询到的任务行规划为“按目标周补齐空起止时间”的修复计划：
 * start_date 为空取最早目标周的周一，due_date 为空取最晚目标周的周日，
 * 时间戳约定与线上写入一致（日期 + 12:00 UTC）。已有值一律不修改；
 * 目标周次无效或不存在的任务跳过并给出原因，不做部分填充。
 */
export function planTaskPeriodBackfill(rows) {
  const updates = [];
  const skipped = [];
  for (const row of rows ?? []) {
    const weeks = Array.isArray(row.targetWeeks) ? [...row.targetWeeks].sort() : [];
    if (weeks.length === 0) {
      skipped.push({ id: row.id, title: row.title, reason: 'NO_TARGET_WEEKS' });
      continue;
    }
    const needsStart = row.startDate === null || row.startDate === undefined;
    const needsDue = row.dueDate === null || row.dueDate === undefined;
    if (!needsStart && !needsDue) {
      skipped.push({ id: row.id, title: row.title, reason: 'ALREADY_FILLED' });
      continue;
    }
    const first = getIsoWeekRange(weeks[0]);
    const last = getIsoWeekRange(weeks[weeks.length - 1]);
    if (needsStart && !first) {
      skipped.push({ id: row.id, title: row.title, reason: `INVALID_WEEK:${weeks[0]}` });
      continue;
    }
    if (needsDue && !last) {
      skipped.push({ id: row.id, title: row.title, reason: `INVALID_WEEK:${weeks[weeks.length - 1]}` });
      continue;
    }
    updates.push({
      id: row.id,
      title: row.title,
      weeks,
      startDate: needsStart ? first.startDate : row.startDate,
      dueDate: needsDue ? last.dueDate : row.dueDate,
    });
  }
  return { updates, skipped };
}

function normalizeRow(raw) {
  return {
    id: raw.id,
    title: raw.title,
    targetWeeks: Array.isArray(raw.target_weeks) ? raw.target_weeks : [],
    startDate: raw.start_date === null || raw.start_date === undefined ? null : Number(raw.start_date),
    dueDate: raw.due_date === null || raw.due_date === undefined ? null : Number(raw.due_date),
  };
}

export async function runTaskPeriodBackfill({ client, execute = false, logger = console } = {}) {
  if (!client) throw new Error('缺少数据库客户端。');
  const result = await client.query(`
    SELECT id, title, target_weeks, start_date, due_date
    FROM tasks
    WHERE target_weeks IS NOT NULL
      AND jsonb_typeof(target_weeks) = 'array'
      AND jsonb_array_length(target_weeks) > 0
      AND (start_date IS NULL OR due_date IS NULL)
    ORDER BY id
  `);
  const plan = planTaskPeriodBackfill((result.rows ?? []).map(normalizeRow));
  for (const update of plan.updates) {
    logger.info?.({
      event: 'backfill_plan',
      taskId: update.id,
      title: update.title,
      targetWeeks: update.weeks,
      startDate: update.startDate,
      dueDate: update.dueDate,
    });
  }
  for (const skip of plan.skipped) {
    logger.info?.({ event: 'backfill_skipped', taskId: skip.id, title: skip.title, reason: skip.reason });
  }
  const summary = {
    candidates: plan.updates.length + plan.skipped.length,
    planned: plan.updates.length,
    skipped: plan.skipped.length,
  };
  if (!execute) {
    const dryRun = { ...summary, executed: false };
    logger.info?.({ event: 'backfill_dry_run', ...dryRun, hint: '确认清单无误后追加 --execute 执行。' });
    return { ...dryRun, updates: plan.updates, skipped: plan.skipped };
  }
  let applied = 0;
  await client.query('BEGIN');
  try {
    for (const update of plan.updates) {
      // WHERE 兜底再次校验空值，保证只填充空字段、不覆盖并发写入的值。
      const updated = await client.query(
        'UPDATE tasks SET start_date = $2, due_date = $3 WHERE id = $1 AND (start_date IS NULL OR due_date IS NULL)',
        [update.id, update.startDate, update.dueDate],
      );
      applied += updated.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  logger.info?.({ event: 'backfill_executed', ...summary, applied });
  return { ...summary, executed: true, applied, updates: plan.updates, skipped: plan.skipped };
}

function resolveConnectionString(env) {
  const direct = env.MCP_BACKFILL_DATABASE_URL;
  if (direct) return direct;
  const { SUPABASE_DB_HOST: host, SUPABASE_DB_PORT: port, SUPABASE_DB_NAME: name, SUPABASE_DB_USER: user, SUPABASE_DB_PASSWORD: password } = env;
  if (host && name && user && password) {
    const encoded = encodeURIComponent(password);
    return `postgresql://${encodeURIComponent(user)}:${encoded}@${host}:${port || 5432}/${name}`;
  }
  throw new Error('缺少数据库连接：请设置 MCP_BACKFILL_DATABASE_URL，或 SUPABASE_DB_HOST/PORT/NAME/USER/PASSWORD。');
}

export async function main({ env = process.env, logger = console, argv = process.argv.slice(2) } = {}) {
  loadDotEnv({ path: path.resolve(projectRoot, '.env') });
  loadDotEnv({ path: path.resolve(projectRoot, 'mcp-server', '.env') });
  const execute = argv.includes('--execute');
  const client = new Client({
    connectionString: resolveConnectionString(env),
    application_name: 'ai-xing-mcp-task-period-backfill',
  });
  await client.connect();
  try {
    return await runTaskPeriodBackfill({ client, execute, logger });
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
