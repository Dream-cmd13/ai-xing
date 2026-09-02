import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readProjectFile = (relativePath) => readFile(path.join(projectRoot, relativePath), 'utf8');

test('data layer exposes database-owned review capability and atomic submit RPCs', async () => {
  const source = await readProjectFile('data.ts');

  assert.match(source, /export const getDepartmentReviewCapability\s*=/);
  assert.match(source, /\.rpc\(['"]web_get_department_review_capability['"]/);
  assert.match(source, /export const submitDepartmentReviewScoped\s*=/);
  assert.match(source, /\.rpc\(['"]web_submit_department_review_scoped['"]/);
  for (const parameter of [
    'p_department_id',
    'p_period_key',
    'p_entry',
    'p_task_updates',
    'p_expected_department_row_version',
    'p_request_id',
    'p_department_root_id',
    'p_department_node_path',
  ]) {
    assert.match(source, new RegExp(`\\b${parameter}\\b`));
  }
});

test('ReviewView uses the capability RPC and one atomic review submit', async () => {
  const source = await readProjectFile('components/ReviewView.tsx');
  const submitBlock = source.match(/const submitReview = async \(\) => \{([\s\S]*?)\r?\n  \};\r?\n\r?\n  const handleNumberInput/);
  assert.ok(submitBlock, 'submitReview implementation should be discoverable');

  assert.doesNotMatch(source, /\bcanManageReview\b/);
  assert.match(source, /getDepartmentReviewCapability/);
  assert.match(source, /reviewCapabilityLoading/);
  assert.match(source, /hasPermission\([\s\S]{0,180}['"]task-center['"]\s*,\s*['"]update['"]\)/);
  assert.match(source, /hasPermission\([\s\S]{0,180}['"]execution['"]\s*,\s*['"]update['"]\)/);
  assert.match(source, /canEditDeliverable\s*=\s*canEditReview\s*&&\s*canUpdateTaskMenu[\s\S]{0,100}!periodDataInvalid[\s\S]{0,100}canManageTask/);
  assert.match(submitBlock[1], /submitDepartmentReviewScoped/);
  assert.doesNotMatch(submitBlock[1], /persistTaskEntries/);
  assert.doesNotMatch(submitBlock[1], /handleSave\s*\(\s*\[['"]departments['"]\]\s*\)/);
});

test('task editing and review cards consume the shared period consistency contract', async () => {
  const [taskModal, reviewView] = await Promise.all([
    readProjectFile('components/TaskModal.tsx'),
    readProjectFile('components/ReviewView.tsx'),
  ]);

  assert.match(taskModal, /getTaskPeriodConsistency/);
  assert.match(taskModal, /normalizeTaskPeriodFromDates/);
  assert.doesNotMatch(taskModal, /synchronizeTaskDatesToWeeks|同步为执行周范围/);
  assert.match(reviewView, /getTaskWeekDisplay/);
  assert.match(reviewView, /任务周期尚未修复/);
  assert.match(reviewView, /getTaskPeriodConsistency\(task\)\.status !== 'valid'/);
});

test('ReviewView keeps background loading silent and renders the review content without entry animation', async () => {
  const reviewView = await readProjectFile('components/ReviewView.tsx');

  assert.doesNotMatch(reviewView, /正在加载当前周期任务/);
  assert.doesNotMatch(reviewView, /正在校验当前部门复盘权限/);
  assert.doesNotMatch(reviewView, /space-y-8 animate-in fade-in slide-in-from-bottom-4/);
  assert.match(reviewView, /taskScopeError\s*&&\s*!isTaskScopeLoading/);
  assert.match(reviewView, /reviewCapabilityError\s*&&\s*!reviewCapabilityLoading/);
});
