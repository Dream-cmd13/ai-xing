import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  checksum, MIGRATION_MANIFEST, RELEASE_ID, runMigrations, unwrapTransaction,
} from '../scripts/migrate.mjs';

test('publishes date-derived task week migrations as the latest release contract', () => {
  assert.equal(RELEASE_ID, '2026-09-01-task-date-weeks');
  assert.deepEqual(MIGRATION_MANIFEST.slice(-2), [
    '2026-09-01_task_date_derived_week_binding_contract.sql',
    '2026-09-01_task_date_derived_week_binding_readiness_gate.sql',
  ]);
});

function fakeClient(initial = [], { rejectedFunctionDefinition = null, releaseContract = null } = {}) {
  const calls = [];
  const history = new Map(initial.map((row) => [row.version, { ...row }]));
  const releaseContracts = new Map(releaseContract ? [[releaseContract.release_id, structuredClone(releaseContract)]] : []);
  const client = {
    calls,
    history,
    releaseContracts,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalized.startsWith('select pg_advisory_lock')) return { rows: [] };
      if (normalized.startsWith('select pg_advisory_unlock')) return { rows: [] };
      if (normalized.includes("to_regclass('public.tasks')")) {
        return { rows: [{ tasks: 'tasks', departments: 'departments', users: 'users', strategy: 'strategy' }] };
      }
      if (normalized.includes('pg_get_functiondef(to_regprocedure($1))')) {
        return { rows: [{ present: params[0] !== rejectedFunctionDefinition }] };
      }
      if (normalized.startsWith('select has_function_privilege')) {
        return { rows: [{ present: true }] };
      }
      if (normalized.startsWith('select to_regclass($1)') || normalized.startsWith('select to_regprocedure($1)')) {
        return { rows: [{ present: true }] };
      }
      if (normalized.startsWith('select version, file_name, checksum, status from mcp_internal.schema_migrations')) {
        if (normalized.includes('where version')) {
          const row = history.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        return { rows: [...history.values()] };
      }
      if (normalized.startsWith('select release_id, manifest_digest, required_versions from mcp_internal.release_contracts')) {
        const row = releaseContracts.get(params[0]);
        return { rows: row ? [structuredClone(row)] : [] };
      }
      if (normalized.startsWith('insert into mcp_internal.schema_migrations')) {
        history.set(params[0], {
          version: params[0], file_name: params[1], checksum: params[2],
          status: normalized.includes("'failed'") ? 'failed' : 'success',
        });
      }
      if (normalized.startsWith('insert into mcp_internal.release_contracts')) {
        releaseContracts.set(params[0], {
          release_id: params[0], manifest_digest: params[1],
          required_versions: JSON.parse(params[2]), deferred_indexes: JSON.parse(params[3]),
        });
      }
      if (normalized.startsWith('update mcp_internal.release_contracts set deferred_indexes')) {
        releaseContracts.get(params[0]).deferred_indexes = JSON.parse(params[1]);
      }
      return { rows: [] };
    },
  };
  return client;
}

test('unwraps a comment-prefixed transaction without touching quoted transaction words', () => {
  const sql = `-- release migration
BEGIN;
CREATE FUNCTION public.example() RETURNS text AS $fn$
BEGIN
  RETURN 'COMMIT;';
END;
$fn$ LANGUAGE plpgsql;
COMMIT;
-- trailing comment`;

  const body = unwrapTransaction(sql);
  assert.doesNotMatch(body, /^\s*BEGIN\s*;/i);
  assert.doesNotMatch(body, /COMMIT\s*;\s*$/i);
  assert.match(body, /RETURN 'COMMIT;'/);
  assert.match(body, /\$fn\$ LANGUAGE plpgsql;/);
});

test('records an immutable release digest and updates only deferred index state', async () => {
  const fake = fakeClient();
  await runMigrations({ client: fake, logger: { info() {} } });
  const first = structuredClone(fake.releaseContracts.get(RELEASE_ID));
  assert.match(first.manifest_digest, /^[0-9a-f]{64}$/);
  assert.equal(first.required_versions.length, MIGRATION_MANIFEST.length - 2);
  assert.equal(first.deferred_indexes['2026-08-27_mcp_task_indexes'], 'pending');

  await runMigrations({ client: fake, includeIndexes: true, logger: { info() {} } });
  const second = fake.releaseContracts.get(RELEASE_ID);
  assert.equal(second.manifest_digest, first.manifest_digest);
  assert.deepEqual(second.required_versions, first.required_versions);
  assert.equal(second.deferred_indexes['2026-08-27_mcp_task_indexes'], 'ready');
});

test('refuses to overwrite a mismatched release contract', async () => {
  const fake = fakeClient([], {
    releaseContract: {
      release_id: RELEASE_ID,
      manifest_digest: '0'.repeat(64),
      required_versions: [],
      deferred_indexes: {},
    },
  });
  await assert.rejects(runMigrations({ client: fake, logger: { info() {} } }), (error) => (
    error?.code === 'RELEASE_CONTRACT_MISMATCH'
  ));
  assert.equal(fake.releaseContracts.get(RELEASE_ID).manifest_digest, '0'.repeat(64));
});

test('rejects malformed or repeated top-level transaction envelopes', () => {
  for (const sql of [
    'SELECT 1; COMMIT;',
    'BEGIN; SELECT 1;',
    'BEGIN; BEGIN; SELECT 1; COMMIT;',
    'BEGIN; SELECT 1; COMMIT; SELECT 2;',
    'BEGIN; SELECT 1; COMMIT; COMMIT;',
  ]) {
    assert.throws(() => unwrapTransaction(sql), (error) => error?.code === 'MIGRATION_ENVELOPE_INVALID');
  }
});

test('keeps the single checksummed legacy no-envelope migration inside the runner transaction', async () => {
  const fake = fakeClient();
  await runMigrations({ client: fake, logger: { info() {} } });
  const readiness = fake.calls.find((call) => String(call.sql).includes('Minimal unauthenticated readiness probe'));
  assert.ok(readiness);
  const readinessIndex = fake.calls.indexOf(readiness);
  assert.equal(fake.calls[readinessIndex - 1].sql, 'BEGIN');
  assert.equal(fake.calls[readinessIndex + 2].sql, 'COMMIT');
});

test('applies the ordered manifest once and skips the same checksummed versions on replay', async () => {
  const fake = fakeClient();
  const logs = [];

  const first = await runMigrations({ client: fake, logger: { info: (event) => logs.push(event) } });
  const second = await runMigrations({ client: fake, logger: { info: (event) => logs.push(event) } });

  assert.equal(first.length, MIGRATION_MANIFEST.length);
  assert.equal(first.filter((item) => item.status === 'applied').length, MIGRATION_MANIFEST.length - 1);
  assert.equal(first.find((item) => item.status === 'deferred')?.version, '2026-08-27_mcp_task_indexes');
  assert.equal(second.filter((item) => item.status === 'skipped').length, MIGRATION_MANIFEST.length - 1);
  assert.equal(second.find((item) => item.status === 'deferred')?.version, '2026-08-27_mcp_task_indexes');
  assert.equal(fake.calls.filter((call) => call.sql.toLowerCase().includes('pg_advisory_lock')).length, 2);
  assert.equal(logs.filter((event) => event.event === 'migration_skipped').length, MIGRATION_MANIFEST.length - 1);
});

test('rejects a changed checksum before executing the migration', async () => {
  const fake = fakeClient([{
    version: MIGRATION_MANIFEST[0].replace(/\.sql$/i, ''),
    file_name: MIGRATION_MANIFEST[0], checksum: '0'.repeat(64), status: 'success',
  }]);

  await assert.rejects(
    runMigrations({ client: fake }),
    /校验和不一致/,
  );
  assert.equal(fake.calls.some((call) => call.sql === 'BEGIN'), false);
});

test('rejects a manifest gap when a later migration was already recorded', async () => {
  const laterFile = MIGRATION_MANIFEST[2];
  const later = laterFile.replace(/\.sql$/i, '');
  const laterSql = await readFile(new URL(`../../sql/${laterFile}`, import.meta.url), 'utf8');
  const fake = fakeClient([{ version: later, file_name: laterFile, checksum: checksum(laterSql), status: 'success' }]);

  await assert.rejects(
    runMigrations({ client: fake }),
    /迁移顺序错误/,
  );
});

test('adopts verified legacy objects before applying new migrations', async () => {
  const fake = fakeClient();
  const logs = [];

  const result = await runMigrations({
    client: fake, adoptExisting: true, logger: { info: (event) => logs.push(event) },
  });

  assert.equal(logs.filter((event) => event.event === 'migration_adopted').length, 7);
  assert.equal(result.filter((item) => item.status === 'skipped').length, 7);
  assert.equal(result.filter((item) => item.status === 'applied').length, MIGRATION_MANIFEST.length - 8);
  assert.equal(result.find((item) => item.status === 'deferred')?.version, '2026-08-27_mcp_task_indexes');
});

test('refuses legacy adoption when a security-critical function body is unexpected', async () => {
  const fake = fakeClient([], {
    rejectedFunctionDefinition: 'public.mcp_save_review_record(text,text,jsonb,bigint,text)',
  });

  await assert.rejects(
    runMigrations({ client: fake, adoptExisting: true }),
    /关键函数定义不符合预期/,
  );
  assert.equal(fake.history.size, 0);
  assert.equal(fake.calls.some((call) => call.sql === 'BEGIN'), false);
});

test('executes each concurrent index as its own statement only when explicitly enabled', async () => {
  const fake = fakeClient();

  await runMigrations({ client: fake, includeIndexes: true, logger: { info() {} } });

  const indexCalls = fake.calls.filter((call) => /^CREATE\s+INDEX\s+CONCURRENTLY/i.test(call.sql));
  assert.equal(indexCalls.length, 3);
  assert.equal(indexCalls.every((call) => !call.sql.includes(';')), true);
});

test('allows a deferred index to be applied after a later transactional migration', async () => {
  const fake = fakeClient();
  const first = await runMigrations({ client: fake });
  assert.equal(first.find((item) => item.status === 'deferred')?.version, '2026-08-27_mcp_task_indexes');
  for (const version of [
    '2026-08-29_nested_department_scope',
    '2026-08-29_nested_department_permission_alignment',
    '2026-08-29_department_tree_peer_read_visibility',
    '2026-08-29_department_tree_peer_read_performance',
    '2026-08-29_department_scope_task_read_performance',
    '2026-08-29_nested_department_task_write_trigger_alignment',
    '2026-08-30_mcp_department_okr_periods_fix',
    '2026-08-31_mcp_okr_contract_hardening',
    '2026-08-31_mcp_okr_task_attachment_fix',
    '2026-08-31_mcp_okr_task_attachment_json_fallback',
    '2026-08-31_mcp_okr_readiness_gate',
  ]) assert.equal(first.some((item) => item.version === version), true);

  const second = await runMigrations({ client: fake, includeIndexes: true });
  assert.equal(second.find((item) => item.status === 'applied')?.version, '2026-08-27_mcp_task_indexes');
  assert.equal(second.find((item) => item.status === 'deferred'), undefined);
});
