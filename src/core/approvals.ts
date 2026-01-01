/**
 * Approval Flow - DB Access Layer for Agent Trust Layer
 *
 * Provides database operations for the approval workflow:
 * - Create approval requests for L3+ commit operations
 * - Query pending approvals for human review
 * - Record approval/rejection decisions
 * - Check approval status before commit execution
 *
 * Database tables:
 * - approval_requests: Stores pending approval requests with expiry
 * - approval_decisions: Immutable audit log of decisions
 *
 * @example
 * ```typescript
 * const store = new ApprovalStore(supabaseClient);
 *
 * // Create request during commit stage
 * const request = await store.createRequest({
 *   runId: "uuid",
 *   workflowName: "daily_ops_brief",
 *   requestedBy: "ops_brief_lead",
 *   trustLevel: "L3",
 *   actionType: "COMMIT_POST_ALERT",
 *   actionPayload: { channel: "slack", message: "..." },
 *   reviewerVerdict: "PASS",
 * });
 *
 * // Check if approved before executing
 * const isApproved = await store.isApproved(request.id);
 * ```
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  TrustLevelSchema,
  DomainSchema,
  ApprovalStatusSchema,
  ReviewerVerdictSchema,
  DecisionTypeSchema,
  type ApprovalStatus,
  type ReviewerVerdict,
  type DecisionType,
  type ApprovalRequest,
  type ApprovalDecision,
} from "./schemas.js";

// Re-export types for convenience
export type {
  ApprovalStatus,
  ReviewerVerdict,
  DecisionType,
  ApprovalRequest,
  ApprovalDecision,
};

// =============================================================================
// Input Schemas (for creating new records)
// =============================================================================

/**
 * Schema for creating a new approval request
 */
export const CreateApprovalRequestSchema = z.object({
  domain: DomainSchema.default("asi"),
  runId: z.string().uuid(),
  workflowName: z.string().min(1),
  requestedBy: z.string().min(1),
  trustLevel: TrustLevelSchema,
  actionType: z.string().min(1),
  actionPayload: z.record(z.unknown()),
  context: z.record(z.unknown()).optional(),
  reviewerVerdict: ReviewerVerdictSchema.optional(),
  reviewerNotes: z.string().optional(),
});
export type CreateApprovalRequestInput = z.infer<
  typeof CreateApprovalRequestSchema
>;

/**
 * Schema for creating a new decision
 */
export const CreateDecisionSchema = z.object({
  approvalRequestId: z.string().uuid(),
  decidedBy: z.string().min(1),
  decision: DecisionTypeSchema,
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateDecisionInput = z.infer<typeof CreateDecisionSchema>;

// =============================================================================
// Database Row Types
// =============================================================================

interface ApprovalRequestRow {
  id: string;
  created_at: string;
  domain: string;
  run_id: string;
  workflow_name: string;
  requested_by: string;
  trust_level: string;
  action_type: string;
  action_payload: Record<string, unknown>;
  status: string;
  expires_at: string;
  context: Record<string, unknown> | null;
  reviewer_verdict: string | null;
  reviewer_notes: string | null;
  auto_approve_eligible: boolean;
  auto_approve_reason: string | null;
}

interface ApprovalDecisionRow {
  id: string;
  created_at: string;
  approval_request_id: string;
  decided_by: string;
  decision: string;
  notes: string | null;
  metadata: Record<string, unknown> | null;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default expiry times by trust level (in seconds)
 */
const DEFAULT_EXPIRY: Record<string, number> = {
  L3: 3600, // 1 hour
  L4: 86400, // 24 hours
};

/**
 * Actions that can NEVER be auto-approved
 */
const AUTO_APPROVE_DENY_LIST: string[] = [
  "COMMIT_SEND_INVOICE",
  "COMMIT_MARK_CHECKPOINT_COMPLETE",
  "billing_reconciliation",
  "compliance_audit_pack",
];

/**
 * Actions that CAN be auto-approved at L3 (if reviewer PASS)
 */
const AUTO_APPROVE_ALLOW_LIST: string[] = [
  "COMMIT_POST_ALERT",
  "COMMIT_PUBLISH_DAILY_BRIEF",
  "COMMIT_APPLY_CHANGES",
  "daily_ops_brief",
  "alert_triage",
];

// =============================================================================
// ApprovalStore Interface
// =============================================================================

/**
 * Storage interface for approval workflow
 *
 * Implementations must handle:
 * - Approval request creation and retrieval
 * - Decision recording
 * - Auto-approval eligibility checks
 * - Expiry management
 */
export interface ApprovalStore {
  // Approval Requests
  createRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest>;
  getRequest(id: string): Promise<ApprovalRequest | null>;
  getPendingRequests(options?: {
    domain?: string;
    workflowName?: string;
    limit?: number;
  }): Promise<ApprovalRequest[]>;
  getRequestsByRunId(runId: string): Promise<ApprovalRequest[]>;
  isApproved(id: string): Promise<boolean>;
  isPending(id: string): Promise<boolean>;
  expireStaleRequests(): Promise<number>;

  // Approval Decisions
  createDecision(input: CreateDecisionInput): Promise<ApprovalDecision>;
  getDecision(approvalRequestId: string): Promise<ApprovalDecision | null>;
  autoApprove(id: string, reason: string): Promise<ApprovalDecision | null>;
}

// =============================================================================
// SupabaseApprovalStore Class
// =============================================================================

/**
 * Supabase implementation of ApprovalStore
 *
 * SECURITY: This class implements FAIL CLOSED semantics.
 * - Invalid inputs = rejection
 * - Database errors = rejection (not silent failure)
 * - L4 requests can NEVER be auto-approved
 * - Expired requests are automatically rejected
 */
export class SupabaseApprovalStore implements ApprovalStore {
  private client: SupabaseClient;
  private requestsTable = "approval_requests";
  private decisionsTable = "approval_decisions";

  constructor(client: SupabaseClient) {
    if (!client) {
      throw new Error("FAIL CLOSED: ApprovalStore requires a valid Supabase client");
    }
    this.client = client;
  }

  // ---------------------------------------------------------------------------
  // Approval Requests
  // ---------------------------------------------------------------------------

  /**
   * Create a new approval request
   *
   * SECURITY: This method enforces:
   * - L4 requests ALWAYS require human approval (never auto-approved)
   * - L3 requests require reviewer PASS for auto-approval eligibility
   * - All requests have enforced expiry times
   *
   * @param input - Request details
   * @returns Created approval request
   */
  async createRequest(
    input: CreateApprovalRequestInput
  ): Promise<ApprovalRequest> {
    // =========================================================================
    // FAIL CLOSED: Validate input strictly
    // =========================================================================
    let validated: CreateApprovalRequestInput;
    try {
      validated = CreateApprovalRequestSchema.parse(input);
    } catch (error) {
      throw new Error(
        `FAIL CLOSED: Invalid approval request input - ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // =========================================================================
    // SECURITY: L4 enforcement
    // =========================================================================
    // L4 requests MUST have longer expiry and can NEVER be auto-approved
    const isL4 = validated.trustLevel === "L4";
    if (isL4) {
      console.log(
        `[ApprovalStore] L4 request for ${validated.actionType} - human approval REQUIRED`
      );
    }

    // Calculate expiry based on trust level
    const expirySeconds = DEFAULT_EXPIRY[validated.trustLevel] ?? 3600;
    const expiresAt = new Date(Date.now() + expirySeconds * 1000);

    // Determine auto-approve eligibility (L4 is ALWAYS false)
    const autoApproveEligible = isL4
      ? false // INVARIANT: L4 can NEVER be auto-approved
      : this.isAutoApproveEligible(
          validated.trustLevel,
          validated.actionType,
          validated.workflowName,
          validated.reviewerVerdict
        );

    const row = {
      domain: validated.domain,
      run_id: validated.runId,
      workflow_name: validated.workflowName,
      requested_by: validated.requestedBy,
      trust_level: validated.trustLevel,
      action_type: validated.actionType,
      action_payload: validated.actionPayload,
      status: "PENDING",
      expires_at: expiresAt.toISOString(),
      context: validated.context ?? null,
      reviewer_verdict: validated.reviewerVerdict ?? null,
      reviewer_notes: validated.reviewerNotes ?? null,
      auto_approve_eligible: autoApproveEligible,
      auto_approve_reason: null,
    };

    const { data, error } = await this.client
      .from(this.requestsTable)
      .insert(row)
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to create approval request: ${error.message}`);
    }

    return this.rowToRequest(data as ApprovalRequestRow);
  }

  /**
   * Get an approval request by ID
   */
  async getRequest(id: string): Promise<ApprovalRequest | null> {
    const { data, error } = await this.client
      .from(this.requestsTable)
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return null; // Not found
      }
      throw new Error(`Failed to get approval request: ${error.message}`);
    }

    return this.rowToRequest(data as ApprovalRequestRow);
  }

  /**
   * Get all pending approval requests
   */
  async getPendingRequests(options?: {
    domain?: string;
    workflowName?: string;
    limit?: number;
  }): Promise<ApprovalRequest[]> {
    let query = this.client
      .from(this.requestsTable)
      .select("*")
      .eq("status", "PENDING")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    if (options?.domain) {
      query = query.eq("domain", options.domain);
    }
    if (options?.workflowName) {
      query = query.eq("workflow_name", options.workflowName);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get pending requests: ${error.message}`);
    }

    return (data ?? []).map((row) =>
      this.rowToRequest(row as ApprovalRequestRow)
    );
  }

  /**
   * Get approval requests by run ID
   */
  async getRequestsByRunId(runId: string): Promise<ApprovalRequest[]> {
    const { data, error } = await this.client
      .from(this.requestsTable)
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to get requests by run ID: ${error.message}`);
    }

    return (data ?? []).map((row) =>
      this.rowToRequest(row as ApprovalRequestRow)
    );
  }

  /**
   * Check if an approval request is approved
   */
  async isApproved(id: string): Promise<boolean> {
    const request = await this.getRequest(id);
    return request?.status === "APPROVED";
  }

  /**
   * Check if an approval request is still pending and valid
   */
  async isPending(id: string): Promise<boolean> {
    const request = await this.getRequest(id);
    if (!request) return false;
    if (request.status !== "PENDING") return false;
    if (new Date(request.expiresAt) < new Date()) return false;
    return true;
  }

  /**
   * Expire stale approval requests
   * Returns the number of expired requests
   */
  async expireStaleRequests(): Promise<number> {
    const { data, error } = await this.client
      .from(this.requestsTable)
      .update({ status: "EXPIRED" })
      .eq("status", "PENDING")
      .lt("expires_at", new Date().toISOString())
      .select("id");

    if (error) {
      throw new Error(`Failed to expire stale requests: ${error.message}`);
    }

    return data?.length ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Approval Decisions
  // ---------------------------------------------------------------------------

  /**
   * Create an approval decision (approve or reject)
   * Note: The database trigger will automatically update the request status
   */
  async createDecision(input: CreateDecisionInput): Promise<ApprovalDecision> {
    const validated = CreateDecisionSchema.parse(input);

    // Verify the request exists and is pending
    const request = await this.getRequest(validated.approvalRequestId);
    if (!request) {
      throw new Error(
        `Approval request not found: ${validated.approvalRequestId}`
      );
    }
    if (request.status !== "PENDING") {
      throw new Error(
        `Cannot decide on request with status: ${request.status}`
      );
    }
    if (new Date(request.expiresAt) < new Date()) {
      throw new Error("Approval request has expired");
    }

    const row = {
      approval_request_id: validated.approvalRequestId,
      decided_by: validated.decidedBy,
      decision: validated.decision,
      notes: validated.notes ?? null,
      metadata: validated.metadata ?? null,
    };

    const { data, error } = await this.client
      .from(this.decisionsTable)
      .insert(row)
      .select("*")
      .single();

    if (error) {
      // Handle unique constraint (already decided)
      if (error.code === "23505") {
        throw new Error("A decision has already been made for this request");
      }
      throw new Error(`Failed to create decision: ${error.message}`);
    }

    return this.rowToDecision(data as ApprovalDecisionRow);
  }

  /**
   * Get decision for an approval request
   */
  async getDecision(
    approvalRequestId: string
  ): Promise<ApprovalDecision | null> {
    const { data, error } = await this.client
      .from(this.decisionsTable)
      .select("*")
      .eq("approval_request_id", approvalRequestId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return null; // Not found
      }
      throw new Error(`Failed to get decision: ${error.message}`);
    }

    return this.rowToDecision(data as ApprovalDecisionRow);
  }

  /**
   * Auto-approve an eligible request
   *
   * SECURITY: This method enforces multiple gates:
   * 1. Request must exist
   * 2. Request must be PENDING (not already decided)
   * 3. Request must NOT be L4 (INVARIANT: L4 always requires human)
   * 4. Request must be marked as auto-approve eligible
   * 5. Reviewer verdict must be PASS
   *
   * Only succeeds if ALL gates pass.
   */
  async autoApprove(
    id: string,
    reason: string
  ): Promise<ApprovalDecision | null> {
    const request = await this.getRequest(id);
    if (!request) {
      throw new Error(`FAIL CLOSED: Approval request not found: ${id}`);
    }

    // =========================================================================
    // SECURITY GATE 1: L4 can NEVER be auto-approved
    // =========================================================================
    if (request.trustLevel === "L4") {
      console.error(
        `[ApprovalStore] BLOCKED: Attempted to auto-approve L4 request ${id}. ` +
        `L4 ALWAYS requires human approval.`
      );
      return null;
    }

    // =========================================================================
    // SECURITY GATE 2: Must be pending
    // =========================================================================
    if (request.status !== "PENDING") {
      console.warn(
        `[ApprovalStore] Cannot auto-approve request ${id} with status ${request.status}`
      );
      return null;
    }

    // =========================================================================
    // SECURITY GATE 3: Must be marked eligible
    // =========================================================================
    if (!request.autoApproveEligible) {
      return null; // Cannot auto-approve
    }

    // =========================================================================
    // SECURITY GATE 4: Reviewer must have PASSED
    // =========================================================================
    if (request.reviewerVerdict !== "PASS") {
      console.warn(
        `[ApprovalStore] Cannot auto-approve request ${id} without reviewer PASS. ` +
        `Current verdict: ${request.reviewerVerdict ?? "none"}`
      );
      return null;
    }

    // =========================================================================
    // SECURITY GATE 5: Must not be expired
    // =========================================================================
    if (new Date(request.expiresAt) < new Date()) {
      console.warn(`[ApprovalStore] Cannot auto-approve expired request ${id}`);
      return null;
    }

    // All gates passed - proceed with auto-approval
    console.log(
      `[ApprovalStore] Auto-approving request ${id}: ${reason}`
    );

    // Update the auto_approve_reason
    await this.client
      .from(this.requestsTable)
      .update({ auto_approve_reason: reason })
      .eq("id", id);

    // Create the decision
    return this.createDecision({
      approvalRequestId: id,
      decidedBy: "system:auto-approve",
      decision: "APPROVE",
      notes: reason,
      metadata: { autoApproved: true, reason },
    });
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Determine if an action is eligible for auto-approval
   */
  private isAutoApproveEligible(
    trustLevel: string,
    actionType: string,
    workflowName: string,
    reviewerVerdict?: string
  ): boolean {
    // L4 can NEVER be auto-approved
    if (trustLevel === "L4") {
      return false;
    }

    // Must be L3 for auto-approve
    if (trustLevel !== "L3") {
      return false;
    }

    // Reviewer must have returned PASS
    if (reviewerVerdict !== "PASS") {
      return false;
    }

    // Check deny list
    if (
      AUTO_APPROVE_DENY_LIST.includes(actionType) ||
      AUTO_APPROVE_DENY_LIST.includes(workflowName)
    ) {
      return false;
    }

    // Check allow list
    if (
      AUTO_APPROVE_ALLOW_LIST.includes(actionType) ||
      AUTO_APPROVE_ALLOW_LIST.includes(workflowName)
    ) {
      return true;
    }

    // Default: not eligible
    return false;
  }

  /**
   * Convert database row to ApprovalRequest
   */
  private rowToRequest(row: ApprovalRequestRow): ApprovalRequest {
    return {
      id: row.id,
      createdAt: new Date(row.created_at),
      domain: row.domain as ApprovalRequest["domain"],
      runId: row.run_id,
      workflowName: row.workflow_name,
      requestedBy: row.requested_by,
      trustLevel: row.trust_level as ApprovalRequest["trustLevel"],
      actionType: row.action_type,
      actionPayload: row.action_payload,
      status: row.status as ApprovalStatus,
      expiresAt: new Date(row.expires_at),
      context: row.context ?? undefined,
      reviewerVerdict: row.reviewer_verdict as ReviewerVerdict | undefined,
      reviewerNotes: row.reviewer_notes ?? undefined,
      autoApproveEligible: row.auto_approve_eligible,
      autoApproveReason: row.auto_approve_reason ?? undefined,
    };
  }

  /**
   * Convert database row to ApprovalDecision
   */
  private rowToDecision(row: ApprovalDecisionRow): ApprovalDecision {
    return {
      id: row.id,
      createdAt: new Date(row.created_at),
      approvalRequestId: row.approval_request_id,
      decidedBy: row.decided_by,
      decision: row.decision as DecisionType,
      notes: row.notes ?? undefined,
      metadata: row.metadata ?? undefined,
    };
  }
}

// =============================================================================
// InMemoryApprovalStore (for testing)
// =============================================================================

/**
 * In-memory implementation of ApprovalStore for testing
 *
 * IMPORTANT: This class implements the same validation and security rules
 * as SupabaseApprovalStore to ensure consistent behavior in tests.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private requests: Map<string, ApprovalRequest> = new Map();
  private decisions: Map<string, ApprovalDecision> = new Map();

  async createRequest(
    input: CreateApprovalRequestInput
  ): Promise<ApprovalRequest> {
    // Validate input
    let validated: CreateApprovalRequestInput;
    try {
      validated = CreateApprovalRequestSchema.parse(input);
    } catch (error) {
      throw new Error(
        `FAIL CLOSED: Invalid approval request input - ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const isL4 = validated.trustLevel === "L4";
    const expirySeconds = isL4 ? 86400 : 3600; // 24h for L4, 1h for L3
    const expiresAt = new Date(Date.now() + expirySeconds * 1000);

    // Determine auto-approve eligibility
    const autoApproveEligible = isL4
      ? false
      : this.isAutoApproveEligible(
          validated.trustLevel,
          validated.actionType,
          validated.workflowName,
          validated.reviewerVerdict
        );

    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      domain: validated.domain as ApprovalRequest["domain"],
      runId: validated.runId,
      workflowName: validated.workflowName,
      requestedBy: validated.requestedBy,
      trustLevel: validated.trustLevel as ApprovalRequest["trustLevel"],
      actionType: validated.actionType,
      actionPayload: validated.actionPayload,
      status: "PENDING",
      expiresAt,
      context: validated.context,
      reviewerVerdict: validated.reviewerVerdict as ReviewerVerdict | undefined,
      reviewerNotes: validated.reviewerNotes,
      autoApproveEligible,
      autoApproveReason: undefined,
    };

    this.requests.set(request.id, request);
    return request;
  }

  async getRequest(id: string): Promise<ApprovalRequest | null> {
    return this.requests.get(id) ?? null;
  }

  async getPendingRequests(options?: {
    domain?: string;
    workflowName?: string;
    limit?: number;
  }): Promise<ApprovalRequest[]> {
    const now = new Date();
    let results = Array.from(this.requests.values())
      .filter((r) => r.status === "PENDING" && new Date(r.expiresAt) > now);

    if (options?.domain) {
      results = results.filter((r) => r.domain === options.domain);
    }
    if (options?.workflowName) {
      results = results.filter((r) => r.workflowName === options.workflowName);
    }

    // Sort by createdAt descending
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async getRequestsByRunId(runId: string): Promise<ApprovalRequest[]> {
    return Array.from(this.requests.values())
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async isApproved(id: string): Promise<boolean> {
    const request = await this.getRequest(id);
    return request?.status === "APPROVED";
  }

  async isPending(id: string): Promise<boolean> {
    const request = await this.getRequest(id);
    if (!request) return false;
    if (request.status !== "PENDING") return false;
    if (new Date(request.expiresAt) < new Date()) return false;
    return true;
  }

  async expireStaleRequests(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.status === "PENDING" && new Date(request.expiresAt) < now) {
        request.status = "EXPIRED";
        count++;
      }
    }
    return count;
  }

  async createDecision(input: CreateDecisionInput): Promise<ApprovalDecision> {
    const validated = CreateDecisionSchema.parse(input);

    const request = await this.getRequest(validated.approvalRequestId);
    if (!request) {
      throw new Error(
        `Approval request not found: ${validated.approvalRequestId}`
      );
    }
    if (request.status !== "PENDING") {
      throw new Error(
        `Cannot decide on request with status: ${request.status}`
      );
    }
    if (new Date(request.expiresAt) < new Date()) {
      throw new Error("Approval request has expired");
    }

    // Check for existing decision
    if (this.decisions.has(validated.approvalRequestId)) {
      throw new Error("A decision has already been made for this request");
    }

    const decision: ApprovalDecision = {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      approvalRequestId: validated.approvalRequestId,
      decidedBy: validated.decidedBy,
      decision: validated.decision,
      notes: validated.notes,
      metadata: validated.metadata,
    };

    // Update request status (simulate database trigger)
    request.status = validated.decision === "APPROVE" ? "APPROVED" : "REJECTED";

    this.decisions.set(validated.approvalRequestId, decision);
    return decision;
  }

  async getDecision(
    approvalRequestId: string
  ): Promise<ApprovalDecision | null> {
    return this.decisions.get(approvalRequestId) ?? null;
  }

  async autoApprove(
    id: string,
    reason: string
  ): Promise<ApprovalDecision | null> {
    const request = await this.getRequest(id);
    if (!request) {
      throw new Error(`FAIL CLOSED: Approval request not found: ${id}`);
    }

    // L4 can NEVER be auto-approved
    if (request.trustLevel === "L4") {
      return null;
    }

    // Must be pending
    if (request.status !== "PENDING") {
      return null;
    }

    // Must be marked eligible
    if (!request.autoApproveEligible) {
      return null;
    }

    // Reviewer must have PASSED
    if (request.reviewerVerdict !== "PASS") {
      return null;
    }

    // Must not be expired
    if (new Date(request.expiresAt) < new Date()) {
      return null;
    }

    // Update auto_approve_reason
    request.autoApproveReason = reason;

    return this.createDecision({
      approvalRequestId: id,
      decidedBy: "system:auto-approve",
      decision: "APPROVE",
      notes: reason,
      metadata: { autoApproved: true, reason },
    });
  }

  /**
   * Helper to determine auto-approve eligibility (mirrors SupabaseApprovalStore)
   */
  private isAutoApproveEligible(
    trustLevel: string,
    actionType: string,
    workflowName: string,
    reviewerVerdict?: string
  ): boolean {
    if (trustLevel === "L4") return false;
    if (trustLevel !== "L3") return false;
    if (reviewerVerdict !== "PASS") return false;

    const denyList = [
      "COMMIT_SEND_INVOICE",
      "COMMIT_MARK_CHECKPOINT_COMPLETE",
      "billing_reconciliation",
      "compliance_audit_pack",
    ];
    if (denyList.includes(actionType) || denyList.includes(workflowName)) {
      return false;
    }

    const allowList = [
      "COMMIT_POST_ALERT",
      "COMMIT_PUBLISH_DAILY_BRIEF",
      "COMMIT_APPLY_CHANGES",
      "daily_ops_brief",
      "alert_triage",
    ];
    if (allowList.includes(actionType) || allowList.includes(workflowName)) {
      return true;
    }

    return false;
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.requests.clear();
    this.decisions.clear();
  }

  /**
   * Get all requests (for testing)
   */
  getRequests(): ApprovalRequest[] {
    return Array.from(this.requests.values());
  }

  /**
   * Get all decisions (for testing)
   */
  getDecisions(): ApprovalDecision[] {
    return Array.from(this.decisions.values());
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a Supabase-backed ApprovalStore
 *
 * @param client - Supabase client (should be service role for server-side operations)
 * @returns SupabaseApprovalStore instance
 */
export function createApprovalStore(client: SupabaseClient): ApprovalStore {
  return new SupabaseApprovalStore(client);
}

/**
 * Create an in-memory ApprovalStore for testing
 *
 * @returns InMemoryApprovalStore instance
 */
export function createInMemoryApprovalStore(): InMemoryApprovalStore {
  return new InMemoryApprovalStore();
}
