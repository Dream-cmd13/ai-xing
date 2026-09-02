-- Phase 2: durable idempotency results and append-only MCP audit events.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mcp_write_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT public.audit_now_ms(),
  completed_at BIGINT,
  CONSTRAINT mcp_write_log_request_id_len
    CHECK (length(request_id) BETWEEN 8 AND 128),
  CONSTRAINT mcp_write_log_tool_name_len
    CHECK (length(tool_name) BETWEEN 1 AND 64),
  CONSTRAINT mcp_write_log_status
    CHECK (status IN ('pending', 'success')),
  CONSTRAINT mcp_write_log_unique
    UNIQUE (user_id, tool_name, request_id)
);

CREATE INDEX IF NOT EXISTS mcp_write_log_user_created_idx
  ON public.mcp_write_log (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.mcp_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  before_summary JSONB,
  after_summary JSONB,
  created_at BIGINT NOT NULL DEFAULT public.audit_now_ms(),
  CONSTRAINT mcp_audit_log_request_id_len
    CHECK (length(request_id) BETWEEN 8 AND 128),
  CONSTRAINT mcp_audit_log_tool_name_len
    CHECK (length(tool_name) BETWEEN 1 AND 64),
  CONSTRAINT mcp_audit_log_action
    CHECK (action IN ('create', 'update', 'submit', 'save_review')),
  CONSTRAINT mcp_audit_log_object_type
    CHECK (object_type IN ('task', 'department_review')),
  CONSTRAINT mcp_audit_log_status
    CHECK (status IN ('success', 'failed'))
);

CREATE INDEX IF NOT EXISTS mcp_audit_log_user_created_idx
  ON public.mcp_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_audit_log_object_created_idx
  ON public.mcp_audit_log (object_type, object_id, created_at DESC);

ALTER TABLE public.mcp_write_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY mcp_write_log_select ON public.mcp_write_log
  FOR SELECT TO authenticated
  USING (
    user_id = public.current_user_id()
    OR public.is_admin()
  );

CREATE POLICY mcp_audit_log_select ON public.mcp_audit_log
  FOR SELECT TO authenticated
  USING (
    user_id = public.current_user_id()
    OR public.is_admin()
  );

REVOKE ALL ON TABLE public.mcp_write_log FROM anon, authenticated;
REVOKE ALL ON TABLE public.mcp_audit_log FROM anon, authenticated;
GRANT SELECT ON TABLE public.mcp_write_log TO authenticated;
GRANT SELECT ON TABLE public.mcp_audit_log TO authenticated;

COMMIT;
