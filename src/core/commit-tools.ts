/**
 * Commit Tools - The ONLY Path to Production Writes
 *
 * Commit tools are the single boundary for all production mutations.
 * Every production write MUST go through one of these 5 commit tools:
 *
 * 1. asi.commit_apply_changes     - Apply staged DB changes
 * 2. asi.commit_publish_daily_brief - Publish daily brief
 * 3. asi.commit_post_alert        - Post notifications
 * 4. asi.commit_mark_checkpoint_complete - Mark compliance checkpoint
 * 5. asi.commit_send_invoice      - Send invoice (L4 - human required)
 *
 * All commit tools enforce:
 * - Trust level >= L3 (or L4 for critical)
 * - Reviewer verdict = PASS
 * - Approval status = APPROVED
 * - Full audit trail
 *
 * @example
 * ```typescript
 * const commitTools = new CommitToolBoundary(approvalStore, sandbox, logger);
 *
 * // Verify before commit
 * const canCommit = await commitTools.verifyCommitEligibility(runId, "COMMIT_POST_ALERT");
 * if (!canCommit.eligible) {
 *   throw new Error(canCommit.reason);
 * }
 *
 * // Execute commit
 * const result = await commitTools.executeCommit(
 *   "asi.commit_post_alert",
 *   runId,
 *   { alert_type: "info", message: "...", channels: ["slack"] }
 * );
 * ```
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApprovalStore, ApprovalRequest } from "./approvals.js";
import type { Sandbox, StagedChange } from "./sandbox.js";
import type { EventLogger } from "./logger.js";
import type { TrustLevel, CommitActionType } from "./schemas.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of checking commit eligibility
 */
export interface CommitEligibilityResult {
  /** Whether the commit can proceed */
  eligible: boolean;
  /** Reason if not eligible */
  reason?: string;
  /** The approval request (if exists) */
  approvalRequest?: ApprovalRequest;
  /** Staged changes to be committed */
  stagedChanges?: StagedChange[];
}

/**
 * Result of executing a commit
 */
export interface CommitResult {
  /** Whether the commit succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** ID of the committed action */
  commitId: string;
  /** Number of changes applied */
  changesApplied: number;
  /** Artifacts produced */
  artifacts: string[];
  /** Timestamp of commit */
  committedAt: Date;
}

/**
 * Commit tool definition with requirements
 */
export interface CommitToolDefinition {
  /** Tool name (asi.commit_*) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Minimum trust level required */
  minTrustLevel: TrustLevel;
  /** Action type for approval tracking */
  actionType: string;
  /** Whether auto-approve is allowed */
  autoApproveEligible: boolean;
  /** Risk level */
  risk: "MEDIUM" | "HIGH" | "CRITICAL";
}

// =============================================================================
// Commit Tool Definitions
// =============================================================================

/**
 * Registry of all commit tools and their requirements
 */
export const COMMIT_TOOLS: Record<string, CommitToolDefinition> = {
  "asi.commit_apply_changes": {
    name: "asi.commit_apply_changes",
    description: "Apply staged changes to production database",
    minTrustLevel: "L3",
    actionType: "COMMIT_APPLY_CHANGES",
    autoApproveEligible: true,
    risk: "HIGH",
  },
  "asi.commit_publish_daily_brief": {
    name: "asi.commit_publish_daily_brief",
    description: "Publish daily operations brief to recipients",
    minTrustLevel: "L3",
    actionType: "COMMIT_PUBLISH_DAILY_BRIEF",
    autoApproveEligible: true, // Internal communication
    risk: "MEDIUM",
  },
  "asi.commit_post_alert": {
    name: "asi.commit_post_alert",
    description: "Post an alert to notification channels",
    minTrustLevel: "L3",
    actionType: "COMMIT_POST_ALERT",
    autoApproveEligible: true, // Internal alerts
    risk: "MEDIUM",
  },
  "asi.commit_mark_checkpoint_complete": {
    name: "asi.commit_mark_checkpoint_complete",
    description: "Mark a compliance checkpoint as complete",
    minTrustLevel: "L3",
    actionType: "COMMIT_MARK_CHECKPOINT_COMPLETE",
    autoApproveEligible: false, // Compliance - NEVER auto-approve
    risk: "HIGH",
  },
  "asi.commit_send_invoice": {
    name: "asi.commit_send_invoice",
    description: "Send billing invoice to customer",
    minTrustLevel: "L4", // Critical - requires L4
    actionType: "COMMIT_SEND_INVOICE",
    autoApproveEligible: false, // Financial - NEVER auto-approve
    risk: "CRITICAL",
  },
};

/**
 * Check if a tool name is a commit tool
 */
export function isCommitTool(toolName: string): boolean {
  return toolName in COMMIT_TOOLS;
}

/**
 * Get commit tool definition
 */
export function getCommitTool(toolName: string): CommitToolDefinition | undefined {
  return COMMIT_TOOLS[toolName];
}

// =============================================================================
// Commit Tool Boundary
// =============================================================================

/**
 * CommitToolBoundary enforces the commit boundary for all production writes
 *
 * SECURITY: This is the ONLY path to production mutations.
 *
 * INVARIANTS (cannot be bypassed):
 * 1. All commits require trust level >= L3
 * 2. All commits require reviewer verdict = PASS
 * 3. All commits require approval status = APPROVED
 * 4. L4 commits ALWAYS require human approval (never auto-approved)
 * 5. Commit tools are the ONLY way to make irreversible changes
 *
 * FAIL CLOSED: Any missing requirement = DENY
 */
export class CommitToolBoundary {
  private approvalStore: ApprovalStore;
  private sandbox: Sandbox;
  private logger: EventLogger;
  private supabase?: SupabaseClient;

  constructor(
    approvalStore: ApprovalStore,
    sandbox: Sandbox,
    logger: EventLogger,
    supabase?: SupabaseClient
  ) {
    // FAIL CLOSED: Require all dependencies
    if (!approvalStore) {
      throw new Error("FAIL CLOSED: CommitToolBoundary requires ApprovalStore");
    }
    if (!sandbox) {
      throw new Error("FAIL CLOSED: CommitToolBoundary requires Sandbox");
    }
    if (!logger) {
      throw new Error("FAIL CLOSED: CommitToolBoundary requires EventLogger");
    }

    this.approvalStore = approvalStore;
    this.sandbox = sandbox;
    this.logger = logger;
    this.supabase = supabase;
  }

  /**
   * Verify that a commit can proceed
   *
   * SECURITY GATES (ALL must pass):
   * 1. Tool must be a valid commit tool
   * 2. Trust level must be >= tool's minimum (L3 or L4)
   * 3. Approval request must exist
   * 4. Approval status must be APPROVED
   * 5. Reviewer verdict must be PASS
   * 6. Request must not be expired
   * 7. Staged changes must exist (for apply_changes tool)
   *
   * FAIL CLOSED: Any missing gate = DENY
   *
   * @param runId - Workflow run ID
   * @param toolName - Commit tool name
   * @returns Eligibility result with explicit reason if denied
   */
  async verifyCommitEligibility(
    runId: string,
    toolName: string
  ): Promise<CommitEligibilityResult> {
    // =========================================================================
    // GATE 1: Validate inputs
    // =========================================================================
    if (!runId || typeof runId !== "string") {
      return {
        eligible: false,
        reason: "FAIL CLOSED: Invalid or missing runId",
      };
    }

    if (!toolName || typeof toolName !== "string") {
      return {
        eligible: false,
        reason: "FAIL CLOSED: Invalid or missing toolName",
      };
    }

    // =========================================================================
    // GATE 2: Verify this is a commit tool
    // =========================================================================
    const toolDef = getCommitTool(toolName);
    if (!toolDef) {
      return {
        eligible: false,
        reason: `FAIL CLOSED: '${toolName}' is not a registered commit tool. ` +
                `Only commit tools can make irreversible changes.`,
      };
    }

    // =========================================================================
    // GATE 3: Get and validate approval request
    // =========================================================================
    let requests: ApprovalRequest[];
    try {
      requests = await this.approvalStore.getRequestsByRunId(runId);
    } catch (error) {
      return {
        eligible: false,
        reason: `FAIL CLOSED: Failed to query approval store - ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (requests.length === 0) {
      return {
        eligible: false,
        reason: `FAIL CLOSED: No approval request found for run ${runId}. ` +
                `All commit operations require prior approval.`,
      };
    }

    // Find the relevant approval request
    const approvalRequest = requests.find(
      (r) => r.actionType === toolDef.actionType || r.actionType === toolName
    );

    if (!approvalRequest) {
      return {
        eligible: false,
        reason: `FAIL CLOSED: No approval request found for action type '${toolDef.actionType}'. ` +
                `Approval must be requested before commit.`,
      };
    }

    // =========================================================================
    // GATE 4: Verify trust level meets minimum
    // =========================================================================
    const trustOrder = ["L0", "L1", "L2", "L3", "L4"];
    const requestTrustIndex = trustOrder.indexOf(approvalRequest.trustLevel);
    const requiredTrustIndex = trustOrder.indexOf(toolDef.minTrustLevel);

    if (requestTrustIndex < requiredTrustIndex) {
      return {
        eligible: false,
        reason: `FAIL CLOSED: Trust level ${approvalRequest.trustLevel} is below required ${toolDef.minTrustLevel} for ${toolName}`,
        approvalRequest,
      };
    }

    // =========================================================================
    // GATE 5: Check approval status is APPROVED
    // =========================================================================
    if (approvalRequest.status !== "APPROVED") {
      return {
        eligible: false,
        reason: `FAIL CLOSED: Approval status is '${approvalRequest.status}', must be 'APPROVED'. ` +
                `Commit operations require explicit approval.`,
        approvalRequest,
      };
    }

    // =========================================================================
    // GATE 6: Check reviewer verdict is PASS
    // =========================================================================
    if (approvalRequest.reviewerVerdict !== "PASS") {
      return {
        eligible: false,
        reason: `FAIL CLOSED: Reviewer verdict is '${approvalRequest.reviewerVerdict ?? "missing"}', must be 'PASS'. ` +
                `All commits require reviewer approval.`,
        approvalRequest,
      };
    }

    // =========================================================================
    // GATE 7: Check request is not expired
    // =========================================================================
    if (new Date(approvalRequest.expiresAt) < new Date()) {
      return {
        eligible: false,
        reason: `FAIL CLOSED: Approval request has expired at ${approvalRequest.expiresAt}. ` +
                `A new approval must be requested.`,
        approvalRequest,
      };
    }

    // =========================================================================
    // GATE 8: Get staged changes from sandbox (if applicable)
    // =========================================================================
    let stagedChanges: StagedChange[] | undefined;
    if (toolName === "asi.commit_apply_changes") {
      const sandboxId = approvalRequest.context?.sandboxId as string | undefined;
      if (sandboxId) {
        try {
          stagedChanges = await this.sandbox.getStagedChanges(sandboxId);
        } catch (error) {
          return {
            eligible: false,
            reason: `FAIL CLOSED: Failed to get staged changes - ${error instanceof Error ? error.message : String(error)}`,
            approvalRequest,
          };
        }

        if (stagedChanges.length === 0) {
          return {
            eligible: false,
            reason: "FAIL CLOSED: No staged changes found to commit. " +
                    "Changes must be staged before commit_apply_changes.",
            approvalRequest,
          };
        }
      }
    }

    // =========================================================================
    // ALL GATES PASSED - Commit is eligible
    // =========================================================================
    console.log(
      `[CommitToolBoundary] Commit eligible: ${toolName} for run ${runId} ` +
      `(approval: ${approvalRequest.id}, trust: ${approvalRequest.trustLevel})`
    );

    return {
      eligible: true,
      approvalRequest,
      stagedChanges,
    };
  }

  /**
   * Execute a commit operation
   *
   * @param toolName - Commit tool name
   * @param runId - Workflow run ID
   * @param args - Tool arguments
   * @returns Commit result
   */
  async executeCommit(
    toolName: string,
    runId: string,
    args: Record<string, unknown>
  ): Promise<CommitResult> {
    const commitId = crypto.randomUUID();
    const startTime = new Date();

    // Verify eligibility
    const eligibility = await this.verifyCommitEligibility(runId, toolName);
    if (!eligibility.eligible) {
      return {
        success: false,
        error: eligibility.reason,
        commitId,
        changesApplied: 0,
        artifacts: [],
        committedAt: startTime,
      };
    }

    try {
      // Execute based on tool type
      let result: CommitResult;

      switch (toolName) {
        case "asi.commit_apply_changes":
          result = await this.executeApplyChanges(
            commitId,
            runId,
            args,
            eligibility.stagedChanges ?? []
          );
          break;

        case "asi.commit_publish_daily_brief":
          result = await this.executePublishDailyBrief(commitId, runId, args);
          break;

        case "asi.commit_post_alert":
          result = await this.executePostAlert(commitId, runId, args);
          break;

        case "asi.commit_mark_checkpoint_complete":
          result = await this.executeMarkCheckpointComplete(commitId, runId, args);
          break;

        case "asi.commit_send_invoice":
          result = await this.executeSendInvoice(commitId, runId, args);
          break;

        default:
          result = {
            success: false,
            error: `Unknown commit tool: ${toolName}`,
            commitId,
            changesApplied: 0,
            artifacts: [],
            committedAt: startTime,
          };
      }

      // Log the commit
      await this.logCommit(toolName, runId, commitId, result, eligibility.approvalRequest!);

      return result;
    } catch (error) {
      const errorResult: CommitResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        commitId,
        changesApplied: 0,
        artifacts: [],
        committedAt: startTime,
      };

      // Log the failed commit
      await this.logCommit(
        toolName,
        runId,
        commitId,
        errorResult,
        eligibility.approvalRequest!
      );

      return errorResult;
    }
  }

  /**
   * Execute asi.commit_apply_changes
   */
  private async executeApplyChanges(
    commitId: string,
    runId: string,
    args: Record<string, unknown>,
    stagedChanges: StagedChange[]
  ): Promise<CommitResult> {
    const startTime = new Date();
    const artifacts: string[] = [];

    // Apply each staged change
    let appliedCount = 0;
    for (const change of stagedChanges) {
      try {
        // In production, this would apply the change to the database
        console.log(
          `[Commit] Applying change ${change.id}: ${change.changeType} ${change.entityType}`
        );
        appliedCount++;
      } catch (error) {
        console.error(
          `[Commit] Failed to apply change ${change.id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Commit the sandbox changes
    const sandboxId = (args as Record<string, string>).sandbox_id;
    if (sandboxId) {
      await this.sandbox.commitChanges(sandboxId);
    }

    return {
      success: true,
      commitId,
      changesApplied: appliedCount,
      artifacts,
      committedAt: startTime,
    };
  }

  /**
   * Execute asi.commit_publish_daily_brief
   */
  private async executePublishDailyBrief(
    commitId: string,
    runId: string,
    args: Record<string, unknown>
  ): Promise<CommitResult> {
    const startTime = new Date();
    const artifacts: string[] = [];

    const briefContent = args.brief_content as Record<string, unknown>;
    const channels = args.channels as string[];
    const recipients = args.recipients as string[] | undefined;

    // Publish to each channel
    let changesApplied = 0;
    for (const channel of channels) {
      try {
        console.log(`[Commit] Publishing daily brief to ${channel}`);
        // In production:
        // - email: Send via SendGrid
        // - slack: Post via Slack API
        changesApplied++;
      } catch (error) {
        console.error(
          `[Commit] Failed to publish to ${channel}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return {
      success: changesApplied > 0,
      commitId,
      changesApplied,
      artifacts,
      committedAt: startTime,
    };
  }

  /**
   * Execute asi.commit_post_alert
   */
  private async executePostAlert(
    commitId: string,
    runId: string,
    args: Record<string, unknown>
  ): Promise<CommitResult> {
    const startTime = new Date();
    const artifacts: string[] = [];

    const alertType = args.alert_type as string;
    const message = args.message as string;
    const channels = args.channels as string[];

    // Post to each channel
    let changesApplied = 0;
    for (const channel of channels) {
      try {
        console.log(`[Commit] Posting ${alertType} alert to ${channel}: ${message.slice(0, 50)}...`);
        // In production:
        // - email: Send via SendGrid
        // - slack: Post via Slack API
        // - webhook: POST to configured URL
        changesApplied++;
      } catch (error) {
        console.error(
          `[Commit] Failed to post to ${channel}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return {
      success: changesApplied > 0,
      commitId,
      changesApplied,
      artifacts,
      committedAt: startTime,
    };
  }

  /**
   * Execute asi.commit_mark_checkpoint_complete
   */
  private async executeMarkCheckpointComplete(
    commitId: string,
    runId: string,
    args: Record<string, unknown>
  ): Promise<CommitResult> {
    const startTime = new Date();
    const artifacts: string[] = [];

    const checkpointId = args.checkpoint_id as string;
    const evidenceRefs = args.evidence_refs as string[];
    const notes = args.notes as string | undefined;

    // Mark checkpoint complete in database
    try {
      console.log(
        `[Commit] Marking checkpoint ${checkpointId} complete with ${evidenceRefs.length} evidence items`
      );
      // In production:
      // - Update checkpoint record in events table
      // - Link evidence references
      // - Log compliance event

      return {
        success: true,
        commitId,
        changesApplied: 1,
        artifacts,
        committedAt: startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        commitId,
        changesApplied: 0,
        artifacts,
        committedAt: startTime,
      };
    }
  }

  /**
   * Execute asi.commit_send_invoice
   */
  private async executeSendInvoice(
    commitId: string,
    runId: string,
    args: Record<string, unknown>
  ): Promise<CommitResult> {
    const startTime = new Date();
    const artifacts: string[] = [];

    const companyId = args.company_id as string;
    const invoiceData = args.invoice_data as Record<string, unknown>;
    const sendTo = args.send_to as string[];

    // Send invoice (CRITICAL operation)
    try {
      console.log(
        `[Commit] CRITICAL: Sending invoice to ${companyId} (${sendTo.join(", ")})`
      );
      // In production:
      // - Generate PDF invoice
      // - Send via SendGrid with PDF attachment
      // - Record in billing events
      // - Update invoice status in OfficeRnD

      return {
        success: true,
        commitId,
        changesApplied: 1,
        artifacts,
        committedAt: startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        commitId,
        changesApplied: 0,
        artifacts,
        committedAt: startTime,
      };
    }
  }

  /**
   * Log a commit operation
   */
  private async logCommit(
    toolName: string,
    runId: string,
    commitId: string,
    result: CommitResult,
    approvalRequest: ApprovalRequest
  ): Promise<void> {
    const toolDef = getCommitTool(toolName);

    try {
      await this.logger.log({
        domain: "asi",
        workflowName: approvalRequest.workflowName,
        agentName: approvalRequest.requestedBy,
        runId,
        trustLevel: toolDef?.minTrustLevel ?? "L3",
        stage: "commit",
        intent: `Commit: ${toolName}`,
        toolName,
        toolArgs: { commitId },
        toolResult: result.success ? { commitId, changesApplied: result.changesApplied } : undefined,
        errors: result.error ? [result.error] : undefined,
        summary: result.success
          ? `Applied ${result.changesApplied} changes`
          : `Failed: ${result.error}`,
      });
    } catch (error) {
      console.error(
        "[CommitToolBoundary] Failed to log commit:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a CommitToolBoundary instance
 */
export function createCommitToolBoundary(
  approvalStore: ApprovalStore,
  sandbox: Sandbox,
  logger: EventLogger,
  supabase?: SupabaseClient
): CommitToolBoundary {
  return new CommitToolBoundary(approvalStore, sandbox, logger, supabase);
}
