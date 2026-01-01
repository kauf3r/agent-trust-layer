-- Agent Trust Layer: Approval Decisions
-- Immutable audit log of approval/rejection decisions
--
-- Usage: Apply after 003_approval_requests.sql
-- This migration also adds the FK from agent_action_events → approval_requests

CREATE TABLE IF NOT EXISTS approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Link to request
  approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,

  -- Decision details
  decided_by TEXT NOT NULL,                -- Email or system identifier
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  notes TEXT,                              -- Human-provided notes
  metadata JSONB,                          -- Additional context (IP, user agent, etc.)

  -- Ensure one decision per request
  UNIQUE(approval_request_id)
);

-- Index: Find decisions by request
CREATE INDEX IF NOT EXISTS idx_approval_decisions_request
  ON approval_decisions(approval_request_id);

-- Index: Find decisions by decider (for audit)
CREATE INDEX IF NOT EXISTS idx_approval_decisions_decider
  ON approval_decisions(decided_by);

-- Trigger to update approval_requests status when decision is made
CREATE OR REPLACE FUNCTION update_approval_request_status() RETURNS TRIGGER AS $$
BEGIN
  UPDATE approval_requests
  SET status = CASE
    WHEN NEW.decision = 'APPROVE' THEN 'APPROVED'
    ELSE 'REJECTED'
  END
  WHERE id = NEW.approval_request_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS trg_update_approval_status ON approval_decisions;
CREATE TRIGGER trg_update_approval_status
  AFTER INSERT ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION update_approval_request_status();

-- Enable RLS (optional - comment out if not using Supabase/RLS)
ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Service role has full access
DROP POLICY IF EXISTS "Service role full access" ON approval_decisions;
CREATE POLICY "Service role full access" ON approval_decisions
  FOR ALL USING (auth.role() = 'service_role');

-- Documentation
COMMENT ON TABLE approval_decisions IS
  'Immutable audit log of approval/rejection decisions. Part of Agent Trust Layer.';

COMMENT ON COLUMN approval_decisions.decided_by IS
  'Email for human approvals, "system:auto-approve" for auto-approved requests.';

COMMENT ON COLUMN approval_decisions.metadata IS
  'Optional metadata: IP address, user agent, approval source (dashboard, API, CLI).';

-- Add foreign key from agent_action_events to approval_requests
-- (must be done after both tables exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_action_events_approval_fk'
  ) THEN
    ALTER TABLE agent_action_events
    ADD CONSTRAINT agent_action_events_approval_fk
    FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id);
  END IF;
END $$;
