/**
 * Default Configuration Exports
 *
 * This module re-exports all default configurations for the Agent Trust Layer.
 * Import from here for a clean API:
 *
 * @example
 * ```typescript
 * import {
 *   TRUST_LEVEL_DEFINITIONS,
 *   getTrustLevelDefinition,
 *   ALL_PATTERNS,
 *   findMatchingPattern,
 * } from "@andykaufman/agent-trust-layer/config/defaults";
 * ```
 */

// Trust Level Definitions
export {
  // Individual level definitions
  L0_DEFINITION,
  L1_DEFINITION,
  L2_DEFINITION,
  L3_DEFINITION,
  L4_DEFINITION,

  // Registry and lookup
  TRUST_LEVEL_DEFINITIONS,
  TRUST_LEVEL_ORDER,
  getTrustLevelDefinition,
  compareTrustLevels,
  isAtLeastAsRestrictive,
  getApprovalThreshold,
  getHumanApprovalThreshold,
  inferTrustLevel,

  // Types
  type TrustLevelDefinition,
} from "./trust-levels.js";

// Tool Catalog Patterns
export {
  // Patterns by level
  L0_PATTERNS,
  L1_PATTERNS,
  L2_PATTERNS,
  L3_PATTERNS,
  L4_PATTERNS,
  ALL_PATTERNS,

  // Categories
  TOOL_PATTERN_CATEGORIES,

  // Lookup and utilities
  getPatternsForLevel,
  findMatchingPattern,
  createToolFromPattern,
  validateToolAgainstPatterns,

  // Types
  type ToolPattern,
  type ToolPatternCategory,
} from "./tool-catalog.js";
