import { describe, it, expect } from "vitest";
import { VERSION, ATL_CONFIG, initATL } from "../index.js";

describe("Agent Trust Layer", () => {
  describe("exports", () => {
    it("exports VERSION constant", () => {
      expect(VERSION).toBe("0.1.0");
    });

    it("exports ATL_CONFIG with correct structure", () => {
      expect(ATL_CONFIG).toEqual({
        name: "@andykaufman/agent-trust-layer",
        version: "0.1.0",
        description: "Security and governance framework for AI agent operations",
      });
    });
  });

  describe("initATL", () => {
    it("initializes with default config when no options provided", () => {
      const result = initATL();

      expect(result.ready).toBe(true);
      expect(result.config).toEqual({
        trustThreshold: 3,
        sandboxMode: false,
        logger: { enabled: true, destination: "console" },
      });
    });

    it("respects custom trust threshold", () => {
      const result = initATL({ trustThreshold: 5 });

      expect(result.config.trustThreshold).toBe(5);
    });

    it("enables sandbox mode when specified", () => {
      const result = initATL({ sandboxMode: true });

      expect(result.config.sandboxMode).toBe(true);
    });

    it("accepts custom logger configuration", () => {
      const result = initATL({
        logger: { enabled: true, destination: "supabase" },
      });

      expect(result.config.logger).toEqual({
        enabled: true,
        destination: "supabase",
      });
    });
  });
});
