#!/usr/bin/env npx ts-node
/**
 * 🎓 ATL Learning Demo: Trust Gate Classification
 *
 * This simpler demo focuses on the core concept: how TrustGate
 * classifies tools and decides whether to approve them.
 *
 * Run it with: npx tsx examples/trust-gate-demo.ts
 */

import { TrustGate, type ToolDefinition, type TrustLevel } from "../src/index.js";

console.log("\n" + "=".repeat(60));
console.log("🎓 ATL Learning Demo: Trust Gate Classification");
console.log("=".repeat(60) + "\n");

// =============================================================================
// STEP 1: Create the Trust Gate
// =============================================================================

console.log("📋 Step 1: Create the Trust Gate\n");

const trustGate = new TrustGate({
  domain: "asi",
  defaultLevel: "L1",
  toolOverrides: {
    // Explicit trust level assignments
    get_weather: "L0",           // Public data
    get_booking: "L1",           // Internal read
    send_email: "L2",            // External notification
    update_booking: "L3",        // Internal write
    delete_all_bookings: "L4",   // Destructive
  },
  humanApprovalThreshold: "L3",  // L3+ requires human approval
  sandboxThreshold: "L4",        // L4 requires sandbox
});

console.log("  ✅ TrustGate configured:");
console.log("     • Domain: asi");
console.log("     • Human approval threshold: L3+");
console.log("     • Sandbox threshold: L4");
console.log("");

// =============================================================================
// STEP 2: Define Tools
// =============================================================================

console.log("📋 Step 2: Define tools to classify\n");

const tools: ToolDefinition[] = [
  {
    name: "get_weather",
    description: "Get public weather data",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
  {
    name: "get_booking",
    description: "Read booking from database",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
  {
    name: "send_email",
    description: "Send notification email",
    capability: "NOTIFY",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
  {
    name: "update_booking",
    description: "Update booking in database",
    capability: "WRITE",
    risk: "MEDIUM",
    executionMode: "DIRECT",
    verification: "HUMAN_REVIEW",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
  {
    name: "delete_all_bookings",
    description: "Delete all bookings (destructive!)",
    capability: "DELETE",
    risk: "HIGH",
    executionMode: "SANDBOXED",
    verification: "HUMAN_REVIEW",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
];

// =============================================================================
// STEP 3: Evaluate Each Tool
// =============================================================================

console.log("📋 Step 3: Evaluate each tool through the Trust Gate\n");
console.log("-".repeat(60));

// Context for evaluation
const context = {
  workflowName: "demo-workflow",
  agentName: "demo-agent",
  runId: "demo-run-1",
};

for (const tool of tools) {
  const result = trustGate.evaluate(tool, "execute", context);

  // Determine display based on result
  const levelEmoji = getLevelEmoji(result.trustLevel);
  const approvedIcon = result.approved ? "✅" : "🛑";
  const approvalText = result.approved ? "AUTO-APPROVED" : "REQUIRES APPROVAL";

  console.log(`\n${levelEmoji} ${tool.name}`);
  console.log(`   Trust Level: ${result.trustLevel}`);
  console.log(`   Capability:  ${tool.capability} / Risk: ${tool.risk}`);
  console.log(`   ${approvedIcon} ${approvalText}`);

  if (result.requiresHumanApproval) {
    console.log(`   👤 Human approval needed before execution`);
  }
  if (result.sandboxRequired) {
    console.log(`   📦 Must run in sandbox environment`);
  }
  if (result.reason) {
    console.log(`   📝 Reason: ${result.reason}`);
  }
}

console.log("\n" + "-".repeat(60));

// =============================================================================
// STEP 4: Summary
// =============================================================================

console.log("\n📋 Step 4: Understanding Trust Levels\n");

console.log(`
┌─────────┬────────────────────────────────────────────────────────┐
│ Level   │ Description                                            │
├─────────┼────────────────────────────────────────────────────────┤
│ L0 🌍   │ Public Read - Weather, public APIs, open data          │
│         │ → Always auto-approved                                 │
├─────────┼────────────────────────────────────────────────────────┤
│ L1 📖   │ Internal Read - Database queries, file reads           │
│         │ → Auto-approved (trusted internal data)                │
├─────────┼────────────────────────────────────────────────────────┤
│ L2 📨   │ External Write - Emails, Slack, notifications          │
│         │ → Auto-approved (low-risk, reversible)                 │
├─────────┼────────────────────────────────────────────────────────┤
│ L3 🔒   │ Internal Write - Database updates, config changes      │
│         │ → REQUIRES HUMAN APPROVAL                              │
├─────────┼────────────────────────────────────────────────────────┤
│ L4 ⚠️   │ Destructive - Deletes, bulk operations, irreversible   │
│         │ → REQUIRES HUMAN APPROVAL + SANDBOX                    │
└─────────┴────────────────────────────────────────────────────────┘
`);

console.log("=".repeat(60));
console.log("🎓 Key Takeaway:");
console.log("=".repeat(60));
console.log(`
The Trust Gate is the FIRST line of defense. It classifies every
tool call and decides:

1. What trust level applies (L0-L4)
2. Whether to auto-approve or require human approval
3. Whether sandboxed execution is needed

This happens BEFORE any tool code runs, ensuring unsafe operations
never execute without proper authorization.
`);

// =============================================================================
// Helper Functions
// =============================================================================

function getLevelEmoji(level: TrustLevel): string {
  switch (level) {
    case "L0": return "🌍";
    case "L1": return "📖";
    case "L2": return "📨";
    case "L3": return "🔒";
    case "L4": return "⚠️";
    default: return "❓";
  }
}
