-- Private agent state only. Never copy public financial history into this table.
CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_state_expiry
  ON agent_state(expires_at) WHERE expires_at IS NOT NULL;
