/**
 * Domain Adapter Interface
 *
 * Provides a plugin architecture for adding domain-specific tools, agents,
 * and workflows to the Agent Trust Layer. Each business vertical (ASI, LandOS, etc.)
 * implements this interface to plug into the ATL core.
 *
 * Architecture Pattern: Plugin + Hexagonal Architecture
 *
 * The DomainAdapter is the main entry point for integrating a business domain
 * with the ATL. It provides:
 * - Tool definitions with handlers
 * - Agent definitions with system prompts
 * - Workflow definitions with stage configurations
 * - Domain-specific trust configuration
 *
 * @example
 * ```typescript
 * // Create a domain adapter for ASI (AirSpace Integration)
 * const asiAdapter: DomainAdapter = {
 *   domain: "asi",
 *   name: "AirSpace Integration",
 *   version: "1.0.0",
 *
 *   getTools: () => [
 *     { definition: getBookingsTool, handler: fetchBookings },
 *     { definition: createFlightTool, handler: createFlight },
 *   ],
 *
 *   getAgents: () => [
 *     { name: "booking_manager", role: "worker", ... },
 *     { name: "compliance_checker", role: "reviewer", ... },
 *   ],
 *
 *   getWorkflows: () => [
 *     { name: "daily_brief", stages: ["plan", "execute", "review", "commit"], ... },
 *   ],
 *
 *   getConfig: () => ({
 *     trustGate: { defaultTrustLevel: "L1", ... },
 *     toolOverrides: { "asi.send_invoice": "L3" },
 *   }),
 * };
 *
 * // Register with ATL
 * const atl = await initializeATL(asiAdapter);
 * ```
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type {
  Domain,
  TrustLevel,
  TrustGateConfig,
  ToolDefinition,
  AgentDefinition,
  WorkflowDefinition,
  ToolCapability,
  RiskLevel,
  ExecutionMode,
  Verification,
} from "./schemas.js";
import type { ToolHandler } from "./tool-router.js";
import type { DomainConfig } from "../config/index.js";

// =============================================================================
// Tool Registration Types
// =============================================================================

/**
 * A tool with its handler, ready to be registered with the ToolRouter.
 *
 * Tools are the atomic operations that agents can perform. Each tool has:
 * - A definition (metadata, input schema, trust classification)
 * - A handler (the actual implementation)
 */
export interface RegisteredTool {
  /** Tool definition with metadata and trust classification */
  definition: ToolDefinition;
  /** Handler function that executes the tool */
  handler: ToolHandler;
}

/**
 * Schema for validating RegisteredTool objects
 */
export const RegisteredToolSchema = z.object({
  definition: z.object({
    name: z.string().min(1),
    description: z.string(),
    capability: z.enum(["READ", "PROPOSE", "WRITE", "SIDE_EFFECTS"]),
    risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    executionMode: z.enum(["DIRECT", "SANDBOX_ONLY"]),
    verification: z.enum(["NONE", "RULES", "MULTI_AGENT", "HUMAN_APPROVAL"]),
    inputSchema: z.record(z.unknown()),
    outputSchema: z.record(z.unknown()).optional(),
  }),
  handler: z.function(),
});

// =============================================================================
// Domain Adapter Interface
// =============================================================================

/**
 * Domain Adapter interface for plugging in domain-specific components.
 *
 * This is the main contract that each business vertical implements to
 * integrate with the ATL. Think of it as a "plugin" that provides:
 *
 * 1. **Tools** - Domain-specific operations (e.g., "get_bookings", "send_invoice")
 * 2. **Agents** - Domain-specific agent definitions (e.g., "booking_manager")
 * 3. **Workflows** - Domain-specific workflows (e.g., "daily_brief", "invoice_run")
 * 4. **Configuration** - Trust levels, overrides, and domain settings
 *
 * The adapter follows the Plugin Architecture pattern, allowing the ATL
 * core to remain domain-agnostic while supporting multiple business verticals.
 */
export interface DomainAdapter {
  // ===========================================================================
  // Identity
  // ===========================================================================

  /** Domain identifier (must match Domain schema) */
  readonly domain: Domain;

  /** Human-readable name for the domain */
  readonly name: string;

  /** Version of the adapter (semver) */
  readonly version: string;

  /** Optional description of the domain */
  readonly description?: string;

  // ===========================================================================
  // Tool Provision
  // ===========================================================================

  /**
   * Returns all tools provided by this domain.
   *
   * Tools are registered with the ToolRouter and become available to agents
   * in workflows. Each tool should follow the naming convention:
   * `{domain}.{category}.{action}` (e.g., "asi.bookings.get_by_date")
   *
   * @returns Array of tools with their handlers
   *
   * @example
   * ```typescript
   * getTools: () => [
   *   {
   *     definition: {
   *       name: "asi.bookings.get_by_date",
   *       description: "Fetch bookings for a specific date",
   *       capability: "READ",
   *       risk: "LOW",
   *       executionMode: "DIRECT",
   *       verification: "NONE",
   *       inputSchema: { date: { type: "string", format: "date" } },
   *     },
   *     handler: async (args) => {
   *       return await officernd.getBookings(args.date);
   *     },
   *   },
   * ]
   * ```
   */
  getTools(): RegisteredTool[];

  // ===========================================================================
  // Agent Provision
  // ===========================================================================

  /**
   * Returns all agent definitions for this domain.
   *
   * Agents are the LLM-powered entities that execute workflows. Each domain
   * typically provides agents with specialized system prompts and tool access.
   *
   * Common patterns:
   * - One planner agent for gathering information
   * - One or more worker agents for taking actions
   * - One reviewer agent for verification
   *
   * @returns Array of agent definitions
   *
   * @example
   * ```typescript
   * getAgents: () => [
   *   {
   *     name: "asi_booking_manager",
   *     role: "worker",
   *     systemPrompt: "You manage UAS test range bookings...",
   *     allowedTools: ["asi.bookings.get_by_date", "asi.bookings.create"],
   *     maxTurns: 10,
   *   },
   * ]
   * ```
   */
  getAgents(): AgentDefinition[];

  // ===========================================================================
  // Workflow Provision
  // ===========================================================================

  /**
   * Returns all workflow definitions for this domain.
   *
   * Workflows are the orchestrated sequences of agent activities. Each workflow
   * defines which agents participate and what stages they execute.
   *
   * Standard stages:
   * - `plan` - Gather information, make decisions (L0-L1 tools only)
   * - `execute` - Take actions (L0-L2 tools, sandboxed writes)
   * - `review` - Verify output (L0-L1 tools, must return PASS/FAIL verdict)
   * - `commit` - Finalize with side effects (L0-L3+ tools, may need approval)
   *
   * @returns Array of workflow definitions
   *
   * @example
   * ```typescript
   * getWorkflows: () => [
   *   {
   *     name: "daily_brief",
   *     domain: "asi",
   *     agents: [...], // planner, worker, reviewer
   *     stages: ["plan", "execute", "review", "commit"],
   *   },
   * ]
   * ```
   */
  getWorkflows(): WorkflowDefinition[];

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Returns domain-specific configuration.
   *
   * This provides trust gate settings, tool overrides, and other
   * domain-specific configuration. The configuration is merged with
   * ATL defaults.
   *
   * @returns Partial domain configuration
   *
   * @example
   * ```typescript
   * getConfig: () => ({
   *   trustGate: {
   *     defaultTrustLevel: "L1",
   *     requireApprovalAbove: "L2",
   *     sandboxWriteOps: true,
   *   },
   *   toolOverrides: {
   *     "asi.invoices.send": "L3",
   *     "asi.alerts.broadcast": "L4",
   *   },
   * })
   * ```
   */
  getConfig(): Partial<DomainConfig>;

  // ===========================================================================
  // Lifecycle Hooks (Optional)
  // ===========================================================================

  /**
   * Called when the adapter is initialized.
   *
   * Use this for any setup that needs to happen before the adapter
   * is used (e.g., API client initialization, cache warming).
   *
   * @returns Promise that resolves when initialization is complete
   */
  onInitialize?(): Promise<void>;

  /**
   * Called when the adapter is being shut down.
   *
   * Use this for cleanup (e.g., closing connections, flushing caches).
   *
   * @returns Promise that resolves when shutdown is complete
   */
  onShutdown?(): Promise<void>;

  /**
   * Called when a workflow starts.
   *
   * Use this for workflow-level setup (e.g., starting a trace, allocating resources).
   *
   * @param workflowName - Name of the workflow starting
   * @param runId - Unique ID for this workflow run
   */
  onWorkflowStart?(workflowName: string, runId: string): Promise<void>;

  /**
   * Called when a workflow completes.
   *
   * Use this for workflow-level cleanup (e.g., recording metrics, releasing resources).
   *
   * @param workflowName - Name of the workflow that completed
   * @param runId - Unique ID for this workflow run
   * @param status - Final status of the workflow
   */
  onWorkflowComplete?(
    workflowName: string,
    runId: string,
    status: "completed" | "failed" | "requires_approval"
  ): Promise<void>;
}

// =============================================================================
// Domain Adapter Validation
// =============================================================================

/**
 * Schema for validating domain adapter metadata
 */
export const DomainAdapterMetadataSchema = z.object({
  domain: z.enum(["asi", "land"]),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver format"),
  description: z.string().optional(),
});

/**
 * Validation result for a domain adapter
 */
export interface AdapterValidationResult {
  /** Whether the adapter is valid */
  valid: boolean;
  /** Validation errors (if any) */
  errors: string[];
  /** Validation warnings (if any) */
  warnings: string[];
  /** Summary statistics */
  stats: {
    toolCount: number;
    agentCount: number;
    workflowCount: number;
  };
}

/**
 * Validate a domain adapter for correctness.
 *
 * Checks:
 * - Adapter metadata is valid
 * - Tools follow naming conventions
 * - Agents have valid roles
 * - Workflows have required stages
 * - All referenced tools exist
 *
 * @param adapter - The domain adapter to validate
 * @returns Validation result with errors, warnings, and stats
 */
export function validateDomainAdapter(
  adapter: DomainAdapter
): AdapterValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate metadata
  const metadataResult = DomainAdapterMetadataSchema.safeParse({
    domain: adapter.domain,
    name: adapter.name,
    version: adapter.version,
    description: adapter.description,
  });

  if (!metadataResult.success) {
    for (const issue of metadataResult.error.issues) {
      errors.push(`Metadata: ${issue.path.join(".")} - ${issue.message}`);
    }
  }

  // Get components
  const tools = adapter.getTools();
  const agents = adapter.getAgents();
  const workflows = adapter.getWorkflows();

  // Build set of tool names for reference checking
  const toolNames = new Set(tools.map((t) => t.definition.name));

  // Validate tools
  for (const tool of tools) {
    const { definition } = tool;

    // Check naming convention
    const expectedPrefix = `${adapter.domain}.`;
    if (!definition.name.startsWith(expectedPrefix)) {
      warnings.push(
        `Tool '${definition.name}' should be prefixed with '${expectedPrefix}'`
      );
    }

    // Check handler is a function
    if (typeof tool.handler !== "function") {
      errors.push(`Tool '${definition.name}' has invalid handler (not a function)`);
    }
  }

  // Validate agents
  for (const agent of agents) {
    // Check agent has valid role
    const validRoles = ["planner", "worker", "reviewer"];
    if (!validRoles.includes(agent.role)) {
      errors.push(`Agent '${agent.name}' has invalid role '${agent.role}'`);
    }

    // Check referenced tools exist
    for (const toolName of agent.allowedTools) {
      if (!toolNames.has(toolName)) {
        warnings.push(
          `Agent '${agent.name}' references unknown tool '${toolName}'`
        );
      }
    }
  }

  // Validate workflows
  for (const workflow of workflows) {
    // Check workflow domain matches adapter domain
    if (workflow.domain !== adapter.domain) {
      errors.push(
        `Workflow '${workflow.name}' has domain '${workflow.domain}' but adapter domain is '${adapter.domain}'`
      );
    }

    // Check required stages for workflows with commit
    if (workflow.stages.includes("commit")) {
      if (!workflow.stages.includes("review")) {
        warnings.push(
          `Workflow '${workflow.name}' has commit stage but no review stage`
        );
      }
    }

    // Check workflow has agents for each stage
    const stageToRole: Record<string, string> = {
      plan: "planner",
      execute: "worker",
      review: "reviewer",
      commit: "worker",
    };

    for (const stage of workflow.stages) {
      const requiredRole = stageToRole[stage];
      if (requiredRole) {
        const hasAgent = workflow.agents.some((a) => a.role === requiredRole);
        if (!hasAgent) {
          errors.push(
            `Workflow '${workflow.name}' stage '${stage}' requires '${requiredRole}' agent but none defined`
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      toolCount: tools.length,
      agentCount: agents.length,
      workflowCount: workflows.length,
    },
  };
}

// =============================================================================
// Domain Adapter Registry
// =============================================================================

/**
 * Registry for managing multiple domain adapters.
 *
 * Allows registering, retrieving, and listing domain adapters.
 * In most cases, only one adapter is active at a time, but the
 * registry supports multiple for testing and multi-tenant scenarios.
 */
export class DomainAdapterRegistry {
  private adapters: Map<Domain, DomainAdapter> = new Map();

  /**
   * Register a domain adapter.
   *
   * Validates the adapter before registration and throws if invalid.
   *
   * @param adapter - The domain adapter to register
   * @throws Error if adapter is invalid or domain already registered
   */
  register(adapter: DomainAdapter): void {
    // Validate adapter
    const validation = validateDomainAdapter(adapter);
    if (!validation.valid) {
      throw new Error(
        `Invalid adapter for domain '${adapter.domain}': ${validation.errors.join(", ")}`
      );
    }

    // Check for duplicate
    if (this.adapters.has(adapter.domain)) {
      throw new Error(`Domain '${adapter.domain}' already has a registered adapter`);
    }

    this.adapters.set(adapter.domain, adapter);
  }

  /**
   * Get a registered adapter by domain.
   *
   * @param domain - The domain to retrieve
   * @returns The adapter, or undefined if not found
   */
  get(domain: Domain): DomainAdapter | undefined {
    return this.adapters.get(domain);
  }

  /**
   * Get a registered adapter by domain, throwing if not found.
   *
   * @param domain - The domain to retrieve
   * @returns The adapter
   * @throws Error if no adapter registered for domain
   */
  getOrThrow(domain: Domain): DomainAdapter {
    const adapter = this.adapters.get(domain);
    if (!adapter) {
      throw new Error(`No adapter registered for domain '${domain}'`);
    }
    return adapter;
  }

  /**
   * List all registered domains.
   *
   * @returns Array of registered domain identifiers
   */
  list(): Domain[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Check if a domain has a registered adapter.
   *
   * @param domain - The domain to check
   * @returns True if adapter is registered
   */
  has(domain: Domain): boolean {
    return this.adapters.has(domain);
  }

  /**
   * Unregister an adapter by domain.
   *
   * @param domain - The domain to unregister
   * @returns True if adapter was removed, false if not found
   */
  unregister(domain: Domain): boolean {
    return this.adapters.delete(domain);
  }

  /**
   * Clear all registered adapters.
   */
  clear(): void {
    this.adapters.clear();
  }

  /**
   * Get count of registered adapters.
   */
  get size(): number {
    return this.adapters.size;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an empty domain adapter registry.
 */
export function createAdapterRegistry(): DomainAdapterRegistry {
  return new DomainAdapterRegistry();
}

/**
 * Create a partial domain adapter with defaults.
 *
 * Use this when you want to create a simple adapter without implementing
 * all methods. Required fields are domain, name, and version.
 *
 * @param options - Partial adapter options
 * @returns A complete DomainAdapter with defaults for missing methods
 *
 * @example
 * ```typescript
 * const adapter = createDomainAdapter({
 *   domain: "asi",
 *   name: "AirSpace Integration",
 *   version: "1.0.0",
 *   tools: [
 *     { definition: {...}, handler: async () => {} },
 *   ],
 * });
 * ```
 */
export function createDomainAdapter(options: {
  domain: Domain;
  name: string;
  version: string;
  description?: string;
  tools?: RegisteredTool[];
  agents?: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  config?: Partial<DomainConfig>;
  onInitialize?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
  onWorkflowStart?: (workflowName: string, runId: string) => Promise<void>;
  onWorkflowComplete?: (
    workflowName: string,
    runId: string,
    status: "completed" | "failed" | "requires_approval"
  ) => Promise<void>;
}): DomainAdapter {
  return {
    domain: options.domain,
    name: options.name,
    version: options.version,
    description: options.description,

    getTools: () => options.tools ?? [],
    getAgents: () => options.agents ?? [],
    getWorkflows: () => options.workflows ?? [],
    getConfig: () => options.config ?? {},

    onInitialize: options.onInitialize,
    onShutdown: options.onShutdown,
    onWorkflowStart: options.onWorkflowStart,
    onWorkflowComplete: options.onWorkflowComplete,
  };
}

/**
 * Merge multiple domain adapters into one.
 *
 * This is useful for composing adapters from smaller pieces.
 * The first adapter's identity (domain, name, version) is used.
 *
 * @param adapters - Array of adapters to merge (first takes precedence for identity)
 * @returns A merged adapter
 */
export function mergeAdapters(...adapters: DomainAdapter[]): DomainAdapter {
  if (adapters.length === 0) {
    throw new Error("At least one adapter is required");
  }

  const [primary, ...rest] = adapters;

  return createDomainAdapter({
    domain: primary.domain,
    name: primary.name,
    version: primary.version,
    description: primary.description,

    tools: adapters.flatMap((a) => a.getTools()),
    agents: adapters.flatMap((a) => a.getAgents()),
    workflows: adapters.flatMap((a) => a.getWorkflows()),

    config: adapters.reduce(
      (acc, a) => ({ ...acc, ...a.getConfig() }),
      {} as Partial<DomainConfig>
    ),

    onInitialize: async () => {
      for (const adapter of adapters) {
        await adapter.onInitialize?.();
      }
    },

    onShutdown: async () => {
      // Shutdown in reverse order
      for (const adapter of [...adapters].reverse()) {
        await adapter.onShutdown?.();
      }
    },
  });
}

/**
 * Build a complete DomainConfig from an adapter.
 *
 * Combines the adapter's configuration with computed values
 * like tool overrides based on the tool definitions.
 *
 * @param adapter - The domain adapter
 * @returns A complete DomainConfig
 */
export function buildDomainConfigFromAdapter(
  adapter: DomainAdapter
): DomainConfig {
  const baseConfig = adapter.getConfig();
  const tools = adapter.getTools();

  // Build tool definitions array
  const toolDefinitions = tools.map((t) => t.definition);

  // Build tool overrides from config, plus any explicit overrides
  const toolOverrides: Record<string, TrustLevel> = {
    ...baseConfig.toolOverrides,
  };

  return {
    domain: adapter.domain,
    name: adapter.name,
    trustGate: {
      domain: adapter.domain,
      defaultTrustLevel: baseConfig.trustGate?.defaultTrustLevel ?? "L1",
      requireApprovalAbove: baseConfig.trustGate?.requireApprovalAbove ?? "L2",
      sandboxWriteOps: baseConfig.trustGate?.sandboxWriteOps ?? true,
      toolOverrides: {
        ...baseConfig.trustGate?.toolOverrides,
        ...toolOverrides,
      },
    },
    tools: toolDefinitions,
    toolOverrides,
  };
}
