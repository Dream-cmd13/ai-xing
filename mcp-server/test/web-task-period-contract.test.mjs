import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readProjectFile = (relativePath) => readFile(path.join(projectRoot, relativePath), 'utf8');

test('TaskModal exposes date-derived weeks without an editable execution-week selector', async () => {
  const source = await readProjectFile('components/TaskModal.tsx');
  assert.match(source, /normalizeTaskPeriodFromDates/);
  assert.match(source, />所属周</);
  assert.doesNotMatch(source, /执行周期 \(可多选\)|同步为执行周范围|synchronizeTaskDatesToWeeks/);
  assert.doesNotMatch(source, /newTargetWeeks/);
});

test('web task persistence always derives target_weeks from final dates', async () => {
  const source = await readProjectFile('data.ts');
  assert.match(source, /normalizeTaskPeriodForPersistence/);
  assert.match(source, /deriveTaskWeeksFromDateRange/);
  assert.match(source, /target_weeks:\s*normalizedTask\.targetWeeks/);
  assert.match(source, /finalTask\s*=\s*hasCompleteDates[\s\S]{0,180}getTaskById\(taskId\)/);
});
