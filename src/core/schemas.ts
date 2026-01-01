/**
 * Agent Trust Layer - Zod Schemas
 *
 * Type-safe schemas for trust gates, tool definitions, and agent action events.
 * These schemas provide runtime validation and TypeScript type inference.
 */

import { z } from "zod";

// =============================================================================
// Trust Level Classification
// =============================================================================

/**
 * Trust levels define how much autonomy an agent has for a given action.
 *
 * L0 - Full autonomy (read-only, low risk)
 * L1 - Can propose (suggestions, drafts)
 * L2 - Sandboxed writes (reversible changes)
 * L3 - Needs review (side effects, external APIs)
 * L4 - Human required (critical operations)
 */
export const TrustLevelSchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

// =============================================================================
// Tool Classification
// =============================================================================

/**
 * Tool capabilities define what type of operation a tool performs.
 */
export const ToolCapabilitySchema = z.enum([
  "READ",         // Read-only access to data
  "PROPOSE",      // Can suggest changes (no side effects)
  "WRITE",        // Can modify data
  "SIDE_EFFECTS", // External side effects (email, API calls, etc.)
]);
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

/**
 * Risk levels for tools, used in trust gate evaluation.
 */
export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * Execution modes determine if a tool runs directly or in a sandbox.
 */
export const ExecutionModeSchema = z.enum(["DIRECT", "SANDBOX_ONLY"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/**
 * Verification requirements for tool outputs.
 */
export const VerificationSchema = z.enum([
  "NONE",           // No verification needed
  "RULES",          // Automated rule checks
  "MULTI_AGENT",    // Reviewer agent required
  "HUMAN_APPROVAL", // Human must approve
]);
export type Verification = z.infer<typeof VerificationSchema>;

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * Complete tool definition with trust metadata.
 */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  capability: ToolCapabilitySchema,
  risk: RiskLevelSchema,
  executionMode: ExecutionModeSchema,
  verification: VerificationSchema,
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// =============================================================================
// Workflow Stages
// =============================================================================

/**
 * Workflow stages define the progression of an agent workflow.
 *
 * plan    - Gathering information, making decisions
 * execute - Taking actions (with trust gate enforcement)
 * review  - Verification by reviewer agent
 * commit  - Final actions (side effects allowed)
 */
export const WorkflowStageSchema = z.enum(["plan", "execute", "review", "commit"]);
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

// =============================================================================
// Domain
// =============================================================================

/**
 * Domain identifies which vertical the action belongs to.
 */
export const DomainSchema = z.enum(["asi", "land"]);
export type Domain = z.infer<typeof DomainSchema>;

// =============================================================================
// Agent Action Event (Audit Log Entry)
// =============================================================================

/**
 * Schema for agent action events (mirrors database table).
 * Every tool call and workflow action is logged as an event.
 */
export const AgentActionEventSchema = z.object({
  // Identity (auto-generated)
  id: z.string().uuid().optional(),
  createdAt: z.date().optional(),

  // Context
  domain: DomainSchema,
  workflowName: z.string().min(1),
  agentName: z.string().min(1),
  runId: z.string().uuid(),

  // Trust classification
  trustLevel: TrustLevelSchema,
  stage: WorkflowStageSchema,
  intent: z.string().min(1),

  // Tool execution (optional - some events are not tool calls)
  toolName: z.string().optional(),
  toolArgs: z.record(z.unknown()).optional(),
  toolResult: z.record(z.unknown()).optional(),

  // Artifacts and status
  artifactRefs: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),

  // Scoring
  summary: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type AgentActionEvent = z.infer<typeof AgentActionEventSchema>;

/**
 * Input schema for creating new agent action events.
 * id and createdAt are auto-generated.
 */
export const AgentActionEventInputSchema = AgentActionEventSchema.omit({
  id: true,
  createdAt: true,
});
export type AgentActionEventInput = z.infer<typeof AgentActionEventInputSchema>;

// =============================================================================
// Eval Run (Regression Testing)
// =============================================================================

/**
 * Status of an evaluation run.
 */
export const EvalRunStatusSchema = z.enum(["running", "passed", "failed", "error"]);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

/**
 * Schema for evaluation runs.
 */
export const EvalRunSchema = z.object({
  id: z.string().uuid().optional(),
  createdAt: z.date().optional(),

  // Run metadata
  suiteName: z.string().min(1),
  modelId: z.string().min(1),
  provider: z.string().default("anthropic"),

  // Results
  status: EvalRunStatusSchema,
  totalTasks: z.number().int().nonnegative(),
  passedTasks: z.number().int().nonnegative(),
  failedTasks: z.number().int().nonnegative(),

  // Metrics
  longestCorrectChain: z.number().int().nonnegative().optional(),
  interventionCount: z.number().int().nonnegative().default(0),
  totalDurationMs: z.number().int().nonnegative().optional(),

  // Detailed results
  taskResults: z.record(z.unknown()).optional(),
  errors: z.array(z.string()).optional(),

  // Drift detection
  baselineRunId: z.string().uuid().optional(),
  driftScore: z.number().min(0).max(100).optional(),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

// =============================================================================
// Golden Task (Eval Fixtures)
// =============================================================================

/**
 * Schema for golden tasks used in evaluation.
 */
export const GoldenTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workflow: z.string().min(1),
  input: z.string().min(1),
  expectedOutput: z.record(z.unknown()).optional(),
  expectedToolCalls: z.array(z.string()).optional(),
  maxDurationMs: z.number().int().positive().optional(),
});
export type GoldenTask = z.infer<typeof GoldenTaskSchema>;

/**
 * Schema for evaluation suites (collection of golden tasks).
 */
export const EvalSuiteSchema = z.object({
  name: z.string().min(1),
  domain: DomainSchema,
  tasks: z.array(GoldenTaskSchema),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

// =============================================================================
// Trust Gate Configuration
// =============================================================================

/**
 * Schema for trust gate configuration (loaded from YAML).
 */
export const TrustGateConfigSchema = z.object({
  domain: DomainSchema,
  defaultTrustLevel: TrustLevelSchema,
  requireApprovalAbove: TrustLevelSchema,
  sandboxWriteOps: z.boolean().default(true),
  toolOverrides: z.record(TrustLevelSchema).optional(),
});
export type TrustGateConfig = z.infer<typeof TrustGateConfigSchema>;

// =============================================================================
// Agent Definition
// =============================================================================

/**
 * Agent role in a workflow.
 */
export const AgentRoleSchema = z.enum(["planner", "worker", "reviewer"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Schema for agent definitions.
 */
export const AgentDefinitionSchema = z.object({
  name: z.string().min(1),
  role: AgentRoleSchema,
  systemPrompt: z.string().min(1),
  allowedTools: z.array(z.string()),
  maxTurns: z.number().int().positive().default(10),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * Schema for workflow definitions.
 */
export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  domain: DomainSchema,
  agents: z.array(AgentDefinitionSchema),
  stages: z.array(WorkflowStageSchema),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// =============================================================================
// Approval Flow (L3+ Commit Operations)
// =============================================================================

/**
 * Approval request status
 */
export const ApprovalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * Reviewer verdict from multi-agent review stage
 */
export const ReviewerVerdictSchema = z.enum(["PASS", "FAIL"]);
export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

/**
 * Decision type for approval decisions
 */
export const DecisionTypeSchema = z.enum(["APPROVE", "REJECT"]);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

/**
 * Action types for commit operations (the ONLY path to production writes)
 */
export const CommitActionTypeSchema = z.enum([
  "COMMIT_APPLY_CHANGES",
  "COMMIT_SEND_INVOICE",
  "COMMIT_MARK_CHECKPOINT_COMPLETE",
  "COMMIT_POST_ALERT",
  "COMMIT_PUBLISH_DAILY_BRIEF",
]);
export type CommitActionType = z.infer<typeof CommitActionTypeSchema>;

/**
 * Schema for approval request (matches approval_requests table)
 */
export const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.date(),
  domain: DomainSchema,
  runId: z.string().uuid(),
  workflowName: z.string().min(1),
  requestedBy: z.string().min(1),
  trustLevel: TrustLevelSchema,
  actionType: z.string().min(1),
  actionPayload: z.record(z.unknown()),
  status: ApprovalStatusSchema,
  expiresAt: z.date(),
  context: z.record(z.unknown()).optional(),
  reviewerVerdict: ReviewerVerdictSchema.optional(),
  reviewerNotes: z.string().optional(),
  autoApproveEligible: z.boolean(),
  autoApproveReason: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * Schema for approval decision (matches approval_decisions table)
 */
export const ApprovalDecisionSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.date(),
  approvalRequestId: z.string().uuid(),
  decidedBy: z.string().min(1),
  decision: DecisionTypeSchema,
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
