import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function migration(name) {
  return readFile(path.join(projectRoot, 'sql', name), 'utf8');
}

function assertTransactional(sql) {
  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
}

test('phase-two SQL is limited to the two approved additive migrations', async () => {
  const sqlFiles = [
    '2026-08-21_mcp_write_infra_tables.sql',
    '2026-08-21_mcp_write_rpc.sql',
  ];
  const names = await (await import('node:fs/promises')).readdir(path.join(projectRoot, 'sql'));
  assert.deepEqual(
    names.filter((name) => name.startsWith('2026-08-21_mcp_') && name.endsWith('.sql')).sort(),
    sqlFiles,
  );
  assert.equal(names.includes('2026-08-21_tighten_processes_rls.sql'), false);
  const sql = (await Promise.all(sqlFiles.map(migration))).join('\n');
  assert.doesNotMatch(sql, /(?:DROP|ALTER)\s+POLICY\s+\S+\s+ON\s+public\.(?:processes|tasks|departments)/i);
  assert.doesNotMatch(sql, /CREATE\s+POLICY\s+processes_/i);
  assert.doesNotMatch(sql, /DROP\s+POLICY/i);
});

test('write infrastructure migration provides unique idempotency and append-only audit RLS', async () => {
  const sql = await migration('2026-08-21_mcp_write_infra_tables.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.mcp_write_log/i);
  assert.match(sql, /UNIQUE\s*\(\s*user_id\s*,\s*tool_name\s*,\s*request_id\s*\)/i);
  assert.match(sql, /CHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'success'\s*\)\s*\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.mcp_audit_log/i);
  assert.match(sql, /CHECK\s*\(\s*status\s+IN\s*\(\s*'success'\s*,\s*'failed'\s*\)\s*\)/i);
  assert.match(sql, /ALTER TABLE public\.mcp_write_log ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE public\.mcp_audit_log ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /CREATE POLICY mcp_write_log_select[\s\S]*user_id\s*=\s*public\.current_user_id\s*\(\s*\)/i);
  assert.match(sql, /CREATE POLICY mcp_audit_log_select[\s\S]*user_id\s*=\s*public\.current_user_id\s*\(\s*\)/i);
  assert.doesNotMatch(sql, /CREATE POLICY\s+\S+\s+ON public\.mcp_(?:write|audit)_log\s+FOR\s+(?:INSERT|UPDATE|DELETE)/i);
});

test('write RPC migration defines the complete transactional security boundary', async () => {
  const sql = await migration('2026-08-21_mcp_write_rpc.sql');

  assertTransactional(sql);
  for (const functionName of [
    'current_user_can_edit_department_reviews',
    'mcp_create_pad_task',
    'mcp_update_pad_task',
    'mcp_submit_pad_task',
    'mcp_save_review_record',
    'mcp_record_failed_write',
  ]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\s*\\(`, 'i'));
  }
  const createdFunctions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\s*\(/gi)]
    .map((match) => match[1]);
  assert.deepEqual(createdFunctions, [
    'current_user_can_edit_department_reviews',
    'mcp_create_pad_task',
    'mcp_update_pad_task',
    'mcp_submit_pad_task',
    'mcp_save_review_record',
    'mcp_record_failed_write',
  ]);
  assert.equal((sql.match(/SECURITY DEFINER/gi) ?? []).length >= 6, true);
  assert.equal((sql.match(/SET search_path\s*=\s*public/gi) ?? []).length >= 6, true);
  assert.match(sql, /ON CONFLICT\s*\(\s*user_id\s*,\s*tool_name\s*,\s*request_id\s*\)\s*DO NOTHING/i);
  assert.match(sql, /MCP_PERMISSION_DENIED:/);
  assert.match(sql, /MCP_VERSION_CONFLICT:/);
  assert.match(sql, /MCP_REQUEST_IN_FLIGHT:/);
  assert.match(sql, /MCP_VALIDATION:/);
  assert.match(sql, /row_version\s*=\s*[^,;]+\+\s*1/i);
  assert.match(sql, /current_user_can_edit_department_reviews\s*\(\s*p_department_id\s*\)/i);
  assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.mcp_create_pad_task[\s\S]{0,180}FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/i);
  assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.mcp_create_pad_task[\s\S]{0,120}TO\s+authenticated/i);
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.mcp_(?:create|update|submit|save|record_failed)[\s\S]{0,120}TO\s+anon/i);
});

test('task RPC contract keeps MCP writes within current website behavior', async () => {
  const sql = await migration('2026-08-21_mcp_write_rpc.sql');

  assert.match(sql, /NEW|current_user_department_id/i);
  assert.match(sql, /current_id\s*:=\s*public\.current_user_id\s*\(\s*\)/i);
  assert.match(sql, /owner_id_value\s*:=\s*COALESCE\([\s\S]{0,120}current_id/i);
  assert.match(sql, /\^\\d\{4\}-W\(0\[1-9\]\|\[1-4\]\\d\|5\[0-3\]\)\$/);
  assert.match(sql, /due_date[\s\S]{0,300}start_date/i);
  assert.match(sql, /participant_ids[\s\S]{0,500}public\.users/i);
  assert.match(sql, /approver_ids[\s\S]{0,500}public\.users/i);
  assert.match(sql, /p_changes\s*\?\s*'department_id'[\s\S]{0,240}MCP_VALIDATION:/i);
  assert.match(sql, /p_changes\s*\?\s*'owner_id'[\s\S]{0,400}(?:is_admin|MCP_PERMISSION_DENIED:)/i);
});

test('review RPC enforces menu permission, target department scope and row version', async () => {
  const sql = await migration('2026-08-21_mcp_write_rpc.sql');

  assert.match(sql, /current_user_can_save_departments\s*\(\s*\)/i);
  assert.match(sql, /current_user_can_manage_department_tree/i);
  assert.match(sql, /current_user_department_id\s*\(\s*\)/i);
  assert.match(sql, /mcp_save_review_record[\s\S]*p_expected_row_version/i);
  assert.match(sql, /UPDATE public\.departments[\s\S]*row_version\s*=\s*(?:row_version|department_row\.row_version)\s*\+\s*1[\s\S]*row_version\s*=\s*p_expected_row_version/i);
});

test('phase-two SQL never contains credentials or high-privilege Supabase keys', async () => {
  const sql = (await Promise.all([
    migration('2026-08-21_mcp_write_infra_tables.sql'),
    migration('2026-08-21_mcp_write_rpc.sql'),
  ])).join('\n');

  assert.doesNotMatch(sql, /(?:Authorization\s*:|Basic\s+[A-Za-z0-9+/=]+|SUPABASE_(?:SECRET|SERVICE)_ROLE_KEY\s*=|JWT\s*[:=]|refresh[_ ]?token\s*[:=])/i);
});

test('name identity migration is additive, read-only and authenticated-only', async () => {
  const sql = await migration('2026-08-25_mcp_name_identity_queries.sql');
  assertTransactional(sql);
  for (const functionName of ['mcp_resolve_users_by_name', 'mcp_query_user_tasks', 'mcp_get_weekly_review_gaps']) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\s*\\(`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,500}SECURITY DEFINER`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,460}STABLE`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,600}SET search_path\\s*=\\s*public`, 'i'));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${functionName}[\\s\\S]{0,180}TO authenticated`, 'i'));
  }
  assert.match(sql, /RETURNS JSONB/i);
  assert.match(sql, /p_relation TEXT DEFAULT 'owner'/i);
  assert.match(sql, /p_month_start BIGINT DEFAULT NULL/i);
  assert.match(sql, /p_week_id TEXT/i);
  assert.match(sql, /p_user_id IS NULL[\s\S]{0,180}p_relation IS NULL/i);
  assert.match(sql, /p_month_start IS NULL[\s\S]{0,420}p_month_end <= p_month_start/i);
  assert.match(sql, /v_name IS NULL/i);
  assert.match(sql, /p_week_id IS NULL/i);
  assert.match(sql, /MCP_VALIDATION: invalid week/i);
  assert.match(sql, /taskEvaluations/i);
  assert.match(sql, /card_evaluation/i);
  assert.match(sql, /MCP_DEPARTMENT_NOT_FOUND:/i);
  assert.match(sql, /MCP_DEPARTMENT_NAME_AMBIGUOUS:/i);
  assert.match(sql, /public\.is_employee\(\)[\s\S]{0,180}public\.current_user_id\(\)/i);
  assert.match(sql, /public\.is_manager\(\)[\s\S]{0,220}current_user_department_id/i);
  assert.match(sql, /t\.start_date\s+IS NOT NULL/i);
  assert.match(sql, /array_remove\(/i);
  assert.match(sql, /department_name/i);
  assert.match(sql, /task_department_name/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mcp_resolve_users_by_name/i);
  assert.match(sql, /FROM PUBLIC, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('task defaults, people and manager submit migration stays within the approved boundary', async () => {
  const sql = await migration('2026-08-25_mcp_task_defaults_people_submit.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_task_people\s*\(\s*p_task_ids TEXT\[\]/i);
  assert.match(sql, /cardinality\s*\(\s*p_task_ids\s*\)\s*>\s*50/i);
  assert.match(sql, /current_user_can_view_task/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_create_pad_task\s*\(/i);
  assert.match(sql, /NOT\s*\(\s*p_task\s*\?\s*'target_weeks'\s*\)[\s\S]{0,160}NOT\s*\(\s*p_task\s*\?\s*'start_date'\s*\)[\s\S]{0,160}NOT\s*\(\s*p_task\s*\?\s*'due_date'\s*\)/i);
  assert.match(sql, /target_weeks[\s\S]*start_date[\s\S]*due_date[\s\S]*Asia\/Shanghai/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_submit_pad_task\s*\(/i);
  assert.match(sql, /public\.is_manager\s*\(\s*\)[\s\S]{0,700}old_task\.created_by\s*=\s*current_id/i);
  assert.match(sql, /old_task\.department_id\s*=\s*public\.current_user_department_id\s*\(\s*\)/i);
  assert.match(sql, /owner_department_id\s*=\s*public\.current_user_department_id\s*\(\s*\)/i);
  assert.match(sql, /ON CONFLICT\s*\(\s*user_id\s*,\s*tool_name\s*,\s*request_id\s*\)\s*DO NOTHING/i);
  assert.match(sql, /row_version\s*=\s*old_task\.row_version\s*\+\s*1/i);
  assert.match(sql, /INSERT INTO public\.mcp_audit_log/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_get_task_people\s*\(\s*TEXT\[\]\s*\) TO authenticated/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|CREATE\s+TRIGGER|DROP\s+TRIGGER/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('P1 hardening keeps save_review_record from accepting task card fields', async () => {
  const sql = await migration('2026-08-26_mcp_p1_hardening.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_review_entry_has_task_fields\s*\(\s*p_value JSONB/i);
  assert.match(sql, /ALTER FUNCTION public\.mcp_save_review_record\(TEXT, TEXT, JSONB, BIGINT, TEXT\)\s+RENAME TO/i);
  assert.match(sql, /mcp_review_entry_has_task_fields\s*\(\s*p_entry->'okrDetails'\s*\)/i);
  assert.match(sql, /MCP_VALIDATION: 任务复盘请通过 commit_update_pad_task 提交/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mcp_save_review_record_impl_20260826/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_save_review_record\(TEXT, TEXT, JSONB, BIGINT, TEXT\)[\s\S]{0,120}TO authenticated/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|DROP\s+TABLE/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('review-slot hardening validates real KR bounds and malformed JSON without unbounded growth', async () => {
  const sql = await migration('2026-08-27_mcp_review_slot_hardening.sql');
  const baseReviewSync = await migration('2026-08-25_mcp_task_review_sync_rpc.sql');
  const reviewSyncWrapper = sql.slice(sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_with_review_sync(',
  ));

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_validate_task_review_slot\s*\(/i);
  assert.match(sql, /regexp_match\s*\(\s*v_task\.aligned_kr_id/i);
  assert.match(sql, /jsonb_array_length\s*\(\s*okr->'keyResults'\s*\)/i);
  assert.match(sql, /jsonb_typeof\s*\(\s*v_okr_details\s*\)/i);
  assert.match(sql, /jsonb_typeof\s*\(\s*v_kr_reviews\s*\)/i);
  assert.match(sql, /KR_INDEX_OUT_OF_RANGE/i);
  assert.match(sql, /FROM public\.tasks WHERE id = p_task_id FOR UPDATE/i);
  assert.match(sql, /FROM public\.departments WHERE id = v_task\.department_id FOR UPDATE/i);
  assert.match(sql, /d\.id\s*=\s*v_task\.department_id/i);
  assert.match(sql, /v_kr_count\s*>\s*101/i);
  assert.match(sql, /jsonb_array_length\s*\(\s*v_kr_reviews\s*\)\s*>\s*101/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_read_task_review_card\s*\(/i);
  assert.match(sql, /reviewState|card_state/i);
  assert.match(sql, /REVIEW_PERIOD_FORMAT_INVALID/i);
  assert.match(sql, /mcp_update_pad_task_with_review_sync_impl_20260827/i);
  assert.match(reviewSyncWrapper, /FROM public\.mcp_write_log[\s\S]*status\s*=\s*'success'/i);
  assert.match(reviewSyncWrapper, /jsonb_build_object\s*\(\s*'replayed'\s*,\s*true\s*,\s*'result'\s*,\s*v_prior_result\s*\)/i);
  assert.ok(
    reviewSyncWrapper.indexOf('FROM public.mcp_write_log')
      < reviewSyncWrapper.indexOf('mcp_validate_task_review_slot'),
    'successful request replay must be checked before current review-slot validation',
  );
  assert.doesNotMatch(sql, /WHILE\s+jsonb_array_length\s*\(\s*kr_reviews\s*\)\s*<=\s*p_kr_index/i);
  assert.doesNotMatch(baseReviewSync, /WHILE\s+jsonb_array_length\s*\(\s*kr_reviews\s*\)\s*<=\s*p_kr_index/i);
  assert.match(baseReviewSync, /p_kr_index\s*>\s*100/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('pagination migration returns independent cursors and stable keyset pages', async () => {
  const sql = await migration('2026-08-27_mcp_task_pagination.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_personal_workbench_page\s*\(/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_visible_tasks_page\s*\(/i);
  assert.match(sql, /ORDER BY\s+updated_at\s+DESC\s*,\s*id\s+DESC/i);
  assert.match(sql, /hasMore/i);
  assert.match(sql, /nextCursor/i);
  assert.match(sql, /p_cursor_updated_at/i);
  assert.match(sql, /p_cursor_id/i);
  assert.match(sql, /LIMIT\s+v_limit\s*\+\s*1/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('web task loading migration provides bounded single-request and scoped RPCs', async () => {
  const sql = await migration('2026-08-28_web_task_load_p0_p1.sql');

  assertTransactional(sql);
  for (const functionName of ['web_get_visible_tasks_full', 'web_get_visible_tasks_scope']) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\s*\\(`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,500}RETURNS JSONB`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,700}SECURITY DEFINER`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,760}SET search_path\\s*=\\s*public`, 'i'));
  }
  assert.match(sql, /p_limit INTEGER DEFAULT 10000/i);
  assert.match(sql, /LEAST\s*\(\s*GREATEST\s*\(\s*COALESCE\(p_limit, 10000\)/i);
  assert.match(sql, /LIMIT\s+v_limit\s*\+\s*1/i);
  assert.match(sql, /public\.get_visible_tasks_full\s*\(\s*\)/i);
  assert.match(sql, /p_week_ids TEXT\[\]/i);
  assert.match(sql, /cardinality\s*\(\s*p_week_ids\s*\)/i);
  assert.match(sql, /\?\|\s*p_week_ids/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.web_get_visible_tasks_full\(INTEGER\) TO authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.web_get_visible_tasks_scope\(TEXT, TEXT\[\], INTEGER\) TO authenticated/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_visible_tasks_page\s*\(/i);
  assert.match(sql, /v_is_admin\s+BOOLEAN/i);
  assert.match(sql, /visible_departments\s+AS\s+MATERIALIZED/i);
  assert.doesNotMatch(sql, /JOIN\s+public\.get_current_user_visible_task_ids\s*\(\s*\)/i);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.web_get_visible_tasks_(?:full|scope)[^\n]*TO anon/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('readiness and index migrations contain only bounded operational checks', async () => {
  const readiness = await migration('2026-08-27_mcp_readiness.sql');
  const indexes = await migration('2026-08-27_mcp_task_indexes.sql');
  const webTask = await migration('2026-08-28_web_task_load_p0_p1.sql');

  assert.match(readiness, /CREATE OR REPLACE FUNCTION public\.mcp_get_readiness\s*\(/i);
  assert.match(readiness, /to_regprocedure/i);
  assert.match(readiness, /GRANT EXECUTE ON FUNCTION public\.mcp_get_readiness\(\) TO anon, authenticated/i);
  assert.doesNotMatch(readiness, /FROM\s+public\.(?:tasks|departments|users|strategy)/i);
  assert.match(indexes, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/i);
  assert.match(indexes, /updated_at\s+DESC\s*,\s*id\s+DESC/i);
  assert.match(indexes, /target_weeks\s+jsonb_path_ops/i);
  assert.match(webTask, /web_get_visible_tasks_full\(integer\)/i);
  assert.match(webTask, /web_get_visible_tasks_scope\(text,text\[\],integer\)/i);
  assert.doesNotMatch(`${readiness}\n${indexes}\n${webTask}`, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('migration control provides an append-only internal checksum ledger', async () => {
  const sql = await migration('2026-08-27_mcp_migration_control.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS mcp_internal/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mcp_internal\.schema_migrations/i);
  assert.match(sql, /version TEXT PRIMARY KEY/i);
  assert.match(sql, /checksum TEXT NOT NULL/i);
  assert.match(sql, /status TEXT NOT NULL CHECK/i);
  assert.match(sql, /source_kind TEXT NOT NULL DEFAULT 'applied'/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('OKR query migration is additive, read-only and authenticated-only', async () => {
  const sql = await migration('2026-08-28_mcp_okr_queries.sql');

  assertTransactional(sql);
  for (const functionName of ['mcp_get_company_okrs', 'mcp_get_department_okrs']) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\s*\\(`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,600}SECURITY DEFINER`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,660}STABLE`, 'i'));
    assert.match(sql, new RegExp(`${functionName}[\\s\\S]{0,800}SET search_path\\s*=\\s*public`, 'i'));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${functionName}[\\s\\S]{0,180}TO authenticated`, 'i'));
    assert.doesNotMatch(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${functionName}[\\s\\S]{0,180}TO anon`, 'i'));
  }
  for (const helperName of [
    'mcp_collect_department_okr_nodes',
    'mcp_find_department_node',
    'mcp_attach_tasks_to_okrs',
    'mcp_normalize_okr_entries',
  ]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${helperName}\\s*\\(`, 'i'));
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${helperName}`, 'i'));
  }
  // 任务反查必须显式过可见性谓词（SECURITY DEFINER 下 RLS 不生效）。
  assert.match(sql, /aligned_kr_id\s*=\s*ANY\s*\(\s*v_slots\s*\)/i);
  assert.match(sql, /public\.current_user_can_view_task\s*\(\s*\n?[\s\S]{0,200}t\.participant_ids[\s\S]{0,80}t\.approver_ids/i);
  // 部门可见性过滤与错误前缀。
  assert.match(sql, /current_user_has_department_visibility\s*\(\s*p_node->>'id'\s*\)/i);
  assert.match(sql, /MCP_PERMISSION_DENIED: department is not visible/i);
  assert.match(sql, /MCP_DEPARTMENT_NOT_FOUND:/i);
  assert.match(sql, /MCP_VALIDATION: invalid (?:year|period)/i);
  // 结果集上限。
  assert.match(sql, /LEAST\s*\(\s*GREATEST\s*\(\s*COALESCE\(p_limit, 20\)\s*,\s*1\)\s*,\s*50\)/i);
  assert.match(sql, /generate_series\s*\(\s*0\s*,\s*LEAST\s*\(\s*v_kr_count,\s*20\s*\)\s*-\s*1\s*\)/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|CREATE\s+TRIGGER|DROP\s+TRIGGER|INSERT\s+INTO\s+public\.|UPDATE\s+public\.|DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('department OKR period fix preserves object-shaped periods when tasks are attached', async () => {
  const sql = await migration('2026-08-30_mcp_department_okr_periods_fix.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_department_okrs\s*\(/i);
  assert.match(sql, /LANGUAGE plpgsql SECURITY DEFINER STABLE/i);
  assert.match(sql, /SET search_path = public/i);
  assert.match(sql, /jsonb_object_agg\s*\(\s*period_key\s*,\s*public\.mcp_attach_tasks_to_okrs/i);
  assert.doesNotMatch(sql, /jsonb_agg\s*\(\s*jsonb_build_object\s*\(\s*period_key/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mcp_get_department_okrs\(TEXT, INTEGER, TEXT, BOOLEAN, INTEGER\)/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_get_department_okrs\(TEXT, INTEGER, TEXT, BOOLEAN, INTEGER\)\s+TO authenticated/i);
  assert.doesNotMatch(sql, /GRANT EXECUTE[^;]+TO anon/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+TABLE|INSERT\s+INTO\s+public\.|UPDATE\s+public\.|DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('OKR contract hardening normalizes legacy aliases and keeps readiness truthful', async () => {
  const sql = await migration('2026-08-31_mcp_okr_contract_hardening.sql');

  assertTransactional(sql);
  for (const functionName of [
    'mcp_okr_text',
    'mcp_okr_id',
    'mcp_okr_objective',
    'mcp_okr_key_results_raw',
    'mcp_okr_key_results',
    'mcp_normalize_okr_entry',
    'mcp_normalize_okr_entries',
  ]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\s*\\(`, 'i'));
  }
  assert.match(sql, /ARRAY\s*\[\s*'objective',\s*'title',\s*'goal',\s*'description'/i);
  assert.match(sql, /ARRAY\s*\[\s*'keyResults',\s*'key_results',\s*'krs'/i);
  assert.match(sql, /'OKR_OBJECTIVE_MISSING'/i);
  assert.match(sql, /'KR_FORMAT_INVALID'/i);
  assert.match(sql, /'dataQuality'/i);
  assert.match(sql, /Keep empty slots so legacy aligned_kr_id indexes never shift/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_collect_department_okr_nodes[\s\S]{0,7000}mcp_normalize_okr_entries/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_company_okrs\s*\([\s\S]{0,2500}jsonb_typeof\(v_company_okrs\) = 'array'/i);
  assert.match(sql, /mcp_get_department_okrs_scope_v2\(text,text,integer,text,boolean,integer\)/i);
  assert.match(sql, /2026-08-31_mcp_okr_contract_hardening/i);
  assert.match(sql, /migrationVersion[\s\S]{0,800}FROM mcp_internal\.schema_migrations/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|CREATE\s+TRIGGER|DROP\s+TRIGGER|INSERT\s+INTO\s+public\.|UPDATE\s+public\.|DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('OKR task attachment reads the JSONB entry from the ordinality record', async () => {
  const sql = await migration('2026-08-31_mcp_okr_task_attachment_fix.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_attach_tasks_to_okrs\s*\(/i);
  assert.match(sql, /v_okr_record\s+RECORD/i);
  assert.match(sql, /SELECT\s+value\s+AS\s+entry\s*,\s*ordinality/i);
  assert.match(sql, /v_entry\s*:=\s*v_okr_record\.entry/i);
  assert.match(sql, /aligned_kr_id\s*=\s*ANY\s*\(\s*v_slots\s*\)/i);
  assert.match(sql, /public\.current_user_can_view_task\s*\(/i);
  assert.match(sql, /LEAST\(v_kr_count,\s*20\)/i);
  assert.doesNotMatch(sql, /v_entry\s*:=\s*v_okr->'value'/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|CREATE\s+TRIGGER|DROP\s+TRIGGER|INSERT\s+INTO\s+public\.|UPDATE\s+public\.|DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('OKR task attachment uses a valid JSONB fallback for empty KR text', async () => {
  const sql = await migration('2026-08-31_mcp_okr_task_attachment_json_fallback.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_attach_tasks_to_okrs\s*\(/i);
  assert.match(sql, /COALESCE\(v_entry->'keyResults'->v_kr_index,\s*to_jsonb\('\'::TEXT\)\)/i);
  assert.match(sql, /v_entry\s*:=\s*v_okr_record\.entry/i);
  assert.doesNotMatch(sql, /COALESCE\(v_entry->'keyResults'->v_kr_index,\s*''\)/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|CREATE\s+TRIGGER|DROP\s+TRIGGER|INSERT\s+INTO\s+public\.|UPDATE\s+public\.|DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('OKR readiness stays degraded until both attachment fixes are recorded', async () => {
  const sql = await migration('2026-08-31_mcp_okr_readiness_gate.sql');

  assertTransactional(sql);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_readiness\s*\(/i);
  assert.match(sql, /2026-08-31_mcp_okr_task_attachment_fix/i);
  assert.match(sql, /2026-08-31_mcp_okr_task_attachment_json_fallback/i);
  assert.match(sql, /status\s*=\s*'success'/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_get_readiness\(\) TO anon, authenticated/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|CREATE\s+TRIGGER|DROP\s+TRIGGER|INSERT\s+INTO\s+public\.|UPDATE\s+public\.|DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('review data preflight is read-only and returns identifiers instead of review content', async () => {
  const sql = await migration('2026-08-27_mcp_review_data_scan.sql');

  assert.match(sql, /ALIGNED_KR_ID_INVALID/i);
  assert.match(sql, /REVIEW_PERIOD_FORMAT_INVALID/i);
  assert.match(sql, /OKR_DETAILS_FORMAT_INVALID/i);
  assert.match(sql, /KR_REVIEWS_OUT_OF_RANGE/i);
  assert.match(sql, /SELECT object_type, object_id, json_path, reason/i);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});
