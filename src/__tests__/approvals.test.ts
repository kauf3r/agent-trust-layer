/**
 * Tests for ApprovalStore abstraction
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryApprovalStore,
  createInMemoryApprovalStore,
  type ApprovalStore,
  type CreateApprovalRequestInput,
} from "../index.js";

describe("ApprovalStore", () => {
  let store: ApprovalStore;

  beforeEach(() => {
    store = createInMemoryApprovalStore();
  });

  describe("InMemoryApprovalStore", () => {
    it("implements ApprovalStore interface", () => {
      const instance = new InMemoryApprovalStore();
      // Type check - if these exist, the interface is implemented
      expect(typeof instance.createRequest).toBe("function");
      expect(typeof instance.getRequest).toBe("function");
      expect(typeof instance.getPendingRequests).toBe("function");
      expect(typeof instance.getRequestsByRunId).toBe("function");
      expect(typeof instance.isApproved).toBe("function");
      expect(typeof instance.isPending).toBe("function");
      expect(typeof instance.expireStaleRequests).toBe("function");
      expect(typeof instance.createDecision).toBe("function");
      expect(typeof instance.getDecision).toBe("function");
      expect(typeof instance.autoApprove).toBe("function");
    });
  });

  describe("createRequest", () => {
    it("creates a valid approval request", async () => {
      const input: CreateApprovalRequestInput = {
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "daily_ops_brief",
        requestedBy: "planner_agent",
        trustLevel: "L3",
        actionType: "COMMIT_POST_ALERT",
        actionPayload: { message: "Test alert" },
        reviewerVerdict: "PASS",
      };

      const request = await store.createRequest(input);

      expect(request.id).toBeDefined();
      expect(request.status).toBe("PENDING");
      expect(request.domain).toBe("asi");
      expect(request.workflowName).toBe("daily_ops_brief");
      expect(request.trustLevel).toBe("L3");
      expect(request.autoApproveEligible).toBe(true); // L3 + PASS + allowed action
    });

    it("rejects invalid input", async () => {
      const input = {
        // Missing required fields
        domain: "asi",
      } as CreateApprovalRequestInput;

      await expect(store.createRequest(input)).rejects.toThrow("FAIL CLOSED");
    });

    it("marks L4 requests as never auto-approvable", async () => {
      const input: CreateApprovalRequestInput = {
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "daily_ops_brief",
        requestedBy: "planner_agent",
        trustLevel: "L4",
        actionType: "COMMIT_POST_ALERT",
        actionPayload: { message: "Test alert" },
        reviewerVerdict: "PASS",
      };

      const request = await store.createRequest(input);

      expect(request.autoApproveEligible).toBe(false); // L4 can NEVER auto-approve
    });
  });

  describe("getRequest", () => {
    it("retrieves an existing request", async () => {
      const input: CreateApprovalRequestInput = {
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "test_workflow",
        requestedBy: "test_agent",
        trustLevel: "L3",
        actionType: "TEST_ACTION",
        actionPayload: {},
      };

      const created = await store.createRequest(input);
      const retrieved = await store.getRequest(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
    });

    it("returns null for non-existent request", async () => {
      const result = await store.getRequest(crypto.randomUUID());
      expect(result).toBeNull();
    });
  });

  describe("createDecision", () => {
    it("approves a pending request", async () => {
      const request = await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "test_workflow",
        requestedBy: "test_agent",
        trustLevel: "L3",
        actionType: "TEST_ACTION",
        actionPayload: {},
      });

      const decision = await store.createDecision({
        approvalRequestId: request.id,
        decidedBy: "human_reviewer",
        decision: "APPROVE",
        notes: "Looks good",
      });

      expect(decision.decision).toBe("APPROVE");
      expect(await store.isApproved(request.id)).toBe(true);
    });

    it("rejects deciding on already-decided request", async () => {
      const request = await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "test_workflow",
        requestedBy: "test_agent",
        trustLevel: "L3",
        actionType: "TEST_ACTION",
        actionPayload: {},
      });

      await store.createDecision({
        approvalRequestId: request.id,
        decidedBy: "reviewer1",
        decision: "APPROVE",
      });

      await expect(
        store.createDecision({
          approvalRequestId: request.id,
          decidedBy: "reviewer2",
          decision: "REJECT",
        })
      ).rejects.toThrow(); // Will throw either "already been made" or "status: APPROVED"
    });
  });

  describe("autoApprove", () => {
    it("auto-approves eligible L3 request with PASS verdict", async () => {
      const request = await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "daily_ops_brief",
        requestedBy: "test_agent",
        trustLevel: "L3",
        actionType: "COMMIT_POST_ALERT",
        actionPayload: {},
        reviewerVerdict: "PASS",
      });

      const decision = await store.autoApprove(request.id, "Auto test");

      expect(decision).not.toBeNull();
      expect(decision?.decidedBy).toBe("system:auto-approve");
      expect(await store.isApproved(request.id)).toBe(true);
    });

    it("blocks auto-approve for L4 requests", async () => {
      const request = await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "daily_ops_brief",
        requestedBy: "test_agent",
        trustLevel: "L4",
        actionType: "COMMIT_POST_ALERT",
        actionPayload: {},
        reviewerVerdict: "PASS",
      });

      const decision = await store.autoApprove(request.id, "Should fail");

      expect(decision).toBeNull();
      expect(await store.isPending(request.id)).toBe(true);
    });

    it("blocks auto-approve without reviewer PASS", async () => {
      const request = await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "daily_ops_brief",
        requestedBy: "test_agent",
        trustLevel: "L3",
        actionType: "COMMIT_POST_ALERT",
        actionPayload: {},
        // No reviewerVerdict
      });

      const decision = await store.autoApprove(request.id, "Should fail");

      expect(decision).toBeNull();
    });
  });

  describe("getPendingRequests", () => {
    it("returns only pending, non-expired requests", async () => {
      // Create a pending request
      await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "workflow1",
        requestedBy: "agent1",
        trustLevel: "L3",
        actionType: "ACTION1",
        actionPayload: {},
      });

      // Create and approve another request
      const approved = await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "workflow2",
        requestedBy: "agent2",
        trustLevel: "L3",
        actionType: "ACTION2",
        actionPayload: {},
      });
      await store.createDecision({
        approvalRequestId: approved.id,
        decidedBy: "reviewer",
        decision: "APPROVE",
      });

      const pending = await store.getPendingRequests();

      expect(pending.length).toBe(1);
      expect(pending[0].workflowName).toBe("workflow1");
    });

    it("filters by domain", async () => {
      await store.createRequest({
        domain: "asi",
        runId: crypto.randomUUID(),
        workflowName: "workflow1",
        requestedBy: "agent",
        trustLevel: "L3",
        actionType: "ACTION",
        actionPayload: {},
      });

      await store.createRequest({
        domain: "land",
        runId: crypto.randomUUID(),
        workflowName: "workflow2",
        requestedBy: "agent",
        trustLevel: "L3",
        actionType: "ACTION",
        actionPayload: {},
      });

      const asiPending = await store.getPendingRequests({ domain: "asi" });
      expect(asiPending.length).toBe(1);
      expect(asiPending[0].domain).toBe("asi");
    });
  });
});
