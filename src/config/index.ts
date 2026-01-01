/**
 * Configuration Module
 *
 * This module provides configuration utilities and default settings
 * for the Agent Trust Layer. It includes:
 *
 * - Default trust level definitions (L0-L4)
 * - Default tool patterns and validation
 * - Configuration loading utilities
 *
 * @example
 * ```typescript
 * import {
 *   TRUST_LEVEL_DEFINITIONS,
 *   ALL_PATTERNS,
 *   loadDomainConfig,
 * } from "@andykaufman/agent-trust-layer/config";
 * ```
 */

// Re-export all defaults
export * from "./defaults/index.js";

// =============================================================================
// Configuration Loading Utilities
// =============================================================================

import {
  TRUST_LEVEL_DEFINITIONS,
  inferTrustLevel,
  findMatchingPattern,
  type TrustLevelDefinition,
} from "./defaults/index.js";

import type {
  TrustLevel,
  TrustGateConfig,
  ToolDefinition,
  Domain,
} from "../core/schemas.js";

/**
 * Domain configuration for a specific vertical
 */
export interface DomainConfig {
  /** Domain identifier */
  domain: Domain;

  /** Display name */
  name: string;

  /** Trust gate configuration */
  trustGate: TrustGateConfig;

  /** Registered tools for this domain */
  tools: ToolDefinition[];

  /** Tool name to trust level overrides */
  toolOverrides: Record<string, TrustLevel>;
}

/**
 * Default trust gate configuration
 */
export const DEFAULT_TRUST_GATE_CONFIG: Omit<TrustGateConfig, "domain"> = {
  defaultTrustLevel: "L1",
  requireApprovalAbove: "L2",
  sandboxWriteOps: true,
  toolOverrides: {},
};

/**
 * Create a domain configuration with sensible defaults
 */
export function createDomainConfig(
  domain: Domain,
  overrides: Partial<DomainConfig> = {}
): DomainConfig {
  return {
    domain,
    name: domain.toUpperCase(),
    trustGate: {
      domain,
      ...DEFAULT_TRUST_GATE_CONFIG,
      ...overrides.trustGate,
    },
    tools: overrides.tools ?? [],
    toolOverrides: overrides.toolOverrides ?? {},
  };
}

/**
 * Compute trust level for a tool based on its definition and patterns
 */
export function computeToolTrustLevel(tool: ToolDefinition): TrustLevel {
  // Check if there's a matching pattern
  const pattern = findMatchingPattern(tool.name);
  if (pattern) {
    return pattern.trustLevel;
  }

  // Fall back to inference from risk + capability
  return inferTrustLevel(tool.risk, tool.capability);
}

/**
 * Build tool overrides map from a list of tool definitions
 */
export function buildToolOverrides(
  tools: ToolDefinition[]
): Record<string, TrustLevel> {
  const overrides: Record<string, TrustLevel> = {};

  for (const tool of tools) {
    overrides[tool.name] = computeToolTrustLevel(tool);
  }

  return overrides;
}

/**
 * Validate a domain configuration
 */
export function validateDomainConfig(
  config: DomainConfig
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check domain is valid
  if (!config.domain) {
    errors.push("Domain is required");
  }

  // Check trust gate config
  if (!config.trustGate) {
    errors.push("Trust gate configuration is required");
  } else {
    if (config.trustGate.domain !== config.domain) {
      errors.push("Trust gate domain must match config domain");
    }
  }

  // Validate each tool
  for (const tool of config.tools) {
    if (!tool.name) {
      errors.push("Tool name is required");
      continue;
    }

    // Check tool follows naming convention
    const expectedPrefix = `${config.domain}.`;
    if (!tool.name.startsWith(expectedPrefix)) {
      warnings.push(
        `Tool '${tool.name}' should be prefixed with '${expectedPrefix}'`
      );
    }

    // Check tool matches expected pattern
    const pattern = findMatchingPattern(tool.name);
    if (!pattern) {
      warnings.push(`Tool '${tool.name}' does not match any known pattern`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Merge two domain configurations (second overrides first)
 */
export function mergeDomainConfigs(
  base: DomainConfig,
  override: Partial<DomainConfig>
): DomainConfig {
  return {
    domain: override.domain ?? base.domain,
    name: override.name ?? base.name,
    trustGate: {
      ...base.trustGate,
      ...override.trustGate,
      toolOverrides: {
        ...base.trustGate.toolOverrides,
        ...override.trustGate?.toolOverrides,
      },
    },
    tools: [...base.tools, ...(override.tools ?? [])],
    toolOverrides: {
      ...base.toolOverrides,
      ...override.toolOverrides,
    },
  };
}

/**
 * Get human-readable description for a trust level
 */
export function describeTrustLevel(level: TrustLevel): string {
  const def = TRUST_LEVEL_DEFINITIONS[level];
  return `${level}: ${def.name} - ${def.description}`;
}

/**
 * Get all trust level descriptions as a formatted string
 */
export function getTrustLevelSummary(): string {
  return Object.values(TRUST_LEVEL_DEFINITIONS)
    .map((def) => `${def.level}: ${def.name}\n   ${def.description}`)
    .join("\n\n");
}
