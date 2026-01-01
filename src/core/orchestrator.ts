/**
 * Agent Orchestrator - Run Planner/Worker/Reviewer Workflows
 *
 * The AgentOrchestrator executes multi-agent workflows with trust-gated tool calls.
 * It supports the planner → worker → reviewer pattern with stage-based policies.
 *
 * Workflow Stages:
 * 1. Plan: Planner agent gathers info, makes decisions (L0-L1 tools only)
 * 2. Execute: Worker agent takes actions (L0-L2 tools, sandboxed)
 * 3. Review: Reviewer agent verifies output (L0-L1 tools only)
 * 4. Commit: Worker applies final changes (L0-L3 tools, with approval)
 *
 * @example
 * ```typescript
 * const orchestrator = new AgentOrchestrator(
 *   { modelId: "claude-sonnet-4-20250514", maxTokens: 8192, temperature: 0 },
 *   toolRouter,
 *   logger
 * );
 *
 * const result = await orchestrator.runWorkflow(dailyBriefWorkflow, {
 *   input: "Generate daily operations brief for January 15, 2025",
 * });
 * ```
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  WorkflowDefinition,
  AgentDefinition,
  WorkflowStage,
  AgentActionEventInput,
  Domain,
} from "./schemas.js";
import type { ToolRouter, ToolCallResult } from "./tool-router.js";
import type { EventLogger } from "./logger.js";
import type { ApprovalStore, CreateApprovalRequestInput } from "./approvals.js";
import { isCommitTool, getCommitTool } from "./commit-tools.js";

/**
 * Configuration for the orchestrator
 */
export interface OrchestratorConfig {
  /** Model ID to use for agent calls */
  modelId: string;
  /** Maximum tokens for responses */
  maxTokens: number;
  /** Temperature for responses (0-1) */
  temperature: number;
  /** Optional: API key (uses ANTHROPIC_API_KEY env var by default) */
  apiKey?: string;
}

/**
 * Options for running a workflow
 */
export interface WorkflowRunOptions {
  /** Initial input for the workflow */
  input: string;
  /** Optional: Override run ID (auto-generated if not provided) */
  runId?: string;
  /** Optional: Additional context to pass to agents */
  context?: Record<string, unknown>;
  /** Optional: Reviewer verdict from review stage (for commit stage) */
  reviewerVerdict?: "PASS" | "FAIL";
  /** Optional: Reviewer notes */
  reviewerNotes?: string;
}

/**
 * Result of a workflow run
 */
export interface WorkflowResult {
  /** Unique ID for this run */
  runId: string;
  /** Final output from the workflow */
  result: unknown;
  /** All events logged during the run */
  events: AgentActionEventInput[];
  /** Status of the workflow */
  status: "completed" | "failed" | "requires_approval";
  /** Error message if failed */
  error?: string;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Approval request ID (if approval required) */
  approvalRequestId?: string;
  /** Reviewer verdict from review stage */
  reviewerVerdict?: "PASS" | "FAIL";
}

/**
 * Result of running a single agent
 */
interface AgentRunResult {
  /** Output from the agent */
  output: unknown;
  /** Tool calls made during the run */
  toolCalls: Array<{ tool: string; result: ToolCallResult }>;
  /** Status */
  status: "completed" | "failed" | "requires_approval";
  /** Error message if failed */
  error?: string;
  /** Approval request ID (if approval required) */
  approvalRequestId?: string;
  /** Reviewer verdict (for reviewer agents) */
  reviewerVerdict?: "PASS" | "FAIL";
}

/**
 * Validate workflow definition has required fields
 * @returns Error message if invalid, undefined if valid
 */
function validateWorkflowDefinition(workflow: unknown): string | undefined {
  if (!workflow || typeof workflow !== "object") {
    return "Workflow definition is null or not an object";
  }
  const w = workflow as Record<string, unknown>;
  if (typeof w.name !== "string" || w.name.length === 0) {
    return "Workflow definition missing required 'name' field";
  }
  if (typeof w.domain !== "string") {
    return "Workflow definition missing required 'domain' field";
  }
  if (!Array.isArray(w.agents) || w.agents.length === 0) {
    return "Workflow definition missing or empty 'agents' array";
  }
  if (!Array.isArray(w.stages) || w.stages.length === 0) {
    return "Workflow definition missing or empty 'stages' array";
  }
  return undefined;
}

/**
 * Valid workflow stages for FAIL CLOSED validation
 */
const VALID_ORCHESTRATOR_STAGES = new Set(["plan", "execute", "review", "commit"]);

/**
 * AgentOrchestrator runs multi-agent workflows with trust gates
 *
 * IMPORTANT: This class implements FAIL CLOSED semantics.
 * - Missing agents for stages = workflow failure
 * - Undefined reviewer verdict when required = commit blocked
 * - Invalid workflow definition = immediate rejection
 */
export class AgentOrchestrator {
  private client: Anthropic;
  private config: OrchestratorConfig;
  private toolRouter: ToolRouter;
  private logger: EventLogger;
  private approvalStore?: ApprovalStore;

  constructor(
    config: OrchestratorConfig,
    toolRouter: ToolRouter,
    logger: EventLogger,
    approvalStore?: ApprovalStore
  ) {
    this.config = config;
    this.toolRouter = toolRouter;
    this.logger = logger;
    this.approvalStore = approvalStore;
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  /**
   * Run a complete workflow
   *
   * IMPORTANT: This method implements FAIL CLOSED semantics.
   * - Invalid workflow definition = immediate rejection
   * - Missing agent for stage = workflow failure
   * - Commit stage without reviewer PASS = blocked
   */
  async runWorkflow(
    workflow: WorkflowDefinition,
    options: WorkflowRunOptions
  ): Promise<WorkflowResult> {
    const startTime = performance.now();
    const runId = options.runId ?? crypto.randomUUID();
    const events: AgentActionEventInput[] = [];

    // =========================================================================
    // FAIL CLOSED: Validate workflow definition
    // =========================================================================
    const workflowError = validateWorkflowDefinition(workflow);
    if (workflowError) {
      return {
        runId,
        result: null,
        events: [],
        status: "failed",
        error: `FAIL CLOSED: ${workflowError}`,
        durationMs: performance.now() - startTime,
      };
    }

    // FAIL CLOSED: Validate all stages are recognized
    for (const stage of workflow.stages) {
      if (!VALID_ORCHESTRATOR_STAGES.has(stage)) {
        return {
          runId,
          result: null,
          events: [],
          status: "failed",
          error: `FAIL CLOSED: Unrecognized stage '${stage}' in workflow`,
          durationMs: performance.now() - startTime,
        };
      }
    }

    // FAIL CLOSED: Validate commit stage has review stage before it
    const stageOrder = workflow.stages;
    const commitIndex = stageOrder.indexOf("commit");
    const reviewIndex = stageOrder.indexOf("review");
    if (commitIndex !== -1 && (reviewIndex === -1 || reviewIndex > commitIndex)) {
      return {
        runId,
        result: null,
        events: [],
        status: "failed",
        error: "FAIL CLOSED: Commit stage requires review stage to precede it",
        durationMs: performance.now() - startTime,
      };
    }

    // Log workflow start
    await this.logEvent({
      domain: workflow.domain,
      workflowName: workflow.name,
      agentName: "orchestrator",
      runId,
      trustLevel: "L0",
      stage: "plan",
      intent: `Starting workflow: ${workflow.name}`,
    });

    let context = options.input;
    let finalResult: unknown;
    let finalStatus: WorkflowResult["status"] = "completed";
    let finalError: string | undefined;
    let approvalRequestId: string | undefined;
    let reviewerVerdict: "PASS" | "FAIL" | undefined = options.reviewerVerdict;

    try {
      // Execute each stage in order
      for (const stage of workflow.stages) {
        const agent = this.getAgentForStage(workflow.agents, stage);

        // FAIL CLOSED: Missing agent for stage = workflow failure
        if (!agent) {
          finalStatus = "failed";
          finalError = `FAIL CLOSED: No agent defined for required stage '${stage}'`;

          await this.logEvent({
            domain: workflow.domain,
            workflowName: workflow.name,
            agentName: "orchestrator",
            runId,
            trustLevel: "L0",
            stage: stage,
            intent: `FAIL CLOSED: Missing agent for stage '${stage}'`,
            errors: [finalError],
          });

          break;
        }

        // =========================================================================
        // FAIL CLOSED: Commit stage requires reviewer verdict
        // =========================================================================
        if (stage === "commit" && reviewerVerdict === undefined) {
          finalStatus = "failed";
          finalError = "FAIL CLOSED: Commit stage requires reviewer verdict but none was provided";

          await this.logEvent({
            domain: workflow.domain,
            workflowName: workflow.name,
            agentName: "orchestrator",
            runId,
            trustLevel: "L0",
            stage: "commit",
            intent: "FAIL CLOSED: Missing reviewer verdict for commit",
            errors: [finalError],
          });

          break;
        }

        // Run the agent for this stage
        const stageResult = await this.runAgent(agent, {
          domain: workflow.domain,
          workflowName: workflow.name,
          runId,
          stage,
          input: context,
          additionalContext: options.context,
          reviewerVerdict: reviewerVerdict,
        });

        // Capture reviewer verdict from review stage
        if (stage === "review" && stageResult.reviewerVerdict) {
          reviewerVerdict = stageResult.reviewerVerdict;

          // CRITICAL: If reviewer returns FAIL, block the commit stage
          if (reviewerVerdict === "FAIL") {
            finalStatus = "failed";
            finalResult = stageResult.output;
            finalError = "Reviewer verdict: FAIL - commit stage blocked";

            await this.logEvent({
              domain: workflow.domain,
              workflowName: workflow.name,
              agentName: "orchestrator",
              runId,
              trustLevel: "L0",
              stage: "review",
              intent: "Workflow blocked: reviewer verdict FAIL",
              warnings: ["Commit stage blocked due to reviewer FAIL verdict"],
              summary: typeof stageResult.output === "string"
                ? stageResult.output.slice(0, 500)
                : undefined,
            });

            break; // Exit the stage loop, skipping commit
          }
        }

        // Collect events from tool calls
        for (const { result } of stageResult.toolCalls) {
          if (result.logged) {
            // Event was already logged by tool router
          }
        }

        // Check if stage requires approval
        if (stageResult.status === "requires_approval") {
          finalStatus = "requires_approval";
          finalResult = stageResult.output;
          approvalRequestId = stageResult.approvalRequestId;

          // Create approval request if we have an approval store and don't have one yet
          if (this.approvalStore && !approvalRequestId && stage === "commit") {
            const request = await this.createApprovalRequest(
              workflow,
              runId,
              agent.name,
              stageResult,
              reviewerVerdict,
              options.reviewerNotes
            );
            approvalRequestId = request?.id;

            // Check if auto-approve is possible
            if (request?.autoApproveEligible && reviewerVerdict === "PASS") {
              const decision = await this.approvalStore.autoApprove(
                request.id,
                "Auto-approved: reviewer PASS + eligible action type"
              );
              if (decision) {
                // Auto-approved! Continue with commit
                finalStatus = "completed";
                approvalRequestId = request.id;

                await this.logEvent({
                  domain: workflow.domain,
                  workflowName: workflow.name,
                  agentName: "orchestrator",
                  runId,
                  trustLevel: "L3",
                  stage,
                  intent: "Auto-approved commit operation",
                  summary: `Auto-approved: ${request.actionType}`,
                });

                // Re-run the commit stage now that we're approved
                continue;
              }
            }
          }

          await this.logEvent({
            domain: workflow.domain,
            workflowName: workflow.name,
            agentName: agent.name,
            runId,
            trustLevel: "L3",
            stage,
            intent: "Workflow paused: requires human approval",
            warnings: ["Approval required to continue"],
          });

          break;
        }

        // Check if stage failed
        if (stageResult.status === "failed") {
          finalStatus = "failed";
          finalError = stageResult.error;
          finalResult = null;

          await this.logEvent({
            domain: workflow.domain,
            workflowName: workflow.name,
            agentName: agent.name,
            runId,
            trustLevel: "L0",
            stage,
            intent: `Stage '${stage}' failed`,
            errors: [stageResult.error ?? "Unknown error"],
          });

          break;
        }

        // Pass output to next stage
        context =
          typeof stageResult.output === "string"
            ? stageResult.output
            : JSON.stringify(stageResult.output);
        finalResult = stageResult.output;
      }

      // Log workflow completion
      await this.logEvent({
        domain: workflow.domain,
        workflowName: workflow.name,
        agentName: "orchestrator",
        runId,
        trustLevel: "L0",
        stage: "commit",
        intent: `Workflow completed with status: ${finalStatus}`,
        summary:
          typeof finalResult === "string"
            ? finalResult.slice(0, 500)
            : JSON.stringify(finalResult).slice(0, 500),
      });
    } catch (err) {
      finalStatus = "failed";
      finalError = err instanceof Error ? err.message : String(err);

      await this.logEvent({
        domain: workflow.domain,
        workflowName: workflow.name,
        agentName: "orchestrator",
        runId,
        trustLevel: "L0",
        stage: "commit",
        intent: "Workflow failed with error",
        errors: [finalError],
      });
    }

    return {
      runId,
      result: finalResult,
      events,
      status: finalStatus,
      error: finalError,
      durationMs: performance.now() - startTime,
      approvalRequestId,
      reviewerVerdict,
    };
  }

  /**
   * Create an approval request for a commit operation
   */
  private async createApprovalRequest(
    workflow: WorkflowDefinition,
    runId: string,
    agentName: string,
    stageResult: AgentRunResult,
    reviewerVerdict?: "PASS" | "FAIL",
    reviewerNotes?: string
  ): Promise<{ id: string; autoApproveEligible: boolean; actionType: string } | null> {
    if (!this.approvalStore) return null;

    // Find the commit tool that was attempted
    const commitToolCall = stageResult.toolCalls.find(
      (tc) => isCommitTool(tc.tool)
    );
    if (!commitToolCall) return null;

    const commitToolDef = getCommitTool(commitToolCall.tool);
    if (!commitToolDef) return null;

    try {
      const input: CreateApprovalRequestInput = {
        domain: workflow.domain,
        runId,
        workflowName: workflow.name,
        requestedBy: agentName,
        trustLevel: commitToolDef.minTrustLevel,
        actionType: commitToolDef.actionType,
        actionPayload: commitToolCall.result.trustGateResult as unknown as Record<string, unknown>,
        context: {
          toolName: commitToolCall.tool,
          toolArgs: commitToolCall.result.result,
          sandboxId: commitToolCall.result.sandboxId,
        },
        reviewerVerdict,
        reviewerNotes,
      };

      const request = await this.approvalStore.createRequest(input);
      return {
        id: request.id,
        autoApproveEligible: request.autoApproveEligible,
        actionType: commitToolDef.actionType,
      };
    } catch (error) {
      console.error(
        "[Orchestrator] Failed to create approval request:",
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Run a single agent within a workflow stage
   */
  private async runAgent(
    agent: AgentDefinition,
    context: {
      domain: Domain;
      workflowName: string;
      runId: string;
      stage: WorkflowStage;
      input: string;
      additionalContext?: Record<string, unknown>;
      reviewerVerdict?: "PASS" | "FAIL";
    }
  ): Promise<AgentRunResult> {
    const toolCalls: Array<{ tool: string; result: ToolCallResult }> = [];
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: context.input },
    ];

    let turns = 0;
    while (turns < agent.maxTurns) {
      // Get available tools for this agent
      const tools = this.getToolsForAgent(agent);

      const response = await this.client.messages.create({
        model: this.config.modelId,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        system: this.buildSystemPrompt(agent, context),
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      // Handle tool use
      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock =>
            block.type === "tool_use"
        );

        // Add assistant response to messages
        messages.push({ role: "assistant", content: response.content });

        // Process each tool call
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        let requiresApproval = false;

        for (const toolUse of toolUseBlocks) {
          const result = await this.toolRouter.call({
            toolName: toolUse.name,
            args: toolUse.input as Record<string, unknown>,
            context: {
              domain: context.domain,
              workflowName: context.workflowName,
              agentName: agent.name,
              runId: context.runId,
              stage: context.stage,
              reviewerVerdict: context.reviewerVerdict,
            },
          });

          toolCalls.push({ tool: toolUse.name, result });

          // Check if any tool requires approval
          if (result.trustGateResult.requiresApproval) {
            requiresApproval = true;
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.success
              ? JSON.stringify(result.result)
              : `Error: ${result.error}`,
            is_error: !result.success,
          });
        }

        // If approval required, pause workflow
        if (requiresApproval) {
          // Find the approval request ID from tool results
          const approvalRequestId = toolCalls.find(
            (tc) => tc.result.approvalRequestId
          )?.result.approvalRequestId;

          return {
            output: null,
            toolCalls,
            status: "requires_approval",
            approvalRequestId,
          };
        }

        // Add tool results
        messages.push({ role: "user", content: toolResults });

        turns++;
        continue;
      }

      // End of turn - extract text response
      const textBlock = response.content.find(
        (block: Anthropic.ContentBlock): block is Anthropic.TextBlock =>
          block.type === "text"
      );

      // For reviewer agents, extract verdict from output
      let reviewerVerdict: "PASS" | "FAIL" | undefined;
      if (agent.role === "reviewer" && textBlock?.text) {
        reviewerVerdict = this.extractReviewerVerdict(textBlock.text);
      }

      return {
        output: textBlock?.text ?? null,
        toolCalls,
        status: "completed",
        reviewerVerdict,
      };
    }

    // Max turns reached
    return {
      output: null,
      toolCalls,
      status: "failed",
      error: `Agent ${agent.name} exceeded max turns (${agent.maxTurns})`,
    };
  }

  /**
   * Build system prompt for an agent
   */
  private buildSystemPrompt(
    agent: AgentDefinition,
    context: {
      stage: WorkflowStage;
      workflowName: string;
      additionalContext?: Record<string, unknown>;
    }
  ): string {
    const stageGuidance = this.getStageGuidance(context.stage);

    return `${agent.systemPrompt}

---
Current Stage: ${context.stage}
Workflow: ${context.workflowName}
Role: ${agent.role}

${stageGuidance}

${
  context.additionalContext
    ? `Additional Context:\n${JSON.stringify(context.additionalContext, null, 2)}`
    : ""
}`;
  }

  /**
   * Get guidance text for a workflow stage
   */
  private getStageGuidance(stage: WorkflowStage): string {
    const guidance: Record<WorkflowStage, string> = {
      plan: `
Stage Guidance (Plan):
- You are gathering information and making decisions
- Only READ and PROPOSE operations are allowed
- Do not attempt any write operations in this stage
- Focus on understanding the task and planning your approach`,

      execute: `
Stage Guidance (Execute):
- You are taking action based on the plan
- READ, PROPOSE, and WRITE operations are allowed
- Write operations will be sandboxed for safety
- Complete the planned actions step by step`,

      review: `
Stage Guidance (Review):
- You are verifying the output of previous stages
- Only READ and PROPOSE operations are allowed
- Check for errors, inconsistencies, and completeness
- Suggest corrections if needed

IMPORTANT: You MUST end your review with an explicit verdict:
- If the output is acceptable: "VERDICT: PASS"
- If the output has issues: "VERDICT: FAIL"

A FAIL verdict will block the commit stage and prevent the workflow from completing.
Only return PASS if you are confident the output is ready for production.`,

      commit: `
Stage Guidance (Commit):
- You are finalizing the workflow output
- All operations including SIDE_EFFECTS are allowed
- Actions with side effects may require approval
- Make final adjustments and confirm completion`,
    };

    return guidance[stage];
  }

  /**
   * Extract PASS/FAIL verdict from reviewer agent output
   *
   * Looks for explicit verdict markers in the text:
   * - "VERDICT: PASS" or "VERDICT: FAIL"
   * - "**VERDICT:** PASS" or "**VERDICT:** FAIL"
   */
  private extractReviewerVerdict(text: string): "PASS" | "FAIL" | undefined {
    // Match VERDICT: PASS or VERDICT: FAIL (with optional markdown bold)
    const verdictMatch = text.match(/\*?\*?VERDICT\*?\*?:\s*(PASS|FAIL)/i);
    if (verdictMatch) {
      return verdictMatch[1].toUpperCase() as "PASS" | "FAIL";
    }

    // Fallback: look for clear approval/rejection language
    const upperText = text.toUpperCase();
    if (
      upperText.includes("APPROVED FOR DISTRIBUTION") ||
      upperText.includes("REVIEW: PASS") ||
      upperText.includes("PASSES REVIEW")
    ) {
      return "PASS";
    }
    if (
      upperText.includes("NOT READY FOR DISTRIBUTION") ||
      upperText.includes("REVIEW: FAIL") ||
      upperText.includes("FAILS REVIEW") ||
      upperText.includes("CANNOT APPROVE")
    ) {
      return "FAIL";
    }

    // No clear verdict found
    return undefined;
  }

  /**
   * Get the agent for a given workflow stage
   */
  private getAgentForStage(
    agents: AgentDefinition[],
    stage: WorkflowStage
  ): AgentDefinition | undefined {
    const roleForStage: Record<WorkflowStage, AgentDefinition["role"]> = {
      plan: "planner",
      execute: "worker",
      review: "reviewer",
      commit: "worker",
    };

    return agents.find((a) => a.role === roleForStage[stage]);
  }

  /**
   * Convert tools to Anthropic format for a specific agent
   */
  private getToolsForAgent(agent: AgentDefinition): Anthropic.Tool[] {
    const allowedSet = new Set(agent.allowedTools);
    const allTools = this.toolRouter.toAnthropicTools();

    return allTools
      .filter((tool) => allowedSet.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
      }));
  }

  /**
   * Log an event through the logger
   */
  private async logEvent(event: AgentActionEventInput): Promise<void> {
    try {
      await this.logger.log(event);
    } catch (err) {
      console.error(
        "[Orchestrator] Failed to log event:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

/**
 * Factory function to create a pre-configured orchestrator
 */
export function createOrchestrator(
  toolRouter: ToolRouter,
  logger: EventLogger,
  options?: Partial<OrchestratorConfig>,
  approvalStore?: ApprovalStore
): AgentOrchestrator {
  return new AgentOrchestrator(
    {
      modelId: options?.modelId ?? "claude-sonnet-4-20250514",
      maxTokens: options?.maxTokens ?? 8192,
      temperature: options?.temperature ?? 0,
      apiKey: options?.apiKey,
    },
    toolRouter,
    logger,
    approvalStore
  );
}

/**
 * Pre-defined workflow templates
 */
export const WORKFLOW_TEMPLATES = {
  /**
   * Simple read-only workflow (planner only)
   */
  readOnly: (
    name: string,
    domain: Domain,
    systemPrompt: string,
    allowedTools: string[]
  ): WorkflowDefinition => ({
    name,
    domain,
    agents: [
      {
        name: "reader",
        role: "planner",
        systemPrompt,
        allowedTools,
        maxTurns: 5,
      },
    ],
    stages: ["plan"],
  }),

  /**
   * Standard workflow (planner → worker → reviewer)
   */
  standard: (
    name: string,
    domain: Domain,
    agents: {
      planner: { systemPrompt: string; allowedTools: string[] };
      worker: { systemPrompt: string; allowedTools: string[] };
      reviewer: { systemPrompt: string; allowedTools: string[] };
    }
  ): WorkflowDefinition => ({
    name,
    domain,
    agents: [
      {
        name: `${name}_planner`,
        role: "planner",
        systemPrompt: agents.planner.systemPrompt,
        allowedTools: agents.planner.allowedTools,
        maxTurns: 5,
      },
      {
        name: `${name}_worker`,
        role: "worker",
        systemPrompt: agents.worker.systemPrompt,
        allowedTools: agents.worker.allowedTools,
        maxTurns: 10,
      },
      {
        name: `${name}_reviewer`,
        role: "reviewer",
        systemPrompt: agents.reviewer.systemPrompt,
        allowedTools: agents.reviewer.allowedTools,
        maxTurns: 3,
      },
    ],
    stages: ["plan", "execute", "review", "commit"],
  }),
};
