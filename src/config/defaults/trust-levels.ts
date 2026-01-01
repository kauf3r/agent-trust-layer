/**
 * Trust Level Defaults - L0-L4 Semantic Definitions
 *
 * This module provides sensible defaults for the Agent Trust Layer's
 * five-tier trust model. Each level defines:
 * - Allowed capabilities (READ, PROPOSE, WRITE, SIDE_EFFECTS)
 * - Stage restrictions (which workflow stages allow the level)
 * - Sandbox requirements
 * - Approval requirements
 *
 * Trust levels form a strict hierarchy where higher levels include
 * more restrictions and oversight requirements.
 */

import type {
  TrustLevel,
  ToolCapability,
  WorkflowStage,
  RiskLevel,
} from "../../core/schemas.js";

// =============================================================================
// Trust Level Semantic Definition
// =============================================================================

/**
 * Complete semantic definition for a trust level.
 * This provides the "meaning" of each level, not just the label.
 */
export interface TrustLevelDefinition {
  /** Trust level identifier */
  level: TrustLevel;

  /** Human-readable name */
  name: string;

  /** Short description for documentation */
  description: string;

  /** Detailed explanation for developers */
  semantics: string;

  /** Tool capabilities allowed at this level */
  allowedCapabilities: ToolCapability[];

  /** Workflow stages where this level is permitted */
  allowedStages: WorkflowStage[];

  /** Risk levels that map to this trust level */
  mappedRiskLevels: RiskLevel[];

  /** Whether sandbox execution is required */
  requiresSandbox: boolean;

  /** Whether reviewer approval is required before execution */
  requiresReviewerApproval: boolean;

  /** Whether human approval is required (can't be auto-approved) */
  requiresHumanApproval: boolean;

  /** Can actions at this level be automatically approved after review? */
  autoApproveEligible: boolean;

  /** Example tools that would typically be at this level */
  exampleTools: string[];
}

// =============================================================================
// L0 - Full Autonomy (Read-Only)
// =============================================================================

export const L0_DEFINITION: TrustLevelDefinition = {
  level: "L0",
  name: "Full Autonomy",
  description: "Read-only operations with no side effects",
  semantics: `
    L0 is the highest autonomy level - agents can execute these tools
    without any approval or sandbox requirements. L0 tools MUST be:

    1. Purely read-only (no mutations)
    2. No external side effects (no emails, webhooks, etc.)
    3. Idempotent (running twice gives same result)
    4. Low risk (cannot cause data loss or security issues)

    L0 tools can run in any workflow stage because they cannot
    change system state.
  `,
  allowedCapabilities: ["READ"],
  allowedStages: ["plan", "execute", "review", "commit"],
  mappedRiskLevels: ["LOW"],
  requiresSandbox: false,
  requiresReviewerApproval: false,
  requiresHumanApproval: false,
  autoApproveEligible: true, // N/A since no approval needed
  exampleTools: [
    "get_bookings",
    "get_members",
    "get_flights",
    "get_weather",
    "get_tfrs",
    "get_events",
    "get_billing_data",
    "classify_alert",
  ],
};

// =============================================================================
// L1 - Can Propose (Suggestions/Drafts)
// =============================================================================

export const L1_DEFINITION: TrustLevelDefinition = {
  level: "L1",
  name: "Can Propose",
  description: "Suggestion and draft generation without side effects",
  semantics: `
    L1 allows agents to generate suggestions, drafts, and proposals
    without actually executing changes. L1 tools:

    1. Generate content (drafts, summaries, analyses)
    2. Do NOT persist changes to databases
    3. Do NOT trigger external actions
    4. Output is reviewed before becoming permanent

    L1 is the default for most planning and analysis tools.
    Agents can run L1 tools autonomously in plan/review stages.
  `,
  allowedCapabilities: ["READ", "PROPOSE"],
  allowedStages: ["plan", "review"],
  mappedRiskLevels: ["LOW", "MEDIUM"],
  requiresSandbox: false,
  requiresReviewerApproval: false,
  requiresHumanApproval: false,
  autoApproveEligible: true, // N/A since no approval needed
  exampleTools: [
    "draft_brief",
    "analyze_compliance",
    "analyze_billing",
    "draft_billing_summary",
    "generate_audit_pack",
    "suggest_schedule",
    "format_report",
  ],
};

// =============================================================================
// L2 - Sandboxed Writes (Reversible Changes)
// =============================================================================

export const L2_DEFINITION: TrustLevelDefinition = {
  level: "L2",
  name: "Sandboxed Writes",
  description: "Database mutations that execute in sandbox first",
  semantics: `
    L2 allows agents to make changes, but ONLY in a sandboxed
    environment first. Changes are staged, not committed. L2 tools:

    1. CAN mutate data (create, update, delete)
    2. MUST run in sandbox isolation
    3. Changes are STAGED, not applied to production
    4. Require explicit commit to become permanent

    L2 is the highest level agents can reach without approval.
    The sandbox provides a safety net - bad changes can be discarded.
  `,
  allowedCapabilities: ["READ", "PROPOSE", "WRITE"],
  allowedStages: ["execute"],
  mappedRiskLevels: ["MEDIUM", "HIGH"],
  requiresSandbox: true,
  requiresReviewerApproval: false,
  requiresHumanApproval: false,
  autoApproveEligible: true, // Sandbox provides safety
  exampleTools: [
    "stage_booking_create",
    "stage_flight_update",
    "stage_event_log",
    "stage_member_update",
    "stage_invoice_draft",
  ],
};

// =============================================================================
// L3 - Needs Review (External Side Effects)
// =============================================================================

export const L3_DEFINITION: TrustLevelDefinition = {
  level: "L3",
  name: "Needs Review",
  description: "External side effects requiring reviewer approval",
  semantics: `
    L3 tools have external side effects that cannot be easily undone.
    They require a multi-agent review before execution. L3 tools:

    1. Have external side effects (emails, webhooks, API calls)
    2. MUST be reviewed by a reviewer agent first
    3. CAN be auto-approved if reviewer passes AND config allows
    4. Changes become permanent upon commit

    L3 is the threshold for commit operations. The reviewer agent
    validates the action before it goes to production.
  `,
  allowedCapabilities: ["READ", "PROPOSE", "WRITE", "SIDE_EFFECTS"],
  allowedStages: ["commit"],
  mappedRiskLevels: ["HIGH"],
  requiresSandbox: true, // Still runs in sandbox first
  requiresReviewerApproval: true,
  requiresHumanApproval: false,
  autoApproveEligible: true, // If reviewer passes, can auto-approve
  exampleTools: [
    "commit_apply_changes",
    "commit_publish_daily_brief",
    "commit_post_alert",
    "send_email",
    "post_to_slack",
    "sync_calendar",
  ],
};

// =============================================================================
// L4 - Human Required (Critical Operations)
// =============================================================================

export const L4_DEFINITION: TrustLevelDefinition = {
  level: "L4",
  name: "Human Required",
  description: "Critical operations requiring explicit human approval",
  semantics: `
    L4 is the highest restriction level. These operations are too
    critical or irreversible to be auto-approved. L4 tools:

    1. Are high-impact, irreversible, or financially sensitive
    2. MUST have explicit human approval (no auto-approve)
    3. Cannot be bypassed even with reviewer approval
    4. Require audit trail for compliance

    L4 is reserved for operations like financial transactions,
    permanent deletions, or compliance-critical actions.
  `,
  allowedCapabilities: ["READ", "PROPOSE", "WRITE", "SIDE_EFFECTS"],
  allowedStages: ["commit"],
  mappedRiskLevels: ["CRITICAL"],
  requiresSandbox: true,
  requiresReviewerApproval: true,
  requiresHumanApproval: true,
  autoApproveEligible: false, // NEVER auto-approve L4
  exampleTools: [
    "commit_send_invoice",
    "commit_mark_checkpoint_complete",
    "delete_member",
    "archive_compliance_data",
    "modify_billing",
    "delete_all_events",
  ],
};

// =============================================================================
// Registry and Lookup
// =============================================================================

/**
 * All trust level definitions indexed by level
 */
export const TRUST_LEVEL_DEFINITIONS: Record<TrustLevel, TrustLevelDefinition> = {
  L0: L0_DEFINITION,
  L1: L1_DEFINITION,
  L2: L2_DEFINITION,
  L3: L3_DEFINITION,
  L4: L4_DEFINITION,
};

/**
 * Trust levels in order from most permissive to most restrictive
 */
export const TRUST_LEVEL_ORDER: TrustLevel[] = ["L0", "L1", "L2", "L3", "L4"];

/**
 * Get the trust level definition for a given level
 */
export function getTrustLevelDefinition(level: TrustLevel): TrustLevelDefinition {
  return TRUST_LEVEL_DEFINITIONS[level];
}

/**
 * Compare two trust levels
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareTrustLevels(a: TrustLevel, b: TrustLevel): number {
  return TRUST_LEVEL_ORDER.indexOf(a) - TRUST_LEVEL_ORDER.indexOf(b);
}

/**
 * Check if level A is at least as restrictive as level B
 */
export function isAtLeastAsRestrictive(a: TrustLevel, b: TrustLevel): boolean {
  return compareTrustLevels(a, b) >= 0;
}

/**
 * Get the minimum trust level that requires approval
 * Default: L3 (anything above L2 needs approval)
 */
export function getApprovalThreshold(): TrustLevel {
  return "L2";
}

/**
 * Get the minimum trust level that requires human approval
 * Default: L4 (only L4 requires human)
 */
export function getHumanApprovalThreshold(): TrustLevel {
  return "L4";
}

/**
 * Determine trust level from risk level and capability
 */
export function inferTrustLevel(
  risk: RiskLevel,
  capability: ToolCapability
): TrustLevel {
  // CRITICAL risk always maps to L4
  if (risk === "CRITICAL") return "L4";

  // HIGH risk with side effects = L3
  if (risk === "HIGH" && capability === "SIDE_EFFECTS") return "L3";

  // HIGH risk or WRITE capability = L2
  if (risk === "HIGH" || capability === "WRITE") return "L2";

  // PROPOSE capability = L1
  if (capability === "PROPOSE") return "L1";

  // Default to L0 (READ only)
  return "L0";
}
