/**
 * Tool Router - Dispatch Tool Calls with Trust Gate Enforcement
 *
 * The ToolRouter is the central dispatcher for agent tool calls.
 * It integrates trust gates, sandboxing, and event logging.
 *
 * Flow:
 * 1. Receive tool call request
 * 2. Evaluate through trust gate
 * 3. If approved, execute (with sandbox if required)
 * 4. Log the action and result
 * 5. Return result to agent
 *
 * @example
 * ```typescript
 * const router = new ToolRouter(trustGate, logger);
 *
 * router.registerTool(
 *   {
 *     name: "get_bookings",
 *     description: "Fetch bookings from OfficeRnD",
 *     capability: "READ",
 *     risk: "LOW",
 *     executionMode: "DIRECT",
 *     verification: "NONE",
 *     inputSchema: { date: "string" },
 *   },
 *   async (args) => {
 *     return await officernd.getBookings(args.date);
 *   }
 * );
 *
 * const result = await router.call({
 *   toolName: "get_bookings",
 *   args: { date: "2025-01-15" },
 *   context: { domain: "asi", workflowName: "daily_brief", ... },
 * });
 * ```
 */

import type {
  ToolDefinition,
  WorkflowStage,
  Domain,
  AgentActionEventInput,
} from "./schemas.js";
import { TrustGate, type TrustGateResult, type TrustGateContext } from "./trust-gates.js";
import type { EventLogger } from "./logger.js";
import type { Sandbox, SandboxExecutionInput } from "./sandbox.js";
import type { ApprovalStore } from "./approvals.js";
import { isCommitTool, getCommitTool, type CommitToolBoundary } from "./commit-tools.js";

/**
 * Handler function for a registered tool
 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Request to call a tool
 */
export interface ToolCallRequest {
  /** Name of the tool to call */
  toolName: string;
  /** Arguments to pass to the tool */
  args: Record<string, unknown>;
  /** Execution context */
  context: {
    domain: Domain;
    workflowName: string;
    agentName: string;
    runId: string;
    stage: WorkflowStage;
    /** Reviewer verdict (for commit tools) */
    reviewerVerdict?: "PASS" | "FAIL";
  };
}

/**
 * Result of a tool call
 */
export interface ToolCallResult {
  /** Whether the call succeeded */
  success: boolean;
  /** Result from the tool (if successful) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Trust gate evaluation result */
  trustGateResult: TrustGateResult;
  /** Whether the call was sandboxed */
  sandboxed: boolean;
  /** Sandbox ID (if sandboxed) */
  sandboxId?: string;
  /** Whether the action was logged */
  logged: boolean;
  /** Duration of the call in milliseconds */
  durationMs: number;
  /** Approval request ID (if approval was required) */
  approvalRequestId?: string;
  /** Whether approval is pending */
  awaitingApproval?: boolean;
}

// Note: Sandbox interface and implementations are in ./sandbox.ts
// Import: import type { Sandbox } from "./sandbox";
// Import: import { createSandbox, createPassthroughSandbox } from "./sandbox";

/**
 * ToolRouter dispatches tool calls through trust gates
 *
 * IMPORTANT: This class implements FAIL CLOSED semantics throughout.
 * All errors result in DENY with explicit logging.
 */
export class ToolRouter {
  private tools: Map<string, ToolDefinition> = new Map();
  private handlers: Map<string, ToolHandler> = new Map();
  private trustGate: TrustGate;
  private logger: EventLogger;
  private sandbox: Sandbox;
  private approvalStore?: ApprovalStore;
  private commitBoundary?: CommitToolBoundary;

  /**
   * Create a FAIL CLOSED result for early validation failures
   */
  private createFailClosedResult(
    reason: string,
    startTime: number
  ): ToolCallResult {
    return {
      success: false,
      error: reason,
      trustGateResult: {
        allowed: false,
        reason,
        requiresApproval: false,
        sandboxed: false,
        trustLevel: "L4",
        isCommitTool: false,
        requiresReviewerVerdict: false,
        autoApproveEligible: false,
      },
      sandboxed: false,
      logged: false,
      durationMs: performance.now() - startTime,
    };
  }

  constructor(
    trustGate: TrustGate,
    logger: EventLogger,
    sandbox: Sandbox,
    approvalStore?: ApprovalStore,
    commitBoundary?: CommitToolBoundary
  ) {
    this.trustGate = trustGate;
    this.logger = logger;
    this.sandbox = sandbox;
    this.approvalStore = approvalStore;
    this.commitBoundary = commitBoundary;
  }

  /**
   * Register a tool with its handler
   */
  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, definition);
    this.handlers.set(definition.name, handler);
  }

  /**
   * Register multiple tools at once
   */
  registerTools(
    tools: Array<{ definition: ToolDefinition; handler: ToolHandler }>
  ): void {
    for (const { definition, handler } of tools) {
      this.registerTool(definition, handler);
    }
  }

  /**
   * Get a registered tool definition
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Call a tool with trust gate enforcement
   *
   * IMPORTANT: This method implements FAIL CLOSED semantics.
   * Any error in trust evaluation, handler lookup, or sandbox execution
   * results in DENY with explicit error logging.
   */
  async call(request: ToolCallRequest): Promise<ToolCallResult> {
    const startTime = performance.now();

    // =========================================================================
    // FAIL CLOSED: Validate request structure
    // =========================================================================
    if (!request || typeof request !== "object") {
      return this.createFailClosedResult(
        "FAIL CLOSED: Request is null or not an object",
        startTime
      );
    }

    if (!request.toolName || typeof request.toolName !== "string") {
      return this.createFailClosedResult(
        "FAIL CLOSED: Request missing required 'toolName' field",
        startTime
      );
    }

    if (!request.context || typeof request.context !== "object") {
      return this.createFailClosedResult(
        "FAIL CLOSED: Request missing required 'context' field",
        startTime
      );
    }

    const tool = this.tools.get(request.toolName);

    // Check if tool exists (FAIL CLOSED: unknown tool = DENY)
    if (!tool) {
      const result: ToolCallResult = {
        success: false,
        error: `FAIL CLOSED: Unknown tool '${request.toolName}'`,
        trustGateResult: {
          allowed: false,
          reason: "Tool not registered - FAIL CLOSED",
          requiresApproval: false,
          sandboxed: false,
          trustLevel: "L4",
          isCommitTool: false,
          requiresReviewerVerdict: false,
          autoApproveEligible: false,
        },
        sandboxed: false,
        logged: false,
        durationMs: performance.now() - startTime,
      };

      // Log the failed attempt
      await this.logToolCall(request, result, undefined);
      result.logged = true;

      return result;
    }

    // FAIL CLOSED: Verify handler exists
    const handler = this.handlers.get(request.toolName);
    if (!handler) {
      const result: ToolCallResult = {
        success: false,
        error: `FAIL CLOSED: No handler registered for tool '${request.toolName}'`,
        trustGateResult: {
          allowed: false,
          reason: "Handler not registered - FAIL CLOSED",
          requiresApproval: false,
          sandboxed: false,
          trustLevel: "L4",
          isCommitTool: false,
          requiresReviewerVerdict: false,
          autoApproveEligible: false,
        },
        sandboxed: false,
        logged: false,
        durationMs: performance.now() - startTime,
      };

      await this.logToolCall(request, result, undefined);
      result.logged = true;

      return result;
    }

    // Build trust gate context
    const gateContext: TrustGateContext = {
      agentName: request.context.agentName,
      runId: request.context.runId,
      workflowName: request.context.workflowName,
      approvalStore: this.approvalStore,
      reviewerVerdict: request.context.reviewerVerdict,
    };

    // =========================================================================
    // FAIL CLOSED: Wrap trust gate evaluation in try-catch
    // =========================================================================
    let gateResult: Awaited<ReturnType<TrustGate["evaluateWithApproval"]>>;
    try {
      gateResult = this.approvalStore
        ? await this.trustGate.evaluateWithApproval(tool, request.context.stage, gateContext)
        : this.trustGate.evaluate(tool, request.context.stage, gateContext);
    } catch (error) {
      // FAIL CLOSED: Trust gate error = DENY
      const result: ToolCallResult = {
        success: false,
        error: `FAIL CLOSED: Trust gate evaluation error - ${error instanceof Error ? error.message : String(error)}`,
        trustGateResult: {
          allowed: false,
          reason: "Trust gate threw exception - FAIL CLOSED",
          requiresApproval: false,
          sandboxed: false,
          trustLevel: "L4",
          isCommitTool: false,
          requiresReviewerVerdict: false,
          autoApproveEligible: false,
        },
        sandboxed: false,
        logged: false,
        durationMs: performance.now() - startTime,
      };

      await this.logToolCall(request, result, undefined);
      result.logged = true;

      return result;
    }

    // Handle denial
    if (!gateResult.allowed) {
      const result: ToolCallResult = {
        success: false,
        error: gateResult.reason,
        trustGateResult: gateResult,
        sandboxed: false,
        logged: false,
        durationMs: performance.now() - startTime,
        approvalRequestId: gateResult.approvalId,
        awaitingApproval: gateResult.approvalStatus === "PENDING",
      };

      // Log the denied attempt
      await this.logToolCall(request, result, undefined);
      result.logged = true;

      return result;
    }

    // Check commit tool boundary (additional validation)
    if (gateResult.isCommitTool && this.commitBoundary) {
      const eligibility = await this.commitBoundary.verifyCommitEligibility(
        request.context.runId,
        request.toolName
      );

      if (!eligibility.eligible) {
        const result: ToolCallResult = {
          success: false,
          error: eligibility.reason,
          trustGateResult: gateResult,
          sandboxed: false,
          logged: false,
          durationMs: performance.now() - startTime,
          approvalRequestId: eligibility.approvalRequest?.id,
        };

        await this.logToolCall(request, result, undefined);
        result.logged = true;

        return result;
      }
    }

    // =========================================================================
    // Execute the tool with FAIL CLOSED handling
    // =========================================================================
    let toolResult: unknown;
    let error: string | undefined;
    let success = true;
    let sandboxId: string | undefined;

    try {
      if (gateResult.sandboxed) {
        // FAIL CLOSED: Verify sandbox is available
        if (!this.sandbox) {
          const result: ToolCallResult = {
            success: false,
            error: "FAIL CLOSED: Sandbox required but not initialized",
            trustGateResult: gateResult,
            sandboxed: true,
            logged: false,
            durationMs: performance.now() - startTime,
          };
          await this.logToolCall(request, result, undefined);
          result.logged = true;
          return result;
        }

        // Execute in sandbox using new sandbox interface
        const sandboxInput: SandboxExecutionInput = {
          runId: request.context.runId,
          toolName: request.toolName,
          toolArgs: request.args,
          handler,
        };
        const sandboxResult = await this.sandbox.execute(sandboxInput);
        toolResult = sandboxResult.result;
        sandboxId = sandboxResult.sandboxId;
        success = sandboxResult.success;
        error = sandboxResult.error;

        // FAIL CLOSED: If sandbox execution failed, ensure we log it as a failure
        if (!success && !error) {
          error = "FAIL CLOSED: Sandbox execution failed without explicit error";
        }
      } else {
        // Direct execution
        toolResult = await handler(request.args);
      }
    } catch (err) {
      // FAIL CLOSED: Any execution error results in failure
      success = false;
      error = `FAIL CLOSED: Execution error - ${err instanceof Error ? err.message : String(err)}`;
    }

    const result: ToolCallResult = {
      success,
      result: success ? toolResult : undefined,
      error,
      trustGateResult: gateResult,
      sandboxed: gateResult.sandboxed,
      sandboxId,
      logged: false,
      durationMs: performance.now() - startTime,
      approvalRequestId: gateResult.approvalId,
    };

    // Log the tool call
    await this.logToolCall(request, result, toolResult);
    result.logged = true;

    return result;
  }

  /**
   * Call multiple tools in parallel (respecting dependencies)
   */
  async callParallel(
    requests: ToolCallRequest[]
  ): Promise<Map<string, ToolCallResult>> {
    const results = new Map<string, ToolCallResult>();

    // Execute all calls in parallel
    const promises = requests.map(async (request) => {
      const result = await this.call(request);
      return { toolName: request.toolName, result };
    });

    const settled = await Promise.all(promises);

    for (const { toolName, result } of settled) {
      results.set(toolName, result);
    }

    return results;
  }

  /**
   * Log a tool call to the event logger
   */
  private async logToolCall(
    request: ToolCallRequest,
    result: ToolCallResult,
    toolResult: unknown
  ): Promise<void> {
    // Build warnings list
    const warnings: string[] = [];
    if (result.trustGateResult.requiresApproval) {
      warnings.push("Requires approval");
    }
    if (result.trustGateResult.isCommitTool) {
      warnings.push("Commit tool");
    }
    if (result.awaitingApproval) {
      warnings.push("Awaiting human approval");
    }

    const event: AgentActionEventInput = {
      domain: request.context.domain,
      workflowName: request.context.workflowName,
      agentName: request.context.agentName,
      runId: request.context.runId,
      trustLevel: result.trustGateResult.trustLevel,
      stage: request.context.stage,
      intent: `Call ${request.toolName}`,
      toolName: request.toolName,
      toolArgs: request.args,
      toolResult: toolResult as Record<string, unknown> | undefined,
      errors: result.error ? [result.error] : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      // Note: approval_request_id would be added to the schema if we update it
      // For now, we include it in the tool args for correlation
    };

    // Include sandbox and approval context in tool args for audit trail
    if (result.sandboxId || result.approvalRequestId) {
      event.toolArgs = {
        ...event.toolArgs,
        _audit: {
          sandboxId: result.sandboxId,
          approvalRequestId: result.approvalRequestId,
          sandboxed: result.sandboxed,
        },
      };
    }

    try {
      await this.logger.log(event);
    } catch (err) {
      // Log failure shouldn't break the tool call
      console.error(
        "[ToolRouter] Failed to log event:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Convert registered tools to Anthropic tool format
   */
  toAnthropicTools(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: tool.inputSchema,
      },
    }));
  }

  /**
   * Get tools filtered by allowed list (for agent-specific routing)
   */
  getToolsForAgent(allowedTools: string[]): ToolDefinition[] {
    const allowed = new Set(allowedTools);
    return Array.from(this.tools.values()).filter((tool) =>
      allowed.has(tool.name)
    );
  }
}

/**
 * Factory function to create a ToolRouter with common ASI tools
 */
export function createAsiToolRouter(
  trustGate: TrustGate,
  logger: EventLogger,
  sandbox: Sandbox,
  approvalStore?: ApprovalStore,
  commitBoundary?: CommitToolBoundary
): ToolRouter {
  const router = new ToolRouter(
    trustGate,
    logger,
    sandbox,
    approvalStore,
    commitBoundary
  );

  // Common ASI read-only tools would be registered here
  // In practice, these would be registered by the domain adapter

  return router;
}

/**
 * Factory function to create a complete ToolRouter with all dependencies
 */
export function createToolRouter(options: {
  trustGate: TrustGate;
  logger: EventLogger;
  sandbox: Sandbox;
  approvalStore?: ApprovalStore;
  commitBoundary?: CommitToolBoundary;
}): ToolRouter {
  return new ToolRouter(
    options.trustGate,
    options.logger,
    options.sandbox,
    options.approvalStore,
    options.commitBoundary
  );
}
