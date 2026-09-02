import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function migration() {
  return readFile(path.join(projectRoot, 'sql', '2026-08-29_nested_department_scope.sql'), 'utf8');
}

async function permissionAlignmentMigration() {
  return readFile(path.join(projectRoot, 'sql', '2026-08-29_nested_department_permission_alignment.sql'), 'utf8');
}

async function peerReadVisibilityMigration() {
  return readFile(path.join(projectRoot, 'sql', '2026-08-29_department_tree_peer_read_visibility.sql'), 'utf8');
}

async function peerReadPerformanceMigration() {
  return readFile(path.join(projectRoot, 'sql', '2026-08-29_department_tree_peer_read_performance.sql'), 'utf8');
}

async function scopedTaskReadPerformanceMigration() {
  return readFile(path.join(projectRoot, 'sql', '2026-08-29_department_scope_task_read_performance.sql'), 'utf8');
}

async function nestedTaskWriteTriggerMigration() {
  return readFile(path.join(projectRoot, 'sql', '2026-08-29_nested_department_task_write_trigger_alignment.sql'), 'utf8');
}

test('nested department migration is transactional and additive', async () => {
  const sql = await migration();
  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.doesNotMatch(sql, /\b(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i);
});

test('nested department tree has bounded recursion, cycle protection and manager identity compatibility', async () => {
  const sql = await migration();
  assert.match(sql, /WITH\s+RECURSIVE\s+tree\s+AS/i);
  assert.match(sql, /tree\.depth\s*<\s*100/i);
  assert.match(sql, /NOT\s*\(\s*\(child\.value->>'id'\)\s*=\s*ANY\s*\(tree\.node_path\)\s*\)/i);
  assert.match(sql, /u\.id::TEXT/i);
  assert.match(sql, /u\.username/i);
  assert.match(sql, /u\.name/i);
  assert.match(sql, /resolved\.id::TEXT/i);
  assert.match(sql, /HAVING\s+count\(\*\)\s*=\s*1/i);
  assert.match(sql, /IF\s+NOT\s+public\.is_manager\(\)\s+THEN\s+RETURN\s+FALSE/i);

  const managerJoinStart = sql.indexOf('LEFT JOIN LATERAL (');
  const managerJoinEnd = sql.indexOf(') manager ON TRUE', managerJoinStart);
  const managerResolution = sql.slice(managerJoinStart, managerJoinEnd);
  const priorityChecks = [
    "btrim(u.id::TEXT) = btrim(COALESCE(tree.node->>'managerUserId'",
    "btrim(u.username) = btrim(COALESCE(tree.node->>'managerUserId'",
    "btrim(u.name) = btrim(COALESCE(tree.node->>'managerUserId'",
    "btrim(u.username) = btrim(COALESCE(tree.node->>'managerName'",
    "btrim(u.name) = btrim(COALESCE(tree.node->>'managerName'",
  ].map((fragment) => managerResolution.indexOf(fragment));
  assert.ok(priorityChecks.every((position) => position >= 0));
  assert.deepEqual([...priorityChecks].sort((left, right) => left - right), priorityChecks);
  assert.equal((managerResolution.match(/HAVING count\(\*\) = 1/g) || []).length, 5);
});

test('scope defaults and bounded people/task reads are explicit', async () => {
  const sql = await migration();
  assert.match(sql, /v_scope\s*:=\s*CASE\s+WHEN[\s\S]{0,180}hasChildren[\s\S]{0,80}'subtree'[\s\S]{0,80}'exact'/i);
  assert.match(sql, /mcp_get_department_people[\s\S]{0,1200}LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 50\)/i);
  assert.match(sql, /mcp_get_department_tasks_page[\s\S]{0,1200}LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 50\)/i);
  assert.match(sql, /scope_ids\s+AS\s+MATERIALIZED/i);
  assert.match(sql, /visible_scope_ids\s+AS\s+MATERIALIZED/i);
  assert.match(sql, /ORDER BY\s+updated_at\s+DESC\s*,\s*id\s+DESC/i);
  assert.match(sql, /p_scope\s+TEXT\s+DEFAULT\s+'auto'/i);
});

test('department visibility permits only the caller branch and scoped reads precompute visible nodes', async () => {
  const sql = await migration();
  const alignment = await permissionAlignmentMigration();
  const visibilityStart = alignment.indexOf('CREATE OR REPLACE FUNCTION public.mcp_current_user_can_see_department_node');
  const visibilityEnd = alignment.indexOf('\n$$;', visibilityStart);
  const visibility = alignment.slice(visibilityStart, visibilityEnd);
  assert.match(visibility, /WITH\s+nodes\s+AS\s+MATERIALIZED/i);
  assert.match(visibility, /JOIN\s+public\.jsonb_text_values\(COALESCE\(v_permissions/i);
  assert.match(visibility, /(?:target_node\.node_id\s*=\s*permitted\.node_id|permitted\.node_id\s*=\s*target_node\.node_id)/i);
  assert.match(visibility, /WHERE\s+node_id\s*=\s*v_current_department_id/i);
  assert.match(visibility, /WHERE\s+node_id\s*=\s*p_target_id/i);
  assert.match(visibility, /target_node\.node_path\[1:cardinality\(current_node\.node_path\)\]\s*=\s*current_node\.node_path/i);
  assert.match(visibility, /current_node\.node_path\[1:cardinality\(target_node\.node_path\)\]\s*=\s*target_node\.node_path/i);

  const resolverStart = alignment.indexOf('CREATE OR REPLACE FUNCTION public.mcp_resolve_department');
  const resolverEnd = alignment.indexOf('\n$$;', resolverStart);
  const resolver = alignment.slice(resolverStart, resolverEnd);
  assert.match(resolver, /v_target_is_ancestor\s+BOOLEAN/i);
  assert.match(resolver, /IF\s+v_target_is_ancestor[\s\S]{0,140}v_scope\s*:=\s*'exact'/i);

  for (const functionName of ['mcp_get_department_tasks_page', 'web_get_visible_tasks_scope_v2', 'mcp_get_weekly_review_gaps_scope_v2']) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
    const end = sql.indexOf('\n$$;', start);
    const definition = sql.slice(start, end);
    assert.match(definition, /visible_scope_ids\s+AS\s+MATERIALIZED/i);
    assert.match(definition, /visible_scope\.id\s+IS\s+NOT\s+NULL/i);
    assert.doesNotMatch(definition, /OR\s+public\.mcp_current_user_can_see_department_node\s*\(\s*COALESCE\(t\.department_id/i);
  }
});

test('scoped writes enforce recursive people permissions and confirmation metadata', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_validate_task_people\s*\(/i);
  assert.match(sql, /mcp_validate_task_people\([\s\S]{0,500}participant_ids[\s\S]{0,500}approver_ids/i);
  assert.match(sql, /mcp_current_user_manages_department_node\(v_user_department\)/i);
  assert.match(sql, /mcp_validate_task_people\([\s\S]{0,500}v_task->'participant_ids'/i);
  assert.match(sql, /mcp_validate_task_people\([\s\S]{0,500}v_old\.participant_ids/i);
  assert.match(sql, /mcp_validate_task_people\([\s\S]{0,500}v_old_task\.participant_ids/i);
  assert.match(sql, /p_department_root_id\s+IS NOT NULL[\s\S]{0,180}v_node\.root_id/i);
  assert.match(sql, /p_department_node_path\s+IS NOT NULL[\s\S]{0,180}v_node\.node_path/i);
  assert.match(sql, /row_version\s*=\s*v_root\.row_version\s*\+\s*1/i);
  assert.match(sql, /ON CONFLICT\s*\(\s*user_id\s*,\s*tool_name\s*,\s*request_id\s*\)\s*DO NOTHING/i);

  const taskManageStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.current_user_can_manage_task');
  const taskManageEnd = sql.indexOf('\n$$;', taskManageStart);
  const taskManage = sql.slice(taskManageStart, taskManageEnd);
  assert.match(taskManage, /task_owner_id\s*=\s*v_current_id\s+THEN\s+RETURN\s+TRUE/i);
  assert.match(taskManage, /task_participant_ids[^\n]{0,120}jsonb_build_array\(v_current_id\)/i);
  assert.doesNotMatch(taskManage, /task_approver_ids[^\n]{0,120}jsonb_build_array\(v_current_id\)/i);
});

test('scoped review keeps legacy period formats, score bounds and task-card sync path', async () => {
  const sql = await migration();
  assert.match(sql, /p_period_key !~ '[^']*W\(0\[1-9\][^']*'\s*\n?\s*AND p_period_key !~ '[^']*\(0\[1-9\]\|1\[0-2\]\)/i);
  assert.match(sql, /p_period_key !~ '[^']*Q\[1-4\]/i);
  assert.match(sql, /score 必须在 0 到 100 之间/i);
  assert.match(sql, /mcp_jsonb_set_department_reviews\([\s\S]{0,500}v_node\.node_id/i);
  assert.match(sql, /mcp_jsonb_contains_task_review_fields\(p_entry\)[\s\S]{0,180}commit_update_pad_task/i);
  assert.match(sql, /v_key IN \('taskEvaluations', 'taskScores'\)/i);
  assert.match(sql, /ancestor\.node->'okrs'/i);
  assert.match(sql, /year_entry\.year_key\s*=\s*v_period_year/i);
  assert.match(sql, /p_kr_index\s*>=\s*COALESCE\(v_nested_kr_count, 0\)/i);
  assert.match(sql, /p_department_node_path\s+IS\s+NULL/i);
  assert.match(sql, /p_department_node_path\s+IS\s+DISTINCT\s+FROM\s+v_node\.node_path/i);
});

test('nested OKR recursion accepts both child-key spellings', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_collect_department_okr_nodes\s*\(/i);
  assert.match(sql, /jsonb_array_elements\(public\.mcp_nested_department_children\(p_node\)\)/i);
  assert.match(sql, /mcp_collect_department_okr_nodes\([\s\S]{0,180}v_child/i);
  const wrapperStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mcp_get_department_okrs_scope_v2');
  const wrapperEnd = sql.indexOf('\n$$;', wrapperStart);
  const wrapper = sql.slice(wrapperStart, wrapperEnd);
  assert.doesNotMatch(wrapper, /FOR\s+v_id\s+IN/i);
  assert.match(wrapper, /mcp_collect_department_okr_nodes\(v_start_node/i);
});

test('name resolution applies auto subtree semantics when a parent department is supplied', async () => {
  const sql = await migration();
  assert.match(sql, /v_department_has_children\s+BOOLEAN/i);
  assert.match(sql, /user_node\.node_path\[1:cardinality\(v_department_path\)\]\s*=\s*v_department_path/i);
  assert.match(sql, /NOT\s+v_department_has_children[\s\S]{0,120}user_node\.node_id\s*=\s*v_department_id/i);
  assert.match(sql, /p_purpose IN \('participant', 'approver'\) OR public\.mcp_current_user_can_see_department_node/i);
});

test('nested RPCs are security-definer, fixed-search-path and authenticated-only', async () => {
  const sql = await migration();
  const definitions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(mcp_[a-z0-9_]+|web_get_visible_tasks_scope_v2)\s*\(/gi)]
    .map((match) => match[1]);
  assert.ok(definitions.includes('mcp_resolve_department'));
  assert.ok(definitions.includes('mcp_get_department_people'));
  assert.ok(definitions.includes('mcp_get_department_tasks_page'));
  assert.ok(definitions.includes('mcp_create_pad_task_scoped'));
  assert.ok(definitions.includes('mcp_save_review_record_scoped'));
  for (const name of ['mcp_resolve_department', 'mcp_get_department_people', 'mcp_get_department_tasks_page', 'mcp_create_pad_task_scoped', 'mcp_save_review_record_scoped']) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const end = sql.indexOf('\n$$;', start);
    const definition = sql.slice(start, end);
    assert.match(definition, /SECURITY DEFINER/i);
    assert.match(definition, /SET search_path\s*=\s*public/i);
  }
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.(?!mcp_get_readiness\(\))[^\n]+ TO anon/i);
  assert.doesNotMatch(sql, /(?:auth_id|password|refresh[_ ]?token|Authorization|JWT|permission_json)/i);
});

test('readiness reports the nested department release only when its required RPCs exist', async () => {
  const sql = await migration();
  const readinessStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mcp_get_readiness');
  const readinessEnd = sql.indexOf('\n$$;', readinessStart);
  const readiness = sql.slice(readinessStart, readinessEnd);
  assert.match(readiness, /'migrationVersion'\s*,\s*'2026-08-29'/i);
  for (const signature of [
    'mcp_resolve_department\\(text,text,text\\)',
    'mcp_get_department_people\\(text,text,integer,text,text\\)',
    'mcp_get_department_tasks_page\\(text,text,text,text,text,integer,bigint,text\\)',
    'mcp_create_pad_task_scoped\\(jsonb,text\\)',
    'mcp_update_pad_task_with_review_sync_scoped\\(text,jsonb,text,text,integer,bigint,bigint,text,text,text\\[\\]\\)',
    'web_get_visible_tasks_scope_v2\\(text,text\\[\\],integer,text\\)',
  ]) {
    assert.match(readiness, new RegExp(signature, 'i'));
  }
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_get_readiness\(\) TO anon, authenticated/i);
});

test('permission alignment is a follow-up migration and keeps the registered scope migration immutable', async () => {
  const sql = await permissionAlignmentMigration();
  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_current_user_can_see_department_node/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_resolve_department/i);
  assert.match(sql, /FROM\s+target_node\s+target_node/i);
  assert.match(sql, /target_node\.root_id\s*=\s*current_node\.root_id/i);
  assert.match(sql, /WITH\s+nodes\s+AS\s+MATERIALIZED/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_resolve_department\(TEXT, TEXT, TEXT\) TO authenticated/i);
  assert.doesNotMatch(sql, /\b(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i);

  const original = await migration();
  assert.match(original, /CREATE OR REPLACE FUNCTION public\.mcp_current_user_can_see_department_node/i);
  assert.match(original, /CREATE OR REPLACE FUNCTION public\.mcp_resolve_department/i);
});

test('peer read visibility migration shares one root without widening write authorization', async () => {
  const sql = await peerReadVisibilityMigration();
  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.doesNotMatch(sql, /\b(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|UPDATE\s+public\.(?:tasks|departments|users))\b/i);

  const readStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mcp_current_user_can_see_department_node');
  const readEnd = sql.indexOf('\n$$;', readStart);
  const readDefinition = sql.slice(readStart, readEnd);
  assert.match(readDefinition, /WITH\s+nodes\s+AS\s+MATERIALIZED/i);
  assert.match(readDefinition, /target_node\.root_id\s*=\s*current_node\.root_id/i);
  assert.doesNotMatch(readDefinition, /target_node\.node_path\[1:cardinality\(current_node\.node_path\)\]/i);

  const writeStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mcp_current_user_can_write_department_node');
  const writeEnd = sql.indexOf('\n$$;', writeStart);
  const writeDefinition = sql.slice(writeStart, writeEnd);
  assert.match(writeDefinition, /target_node\.node_path\[1:cardinality\(current_node\.node_path\)\]\s*=\s*current_node\.node_path/i);
  assert.match(writeDefinition, /current_node\.node_path\[1:cardinality\(target_node\.node_path\)\]\s*=\s*target_node\.node_path/i);

  const resolverStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mcp_resolve_department');
  const resolverEnd = sql.indexOf('\n$$;', resolverStart);
  const resolver = sql.slice(resolverStart, resolverEnd);
  assert.match(resolver, /v_scope\s*:=\s*CASE\s+WHEN[\s\S]{0,180}hasChildren[\s\S]{0,80}'subtree'[\s\S]{0,80}'exact'/i);
  assert.doesNotMatch(resolver, /v_target_is_ancestor/i);
  assert.doesNotMatch(resolver, /mcp_current_user_manages_department_node[\s\S]{0,120}v_scope\s*:=\s*'exact'/i);

  const reviewStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.current_user_can_edit_department_reviews');
  const reviewEnd = sql.indexOf('\n$$;', reviewStart);
  const reviewDefinition = sql.slice(reviewStart, reviewEnd);
  assert.match(reviewDefinition, /mcp_current_user_can_write_department_node\(p_department_id\)/i);
  assert.doesNotMatch(reviewDefinition, /mcp_current_user_can_see_department_node\(p_department_id\)/i);

  assert.match(sql, /ALTER\s+FUNCTION\s+public\.mcp_create_pad_task_scoped\(JSONB,\s*TEXT\)\s+RENAME\s+TO\s+mcp_create_pad_task_scoped_branch_impl_20260829/i);
  assert.match(sql, /CREATE\s+FUNCTION\s+public\.mcp_create_pad_task_scoped\s*\(/i);
  assert.match(sql, /NOT\s+public\.mcp_current_user_can_write_department_node\(v_department_id\)/i);
  assert.match(sql, /RETURN\s+public\.mcp_create_pad_task_scoped_branch_impl_20260829\(p_task,\s*p_request_id\)/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mcp_current_user_can_write_department_node\(TEXT\)[\s\S]{0,100}authenticated/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mcp_create_pad_task_scoped_branch_impl_20260829\(JSONB, TEXT\)[\s\S]{0,100}authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_create_pad_task_scoped\(JSONB, TEXT\) TO authenticated/i);
});

test('peer read performance migration avoids manager expansion for same-root checks', async () => {
  const sql = await peerReadPerformanceMigration();
  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.doesNotMatch(sql, /\b(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|UPDATE\s+public\.(?:tasks|departments|users))\b/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_department_tree_paths\s*\(/i);
  assert.match(sql, /WITH\s+RECURSIVE\s+tree\s+AS/i);
  assert.match(sql, /tree\.depth\s*<\s*100/i);
  assert.match(sql, /NOT\s*\(\(child\.value->>'id'\)\s*=\s*ANY\s*\(tree\.node_path\)\)/i);

  const readStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mcp_current_user_can_see_department_node');
  const readEnd = sql.indexOf('\n$$;', readStart);
  const readDefinition = sql.slice(readStart, readEnd);
  assert.match(readDefinition, /WITH\s+paths\s+AS\s+MATERIALIZED/i);
  assert.match(readDefinition, /FROM\s+public\.mcp_department_tree_paths\(\)/i);
  assert.match(readDefinition, /v_current_root_id\s*=\s*v_target_root_id/i);
  assert.match(readDefinition, /mcp_current_user_manages_department_node\(p_target_id\)/i);
  assert.match(readDefinition, /jsonb_text_values\(COALESCE\(v_permissions/i);
  assert.doesNotMatch(readDefinition, /mcp_department_tree_nodes\(\)/i);
  assert.doesNotMatch(readDefinition, /manager_user_id/i);

  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mcp_department_tree_paths\(\)[\s\S]{0,100}authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_current_user_can_see_department_node\(TEXT\) TO authenticated/i);
});

test('scoped task read performance migration short-circuits visible departments', async () => {
  const sql = await scopedTaskReadPerformanceMigration();
  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.doesNotMatch(sql, /\b(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|UPDATE\s+public\.(?:tasks|departments|users))\b/i);

  for (const functionName of ['mcp_get_department_tasks_page', 'web_get_visible_tasks_scope_v2']) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
    const end = sql.indexOf('\n$$;', start);
    const definition = sql.slice(start, end);
    assert.match(definition, /v_current_user_id\s+TEXT\s*:=\s*public\.current_user_id\(\)/i);
    assert.match(definition, /v_is_admin\s+BOOLEAN\s*:=\s*public\.is_admin\(\)/i);
    const visiblePosition = definition.indexOf('visible_scope.id IS NOT NULL');
    const adminPosition = definition.indexOf('v_is_admin', visiblePosition);
    const currentUserCallPosition = definition.indexOf('public.current_user_id()', visiblePosition);
    assert.ok(visiblePosition >= 0);
    assert.ok(adminPosition > visiblePosition);
    assert.equal(currentUserCallPosition, -1);
  }

  const taskStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mcp_get_department_tasks_page');
  const taskEnd = sql.indexOf('\n$$;', taskStart);
  const taskDefinition = sql.slice(taskStart, taskEnd);
  assert.match(taskDefinition, /nodes\s+AS\s+MATERIALIZED\s*\(\s*SELECT\s+node_id,\s*node_name/i);
  assert.equal((taskDefinition.match(/mcp_department_tree_nodes\(\)/g) || []).length, 1);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_get_department_tasks_page\(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT\)\s+TO authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.web_get_visible_tasks_scope_v2\(TEXT, TEXT\[\], INTEGER, TEXT\)\s+TO authenticated/i);
});

test('nested task write trigger aligns manager writes without using read visibility', async () => {
  const sql = await nestedTaskWriteTriggerMigration();
  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.doesNotMatch(sql, /\b(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|UPDATE\s+public\.(?:tasks|departments|users))\b/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.enforce_task_owner_scope\(\)/i);
  assert.match(sql, /SET search_path\s*=\s*public/i);
  assert.match(sql, /TG_OP\s*=\s*'INSERT'[\s\S]{0,700}mcp_current_user_manages_department_node\(NEW\.department_id\)/i);
  assert.match(sql, /mcp_current_user_manages_department_node\(owner_department_id\)/i);
  assert.match(sql, /NEW\.department_id\s+IS\s+DISTINCT\s+FROM\s+current_department_id/i);
  assert.match(sql, /NEW\.owner_id\s+IS\s+DISTINCT\s+FROM\s+current_id/i);
  assert.match(sql, /TG_OP\s*=\s*'UPDATE'[\s\S]{0,700}mcp_current_user_manages_department_node\(NEW\.department_id\)/i);
  assert.doesNotMatch(sql, /mcp_current_user_can_see_department_node|current_user_has_department_visibility/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.enforce_task_owner_scope\(\)[\s\S]{0,100}authenticated/i);
});
