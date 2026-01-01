/**
 * Tool Catalog Defaults - Common Tool Patterns for ATL
 *
 * This module provides a catalog of common tool patterns organized by
 * trust level. Domain adapters can use these as templates when defining
 * their tool registries.
 *
 * Each pattern includes:
 * - Naming conventions
 * - Required capabilities and risk levels
 * - Input/output schema templates
 * - Verification requirements
 *
 * The patterns follow the namespacing convention: {domain}.{action}
 * Example: asi.get_bookings, asi.commit_apply_changes
 */

import type {
  ToolDefinition,
  ToolCapability,
  RiskLevel,
  ExecutionMode,
  Verification,
  TrustLevel,
} from "../../core/schemas.js";

// =============================================================================
// Tool Pattern Types
// =============================================================================

/**
 * A tool pattern is a template for creating tool definitions.
 * It defines the common characteristics without domain-specific details.
 */
export interface ToolPattern {
  /** Pattern name (e.g., "get_{resource}") */
  namePattern: string;

  /** Human-readable description template */
  descriptionTemplate: string;

  /** Expected trust level for tools matching this pattern */
  trustLevel: TrustLevel;

  /** Tool capability */
  capability: ToolCapability;

  /** Risk level */
  risk: RiskLevel;

  /** Execution mode */
  executionMode: ExecutionMode;

  /** Verification requirements */
  verification: Verification;

  /** Common input schema fields */
  commonInputFields: Record<string, { type: string; description: string; required?: boolean }>;

  /** Example tool names that match this pattern */
  examples: string[];
}

/**
 * Category of tool patterns by trust level
 */
export interface ToolPatternCategory {
  /** Trust level this category covers */
  level: TrustLevel;

  /** Description of the category */
  description: string;

  /** Patterns in this category */
  patterns: ToolPattern[];
}

// =============================================================================
// L0 Patterns - Read-Only Tools
// =============================================================================

export const L0_PATTERNS: ToolPattern[] = [
  {
    namePattern: "get_{resource}",
    descriptionTemplate: "Retrieve {resource} data from the system",
    trustLevel: "L0",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      id: { type: "string", description: "Optional ID to fetch a specific item" },
      filters: { type: "object", description: "Query filters" },
      limit: { type: "number", description: "Maximum items to return" },
    },
    examples: ["get_bookings", "get_members", "get_flights", "get_events"],
  },
  {
    namePattern: "list_{resources}",
    descriptionTemplate: "List all {resources} with optional filtering",
    trustLevel: "L0",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      filters: { type: "object", description: "Query filters" },
      cursor: { type: "string", description: "Pagination cursor" },
      limit: { type: "number", description: "Maximum items to return" },
    },
    examples: ["list_members", "list_companies", "list_resources"],
  },
  {
    namePattern: "search_{resource}",
    descriptionTemplate: "Search for {resource} matching criteria",
    trustLevel: "L0",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      query: { type: "string", description: "Search query", required: true },
      filters: { type: "object", description: "Additional filters" },
      limit: { type: "number", description: "Maximum results" },
    },
    examples: ["search_members", "search_bookings"],
  },
  {
    namePattern: "classify_{entity}",
    descriptionTemplate: "Classify {entity} into categories",
    trustLevel: "L0",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      input: { type: "object", description: "Entity to classify", required: true },
    },
    examples: ["classify_alert", "classify_event"],
  },
];

// =============================================================================
// L1 Patterns - Proposal Tools
// =============================================================================

export const L1_PATTERNS: ToolPattern[] = [
  {
    namePattern: "draft_{content}",
    descriptionTemplate: "Generate a draft {content} for review",
    trustLevel: "L1",
    capability: "PROPOSE",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      context: { type: "object", description: "Context for draft generation", required: true },
      format: { type: "string", description: "Output format preference" },
    },
    examples: ["draft_brief", "draft_email", "draft_report"],
  },
  {
    namePattern: "analyze_{subject}",
    descriptionTemplate: "Analyze {subject} and provide insights",
    trustLevel: "L1",
    capability: "PROPOSE",
    risk: "MEDIUM",
    executionMode: "DIRECT",
    verification: "RULES",
    commonInputFields: {
      data: { type: "object", description: "Data to analyze", required: true },
      options: { type: "object", description: "Analysis options" },
    },
    examples: ["analyze_compliance", "analyze_billing", "analyze_trends"],
  },
  {
    namePattern: "generate_{artifact}",
    descriptionTemplate: "Generate {artifact} from inputs",
    trustLevel: "L1",
    capability: "PROPOSE",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      input: { type: "object", description: "Input data", required: true },
      template: { type: "string", description: "Template to use" },
    },
    examples: ["generate_audit_pack", "generate_summary", "generate_schedule"],
  },
  {
    namePattern: "suggest_{action}",
    descriptionTemplate: "Suggest {action} based on context",
    trustLevel: "L1",
    capability: "PROPOSE",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      context: { type: "object", description: "Current context", required: true },
    },
    examples: ["suggest_schedule", "suggest_response", "suggest_next_action"],
  },
  {
    namePattern: "format_{content}",
    descriptionTemplate: "Format {content} for output",
    trustLevel: "L1",
    capability: "PROPOSE",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    commonInputFields: {
      content: { type: "string", description: "Content to format", required: true },
      format: { type: "string", description: "Target format", required: true },
    },
    examples: ["format_report", "format_email", "format_notification"],
  },
];

// =============================================================================
// L2 Patterns - Sandboxed Write Tools
// =============================================================================

export const L2_PATTERNS: ToolPattern[] = [
  {
    namePattern: "stage_{resource}_create",
    descriptionTemplate: "Stage creation of a new {resource} (sandboxed)",
    trustLevel: "L2",
    capability: "WRITE",
    risk: "MEDIUM",
    executionMode: "SANDBOX_ONLY",
    verification: "RULES",
    commonInputFields: {
      data: { type: "object", description: "Resource data to create", required: true },
      runId: { type: "string", description: "Workflow run ID", required: true },
    },
    examples: ["stage_booking_create", "stage_member_create", "stage_event_create"],
  },
  {
    namePattern: "stage_{resource}_update",
    descriptionTemplate: "Stage update to existing {resource} (sandboxed)",
    trustLevel: "L2",
    capability: "WRITE",
    risk: "MEDIUM",
    executionMode: "SANDBOX_ONLY",
    verification: "RULES",
    commonInputFields: {
      id: { type: "string", description: "Resource ID to update", required: true },
      data: { type: "object", description: "Fields to update", required: true },
      runId: { type: "string", description: "Workflow run ID", required: true },
    },
    examples: ["stage_flight_update", "stage_member_update", "stage_booking_update"],
  },
  {
    namePattern: "stage_{resource}_delete",
    descriptionTemplate: "Stage deletion of {resource} (sandboxed)",
    trustLevel: "L2",
    capability: "WRITE",
    risk: "HIGH",
    executionMode: "SANDBOX_ONLY",
    verification: "MULTI_AGENT",
    commonInputFields: {
      id: { type: "string", description: "Resource ID to delete", required: true },
      reason: { type: "string", description: "Reason for deletion" },
      runId: { type: "string", description: "Workflow run ID", required: true },
    },
    examples: ["stage_event_delete", "stage_draft_delete"],
  },
  {
    namePattern: "stage_{action}",
    descriptionTemplate: "Stage {action} for later commit (sandboxed)",
    trustLevel: "L2",
    capability: "WRITE",
    risk: "MEDIUM",
    executionMode: "SANDBOX_ONLY",
    verification: "RULES",
    commonInputFields: {
      payload: { type: "object", description: "Action payload", required: true },
      runId: { type: "string", description: "Workflow run ID", required: true },
    },
    examples: ["stage_event_log", "stage_notification"],
  },
];

// =============================================================================
// L3 Patterns - Commit Tools (Review Required)
// =============================================================================

export const L3_PATTERNS: ToolPattern[] = [
  {
    namePattern: "commit_apply_changes",
    descriptionTemplate: "Apply all staged changes to production",
    trustLevel: "L3",
    capability: "SIDE_EFFECTS",
    risk: "HIGH",
    executionMode: "SANDBOX_ONLY",
    verification: "MULTI_AGENT",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      dryRun: { type: "boolean", description: "Preview changes without applying" },
    },
    examples: ["commit_apply_changes"],
  },
  {
    namePattern: "commit_publish_{content}",
    descriptionTemplate: "Publish {content} to recipients",
    trustLevel: "L3",
    capability: "SIDE_EFFECTS",
    risk: "MEDIUM",
    executionMode: "SANDBOX_ONLY",
    verification: "MULTI_AGENT",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      recipients: { type: "array", description: "Target recipients" },
      content: { type: "object", description: "Content to publish", required: true },
    },
    examples: ["commit_publish_daily_brief", "commit_publish_report"],
  },
  {
    namePattern: "commit_post_{notification}",
    descriptionTemplate: "Post {notification} to channels",
    trustLevel: "L3",
    capability: "SIDE_EFFECTS",
    risk: "MEDIUM",
    executionMode: "SANDBOX_ONLY",
    verification: "MULTI_AGENT",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      channels: { type: "array", description: "Target channels", required: true },
      message: { type: "object", description: "Notification content", required: true },
    },
    examples: ["commit_post_alert", "commit_post_notification"],
  },
  {
    namePattern: "send_{communication}",
    descriptionTemplate: "Send {communication} to external recipients",
    trustLevel: "L3",
    capability: "SIDE_EFFECTS",
    risk: "HIGH",
    executionMode: "SANDBOX_ONLY",
    verification: "MULTI_AGENT",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      to: { type: "array", description: "Recipients", required: true },
      content: { type: "object", description: "Communication content", required: true },
    },
    examples: ["send_email", "send_sms"],
  },
  {
    namePattern: "sync_{resource}",
    descriptionTemplate: "Synchronize {resource} with external system",
    trustLevel: "L3",
    capability: "SIDE_EFFECTS",
    risk: "HIGH",
    executionMode: "SANDBOX_ONLY",
    verification: "MULTI_AGENT",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      target: { type: "string", description: "External system to sync with" },
      options: { type: "object", description: "Sync options" },
    },
    examples: ["sync_calendar", "sync_contacts"],
  },
];

// =============================================================================
// L4 Patterns - Critical Commit Tools (Human Required)
// =============================================================================

export const L4_PATTERNS: ToolPattern[] = [
  {
    namePattern: "commit_send_invoice",
    descriptionTemplate: "Send billing invoice to customer",
    trustLevel: "L4",
    capability: "SIDE_EFFECTS",
    risk: "CRITICAL",
    executionMode: "SANDBOX_ONLY",
    verification: "HUMAN_APPROVAL",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      invoiceId: { type: "string", description: "Invoice to send", required: true },
      recipient: { type: "object", description: "Invoice recipient", required: true },
    },
    examples: ["commit_send_invoice"],
  },
  {
    namePattern: "commit_mark_checkpoint_complete",
    descriptionTemplate: "Mark compliance checkpoint as complete",
    trustLevel: "L4",
    capability: "SIDE_EFFECTS",
    risk: "CRITICAL",
    executionMode: "SANDBOX_ONLY",
    verification: "HUMAN_APPROVAL",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      checkpointId: { type: "string", description: "Checkpoint ID", required: true },
      evidence: { type: "object", description: "Compliance evidence", required: true },
    },
    examples: ["commit_mark_checkpoint_complete"],
  },
  {
    namePattern: "delete_{resource}",
    descriptionTemplate: "Permanently delete {resource}",
    trustLevel: "L4",
    capability: "SIDE_EFFECTS",
    risk: "CRITICAL",
    executionMode: "SANDBOX_ONLY",
    verification: "HUMAN_APPROVAL",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      id: { type: "string", description: "Resource ID to delete", required: true },
      reason: { type: "string", description: "Reason for deletion", required: true },
      confirmation: { type: "string", description: "Confirmation code", required: true },
    },
    examples: ["delete_member", "delete_all_events"],
  },
  {
    namePattern: "archive_{data}",
    descriptionTemplate: "Archive {data} (irreversible)",
    trustLevel: "L4",
    capability: "SIDE_EFFECTS",
    risk: "CRITICAL",
    executionMode: "SANDBOX_ONLY",
    verification: "HUMAN_APPROVAL",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      target: { type: "string", description: "Data to archive", required: true },
      reason: { type: "string", description: "Reason for archival", required: true },
    },
    examples: ["archive_compliance_data", "archive_billing_history"],
  },
  {
    namePattern: "modify_billing",
    descriptionTemplate: "Modify billing configuration",
    trustLevel: "L4",
    capability: "SIDE_EFFECTS",
    risk: "CRITICAL",
    executionMode: "SANDBOX_ONLY",
    verification: "HUMAN_APPROVAL",
    commonInputFields: {
      runId: { type: "string", description: "Workflow run ID", required: true },
      changes: { type: "object", description: "Billing changes", required: true },
      reason: { type: "string", description: "Reason for modification", required: true },
    },
    examples: ["modify_billing", "modify_pricing"],
  },
];

// =============================================================================
// Pattern Categories
// =============================================================================

export const TOOL_PATTERN_CATEGORIES: ToolPatternCategory[] = [
  {
    level: "L0",
    description: "Read-only operations with full autonomy",
    patterns: L0_PATTERNS,
  },
  {
    level: "L1",
    description: "Proposal and analysis tools that don't mutate state",
    patterns: L1_PATTERNS,
  },
  {
    level: "L2",
    description: "Sandboxed write operations (staged, not committed)",
    patterns: L2_PATTERNS,
  },
  {
    level: "L3",
    description: "Commit tools requiring reviewer approval",
    patterns: L3_PATTERNS,
  },
  {
    level: "L4",
    description: "Critical operations requiring human approval",
    patterns: L4_PATTERNS,
  },
];

/**
 * All patterns flattened into a single array
 */
export const ALL_PATTERNS: ToolPattern[] = [
  ...L0_PATTERNS,
  ...L1_PATTERNS,
  ...L2_PATTERNS,
  ...L3_PATTERNS,
  ...L4_PATTERNS,
];

// =============================================================================
// Pattern Lookup and Matching
// =============================================================================

/**
 * Get all patterns for a specific trust level
 */
export function getPatternsForLevel(level: TrustLevel): ToolPattern[] {
  const category = TOOL_PATTERN_CATEGORIES.find((c) => c.level === level);
  return category?.patterns ?? [];
}

/**
 * Find a matching pattern for a tool name
 */
export function findMatchingPattern(toolName: string): ToolPattern | undefined {
  // Extract the base name without domain prefix
  const baseName = toolName.includes(".") ? toolName.split(".").slice(1).join(".") : toolName;

  for (const pattern of ALL_PATTERNS) {
    // Convert pattern to regex
    // e.g., "get_{resource}" -> /^get_\w+$/
    const regex = new RegExp(
      "^" + pattern.namePattern.replace(/\{[^}]+\}/g, "\\w+") + "$"
    );
    if (regex.test(baseName)) {
      return pattern;
    }
  }

  return undefined;
}

/**
 * Create a tool definition from a pattern
 */
export function createToolFromPattern(
  pattern: ToolPattern,
  name: string,
  description: string,
  inputSchema: Record<string, unknown> = {}
): ToolDefinition {
  return {
    name,
    description,
    capability: pattern.capability,
    risk: pattern.risk,
    executionMode: pattern.executionMode,
    verification: pattern.verification,
    inputSchema: {
      ...Object.fromEntries(
        Object.entries(pattern.commonInputFields).map(([key, field]) => [
          key,
          { type: field.type, description: field.description },
        ])
      ),
      ...inputSchema,
    },
  };
}

/**
 * Validate a tool definition matches expected patterns
 */
export function validateToolAgainstPatterns(
  tool: ToolDefinition
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const pattern = findMatchingPattern(tool.name);

  if (!pattern) {
    warnings.push(`Tool '${tool.name}' does not match any known pattern`);
    return { valid: true, warnings }; // Custom tools are allowed
  }

  // Check capability matches
  if (tool.capability !== pattern.capability) {
    warnings.push(
      `Tool '${tool.name}' has capability '${tool.capability}' but pattern expects '${pattern.capability}'`
    );
  }

  // Check risk level is appropriate
  const riskOrder = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  if (riskOrder.indexOf(tool.risk) < riskOrder.indexOf(pattern.risk)) {
    warnings.push(
      `Tool '${tool.name}' has lower risk '${tool.risk}' than pattern minimum '${pattern.risk}'`
    );
  }

  // Check execution mode
  if (pattern.executionMode === "SANDBOX_ONLY" && tool.executionMode !== "SANDBOX_ONLY") {
    warnings.push(
      `Tool '${tool.name}' should use SANDBOX_ONLY execution mode for pattern '${pattern.namePattern}'`
    );
  }

  return { valid: warnings.length === 0, warnings };
}
