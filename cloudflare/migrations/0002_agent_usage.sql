-- Private application inference ledger. Costs are integer millionths of a neuron.
-- Every attempt is reserved before calling Workers AI; unknown outcomes retain cost.
CREATE TABLE IF NOT EXISTS agent_usage (
  owner TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0 AND attempt < 2),
  utc_date TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_profile_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  reserved_microneurons INTEGER NOT NULL CHECK (reserved_microneurons > 0),
  charged_microneurons INTEGER NOT NULL CHECK (charged_microneurons >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('reserved', 'succeeded', 'failed', 'outcome_unknown')),
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  error_category TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY (owner, reservation_id),
  UNIQUE (owner, job_id, attempt)
);
CREATE INDEX IF NOT EXISTS agent_usage_owner_date ON agent_usage(owner, utc_date);
CREATE INDEX IF NOT EXISTS agent_usage_owner_outcome ON agent_usage(owner, outcome, settled_at);
CREATE INDEX IF NOT EXISTS agent_usage_owner_open_day ON agent_usage(owner, outcome, utc_date);
