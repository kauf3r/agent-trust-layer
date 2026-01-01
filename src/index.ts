/**
 * Agent Trust Layer (ATL)
 *
 * A security and governance framework for AI agent operations.
 * Provides trust gates, event logging, approval workflows, and sandboxed execution.
 *
 * @packageDocumentation
 */

// =============================================================================
// Version Info
// =============================================================================

export const VERSION = "0.1.0";

export const ATL_CONFIG = {
  name: "@andykaufman/agent-trust-layer",
  version: VERSION,
  description: "Security and governance framework for AI agent operations",
} as const;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Configuration options for initializing ATL
 */
export interface InitATLOptions {
  /** Minimum trust level required for execution (default: 3 = L3) */
  trustThreshold?: number;
  /** Enable sandboxed execution mode (default: false) */
  sandboxMode?: boolean;
  /** Logger configuration */
  logger?: {
    enabled: boolean;
    destination: string;
  };
}

/**
 * Result of ATL initialization
 */
export interface InitATLResult {
  /** Whether ATL is ready for use */
  ready: boolean;
  /** Resolved configuration with defaults applied */
  config: {
    trustThreshold: number;
    sandboxMode: boolean;
    logger: {
      enabled: boolean;
      destination: string;
    };
  };
}

const DEFAULT_INIT_CONFIG = {
  trustThreshold: 3,
  sandboxMode: false,
  logger: { enabled: true, destination: "console" },
} as const;

/**
 * Initialize Agent Trust Layer with optional configuration.
 *
 * @param options - Configuration options (all optional, sensible defaults applied)
 * @returns Initialization result with resolved config
 *
 * @example
 * ```ts
 * // Initialize with defaults
 * const atl = initATL();
 *
 * // Initialize with custom trust threshold
 * const atl = initATL({ trustThreshold: 4 });
 *
 * // Initialize with Supabase logging
 * const atl = initATL({
 *   logger: { enabled: true, destination: "supabase" }
 * });
 * ```
 */
export function initATL(options?: InitATLOptions): InitATLResult {
  return {
    ready: true,
    config: {
      trustThreshold: options?.trustThreshold ?? DEFAULT_INIT_CONFIG.trustThreshold,
      sandboxMode: options?.sandboxMode ?? DEFAULT_INIT_CONFIG.sandboxMode,
      logger: options?.logger ?? DEFAULT_INIT_CONFIG.logger,
    },
  };
}

// =============================================================================
// Core Schema Types (from Zod schemas)
// =============================================================================

export {
  // Trust Levels
  TrustLevelSchema,
  type TrustLevel,

  // Tool Classification
  ToolCapabilitySchema,
  type ToolCapability,
  RiskLevelSchema,
  type RiskLevel,
  ExecutionModeSchema,
  type ExecutionMode,
  VerificationSchema,
  type Verification,

  // Tool Definition
  ToolDefinitionSchema,
  type ToolDefinition,

  // Workflow Stages
  WorkflowStageSchema,
  type WorkflowStage,

  // Domain
  DomainSchema,
  type Domain,

  // Agent Action Events
  AgentActionEventSchema,
  type AgentActionEvent,
  AgentActionEventInputSchema,
  type AgentActionEventInput,

  // Eval Runs
  EvalRunStatusSchema,
  type EvalRunStatus,
  EvalRunSchema,
  type EvalRun,

  // Golden Tasks
  GoldenTaskSchema,
  type GoldenTask,
  EvalSuiteSchema,
  type EvalSuite,

  // Trust Gate Config
  TrustGateConfigSchema,
  type TrustGateConfig,

  // Agent Definitions
  AgentRoleSchema,
  type AgentRole,
  AgentDefinitionSchema,
  type AgentDefinition,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,

  // Approval Flow
  ApprovalStatusSchema,
  type ApprovalStatus,
  ReviewerVerdictSchema,
  type ReviewerVerdict,
  DecisionTypeSchema,
  type DecisionType,
  CommitActionTypeSchema,
  type CommitActionType,
  ApprovalRequestSchema,
  type ApprovalRequest,
  ApprovalDecisionSchema,
  type ApprovalDecision,
} from "./core/schemas.js";

// =============================================================================
// Trust Gates
// =============================================================================

export {
  TrustGate,
  DEFAULT_GATES,
  type TrustGateResult,
  type TrustGateContext,
} from "./core/trust-gates.js";

// =============================================================================
// Event Logger
// =============================================================================

export {
  AgentEventLogger,
  InMemoryEventLogger,
  type EventLogger,
  type LogResult,
  type AgentLoggerStats,
  type AgentEventQuery,
} from "./core/logger.js";

// =============================================================================
// Approval Store
// =============================================================================

export {
  // Interface
  type ApprovalStore,

  // Implementations
  SupabaseApprovalStore,
  InMemoryApprovalStore,

  // Factory functions
  createApprovalStore,
  createInMemoryApprovalStore,

  // Input schemas and types
  CreateApprovalRequestSchema,
  CreateDecisionSchema,
  type CreateApprovalRequestInput,
  type CreateDecisionInput,
} from "./core/approvals.js";

// =============================================================================
// Commit Tools
// =============================================================================

export {
  CommitToolBoundary,
  COMMIT_TOOLS,
  isCommitTool,
  getCommitTool,
  type CommitToolDefinition,
  type CommitEligibilityResult,
} from "./core/commit-tools.js";

// =============================================================================
// Sandbox
// =============================================================================

export {
  DockerSandbox,
  FailClosedSandbox,
  PassthroughSandbox,
  createSandbox,
  createDockerSandbox,
  createPassthroughSandbox,
  createFailClosedSandbox,
  DEFAULT_SANDBOX_CONFIG,
  type Sandbox,
  type SandboxConfig,
  type SandboxExecutionInput,
  type SandboxExecutionResult,
  type StagedChange,
  type SandboxFailureReason,
} from "./core/sandbox.js";

// =============================================================================
// Tool Router
// =============================================================================

export {
  ToolRouter,
  createToolRouter,
  createAsiToolRouter,
  type ToolHandler,
  type ToolCallRequest,
  type ToolCallResult,
} from "./core/tool-router.js";

// =============================================================================
// Orchestrator
// =============================================================================

export {
  AgentOrchestrator,
  createOrchestrator,
  WORKFLOW_TEMPLATES,
  type OrchestratorConfig,
  type WorkflowRunOptions,
  type WorkflowResult,
} from "./core/orchestrator.js";

// =============================================================================
// Configuration Defaults
// =============================================================================

export {
  // Trust Level Definitions
  L0_DEFINITION,
  L1_DEFINITION,
  L2_DEFINITION,
  L3_DEFINITION,
  L4_DEFINITION,
  TRUST_LEVEL_DEFINITIONS,
  TRUST_LEVEL_ORDER,
  getTrustLevelDefinition,
  compareTrustLevels,
  isAtLeastAsRestrictive,
  getApprovalThreshold,
  getHumanApprovalThreshold,
  inferTrustLevel,
  type TrustLevelDefinition,

  // Tool Patterns
  L0_PATTERNS,
  L1_PATTERNS,
  L2_PATTERNS,
  L3_PATTERNS,
  L4_PATTERNS,
  ALL_PATTERNS,
  TOOL_PATTERN_CATEGORIES,
  getPatternsForLevel,
  findMatchingPattern,
  createToolFromPattern,
  validateToolAgainstPatterns,
  type ToolPattern,
  type ToolPatternCategory,

  // Domain Configuration
  DEFAULT_TRUST_GATE_CONFIG,
  createDomainConfig,
  computeToolTrustLevel,
  buildToolOverrides,
  validateDomainConfig,
  mergeDomainConfigs,
  describeTrustLevel,
  getTrustLevelSummary,
  type DomainConfig,
} from "./config/index.js";

// =============================================================================
// Domain Adapter
// =============================================================================

export {
  // Interface
  type DomainAdapter,
  type RegisteredTool,
  type AdapterValidationResult,

  // Registry
  DomainAdapterRegistry,
  createAdapterRegistry,

  // Factory Functions
  createDomainAdapter,
  mergeAdapters,
  buildDomainConfigFromAdapter,

  // Validation
  validateDomainAdapter,
  DomainAdapterMetadataSchema,
  RegisteredToolSchema,
} from "./core/domain-adapter.js";

// =============================================================================
// Migrations
// =============================================================================

export {
  // Migration file identifiers
  MIGRATIONS,
  MIGRATION_ORDER,

  // Path accessors
  getMigrationsDir,
  getMigrationPaths,
  getMigrationPath,

  // SQL readers
  readMigration,
  readAllMigrations,

  // Validation
  validateMigrations,
} from "./migrations.js";
