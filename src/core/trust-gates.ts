/**
 * Trust Gates - L0-L4 Enforcement for Agent Tool Calls
 *
 * Trust gates evaluate whether an agent can execute a tool based on:
 * 1. Tool risk level and capability
 * 2. Current workflow stage
 * 3. Domain-specific policies
 * 4. Approval status (for L3+ operations)
 * 5. Sandbox requirements (for L2+ operations)
 *
 * Trust Levels:
 * - L0: Full autonomy (read-only, low risk)
 * - L1: Can propose (suggestions, drafts)
 * - L2: Sandboxed writes (reversible changes)
 * - L3: Needs review (side effects, external APIs) + approval required
 * - L4: Human required (critical operations) + human approval mandatory
 *
 * @example
 * ```typescript
 * const gate = new TrustGate({
 *   defaultTrustLevel: "L1",
 *   requireApprovalAbove: "L2",
 *   sandboxWriteOps: true,
 * });
 *
 * const result = await gate.evaluateWithApproval(tool, "commit", {
 *   agentName: "worker",
 *   runId,
 *   approvalStore,
 * });
 *
 * if (!result.allowed) {
 *   if (result.approvalRequired && !result.approvalId) {
 *     // Need to create approval request
 *   } else {
 *     console.log("Blocked:", result.reason);
 *   }
 * }
 * ```
 */

import type {
  TrustLevel,
  ToolDefinition,
  WorkflowStage,
  TrustGateConfig,
} from "./schemas.js";
import type { ApprovalStore, ApprovalRequest } from "./approvals.js";
import { isCommitTool, getCommitTool } from "./commit-tools.js";

/**
 * Result of trust gate evaluation
 */
export interface TrustGateResult {
  /** Whether the tool call is allowed */
  allowed: boolean;
  /** Reason for denial (if not allowed) */
  reason?: string;
  /** Whether human approval is required before execution */
  requiresApproval: boolean;
  /** Approval request ID (if exists) */
  approvalId?: string;
  /** Approval status (if request exists) */
  approvalStatus?: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  /** Whether the tool should run in sandbox mode */
  sandboxed: boolean;
  /** Computed trust level for this tool call */
  trustLevel: TrustLevel;
  /** Whether this is a commit tool */
  isCommitTool: boolean;
  /** Whether reviewer verdict is required */
  requiresReviewerVerdict: boolean;
  /** Whether auto-approve is possible (if reviewer passes) */
  autoApproveEligible: boolean;
}

/**
 * Context for trust gate evaluation
 */
export interface TrustGateContext {
  /** Name of the agent making the call */
  agentName: string;
  /** Unique ID for this workflow run */
  runId: string;
  /** Optional: override domain config */
  domainOverride?: TrustGateConfig;
  /** Optional: approval store for checking approval status */
  approvalStore?: ApprovalStore;
  /** Optional: workflow name (for approval requests) */
  workflowName?: string;
  /** Optional: reviewer verdict from review stage */
  reviewerVerdict?: "PASS" | "FAIL";
}

/**
 * Stage-based policy for trust level enforcement
 */
interface StagePolicy {
  /** Maximum trust level allowed in this stage */
  maxTrustLevel: TrustLevel;
  /** Allowed tool capabilities in this stage */
  allowedCapabilities: ToolDefinition["capability"][];
  /** Whether to sandbox all operations in this stage */
  sandboxed?: boolean;
  /** Whether reviewer approval is required */
  requiresReviewerApproval?: boolean;
}

/**
 * Trust order for level comparison
 */
const TRUST_ORDER: TrustLevel[] = ["L0", "L1", "L2", "L3", "L4"];

/**
 * Valid workflow stages (for fail-closed validation)
 */
const VALID_STAGES: Set<WorkflowStage> = new Set(["plan", "execute", "review", "commit"]);

/**
 * Create a DENY result for fail-closed scenarios
 */
function createDenyResult(reason: string, trustLevel: TrustLevel = "L4"): TrustGateResult {
  return {
    allowed: false,
    reason,
    requiresApproval: false,
    sandboxed: false,
    trustLevel,
    isCommitTool: false,
    requiresReviewerVerdict: false,
    autoApproveEligible: false,
  };
}

/**
 * Validate tool definition has required fields
 * @returns Error message if invalid, undefined if valid
 */
function validateToolDefinition(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object") {
    return "Tool definition is null or not an object";
  }
  const t = tool as Record<string, unknown>;
  if (typeof t.name !== "string" || t.name.length === 0) {
    return "Tool definition missing required 'name' field";
  }
  if (typeof t.capability !== "string") {
    return "Tool definition missing required 'capability' field";
  }
  if (typeof t.risk !== "string") {
    return "Tool definition missing required 'risk' field";
  }
  return undefined;
}

/**
 * Validate context has required fields
 * @returns Error message if invalid, undefined if valid
 */
function validateContext(context: unknown): string | undefined {
  if (!context || typeof context !== "object") {
    return "Context is null or not an object";
  }
  const c = context as Record<string, unknown>;
  if (typeof c.agentName !== "string" || c.agentName.length === 0) {
    return "Context missing required 'agentName' field";
  }
  if (typeof c.runId !== "string" || c.runId.length === 0) {
    return "Context missing required 'runId' field";
  }
  return undefined;
}

/**
 * Default stage policies
 */
const DEFAULT_STAGE_POLICIES: Record<WorkflowStage, StagePolicy> = {
  plan: {
    maxTrustLevel: "L1",
    allowedCapabilities: ["READ", "PROPOSE"],
  },
  execute: {
    maxTrustLevel: "L2",
    allowedCapabilities: ["READ", "PROPOSE", "WRITE"],
    sandboxed: true,
  },
  review: {
    maxTrustLevel: "L1",
    allowedCapabilities: ["READ", "PROPOSE"],
  },
  commit: {
    maxTrustLevel: "L4", // Allow up to L4 in commit stage (requires human approval)
    allowedCapabilities: ["READ", "PROPOSE", "WRITE", "SIDE_EFFECTS"],
    requiresReviewerApproval: true,
    sandboxed: true, // Commit tools still run in sandbox first
  },
};

/**
 * TrustGate evaluates whether agent tool calls should be allowed
 */
export class TrustGate {
  private config: TrustGateConfig;
  private stagePolicies: Record<WorkflowStage, StagePolicy>;

  constructor(
    config: Partial<TrustGateConfig> & { domain: TrustGateConfig["domain"] },
    stagePolicies?: Partial<Record<WorkflowStage, Partial<StagePolicy>>>
  ) {
    this.config = {
      domain: config.domain,
      defaultTrustLevel: config.defaultTrustLevel ?? "L1",
      requireApprovalAbove: config.requireApprovalAbove ?? "L2",
      sandboxWriteOps: config.sandboxWriteOps ?? true,
      toolOverrides: config.toolOverrides,
    };

    // Merge custom stage policies with defaults
    this.stagePolicies = { ...DEFAULT_STAGE_POLICIES };
    if (stagePolicies) {
      for (const [stage, policy] of Object.entries(stagePolicies)) {
        this.stagePolicies[stage as WorkflowStage] = {
          ...DEFAULT_STAGE_POLICIES[stage as WorkflowStage],
          ...policy,
        };
      }
    }
  }

  /**
   * Evaluate whether a tool call should be allowed (synchronous, no approval check)
   *
   * IMPORTANT: This method implements FAIL CLOSED semantics.
   * Any validation failure or undefined input results in DENY.
   *
   * @param tool - The tool definition
   * @param stage - Current workflow stage
   * @param context - Execution context (agent name, run ID)
   * @returns TrustGateResult with allow/deny decision and metadata
   */
  evaluate(
    tool: ToolDefinition,
    stage: WorkflowStage,
    context: TrustGateContext
  ): TrustGateResult {
    // =========================================================================
    // FAIL CLOSED: Validate all inputs before any evaluation
    // =========================================================================

    // Validate tool definition
    const toolError = validateToolDefinition(tool);
    if (toolError) {
      return createDenyResult(`FAIL CLOSED: ${toolError}`);
    }

    // Validate stage is recognized
    if (!VALID_STAGES.has(stage)) {
      return createDenyResult(`FAIL CLOSED: Unrecognized stage '${stage}'`);
    }

    // Validate context
    const contextError = validateContext(context);
    if (contextError) {
      return createDenyResult(`FAIL CLOSED: ${contextError}`);
    }

    // Validate stage policy exists (defensive)
    const stagePolicy = this.stagePolicies[stage];
    if (!stagePolicy) {
      return createDenyResult(`FAIL CLOSED: No policy defined for stage '${stage}'`);
    }

    // =========================================================================
    // Normal evaluation (inputs validated)
    // =========================================================================

    // Get trust level for this tool
    const trustLevel = this.getTrustLevelForTool(tool);
    const commitTool = isCommitTool(tool.name);
    const commitToolDef = commitTool ? getCommitTool(tool.name) : undefined;

    // Check if trust level exceeds stage maximum
    if (this.compareLevel(trustLevel, stagePolicy.maxTrustLevel) > 0) {
      return {
        allowed: false,
        reason: `Stage '${stage}' does not allow trust level ${trustLevel} (max: ${stagePolicy.maxTrustLevel})`,
        requiresApproval: false,
        sandboxed: false,
        trustLevel,
        isCommitTool: commitTool,
        requiresReviewerVerdict: commitTool,
        autoApproveEligible: false,
      };
    }

    // Check if capability is allowed in this stage
    if (!stagePolicy.allowedCapabilities.includes(tool.capability)) {
      return {
        allowed: false,
        reason: `Stage '${stage}' does not allow capability '${tool.capability}' (allowed: ${stagePolicy.allowedCapabilities.join(", ")})`,
        requiresApproval: false,
        sandboxed: false,
        trustLevel,
        isCommitTool: commitTool,
        requiresReviewerVerdict: commitTool,
        autoApproveEligible: false,
      };
    }

    // Determine if sandboxing is required
    const sandboxed = this.shouldSandbox(tool, stage, stagePolicy);

    // Determine if approval is required
    const requiresApproval =
      this.compareLevel(trustLevel, this.config.requireApprovalAbove) > 0 ||
      stagePolicy.requiresReviewerApproval === true ||
      commitTool;

    // Determine if reviewer verdict is required
    const requiresReviewerVerdict = commitTool || stagePolicy.requiresReviewerApproval === true;

    // Determine auto-approve eligibility
    const autoApproveEligible =
      trustLevel === "L3" &&
      commitToolDef?.autoApproveEligible === true;

    // L4 tools always block without approval - cannot proceed synchronously
    if (trustLevel === "L4") {
      return {
        allowed: false,
        reason: `Human approval required for L4 operations (tool: ${tool.name})`,
        requiresApproval: true,
        sandboxed,
        trustLevel,
        isCommitTool: commitTool,
        requiresReviewerVerdict,
        autoApproveEligible: false, // L4 can never auto-approve
      };
    }

    // Commit tools require approval flow
    if (commitTool && stage === "commit") {
      return {
        allowed: false, // Block until approval checked
        reason: "Commit tool requires approval check",
        requiresApproval: true,
        sandboxed,
        trustLevel,
        isCommitTool: true,
        requiresReviewerVerdict: true,
        autoApproveEligible,
      };
    }

    return {
      allowed: true,
      requiresApproval,
      sandboxed,
      trustLevel,
      isCommitTool: commitTool,
      requiresReviewerVerdict,
      autoApproveEligible,
    };
  }

  /**
   * Evaluate with approval status check (async)
   *
   * IMPORTANT: This method implements FAIL CLOSED semantics.
   * Any error from approval store results in DENY.
   *
   * This method checks the approval store to determine if the tool
   * can proceed based on existing approval requests.
   *
   * @param tool - The tool definition
   * @param stage - Current workflow stage
   * @param context - Execution context with approval store
   * @returns Promise<TrustGateResult> with approval status
   */
  async evaluateWithApproval(
    tool: ToolDefinition,
    stage: WorkflowStage,
    context: TrustGateContext
  ): Promise<TrustGateResult> {
    // First, do the basic evaluation (includes FAIL CLOSED validation)
    const basicResult = this.evaluate(tool, stage, context);

    // If basic evaluation failed, return that result
    if (!basicResult.allowed && !basicResult.requiresApproval) {
      return basicResult;
    }

    // If no approval required or no approval store, return basic result
    if (!basicResult.requiresApproval || !context.approvalStore) {
      return basicResult;
    }

    // =========================================================================
    // FAIL CLOSED: Wrap approval store access in try-catch
    // =========================================================================
    let requests: Awaited<ReturnType<typeof context.approvalStore.getRequestsByRunId>>;
    try {
      requests = await context.approvalStore.getRequestsByRunId(context.runId);
    } catch (error) {
      // FAIL CLOSED: Approval store error = DENY
      return {
        ...basicResult,
        allowed: false,
        reason: `FAIL CLOSED: Approval store error - ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const relevantRequest = requests.find(
      (r) => r.actionType === tool.name || r.actionType.includes(tool.name.split(".").pop()!)
    );

    if (!relevantRequest) {
      // No approval request exists - need to create one
      return {
        ...basicResult,
        allowed: false,
        reason: "Approval request required",
      };
    }

    // Check approval status
    if (relevantRequest.status === "APPROVED") {
      // Approved - check reviewer verdict if required
      if (basicResult.requiresReviewerVerdict && relevantRequest.reviewerVerdict !== "PASS") {
        return {
          ...basicResult,
          allowed: false,
          reason: `Reviewer verdict is ${relevantRequest.reviewerVerdict ?? "missing"}, expected PASS`,
          approvalId: relevantRequest.id,
          approvalStatus: relevantRequest.status,
        };
      }

      return {
        ...basicResult,
        allowed: true,
        approvalId: relevantRequest.id,
        approvalStatus: "APPROVED",
      };
    }

    if (relevantRequest.status === "PENDING") {
      // Still pending - check if auto-approve is possible
      if (
        basicResult.autoApproveEligible &&
        context.reviewerVerdict === "PASS" &&
        relevantRequest.autoApproveEligible
      ) {
        // Could auto-approve - return with info for caller to trigger
        return {
          ...basicResult,
          allowed: false,
          reason: "Pending approval (auto-approve eligible)",
          approvalId: relevantRequest.id,
          approvalStatus: "PENDING",
          autoApproveEligible: true,
        };
      }

      return {
        ...basicResult,
        allowed: false,
        reason: "Awaiting human approval",
        approvalId: relevantRequest.id,
        approvalStatus: "PENDING",
      };
    }

    // Rejected or expired
    return {
      ...basicResult,
      allowed: false,
      reason: `Approval ${relevantRequest.status.toLowerCase()}`,
      approvalId: relevantRequest.id,
      approvalStatus: relevantRequest.status,
    };
  }

  /**
   * Get trust level for a specific tool
   */
  getTrustLevelForTool(tool: ToolDefinition): TrustLevel {
    // Check for tool-specific override
    if (this.config.toolOverrides?.[tool.name]) {
      return this.config.toolOverrides[tool.name];
    }

    // Map risk + capability to trust level
    if (tool.risk === "CRITICAL") return "L4";
    if (tool.risk === "HIGH" && tool.capability === "SIDE_EFFECTS") return "L3";
    if (tool.risk === "HIGH" || tool.capability === "WRITE") return "L2";
    if (tool.capability === "PROPOSE") return "L1";
    return "L0";
  }

  /**
   * Compare two trust levels
   * @returns negative if a < b, 0 if equal, positive if a > b
   */
  private compareLevel(a: TrustLevel, b: TrustLevel): number {
    return TRUST_ORDER.indexOf(a) - TRUST_ORDER.indexOf(b);
  }

  /**
   * Determine if a tool should be sandboxed
   */
  private shouldSandbox(
    tool: ToolDefinition,
    _stage: WorkflowStage,
    stagePolicy: StagePolicy
  ): boolean {
    // Stage-level sandbox requirement
    if (stagePolicy.sandboxed) {
      return true;
    }

    // Global sandbox for write operations
    if (
      this.config.sandboxWriteOps &&
      (tool.capability === "WRITE" || tool.capability === "SIDE_EFFECTS")
    ) {
      return true;
    }

    // Tool definition requires sandbox
    if (tool.executionMode === "SANDBOX_ONLY") {
      return true;
    }

    return false;
  }

  /**
   * Create a TrustGate from a configuration object (e.g., parsed YAML)
   */
  static fromConfig(config: TrustGateConfig): TrustGate {
    return new TrustGate({
      domain: config.domain,
      defaultTrustLevel: config.defaultTrustLevel,
      requireApprovalAbove: config.requireApprovalAbove,
      sandboxWriteOps: config.sandboxWriteOps,
      toolOverrides: config.toolOverrides,
    });
  }

  /**
   * Get the current configuration (for debugging/testing)
   */
  getConfig(): TrustGateConfig {
    return { ...this.config };
  }
}

/**
 * Pre-configured trust gates for common domains
 */
export const DEFAULT_GATES = {
  /**
   * ASI domain: Stricter controls for aviation operations
   */
  asi: new TrustGate({
    domain: "asi",
    defaultTrustLevel: "L1",
    requireApprovalAbove: "L2",
    sandboxWriteOps: true,
    toolOverrides: {
      // Read-only tools (L0 - full autonomy) - asi.* namespace
      "asi.get_bookings": "L0",
      "asi.get_members": "L0",
      "asi.get_flights": "L0",
      "asi.get_weather": "L0",
      "asi.get_tfrs": "L0",
      "asi.get_events": "L0",
      "asi.get_billing_data": "L0",
      "asi.classify_alert": "L0",

      // Proposal tools (L1 - can suggest)
      "asi.draft_brief": "L1",
      "asi.analyze_compliance": "L1",
      "asi.analyze_billing": "L1",
      "asi.draft_billing_summary": "L1",
      "asi.generate_audit_pack": "L1",

      // Sandbox write tools (L2 - sandboxed writes)
      "asi.stage_booking_create": "L2",
      "asi.stage_flight_update": "L2",
      "asi.stage_event_log": "L2",

      // Commit tools (L3 - needs review + approval)
      "asi.commit_apply_changes": "L3",
      "asi.commit_publish_daily_brief": "L3",
      "asi.commit_post_alert": "L3",
      "asi.commit_mark_checkpoint_complete": "L3",

      // Critical commit tools (L4 - human required)
      "asi.commit_send_invoice": "L4",

      // Legacy names (backwards compatibility)
      get_bookings: "L0",
      get_members: "L0",
      get_flights: "L0",
      get_weather: "L0",
      draft_brief: "L1",
      analyze_compliance: "L1",
      create_booking: "L2",
      update_flight: "L2",
      log_event: "L2",
      send_email: "L3",
      post_to_slack: "L3",
      sync_calendar: "L3",
      delete_member: "L4",
      archive_compliance_data: "L4",
      modify_billing: "L4",
    },
  }),

  /**
   * Land domain: Similar controls for land operations
   */
  land: new TrustGate({
    domain: "land",
    defaultTrustLevel: "L1",
    requireApprovalAbove: "L2",
    sandboxWriteOps: true,
    toolOverrides: {
      // Land-specific tool overrides would go here
    },
  }),
};
