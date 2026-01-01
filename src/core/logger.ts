/**
 * Agent Action Event Logger
 *
 * Logs agent tool calls and workflow actions to the agent_action_events table.
 * Uses fire-and-forget pattern for non-blocking logging.
 *
 * @example
 * ```typescript
 * import { AgentEventLogger } from "@andykaufman/agent-trust-layer/logger";
 *
 * const logger = new AgentEventLogger(supabaseClient);
 * await logger.log({
 *   domain: "asi",
 *   workflowName: "daily_brief",
 *   agentName: "planner",
 *   runId: "550e8400-e29b-41d4-a716-446655440000",
 *   trustLevel: "L0",
 *   stage: "plan",
 *   intent: "Gathering booking data",
 *   toolName: "get_bookings",
 * });
 * ```
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentActionEventInput, TrustLevel, WorkflowStage, Domain } from "./schemas.js";

/**
 * Database row structure for agent_action_events table
 */
interface AgentActionEventRow {
  id: string;
  created_at: string;
  domain: string;
  workflow_name: string;
  agent_name: string;
  run_id: string;
  trust_level: string;
  stage: string;
  intent: string;
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  tool_result: Record<string, unknown> | null;
  artifact_refs: string[] | null;
  warnings: string[] | null;
  errors: string[] | null;
  summary: string | null;
  confidence: number | null;
}

/**
 * Result of a log operation
 */
export interface LogResult {
  success: boolean;
  eventId: string;
  error?: string;
}

/**
 * Statistics about logged events
 */
export interface AgentLoggerStats {
  totalEvents: number;
  eventsByTrustLevel: Record<TrustLevel, number>;
  eventsByStage: Record<WorkflowStage, number>;
  eventsByDomain: Record<Domain, number>;
  errorCount: number;
}

/**
 * Query options for retrieving events
 */
export interface AgentEventQuery {
  runId?: string;
  workflowName?: string;
  agentName?: string;
  domain?: Domain;
  trustLevel?: TrustLevel;
  stage?: WorkflowStage;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
}

/**
 * Logger interface for dependency injection and testing
 */
export interface EventLogger {
  log(event: AgentActionEventInput): Promise<LogResult>;
  query(options: AgentEventQuery): Promise<AgentActionEventInput[]>;
  getStats(runId?: string): Promise<AgentLoggerStats>;
}

/**
 * Validate event has required fields
 * @returns Error message if invalid, undefined if valid
 */
function validateEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return "Event is null or not an object";
  }
  const e = event as Record<string, unknown>;

  // Required fields per AgentActionEventInput schema
  if (typeof e.domain !== "string") {
    return "Event missing required 'domain' field";
  }
  if (typeof e.workflowName !== "string" || e.workflowName.length === 0) {
    return "Event missing required 'workflowName' field";
  }
  if (typeof e.agentName !== "string" || e.agentName.length === 0) {
    return "Event missing required 'agentName' field";
  }
  if (typeof e.runId !== "string" || e.runId.length === 0) {
    return "Event missing required 'runId' field";
  }
  if (typeof e.trustLevel !== "string") {
    return "Event missing required 'trustLevel' field";
  }
  if (typeof e.stage !== "string") {
    return "Event missing required 'stage' field";
  }
  if (typeof e.intent !== "string" || e.intent.length === 0) {
    return "Event missing required 'intent' field";
  }
  return undefined;
}

/**
 * Supabase implementation of EventLogger for agent actions
 *
 * IMPORTANT: This class validates all events before logging.
 * Malformed events are rejected with explicit error messages.
 */
export class AgentEventLogger implements EventLogger {
  private client: SupabaseClient;
  private tableName: string;
  private fireAndForget: boolean;

  constructor(
    client: SupabaseClient,
    options: { tableName?: string; fireAndForget?: boolean } = {}
  ) {
    this.client = client;
    this.tableName = options.tableName ?? "agent_action_events";
    this.fireAndForget = options.fireAndForget ?? true;
  }

  /**
   * Log an agent action event
   *
   * IMPORTANT: This method validates events before logging.
   * Malformed events are rejected with explicit error.
   *
   * Uses fire-and-forget pattern by default for non-blocking performance.
   * Set fireAndForget: false in constructor for synchronous logging.
   */
  async log(event: AgentActionEventInput): Promise<LogResult> {
    const eventId = crypto.randomUUID();

    // =========================================================================
    // Validate event before logging
    // =========================================================================
    const validationError = validateEvent(event);
    if (validationError) {
      console.error(`[AgentEventLogger] Event validation failed: ${validationError}`);
      return {
        success: false,
        eventId,
        error: `Event validation failed: ${validationError}`,
      };
    }

    const row = this.eventToRow(event);

    if (this.fireAndForget) {
      // Fire-and-forget: don't await the insert
      this.client
        .from(this.tableName)
        .insert({ ...row, id: eventId })
        .then(({ error }) => {
          if (error) {
            console.error("[AgentEventLogger] Insert failed:", error.message);
          }
        });

      return { success: true, eventId };
    }

    // Synchronous insert
    const { data, error } = await this.client
      .from(this.tableName)
      .insert({ ...row, id: eventId })
      .select("id")
      .single();

    if (error) {
      return {
        success: false,
        eventId,
        error: error.message,
      };
    }

    return {
      success: true,
      eventId: data.id,
    };
  }

  /**
   * Query agent action events with filtering
   */
  async query(options: AgentEventQuery): Promise<AgentActionEventInput[]> {
    let query = this.client.from(this.tableName).select("*");

    // Apply filters
    if (options.runId) {
      query = query.eq("run_id", options.runId);
    }
    if (options.workflowName) {
      query = query.eq("workflow_name", options.workflowName);
    }
    if (options.agentName) {
      query = query.eq("agent_name", options.agentName);
    }
    if (options.domain) {
      query = query.eq("domain", options.domain);
    }
    if (options.trustLevel) {
      query = query.eq("trust_level", options.trustLevel);
    }
    if (options.stage) {
      query = query.eq("stage", options.stage);
    }
    if (options.startTime) {
      query = query.gte("created_at", options.startTime.toISOString());
    }
    if (options.endTime) {
      query = query.lte("created_at", options.endTime.toISOString());
    }

    // Order by timestamp descending (newest first)
    query = query.order("created_at", { ascending: false });

    // Apply limit
    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Query failed: ${error.message}`);
    }

    return (data ?? []).map((row) => this.rowToEvent(row as AgentActionEventRow));
  }

  /**
   * Get statistics about agent action events
   */
  async getStats(runId?: string): Promise<AgentLoggerStats> {
    let baseQuery = this.client.from(this.tableName).select("*");

    if (runId) {
      baseQuery = baseQuery.eq("run_id", runId);
    }

    const { data, error } = await baseQuery;

    if (error) {
      throw new Error(`Stats query failed: ${error.message}`);
    }

    const rows = (data ?? []) as AgentActionEventRow[];

    // Aggregate stats
    const eventsByTrustLevel: Record<TrustLevel, number> = {
      L0: 0,
      L1: 0,
      L2: 0,
      L3: 0,
      L4: 0,
    };
    const eventsByStage: Record<WorkflowStage, number> = {
      plan: 0,
      execute: 0,
      review: 0,
      commit: 0,
    };
    const eventsByDomain: Record<Domain, number> = {
      asi: 0,
      land: 0,
    };
    let errorCount = 0;

    for (const row of rows) {
      const trustLevel = row.trust_level as TrustLevel;
      const stage = row.stage as WorkflowStage;
      const domain = row.domain as Domain;

      if (trustLevel in eventsByTrustLevel) {
        eventsByTrustLevel[trustLevel]++;
      }
      if (stage in eventsByStage) {
        eventsByStage[stage]++;
      }
      if (domain in eventsByDomain) {
        eventsByDomain[domain]++;
      }
      if (row.errors && row.errors.length > 0) {
        errorCount++;
      }
    }

    return {
      totalEvents: rows.length,
      eventsByTrustLevel,
      eventsByStage,
      eventsByDomain,
      errorCount,
    };
  }

  /**
   * Convert AgentActionEventInput to database row format
   */
  private eventToRow(
    event: AgentActionEventInput
  ): Omit<AgentActionEventRow, "id" | "created_at"> {
    return {
      domain: event.domain,
      workflow_name: event.workflowName,
      agent_name: event.agentName,
      run_id: event.runId,
      trust_level: event.trustLevel,
      stage: event.stage,
      intent: event.intent,
      tool_name: event.toolName ?? null,
      tool_args: event.toolArgs ?? null,
      tool_result: event.toolResult ?? null,
      artifact_refs: event.artifactRefs ?? null,
      warnings: event.warnings ?? null,
      errors: event.errors ?? null,
      summary: event.summary ?? null,
      confidence: event.confidence ?? null,
    };
  }

  /**
   * Convert database row to AgentActionEventInput
   */
  private rowToEvent(row: AgentActionEventRow): AgentActionEventInput {
    return {
      domain: row.domain as Domain,
      workflowName: row.workflow_name,
      agentName: row.agent_name,
      runId: row.run_id,
      trustLevel: row.trust_level as TrustLevel,
      stage: row.stage as WorkflowStage,
      intent: row.intent,
      toolName: row.tool_name ?? undefined,
      toolArgs: row.tool_args ?? undefined,
      toolResult: row.tool_result ?? undefined,
      artifactRefs: row.artifact_refs ?? undefined,
      warnings: row.warnings ?? undefined,
      errors: row.errors ?? undefined,
      summary: row.summary ?? undefined,
      confidence: row.confidence ?? undefined,
    };
  }
}

/**
 * In-memory logger for testing
 *
 * IMPORTANT: This class validates all events before logging,
 * matching the behavior of AgentEventLogger.
 */
export class InMemoryEventLogger implements EventLogger {
  private events: AgentActionEventInput[] = [];

  async log(event: AgentActionEventInput): Promise<LogResult> {
    const eventId = crypto.randomUUID();

    // Validate event (same as AgentEventLogger)
    const validationError = validateEvent(event);
    if (validationError) {
      return {
        success: false,
        eventId,
        error: `Event validation failed: ${validationError}`,
      };
    }

    this.events.push(event);
    return { success: true, eventId };
  }

  async query(options: AgentEventQuery): Promise<AgentActionEventInput[]> {
    return this.events.filter((event) => {
      if (options.runId && event.runId !== options.runId) return false;
      if (options.workflowName && event.workflowName !== options.workflowName) return false;
      if (options.agentName && event.agentName !== options.agentName) return false;
      if (options.domain && event.domain !== options.domain) return false;
      if (options.trustLevel && event.trustLevel !== options.trustLevel) return false;
      if (options.stage && event.stage !== options.stage) return false;
      return true;
    });
  }

  async getStats(): Promise<AgentLoggerStats> {
    const eventsByTrustLevel: Record<TrustLevel, number> = {
      L0: 0,
      L1: 0,
      L2: 0,
      L3: 0,
      L4: 0,
    };
    const eventsByStage: Record<WorkflowStage, number> = {
      plan: 0,
      execute: 0,
      review: 0,
      commit: 0,
    };
    const eventsByDomain: Record<Domain, number> = {
      asi: 0,
      land: 0,
    };
    let errorCount = 0;

    for (const event of this.events) {
      eventsByTrustLevel[event.trustLevel]++;
      eventsByStage[event.stage]++;
      eventsByDomain[event.domain]++;
      if (event.errors && event.errors.length > 0) {
        errorCount++;
      }
    }

    return {
      totalEvents: this.events.length,
      eventsByTrustLevel,
      eventsByStage,
      eventsByDomain,
      errorCount,
    };
  }

  /**
   * Get all events (for testing)
   */
  getEvents(): AgentActionEventInput[] {
    return [...this.events];
  }

  /**
   * Clear all events (for testing)
   */
  clear(): void {
    this.events = [];
  }
}
