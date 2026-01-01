-- Agent Trust Layer: Agent Action Events
-- Audit trail for all agent tool calls and workflow actions
--
-- Usage: Apply this migration first when setting up ATL

CREATE TABLE IF NOT EXISTS agent_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Context: Which workflow and agent
  domain TEXT NOT NULL,                 -- Your domain identifier (e.g., "asi", "land")
  workflow_name TEXT NOT NULL,          -- e.g., "daily_brief", "compliance_audit"
  agent_name TEXT NOT NULL,             -- "planner" | "worker" | "reviewer"
  run_id UUID NOT NULL,                 -- Ties all events for one workflow run

  -- Trust classification
  trust_level TEXT NOT NULL CHECK (trust_level IN ('L0', 'L1', 'L2', 'L3', 'L4')),
  stage TEXT NOT NULL CHECK (stage IN ('plan', 'execute', 'review', 'commit')),
  intent TEXT NOT NULL,                 -- Human-readable description of action

  -- Tool execution details
  tool_name TEXT,                       -- Which tool was called (null for non-tool events)
  tool_args JSONB,                      -- Arguments passed to tool
  tool_result JSONB,                    -- Result returned from tool

  -- Artifacts and status
  artifact_refs JSONB,                  -- Links to PDFs, docs, PRs, etc.
  warnings JSONB,                       -- Non-fatal issues encountered
  errors JSONB,                         -- Errors that occurred

  -- Scoring and summary
  summary TEXT,                         -- Brief description of what happened
  confidence NUMERIC,                   -- Agent's confidence in action (0-1)

  -- Approval + sandbox support (for L3+ operations)
  approval_request_id UUID,             -- Links to approval_requests table
  sandbox_id TEXT,                      -- Docker container or sandbox identifier
  sandbox_artifacts TEXT[]              -- Artifact paths from sandboxed execution
);

-- Index: Find all events for a specific workflow run
CREATE INDEX IF NOT EXISTS idx_agent_action_events_run
  ON agent_action_events(run_id);

-- Index: Query by domain and workflow (e.g., "all daily_brief runs")
CREATE INDEX IF NOT EXISTS idx_agent_action_events_domain_workflow
  ON agent_action_events(domain, workflow_name);

-- Index: Time-based queries (newest first)
CREATE INDEX IF NOT EXISTS idx_agent_action_events_timestamp
  ON agent_action_events(created_at DESC);

-- Index: Filter by trust level and stage
CREATE INDEX IF NOT EXISTS idx_agent_action_events_trust
  ON agent_action_events(trust_level, stage);

-- Index: Find events by tool name
CREATE INDEX IF NOT EXISTS idx_agent_action_events_tool
  ON agent_action_events(tool_name)
  WHERE tool_name IS NOT NULL;

-- Index: Approval lookups
CREATE INDEX IF NOT EXISTS idx_agent_action_events_approval
  ON agent_action_events(approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- Index: Sandbox lookups
CREATE INDEX IF NOT EXISTS idx_agent_action_events_sandbox
  ON agent_action_events(sandbox_id)
  WHERE sandbox_id IS NOT NULL;

-- Enable RLS (optional - comment out if not using Supabase/RLS)
ALTER TABLE agent_action_events ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Service role has full access
DROP POLICY IF EXISTS "Service role full access" ON agent_action_events;
CREATE POLICY "Service role full access" ON agent_action_events
  FOR ALL USING (auth.role() = 'service_role');

-- Documentation
COMMENT ON TABLE agent_action_events IS
  'Audit trail for Agent Trust Layer. Logs every tool call with trust classification, sandbox context, and approval linkage.';

COMMENT ON COLUMN agent_action_events.trust_level IS
  'L0=full autonomy, L1=can propose, L2=sandboxed writes, L3=needs review, L4=human required';

COMMENT ON COLUMN agent_action_events.stage IS
  'Workflow stage: plan (gathering info), execute (taking action), review (verification), commit (final)';

COMMENT ON COLUMN agent_action_events.approval_request_id IS
  'Links to approval_requests table for L3+ actions requiring approval';

COMMENT ON COLUMN agent_action_events.sandbox_id IS
  'Docker container or sandbox identifier for L2+ sandboxed execution';

COMMENT ON COLUMN agent_action_events.sandbox_artifacts IS
  'Array of artifact paths produced during sandboxed execution';
