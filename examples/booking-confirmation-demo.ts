#!/usr/bin/env npx ts-node
/**
 * 🎓 ATL Learning Demo: Booking Confirmation Workflow
 *
 * This script demonstrates the Agent Trust Layer in action.
 * Run it with: npx ts-node examples/booking-confirmation-demo.ts
 *
 * What you'll learn:
 * 1. How trust levels (L0-L4) classify tools
 * 2. How L0-L2 tools auto-approve
 * 3. How L3+ tools pause for human approval
 * 4. How the event logger captures an audit trail
 */

import {
  TrustGate,
  InMemoryEventLogger,
  InMemoryApprovalStore,
  ToolRouter,
  type ToolDefinition,
  type TrustLevel,
  type ToolHandler,
} from "../src/index.js";

// =============================================================================
// STEP 1: Define Tools with Trust Levels
// =============================================================================

console.log("\n" + "=".repeat(60));
console.log("🎓 ATL Learning Demo: Booking Confirmation Workflow");
console.log("=".repeat(60) + "\n");

console.log("📋 Step 1: Define tools with trust levels\n");

/**
 * Tool definitions - each tool has a trust level that determines
 * how it's handled by the ATL.
 */
const tools: ToolDefinition[] = [
  {
    name: "get_booking",
    description: "Retrieve booking details (L1 - Internal Read)",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    inputSchema: { type: "object", properties: { bookingId: { type: "string" } } },
    outputSchema: { type: "object" },
  },
  {
    name: "get_member",
    description: "Look up member info (L1 - Internal Read)",
    capability: "READ",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    inputSchema: { type: "object", properties: { memberId: { type: "string" } } },
    outputSchema: { type: "object" },
  },
  {
    name: "update_booking_status",
    description: "Update booking status (L3 - Internal Write) ⚠️ REQUIRES APPROVAL",
    capability: "WRITE",
    risk: "MEDIUM",
    executionMode: "DIRECT",
    verification: "HUMAN_REVIEW",
    inputSchema: {
      type: "object",
      properties: {
        bookingId: { type: "string" },
        status: { type: "string" },
      },
    },
    outputSchema: { type: "object" },
  },
  {
    name: "send_confirmation_email",
    description: "Send confirmation email (L2 - External Write)",
    capability: "NOTIFY",
    risk: "LOW",
    executionMode: "DIRECT",
    verification: "NONE",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        message: { type: "string" },
      },
    },
    outputSchema: { type: "object" },
  },
];

// Print tool summary
for (const tool of tools) {
  const level = inferTrustLevel(tool);
  const emoji = level === "L3" ? "🔒" : level === "L2" ? "📨" : "📖";
  console.log(`  ${emoji} ${tool.name}: ${level} (${tool.capability}/${tool.risk})`);
}

// =============================================================================
// STEP 2: Create ATL Components
// =============================================================================

console.log("\n📋 Step 2: Create ATL components\n");

// Create the trust gate for ASI domain
const trustGate = new TrustGate({
  domain: "asi",
  defaultLevel: "L1",
  toolOverrides: {
    update_booking_status: "L3", // Explicitly set to L3
    send_confirmation_email: "L2",
  },
  humanApprovalThreshold: "L3", // L3+ requires human approval
  sandboxThreshold: "L4",
});

console.log("  ✅ TrustGate created (L3+ requires human approval)");

// Create an in-memory event logger (no Supabase needed for demo)
const logger = new InMemoryEventLogger();
console.log("  ✅ InMemoryEventLogger created (audit trail)");

// Create an in-memory approval store
const approvalStore = new InMemoryApprovalStore();
console.log("  ✅ InMemoryApprovalStore created (approval workflow)");

// Create the tool router
const router = new ToolRouter(trustGate, logger);
console.log("  ✅ ToolRouter created");

// =============================================================================
// STEP 3: Register Tool Handlers
// =============================================================================

console.log("\n📋 Step 3: Register tool handlers\n");

// Simulated handlers
const handlers: Record<string, ToolHandler> = {
  get_booking: async (args) => {
    console.log(`    [Handler] get_booking called with: ${JSON.stringify(args)}`);
    return {
      id: args.bookingId,
      resourceName: "Conference Room A",
      date: "2025-01-15",
      time: "10:00 - 11:00",
      status: "pending",
      memberId: "member-123",
    };
  },

  get_member: async (args) => {
    console.log(`    [Handler] get_member called with: ${JSON.stringify(args)}`);
    return {
      id: args.memberId,
      name: "Andy Kaufman",
      email: "andy@airspaceintegration.com",
      company: "AirSpace Integration",
    };
  },

  update_booking_status: async (args) => {
    console.log(`    [Handler] update_booking_status called with: ${JSON.stringify(args)}`);
    return {
      success: true,
      bookingId: args.bookingId,
      oldStatus: "pending",
      newStatus: args.status,
      updatedAt: new Date().toISOString(),
    };
  },

  send_confirmation_email: async (args) => {
    console.log(`    [Handler] send_confirmation_email called with: ${JSON.stringify(args)}`);
    return {
      success: true,
      recipient: args.email,
      sentAt: new Date().toISOString(),
    };
  },
};

// Register tools with handlers
for (const tool of tools) {
  router.registerTool(tool, handlers[tool.name]);
  console.log(`  ✅ Registered: ${tool.name}`);
}

// =============================================================================
// STEP 4: Execute the Workflow
// =============================================================================

async function runDemo() {
  console.log("\n📋 Step 4: Execute the booking confirmation workflow\n");
  console.log("-".repeat(60));

  const context = {
    domain: "asi" as const,
    workflowName: "booking-confirmation-demo",
    agentName: "demo-agent",
    runId: `run-${Date.now()}`,
    stage: "execute" as const,
  };

  // Tool 1: get_booking (L1 - auto-approved)
  console.log("\n🔷 Calling: get_booking (L1 - Internal Read)");
  const bookingResult = await router.call({
    toolName: "get_booking",
    args: { bookingId: "booking-456" },
    context,
  });
  const bookingStatus = bookingResult.success ? "✅ success" : `❌ failed: ${bookingResult.error}`;
  console.log(`  📊 Result: ${bookingStatus}`);
  console.log(`  🔐 Trust Level: ${bookingResult.trustGateResult.trustLevel}`);
  console.log(`  ✓ Approved: ${bookingResult.trustGateResult.approved}`);
  if (bookingResult.success) {
    console.log(`  📦 Data: ${JSON.stringify(bookingResult.result, null, 2)}`);
  }

  // Tool 2: get_member (L1 - auto-approved)
  console.log("\n🔷 Calling: get_member (L1 - Internal Read)");
  const memberResult = await router.call({
    toolName: "get_member",
    args: { memberId: "member-123" },
    context,
  });
  const memberStatus = memberResult.success ? "✅ success" : `❌ failed: ${memberResult.error}`;
  console.log(`  📊 Result: ${memberStatus}`);
  console.log(`  🔐 Trust Level: ${memberResult.trustGateResult.trustLevel}`);
  console.log(`  ✓ Approved: ${memberResult.trustGateResult.approved}`);
  if (memberResult.success) {
    console.log(`  📦 Data: ${JSON.stringify(memberResult.result, null, 2)}`);
  }

  // Tool 3: update_booking_status (L3 - REQUIRES APPROVAL)
  console.log("\n🔷 Calling: update_booking_status (L3 - Internal Write)");
  console.log("  ⚠️  This tool is L3 - it will require human approval!\n");

  const updateResult = await router.call({
    toolName: "update_booking_status",
    args: { bookingId: "booking-456", status: "confirmed" },
    context,
  });

  const updateStatus = updateResult.success ? "✅ success" : `❌ blocked: ${updateResult.error}`;
  console.log(`  📊 Result: ${updateStatus}`);
  console.log(`  🔐 Trust Level: ${updateResult.trustGateResult.trustLevel}`);
  console.log(`  ✓ Approved: ${updateResult.trustGateResult.approved}`);
  console.log(`  📝 Reason: ${updateResult.trustGateResult.reason}`);

  if (!updateResult.trustGateResult.approved) {
    console.log("\n  🛑 WORKFLOW PAUSED - Awaiting human approval!");
    console.log("  📋 In production, this would appear in the Approval Inbox");
    console.log("  📋 An operator would review and click Approve/Reject\n");

    // Simulate human approval
    console.log("  🧑 [Simulating human approval...]");
    await new Promise((r) => setTimeout(r, 1000));
    console.log("  ✅ [Human approved the action!]\n");

    // Note: In real system, orchestrator handles re-execution after approval
    console.log("  💡 After approval, the orchestrator would re-execute this tool");
  }

  // Tool 4: send_confirmation_email (L2 - auto-approved)
  console.log("\n🔷 Calling: send_confirmation_email (L2 - External Write)");
  const emailResult = await router.call({
    toolName: "send_confirmation_email",
    args: {
      email: "andy@airspaceintegration.com",
      message: "Your booking is confirmed!",
    },
    context,
  });
  const emailStatus = emailResult.success ? "✅ success" : `❌ failed: ${emailResult.error}`;
  console.log(`  📊 Result: ${emailStatus}`);
  console.log(`  🔐 Trust Level: ${emailResult.trustGateResult.trustLevel}`);
  console.log(`  ✓ Approved: ${emailResult.trustGateResult.approved}`);

  // =============================================================================
  // STEP 5: Review the Audit Trail
  // =============================================================================

  console.log("\n" + "-".repeat(60));
  console.log("\n📋 Step 5: Review the audit trail\n");

  const events = await logger.query({});
  console.log(`  📜 Total events logged: ${events.length}\n`);

  for (const event of events) {
    const emoji =
      event.outcome === "success" ? "✅" :
      event.outcome === "blocked" ? "🛑" :
      event.outcome === "pending" ? "⏳" : "❌";

    console.log(`  ${emoji} ${event.toolName}`);
    console.log(`     Trust: ${event.trustLevel} | Outcome: ${event.outcome}`);
    console.log(`     Time: ${event.timestamp}`);
  }

  // =============================================================================
  // Summary
  // =============================================================================

  console.log("\n" + "=".repeat(60));
  console.log("🎓 Demo Complete!");
  console.log("=".repeat(60));
  console.log(`
What you learned:

1. ✅ L0-L1 tools (reads) execute immediately
2. ✅ L2 tools (notifications) also auto-approve
3. 🔒 L3+ tools (writes) pause for human approval
4. 📜 Every action is logged to the audit trail

Next steps:
- View the ApprovalInbox component in the dashboard
- Check Supabase agent_action_events table in production
- Add your own tools and trust levels
`);
}

// =============================================================================
// Helper Functions
// =============================================================================

function inferTrustLevel(tool: ToolDefinition): TrustLevel {
  // Infer trust level from capability and risk
  if (tool.verification === "HUMAN_REVIEW") return "L3";
  if (tool.capability === "NOTIFY") return "L2";
  if (tool.capability === "READ") return "L1";
  if (tool.capability === "WRITE" && tool.risk === "HIGH") return "L4";
  if (tool.capability === "WRITE") return "L3";
  return "L0";
}

// Run the demo
runDemo().catch(console.error);
