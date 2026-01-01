# Agent Trust Layer SQL Migrations

SQL schema templates for the Agent Trust Layer audit trail and approval system.

## Quick Start

Apply migrations in order:

```bash
# Using psql
psql -d your_database -f 001_agent_action_events.sql
psql -d your_database -f 002_eval_runs.sql
psql -d your_database -f 003_approval_requests.sql
psql -d your_database -f 004_approval_decisions.sql

# Using Supabase CLI
supabase db push
```

## Migration Order

| File | Description | Dependencies |
|------|-------------|--------------|
| `001_agent_action_events.sql` | Core audit trail for tool calls | None |
| `002_eval_runs.sql` | Evaluation runs for drift detection | None |
| `003_approval_requests.sql` | L3+ approval request queue | None |
| `004_approval_decisions.sql` | Approval decisions + trigger | `003_approval_requests` |

## Tables Overview

### `agent_action_events`
Audit trail for every agent tool call and workflow action.

**Key columns:**
- `domain` - Your domain identifier
- `workflow_name` - Which workflow ran
- `trust_level` - L0-L4 classification
- `stage` - plan/execute/review/commit
- `tool_name`, `tool_args`, `tool_result` - Tool execution details
- `approval_request_id` - Links L3+ actions to approval
- `sandbox_id` - For L2+ sandboxed execution

### `eval_runs`
Tracks regression test runs for drift detection.

**Key columns:**
- `suite_name` - Eval suite identifier
- `model_id`, `provider` - Model version tracking
- `status` - running/passed/failed/error
- `drift_score` - 0-100 behavioral drift from baseline
- `drift_metadata` - Full context for reproducibility

### `approval_requests`
Queue for pending L3+ commit operations.

**Key columns:**
- `action_type` - COMMIT_* action type
- `action_payload` - Full action payload
- `status` - PENDING/APPROVED/REJECTED/EXPIRED
- `expires_at` - Auto-expiration time
- `auto_approve_eligible` - Whether safe for auto-approval

### `approval_decisions`
Immutable audit log of approval/rejection decisions.

**Key columns:**
- `approval_request_id` - Which request
- `decision` - APPROVE/REJECT
- `decided_by` - Human email or "system:auto-approve"
- Trigger auto-updates `approval_requests.status`

## Customization

### Domain CHECK Constraint
Edit `003_approval_requests.sql` to add your domain validation:

```sql
domain TEXT NOT NULL DEFAULT 'default' CHECK (domain IN ('asi', 'land', 'your-domain')),
```

### Row Level Security (RLS)
RLS is enabled by default for Supabase compatibility. If not using RLS:

```sql
-- Comment out or remove these lines:
-- ALTER TABLE agent_action_events ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Service role full access" ...
```

### Auto-Expire Approvals
Call the `expire_stale_approvals()` function periodically:

```sql
-- Run hourly via cron or pg_cron
SELECT expire_stale_approvals();
```

## Trust Levels Reference

| Level | Name | Capabilities | Approval |
|-------|------|--------------|----------|
| L0 | Full Auto | Read-only, no side effects | None |
| L1 | Propose | Can propose changes, read external | None |
| L2 | Sandboxed | Writes in sandbox environment | Auto |
| L3 | Commit | Real external writes | Human review |
| L4 | Critical | Billing, compliance, irreversible | Human required |

## Usage with ATL Package

```typescript
import { createATL } from '@asi/agent-trust-layer';

const atl = createATL({
  domain: 'your-domain',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
});

// Events are automatically logged to agent_action_events
const result = await atl.execute({
  workflow: 'daily-brief',
  agent: 'planner',
  tool: 'fetchBookings',
  args: { date: '2025-01-01' },
});
```
