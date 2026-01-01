-- Agent Trust Layer: Evaluation Runs
-- Tracks regression test runs for agent workflows ("golden tasks")
-- Used for drift detection across model/provider changes
--
-- Usage: Apply after 001_agent_action_events.sql

CREATE TABLE IF NOT EXISTS eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Run metadata
  suite_name TEXT NOT NULL,             -- e.g., "daily-brief", "billing-reconcile"
  model_id TEXT NOT NULL,               -- e.g., "claude-3-5-sonnet-20241022"
  provider TEXT NOT NULL DEFAULT 'anthropic',

  -- Results summary
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'error')),
  total_tasks INTEGER NOT NULL DEFAULT 0,
  passed_tasks INTEGER NOT NULL DEFAULT 0,
  failed_tasks INTEGER NOT NULL DEFAULT 0,

  -- Key metrics
  longest_correct_chain INTEGER,        -- Max consecutive correct tool calls
  tool_call_chain_length_max INTEGER,   -- Alias for above (more descriptive)
  intervention_count INTEGER DEFAULT 0, -- Human interventions needed
  total_duration_ms INTEGER,            -- Total runtime in milliseconds

  -- Detailed results
  task_results JSONB,                   -- Per-task breakdown with scores
  errors JSONB,                         -- Any errors encountered

  -- Drift detection
  baseline_run_id UUID REFERENCES eval_runs(id),
  drift_score NUMERIC CHECK (drift_score IS NULL OR (drift_score >= 0 AND drift_score <= 100)),
  drift_metadata JSONB                  -- Model version, config hashes, git SHA
);

-- Index: Find runs by suite (e.g., "all daily-brief runs")
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite
  ON eval_runs(suite_name, created_at DESC);

-- Index: Find runs by model
CREATE INDEX IF NOT EXISTS idx_eval_runs_model
  ON eval_runs(model_id, created_at DESC);

-- Index: Find runs by status
CREATE INDEX IF NOT EXISTS idx_eval_runs_status
  ON eval_runs(status, created_at DESC);

-- Index: Find baseline comparisons
CREATE INDEX IF NOT EXISTS idx_eval_runs_baseline
  ON eval_runs(baseline_run_id)
  WHERE baseline_run_id IS NOT NULL;

-- Index: Drift detection queries
CREATE INDEX IF NOT EXISTS idx_eval_runs_drift
  ON eval_runs(drift_score)
  WHERE drift_score IS NOT NULL;

-- Enable RLS (optional - comment out if not using Supabase/RLS)
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Service role has full access
DROP POLICY IF EXISTS "Service role full access" ON eval_runs;
CREATE POLICY "Service role full access" ON eval_runs
  FOR ALL USING (auth.role() = 'service_role');

-- Documentation
COMMENT ON TABLE eval_runs IS
  'Tracks evaluation runs for Agent Trust Layer. Used for regression testing and drift detection.';

COMMENT ON COLUMN eval_runs.longest_correct_chain IS
  'Maximum number of consecutive correct tool calls in the run. Key reliability metric.';

COMMENT ON COLUMN eval_runs.tool_call_chain_length_max IS
  'Alias for longest_correct_chain. Maximum correct tool calls in a single chain.';

COMMENT ON COLUMN eval_runs.drift_score IS
  '0-100 score indicating how much behavior drifted from baseline. 0=identical, 100=completely different.';

COMMENT ON COLUMN eval_runs.drift_metadata IS
  'JSON: {model_provider, model_name, model_version, tool_registry_hash, trust_config_hash, prompts_hash, git_commit_sha}';

-- Example drift_metadata structure:
-- {
--   "model_provider": "anthropic",
--   "model_name": "claude-3-5-sonnet",
--   "model_version": "20241022",
--   "tool_registry_hash": "sha256:abc123...",
--   "trust_config_hash": "sha256:def456...",
--   "prompts_hash": "sha256:ghi789...",
--   "git_commit_sha": "abc1234"
-- }
