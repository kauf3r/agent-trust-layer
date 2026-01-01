/**
 * Domain Adapter Tests
 *
 * Tests for the DomainAdapter interface, registry, and factory functions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  type DomainAdapter,
  type RegisteredTool,
  DomainAdapterRegistry,
  createAdapterRegistry,
  createDomainAdapter,
  mergeAdapters,
  buildDomainConfigFromAdapter,
  validateDomainAdapter,
} from "../core/domain-adapter.js";
import type { ToolDefinition, AgentDefinition, WorkflowDefinition } from "../core/schemas.js";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a minimal valid tool for testing
 */
function createTestTool(name: string): RegisteredTool {
  return {
    definition: {
      name,
      description: `Test tool: ${name}`,
      capability: "READ",
      risk: "LOW",
      executionMode: "DIRECT",
      verification: "NONE",
      inputSchema: { query: { type: "string" } },
    },
    handler: async () => ({ result: "test" }),
  };
}

/**
 * Create a minimal valid agent for testing
 */
function createTestAgent(
  name: string,
  role: "planner" | "worker" | "reviewer",
  allowedTools: string[] = []
): AgentDefinition {
  return {
    name,
    role,
    systemPrompt: `You are a ${role} agent named ${name}.`,
    allowedTools,
    maxTurns: 5,
  };
}

/**
 * Create a minimal valid workflow for testing
 */
function createTestWorkflow(
  name: string,
  agents: AgentDefinition[],
  stages: Array<"plan" | "execute" | "review" | "commit"> = ["plan"]
): WorkflowDefinition {
  return {
    name,
    domain: "asi",
    agents,
    stages,
  };
}

/**
 * Create a valid ASI domain adapter for testing
 */
function createValidAsiAdapter(): DomainAdapter {
  const tools = [
    createTestTool("asi.bookings.get"),
    createTestTool("asi.bookings.create"),
    createTestTool("asi.members.get"),
  ];

  const agents = [
    createTestAgent("planner", "planner", ["asi.bookings.get", "asi.members.get"]),
    createTestAgent("worker", "worker", ["asi.bookings.create"]),
    createTestAgent("reviewer", "reviewer", ["asi.bookings.get"]),
  ];

  const workflows = [
    createTestWorkflow("daily_brief", agents, ["plan", "execute", "review", "commit"]),
  ];

  return createDomainAdapter({
    domain: "asi",
    name: "AirSpace Integration",
    version: "1.0.0",
    description: "Test adapter for ASI domain",
    tools,
    agents,
    workflows,
    config: {
      trustGate: {
        domain: "asi",
        defaultTrustLevel: "L1",
        requireApprovalAbove: "L2",
        sandboxWriteOps: true,
      },
      toolOverrides: {
        "asi.invoices.send": "L3",
      },
    },
  });
}

// =============================================================================
// createDomainAdapter Tests
// =============================================================================

describe("createDomainAdapter", () => {
  it("creates an adapter with minimal required fields", () => {
    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Minimal Adapter",
      version: "0.0.1",
    });

    expect(adapter.domain).toBe("asi");
    expect(adapter.name).toBe("Minimal Adapter");
    expect(adapter.version).toBe("0.0.1");
    expect(adapter.getTools()).toEqual([]);
    expect(adapter.getAgents()).toEqual([]);
    expect(adapter.getWorkflows()).toEqual([]);
    expect(adapter.getConfig()).toEqual({});
  });

  it("creates an adapter with all fields", () => {
    const adapter = createValidAsiAdapter();

    expect(adapter.domain).toBe("asi");
    expect(adapter.name).toBe("AirSpace Integration");
    expect(adapter.version).toBe("1.0.0");
    expect(adapter.description).toBe("Test adapter for ASI domain");
    expect(adapter.getTools()).toHaveLength(3);
    expect(adapter.getAgents()).toHaveLength(3);
    expect(adapter.getWorkflows()).toHaveLength(1);
    expect(adapter.getConfig()).toBeDefined();
  });

  it("supports lifecycle hooks", async () => {
    const onInitialize = vi.fn().mockResolvedValue(undefined);
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const onWorkflowStart = vi.fn().mockResolvedValue(undefined);
    const onWorkflowComplete = vi.fn().mockResolvedValue(undefined);

    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Lifecycle Test",
      version: "1.0.0",
      onInitialize,
      onShutdown,
      onWorkflowStart,
      onWorkflowComplete,
    });

    await adapter.onInitialize?.();
    await adapter.onShutdown?.();
    await adapter.onWorkflowStart?.("test_workflow", "run-123");
    await adapter.onWorkflowComplete?.("test_workflow", "run-123", "completed");

    expect(onInitialize).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onWorkflowStart).toHaveBeenCalledWith("test_workflow", "run-123");
    expect(onWorkflowComplete).toHaveBeenCalledWith(
      "test_workflow",
      "run-123",
      "completed"
    );
  });
});

// =============================================================================
// validateDomainAdapter Tests
// =============================================================================

describe("validateDomainAdapter", () => {
  it("validates a correct adapter", () => {
    const adapter = createValidAsiAdapter();
    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.toolCount).toBe(3);
    expect(result.stats.agentCount).toBe(3);
    expect(result.stats.workflowCount).toBe(1);
  });

  it("reports error for invalid domain", () => {
    const adapter = createDomainAdapter({
      domain: "invalid" as any,
      name: "Invalid Domain",
      version: "1.0.0",
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("domain"))).toBe(true);
  });

  it("reports error for invalid version format", () => {
    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Invalid Version",
      version: "v1.0", // Missing third number
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("reports warning for tool without domain prefix", () => {
    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Wrong Tool Prefix",
      version: "1.0.0",
      tools: [createTestTool("bookings.get")], // Missing "asi." prefix
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(true); // Still valid, just a warning
    expect(result.warnings.some((w) => w.includes("should be prefixed"))).toBe(
      true
    );
  });

  it("reports error for agent with invalid role", () => {
    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Invalid Agent Role",
      version: "1.0.0",
      agents: [createTestAgent("test", "invalid" as any)],
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("invalid role"))).toBe(true);
  });

  it("reports warning for agent referencing unknown tool", () => {
    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Unknown Tool Reference",
      version: "1.0.0",
      tools: [createTestTool("asi.bookings.get")],
      agents: [createTestAgent("worker", "worker", ["asi.unknown.tool"])],
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(true); // Still valid, just a warning
    expect(result.warnings.some((w) => w.includes("unknown tool"))).toBe(true);
  });

  it("reports error for workflow with mismatched domain", () => {
    const agents = [createTestAgent("planner", "planner")];
    const workflow: WorkflowDefinition = {
      name: "mismatched",
      domain: "land", // Different from adapter domain
      agents,
      stages: ["plan"],
    };

    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Mismatched Workflow",
      version: "1.0.0",
      agents,
      workflows: [workflow],
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("domain"))).toBe(true);
  });

  it("reports warning for commit stage without review stage", () => {
    const agents = [
      createTestAgent("planner", "planner"),
      createTestAgent("worker", "worker"),
    ];
    const workflow = createTestWorkflow("no_review", agents, ["plan", "execute", "commit"]);

    const adapter = createDomainAdapter({
      domain: "asi",
      name: "No Review Stage",
      version: "1.0.0",
      agents,
      workflows: [workflow],
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(true); // Still valid, just a warning
    expect(result.warnings.some((w) => w.includes("no review stage"))).toBe(
      true
    );
  });

  it("reports error for workflow stage without corresponding agent", () => {
    const agents = [createTestAgent("planner", "planner")]; // Missing worker
    const workflow = createTestWorkflow("missing_worker", agents, ["plan", "execute"]);

    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Missing Worker",
      version: "1.0.0",
      agents,
      workflows: [workflow],
    });

    const result = validateDomainAdapter(adapter);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("requires 'worker' agent"))).toBe(
      true
    );
  });
});

// =============================================================================
// DomainAdapterRegistry Tests
// =============================================================================

describe("DomainAdapterRegistry", () => {
  let registry: DomainAdapterRegistry;

  beforeEach(() => {
    registry = createAdapterRegistry();
  });

  it("registers a valid adapter", () => {
    const adapter = createValidAsiAdapter();
    registry.register(adapter);

    expect(registry.has("asi")).toBe(true);
    expect(registry.get("asi")).toBe(adapter);
    expect(registry.size).toBe(1);
  });

  it("throws when registering invalid adapter", () => {
    const invalidAdapter = createDomainAdapter({
      domain: "invalid" as any,
      name: "Invalid",
      version: "bad-version",
    });

    expect(() => registry.register(invalidAdapter)).toThrow();
  });

  it("throws when registering duplicate domain", () => {
    const adapter1 = createValidAsiAdapter();
    const adapter2 = createDomainAdapter({
      domain: "asi",
      name: "Another ASI",
      version: "1.0.0",
    });

    registry.register(adapter1);
    expect(() => registry.register(adapter2)).toThrow("already has a registered adapter");
  });

  it("gets adapter or throws", () => {
    const adapter = createValidAsiAdapter();
    registry.register(adapter);

    expect(registry.getOrThrow("asi")).toBe(adapter);
    expect(() => registry.getOrThrow("land")).toThrow("No adapter registered");
  });

  it("lists all registered domains", () => {
    const asiAdapter = createValidAsiAdapter();
    const landAdapter = createDomainAdapter({
      domain: "land",
      name: "Land Domain",
      version: "1.0.0",
    });

    registry.register(asiAdapter);
    registry.register(landAdapter);

    const domains = registry.list();
    expect(domains).toHaveLength(2);
    expect(domains).toContain("asi");
    expect(domains).toContain("land");
  });

  it("unregisters an adapter", () => {
    const adapter = createValidAsiAdapter();
    registry.register(adapter);

    expect(registry.unregister("asi")).toBe(true);
    expect(registry.has("asi")).toBe(false);
    expect(registry.unregister("asi")).toBe(false); // Already removed
  });

  it("clears all adapters", () => {
    registry.register(createValidAsiAdapter());
    registry.register(
      createDomainAdapter({
        domain: "land",
        name: "Land",
        version: "1.0.0",
      })
    );

    expect(registry.size).toBe(2);
    registry.clear();
    expect(registry.size).toBe(0);
  });
});

// =============================================================================
// mergeAdapters Tests
// =============================================================================

describe("mergeAdapters", () => {
  it("merges multiple adapters", () => {
    const adapter1 = createDomainAdapter({
      domain: "asi",
      name: "Primary",
      version: "1.0.0",
      tools: [createTestTool("asi.tool1")],
      agents: [createTestAgent("agent1", "planner")],
    });

    const adapter2 = createDomainAdapter({
      domain: "asi",
      name: "Secondary",
      version: "2.0.0",
      tools: [createTestTool("asi.tool2")],
      agents: [createTestAgent("agent2", "worker")],
    });

    const merged = mergeAdapters(adapter1, adapter2);

    // Uses first adapter's identity
    expect(merged.domain).toBe("asi");
    expect(merged.name).toBe("Primary");
    expect(merged.version).toBe("1.0.0");

    // Combines tools and agents
    expect(merged.getTools()).toHaveLength(2);
    expect(merged.getAgents()).toHaveLength(2);
  });

  it("throws when no adapters provided", () => {
    expect(() => mergeAdapters()).toThrow("At least one adapter is required");
  });

  it("calls lifecycle hooks in order", async () => {
    const initOrder: string[] = [];
    const shutdownOrder: string[] = [];

    const adapter1 = createDomainAdapter({
      domain: "asi",
      name: "First",
      version: "1.0.0",
      onInitialize: async () => {
        initOrder.push("first");
      },
      onShutdown: async () => {
        shutdownOrder.push("first");
      },
    });

    const adapter2 = createDomainAdapter({
      domain: "asi",
      name: "Second",
      version: "1.0.0",
      onInitialize: async () => {
        initOrder.push("second");
      },
      onShutdown: async () => {
        shutdownOrder.push("second");
      },
    });

    const merged = mergeAdapters(adapter1, adapter2);

    await merged.onInitialize?.();
    expect(initOrder).toEqual(["first", "second"]);

    await merged.onShutdown?.();
    // Shutdown in reverse order
    expect(shutdownOrder).toEqual(["second", "first"]);
  });
});

// =============================================================================
// buildDomainConfigFromAdapter Tests
// =============================================================================

describe("buildDomainConfigFromAdapter", () => {
  it("builds a complete DomainConfig", () => {
    const adapter = createValidAsiAdapter();
    const config = buildDomainConfigFromAdapter(adapter);

    expect(config.domain).toBe("asi");
    expect(config.name).toBe("AirSpace Integration");
    expect(config.trustGate.domain).toBe("asi");
    expect(config.trustGate.defaultTrustLevel).toBe("L1");
    expect(config.trustGate.requireApprovalAbove).toBe("L2");
    expect(config.trustGate.sandboxWriteOps).toBe(true);
    expect(config.tools).toHaveLength(3);
    expect(config.toolOverrides["asi.invoices.send"]).toBe("L3");
  });

  it("uses defaults when config is empty", () => {
    const adapter = createDomainAdapter({
      domain: "asi",
      name: "Minimal",
      version: "1.0.0",
    });

    const config = buildDomainConfigFromAdapter(adapter);

    expect(config.trustGate.defaultTrustLevel).toBe("L1");
    expect(config.trustGate.requireApprovalAbove).toBe("L2");
    expect(config.trustGate.sandboxWriteOps).toBe(true);
    expect(config.tools).toEqual([]);
  });
});
