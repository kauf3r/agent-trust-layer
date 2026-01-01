-- Agent Trust Layer: Approval Requests
-- Stores pending approval requests for L3+ commit operations
--
-- Usage: Apply after 001_agent_action_events.sql

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Domain context (customize the CHECK constraint for your domains)
  domain TEXT NOT NULL DEFAULT 'default',

  -- Workflow context
  run_id UUID NOT NULL,
  workflow_name TEXT NOT NULL,

  -- Request details
  requested_by TEXT NOT NULL,              -- Agent name that requested approval
  trust_level TEXT NOT NULL CHECK (trust_level IN ('L0', 'L1', 'L2', 'L3', 'L4')),
  action_type TEXT NOT NULL,               -- e.g., 'COMMIT_POST_ALERT', 'COMMIT_SEND_INVOICE'
  action_payload JSONB NOT NULL,           -- Full payload for the commit action

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,         -- When this request auto-expires

  -- Evidence and context
  context JSONB,                           -- Additional context (artifacts, summaries)
  reviewer_verdict TEXT CHECK (reviewer_verdict IN ('PASS', 'FAIL')),
  reviewer_notes TEXT,

  -- Auto-approval tracking
  auto_approve_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  auto_approve_reason TEXT                 -- If auto-approved, why
);

-- Index: Find pending approvals quickly
CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests(status);

-- Index: Find approvals by run
CREATE INDEX IF NOT EXISTS idx_approval_requests_run
  ON approval_requests(run_id);

-- Index: Find expiring approvals
CREATE INDEX IF NOT EXISTS idx_approval_requests_expires
  ON approval_requests(expires_at)
  WHERE status = 'PENDING';

-- Index: Find by workflow for dashboard
CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow
  ON approval_requests(workflow_name, created_at DESC);

-- Index: Find by action type (for analytics)
CREATE INDEX IF NOT EXISTS idx_approval_requests_action
  ON approval_requests(action_type);

-- Function to auto-expire stale approvals
CREATE OR REPLACE FUNCTION expire_stale_approvals() RETURNS void AS $$
BEGIN
  UPDATE approval_requests
  SET status = 'EXPIRED'
  WHERE status = 'PENDING' AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Enable RLS (optional - comment out if not using Supabase/RLS)
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Service role has full access
DROP POLICY IF EXISTS "Service role full access" ON approval_requests;
CREATE POLICY "Service role full access" ON approval_requests
  FOR ALL USING (auth.role() = 'service_role');

-- Documentation
COMMENT ON TABLE approval_requests IS
  'Approval requests for L3+ commit operations. Part of Agent Trust Layer safety hardening.';

COMMENT ON COLUMN approval_requests.action_type IS
  'Commit tool action type, e.g.: COMMIT_APPLY_CHANGES, COMMIT_SEND_INVOICE, COMMIT_POST_ALERT';

COMMENT ON COLUMN approval_requests.auto_approve_eligible IS
  'Whether this request can be auto-approved. FALSE for billing, compliance, external comms.';

COMMENT ON COLUMN approval_requests.expires_at IS
  'L3 requests expire in 1 hour, L4 requests expire in 24 hours.';
