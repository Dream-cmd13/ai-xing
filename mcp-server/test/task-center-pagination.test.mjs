import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readMigration = () => readFile(
  path.join(projectRoot, 'sql', '2026-08-31_web_task_center_scoped_pagination.sql'),
  'utf8',
);

const readTaskCenterView = () => readFile(
  path.join(projectRoot, 'components', 'TaskCenterView.tsx'),
  'utf8',
);

const readDataLayer = () => readFile(path.join(projectRoot, 'data.ts'), 'utf8');

test('task center migration filters the department scope before keyset paging', async () => {
  const sql = await readMigration();

  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.web_get_task_center_page\s*\(/i);
  assert.match(sql, /p_department_id TEXT DEFAULT NULL/i);
  assert.match(sql, /p_scope TEXT DEFAULT 'all'/i);
  assert.match(sql, /mcp_collect_department_scope_ids\s*\(\s*p_department_id/i);
  assert.match(sql, /visible_scope_ids\s+AS\s+MATERIALIZED/i);
  assert.match(sql, /filtered\s+AS\s+MATERIALIZED/i);
  assert.match(sql, /p_department_id IS NULL OR scoped\.id IS NOT NULL/i);
  assert.match(sql, /task_row\.title ILIKE[\s\S]{0,120}owner_user\.name ILIKE/i);
  assert.match(sql, /ORDER BY updated_at DESC, id DESC/i);
  assert.match(sql, /p_cursor_updated_at/i);
  assert.match(sql, /p_cursor_id/i);
  assert.match(sql, /LIMIT v_limit \+ 1/i);
  assert.match(sql, /'hasMore', v_has_more/i);
  assert.match(sql, /'nextCursor'/i);
  assert.match(sql, /'total', v_total/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.web_get_task_center_page/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.web_get_task_center_page[\s\S]{0,180}TO authenticated/i);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE|UPSERT)\s+INTO\s+public\.(?:tasks|departments|users)/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('task center migration extends readiness with the scoped RPC contract', async () => {
  const sql = await readMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_get_readiness\s*\(/i);
  assert.match(sql, /web_get_task_center_page\(text,text,text,text,text,integer,bigint,text\)/i);
  assert.match(sql, /'taskCenterRpc'/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_get_readiness\(\) TO anon, authenticated/i);
});

test('task center organization view keeps its own scoped page state', async () => {
  const source = await readTaskCenterView();

  assert.match(source, /getTaskCenterPage/);
  assert.match(source, /departmentId:\s*selectedOrgDeptId/);
  assert.match(source, /scope:\s*selectedOrgDeptId\s*\?\s*'subtree'\s*:\s*'all'/);
  assert.match(source, /const \[orgTasks, setOrgTasks\]/);
  assert.match(source, /orgRequestIdRef/);
  assert.match(source, /loadOrgTasks\(false, orgCursor\)/);
  assert.doesNotMatch(source, /getTaskList/);
});

test('frontend scoped task reads fail closed except for explicit exact compatibility', async () => {
  const source = await readDataLayer();
  const start = source.indexOf('export const getVisibleTasksForScope');
  const end = source.indexOf('export const getTaskUsersForTasks', start);
  assert.ok(start >= 0 && end > start);
  const scopedReader = source.slice(start, end);

  assert.match(scopedReader, /if \(scope !== 'exact'\)[\s\S]{0,180}buildRpcNotConfiguredError/);
  assert.match(scopedReader, /supabase\.rpc\('web_get_visible_tasks_scope'/);
  assert.doesNotMatch(scopedReader, /const allTasks = await getTasks\(\)/);
  assert.doesNotMatch(scopedReader, /userDepartmentById/);
});
