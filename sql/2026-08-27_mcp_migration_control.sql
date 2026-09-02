-- Internal migration ledger used by mcp-server/scripts/migrate.mjs.
-- The application role cannot read or write this schema; only the controlled
-- migration connection should own it.

BEGIN;

CREATE SCHEMA IF NOT EXISTS mcp_internal;
REVOKE ALL ON SCHEMA mcp_internal FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS mcp_internal.schema_migrations (
  version TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  error_code TEXT,
  source_kind TEXT NOT NULL DEFAULT 'applied' CHECK (source_kind IN ('applied', 'adopted')),
  installed_by TEXT NOT NULL DEFAULT current_user
);

ALTER TABLE mcp_internal.schema_migrations
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'applied'
  CHECK (source_kind IN ('applied', 'adopted'));

REVOKE ALL ON TABLE mcp_internal.schema_migrations FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
