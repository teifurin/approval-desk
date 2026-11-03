import { runMigrations } from "@agent-native/core/db";

export default runMigrations(
  [
    {
      version: 1,
      name: "approval-desk-core",
      sql: `CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  agent TEXT NOT NULL,
  caller TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('purchase', 'external_email', 'shell_command', 'merge_pr', 'delete_file', 'other')),
  title TEXT NOT NULL,
  reason TEXT,
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  payload TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  decided_by TEXT CHECK (decided_by IS NULL OR decided_by IN ('human', 'agent', 'policy')),
  rule_hits TEXT NOT NULL,
  execution_result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  executed_at TEXT
);
CREATE TABLE IF NOT EXISTS approval_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES approval_requests(id),
  owner_email TEXT NOT NULL,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('human', 'agent', 'policy')),
  channel TEXT NOT NULL,
  actor TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'reject', 'hold')),
  note TEXT,
  amended_from TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_policies (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('block_pattern', 'always_review', 'auto_approve_under', 'daily_auto_limit', 'hold_window')),
  params TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_requests_owner_created_idx ON approval_requests (owner_email, created_at);
CREATE INDEX IF NOT EXISTS approval_requests_owner_status_idx ON approval_requests (owner_email, status, created_at);
CREATE INDEX IF NOT EXISTS approval_requests_owner_type_idx ON approval_requests (owner_email, action_type, created_at);
CREATE INDEX IF NOT EXISTS approval_decisions_request_idx ON approval_decisions (request_id, created_at);
CREATE INDEX IF NOT EXISTS approval_decisions_owner_created_idx ON approval_decisions (owner_email, created_at);
CREATE INDEX IF NOT EXISTS approval_policies_owner_idx ON approval_policies (owner_email)`,
    },
    {
      version: 2,
      name: "approval-desk-approval-expiry",
      sql: `ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS approval_expires_at TEXT`,
    },
  ],
  { table: "approval_desk_migrations" },
);
