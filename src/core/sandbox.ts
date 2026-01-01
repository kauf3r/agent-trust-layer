/**
 * Docker Sandbox - Isolated Execution Environment for L2+ Operations
 *
 * The sandbox provides process isolation for SANDBOX_WRITE (L2) and COMMIT (L3+) tools.
 * All operations that modify state run in a Docker container with:
 * - No access to production secrets
 * - No network egress (default)
 * - Resource limits (CPU, memory, timeout)
 * - Artifact collection for review
 *
 * @example
 * ```typescript
 * const sandbox = new DockerSandbox({
 *   image: "node:20-alpine",
 *   memoryLimit: "512m",
 *   cpuLimit: "1.0",
 *   timeoutSeconds: 300,
 * });
 *
 * const result = await sandbox.execute({
 *   runId: "uuid",
 *   toolName: "asi.stage_booking_create",
 *   toolArgs: { resource_id: "...", start: "...", end: "..." },
 *   handler: async (args) => { ... },
 * });
 *
 * if (result.success) {
 *   console.log("Artifacts:", result.artifacts);
 * }
 * ```
 */

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

// =============================================================================
// Security Constants
// =============================================================================

/**
 * Environment variables that must NEVER be passed to sandbox containers.
 * These could leak production secrets if mounted.
 *
 * FAIL CLOSED: If any of these are in allowedEnvVars, sandbox refuses to start.
 */
const BLOCKED_ENV_VARS: Set<string> = new Set([
  // API Keys & Secrets
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_KEY",
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",

  // Auth & OAuth
  "JWT_SECRET",
  "SESSION_SECRET",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "OFFICERND_CLIENT_SECRET",

  // Cloud Provider Credentials
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_CLIENT_SECRET",
  "GCP_SERVICE_ACCOUNT_KEY",
  "DIGITALOCEAN_TOKEN",

  // Payment & Billing
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",

  // Email & Messaging
  "SENDGRID_API_KEY",
  "SLACK_BOT_TOKEN",
  "TWILIO_AUTH_TOKEN",

  // Generic Secret Patterns
  "SECRET",
  "PASSWORD",
  "PRIVATE_KEY",
  "API_KEY",
]);

/**
 * Reasons why sandbox execution might fail.
 * Used for explicit fail-closed logging.
 */
export type SandboxFailureReason =
  | "DOCKER_NOT_AVAILABLE"
  | "DOCKER_NOT_RUNNING"
  | "IMAGE_PULL_FAILED"
  | "BLOCKED_ENV_VAR_REQUESTED"
  | "INVALID_INPUT"
  | "NETWORK_ALLOWLIST_INVALID"
  | "ARTIFACTS_DIR_CREATION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "CONTAINER_STARTUP_FAILED"
  | "UNKNOWN_ERROR";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Sandbox configuration loaded from config/trust/global.yaml
 */
export interface SandboxConfig {
  /** Docker image to use */
  image: string;
  /** Memory limit (e.g., "512m") */
  memoryLimit: string;
  /** CPU limit (e.g., "1.0") */
  cpuLimit: string;
  /** Execution timeout in seconds */
  timeoutSeconds: number;
  /** Network egress allowed */
  egressAllowed: boolean;
  /** Allowed network destinations (if egress allowed) */
  egressAllowlist: string[];
  /** Environment variables to pass to container */
  allowedEnvVars: string[];
  /** Artifacts output directory */
  artifactsDir: string;
  /** Max artifacts size in MB */
  maxArtifactsSizeMb: number;

  // =========================================================================
  // Fail-Closed Configuration
  // =========================================================================

  /**
   * If true, sandbox will DENY execution when Docker is unavailable.
   * If false, falls back to direct execution (DANGEROUS - only for dev).
   *
   * Default: true (fail closed)
   */
  failClosedOnDockerUnavailable: boolean;

  /**
   * If true, logs detailed security events to console.
   * Useful for debugging but may leak info in production logs.
   *
   * Default: false
   */
  verboseSecurityLogging: boolean;
}

/**
 * Default sandbox configuration
 *
 * SECURITY: Defaults are set for MAXIMUM SECURITY (fail closed).
 * Override only with explicit justification.
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  image: "node:20-alpine",
  memoryLimit: "512m",
  cpuLimit: "1.0",
  timeoutSeconds: 300,
  egressAllowed: false,
  egressAllowlist: [],
  allowedEnvVars: ["NODE_ENV", "TZ"],
  artifactsDir: "/tmp/sandbox-artifacts",
  maxArtifactsSizeMb: 100,

  // FAIL CLOSED by default
  failClosedOnDockerUnavailable: true,
  verboseSecurityLogging: false,
};

// =============================================================================
// Types
// =============================================================================

/**
 * Input for sandbox execution
 */
export interface SandboxExecutionInput {
  /** Unique ID for this sandbox execution */
  sandboxId?: string;
  /** Workflow run ID (for correlation) */
  runId: string;
  /** Tool being executed */
  toolName: string;
  /** Tool arguments */
  toolArgs: Record<string, unknown>;
  /** The handler function to execute */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Result of sandbox execution
 */
export interface SandboxExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Result from the handler (if successful) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Unique sandbox ID */
  sandboxId: string;
  /** Artifacts collected during execution */
  artifacts: string[];
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether timeout was hit */
  timedOut: boolean;
  /** Container exit code */
  exitCode?: number;
  /** stdout from container */
  stdout?: string;
  /** stderr from container */
  stderr?: string;

  // =========================================================================
  // Fail-Closed Metadata
  // =========================================================================

  /**
   * If execution failed due to sandbox security policy, this contains
   * the specific reason. Useful for debugging and audit logs.
   */
  failureReason?: SandboxFailureReason;

  /**
   * Whether execution was denied due to fail-closed policy.
   * If true, the handler was NEVER executed.
   */
  deniedByPolicy?: boolean;
}

/**
 * Staged changes from sandbox execution
 */
export interface StagedChange {
  /** Unique change ID */
  id: string;
  /** Sandbox ID that created this change */
  sandboxId: string;
  /** Tool that created the change */
  toolName: string;
  /** Type of change */
  changeType: "create" | "update" | "delete";
  /** Target entity type */
  entityType: string;
  /** Target entity ID */
  entityId?: string;
  /** Change payload */
  payload: Record<string, unknown>;
  /** Timestamp */
  createdAt: Date;
}

// =============================================================================
// Sandbox Interface
// =============================================================================

/**
 * Sandbox interface for isolated execution
 */
export interface Sandbox {
  /**
   * Execute a function in sandboxed environment
   * @param input - Execution input including handler function
   * @returns Promise with execution result
   */
  execute(input: SandboxExecutionInput): Promise<SandboxExecutionResult>;

  /**
   * Get staged changes from a sandbox execution
   * @param sandboxId - Sandbox ID to query
   */
  getStagedChanges(sandboxId: string): Promise<StagedChange[]>;

  /**
   * Commit staged changes (apply to production)
   * @param sandboxId - Sandbox ID whose changes to commit
   */
  commitChanges(sandboxId: string): Promise<void>;

  /**
   * Rollback staged changes (discard them)
   * @param sandboxId - Sandbox ID whose changes to rollback
   */
  rollbackChanges(sandboxId: string): Promise<void>;

  /**
   * Cleanup artifacts and temporary files
   * @param sandboxId - Sandbox ID to cleanup
   */
  cleanup(sandboxId: string): Promise<void>;
}

// =============================================================================
// Docker Sandbox Implementation
// =============================================================================

/**
 * DockerSandbox provides isolated execution via Docker containers
 *
 * SECURITY: This class implements FAIL CLOSED semantics.
 * - Invalid inputs = DENY
 * - Blocked env vars = DENY
 * - Docker unavailable = DENY (unless explicitly overridden)
 * - Network egress = DENY by default
 */
export class DockerSandbox implements Sandbox {
  private config: SandboxConfig;
  private stagedChanges: Map<string, StagedChange[]> = new Map();
  private dockerAvailabilityCache: boolean | null = null;
  private dockerAvailabilityCacheTime: number = 0;
  private static readonly DOCKER_CACHE_TTL_MS = 30000; // 30 seconds

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };

    // FAIL CLOSED: Validate config doesn't include blocked env vars
    const blockedFound = this.config.allowedEnvVars.filter((v) =>
      this.isBlockedEnvVar(v)
    );
    if (blockedFound.length > 0) {
      throw new Error(
        `FAIL CLOSED: SandboxConfig includes blocked environment variables: ${blockedFound.join(", ")}`
      );
    }
  }

  /**
   * Check if an environment variable is blocked
   */
  private isBlockedEnvVar(envVar: string): boolean {
    // Direct match
    if (BLOCKED_ENV_VARS.has(envVar)) return true;

    // Pattern match (contains SECRET, PASSWORD, KEY, etc.)
    const upper = envVar.toUpperCase();
    if (upper.includes("SECRET")) return true;
    if (upper.includes("PASSWORD")) return true;
    if (upper.includes("PRIVATE_KEY")) return true;
    if (upper.endsWith("_KEY") && upper.includes("API")) return true;

    return false;
  }

  /**
   * Create a fail-closed result
   */
  private createFailClosedResult(
    sandboxId: string,
    reason: SandboxFailureReason,
    error: string,
    startTime: number
  ): SandboxExecutionResult {
    if (this.config.verboseSecurityLogging) {
      console.error(`[Sandbox FAIL CLOSED] ${reason}: ${error}`);
    }

    return {
      success: false,
      error: `FAIL CLOSED: ${error}`,
      sandboxId,
      artifacts: [],
      durationMs: Math.round(performance.now() - startTime),
      timedOut: false,
      failureReason: reason,
      deniedByPolicy: true,
    };
  }

  /**
   * Validate sandbox execution input
   */
  private validateInput(input: SandboxExecutionInput): string | undefined {
    if (!input) {
      return "Input is null or undefined";
    }
    if (!input.runId || typeof input.runId !== "string") {
      return "Input missing required 'runId' field";
    }
    if (!input.toolName || typeof input.toolName !== "string") {
      return "Input missing required 'toolName' field";
    }
    if (!input.handler || typeof input.handler !== "function") {
      return "Input missing required 'handler' function";
    }
    if (input.toolArgs && typeof input.toolArgs !== "object") {
      return "Input 'toolArgs' must be an object";
    }
    return undefined;
  }

  /**
   * Execute handler in Docker container
   *
   * IMPORTANT: This method implements FAIL CLOSED semantics.
   * The handler is NEVER executed outside a sandbox unless
   * failClosedOnDockerUnavailable is explicitly set to false.
   */
  async execute(input: SandboxExecutionInput): Promise<SandboxExecutionResult> {
    const sandboxId = input.sandboxId ?? `sandbox-${randomUUID()}`;
    const startTime = performance.now();

    // =========================================================================
    // FAIL CLOSED: Validate input
    // =========================================================================
    const inputError = this.validateInput(input);
    if (inputError) {
      return this.createFailClosedResult(
        sandboxId,
        "INVALID_INPUT",
        inputError,
        startTime
      );
    }

    // =========================================================================
    // FAIL CLOSED: Create artifacts directory
    // =========================================================================
    const artifactsPath = path.join(this.config.artifactsDir, sandboxId);
    try {
      await fs.mkdir(artifactsPath, { recursive: true });
    } catch (error) {
      return this.createFailClosedResult(
        sandboxId,
        "ARTIFACTS_DIR_CREATION_FAILED",
        `Failed to create artifacts directory: ${error instanceof Error ? error.message : String(error)}`,
        startTime
      );
    }

    try {
      // Execute with isolation (Docker or fail-closed fallback)
      const result = await this.executeWithIsolation(input, sandboxId, artifactsPath);

      // If denied by policy, return immediately
      if (result.deniedByPolicy) {
        return result;
      }

      // Collect artifacts
      const artifacts = await this.collectArtifacts(artifactsPath);

      return {
        success: result.success,
        result: result.result,
        error: result.error,
        sandboxId,
        artifacts,
        durationMs: Math.round(performance.now() - startTime),
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        failureReason: result.failureReason,
        deniedByPolicy: result.deniedByPolicy,
      };
    } catch (error) {
      return {
        success: false,
        error: `FAIL CLOSED: Unexpected error - ${error instanceof Error ? error.message : String(error)}`,
        sandboxId,
        artifacts: [],
        durationMs: Math.round(performance.now() - startTime),
        timedOut: false,
        failureReason: "UNKNOWN_ERROR",
        deniedByPolicy: true,
      };
    }
  }

  /**
   * Execute with isolation (Docker or fail-closed fallback)
   *
   * IMPORTANT: When Docker is unavailable and failClosedOnDockerUnavailable is true,
   * this method returns a DENY result and the handler is NEVER executed.
   */
  private async executeWithIsolation(
    input: SandboxExecutionInput,
    sandboxId: string,
    artifactsPath: string
  ): Promise<SandboxExecutionResult> {
    const startTime = performance.now();

    // Check if Docker is available (with caching)
    const dockerAvailable = await this.isDockerAvailable();

    if (dockerAvailable) {
      // Execute in Docker with full isolation
      const result = await this.executeInDocker(input, sandboxId, artifactsPath);
      return {
        ...result,
        sandboxId,
        artifacts: [],
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    // =========================================================================
    // FAIL CLOSED: Docker not available
    // =========================================================================
    if (this.config.failClosedOnDockerUnavailable) {
      // Log why we're failing closed
      const reason = await this.diagnoseDockerUnavailability();

      console.error(
        `[Sandbox FAIL CLOSED] Docker unavailable for sandbox ${sandboxId}. ` +
        `Reason: ${reason}. Handler was NOT executed.`
      );

      return {
        success: false,
        error: `FAIL CLOSED: Docker unavailable - ${reason}. ` +
               `Sandboxed execution is required for L2+ operations.`,
        sandboxId,
        artifacts: [],
        durationMs: Math.round(performance.now() - startTime),
        timedOut: false,
        failureReason: reason === "Docker daemon is not running"
          ? "DOCKER_NOT_RUNNING"
          : "DOCKER_NOT_AVAILABLE",
        deniedByPolicy: true,
      };
    }

    // =========================================================================
    // FALLBACK (DANGEROUS): Direct execution without isolation
    // Only used when failClosedOnDockerUnavailable is explicitly false
    // =========================================================================
    console.warn(
      `[Sandbox WARNING] Docker not available, falling back to UNSAFE direct execution for ${sandboxId}. ` +
      `This should ONLY happen in development!`
    );

    const directResult = await this.executeDirectly(input, sandboxId);
    return {
      ...directResult,
      sandboxId,
      artifacts: [],
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  /**
   * Diagnose why Docker is unavailable
   */
  private async diagnoseDockerUnavailability(): Promise<string> {
    try {
      // Try to run docker version
      const result = await this.runCommand("docker", ["version"]);

      if (result.exitCode !== 0) {
        if (result.stderr.includes("Cannot connect to the Docker daemon")) {
          return "Docker daemon is not running";
        }
        if (result.stderr.includes("command not found") || result.stderr.includes("not found")) {
          return "Docker is not installed";
        }
        if (result.stderr.includes("permission denied")) {
          return "Permission denied to access Docker socket";
        }
        return `Docker error: ${result.stderr.slice(0, 100)}`;
      }

      return "Unknown Docker issue";
    } catch (error) {
      return `Docker check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Check if Docker is available (with caching to avoid repeated calls)
   */
  private async isDockerAvailable(): Promise<boolean> {
    const now = Date.now();

    // Use cached result if available and not expired
    if (
      this.dockerAvailabilityCache !== null &&
      now - this.dockerAvailabilityCacheTime < DockerSandbox.DOCKER_CACHE_TTL_MS
    ) {
      return this.dockerAvailabilityCache;
    }

    try {
      const result = await this.runCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
      this.dockerAvailabilityCache = result.exitCode === 0;
      this.dockerAvailabilityCacheTime = now;
      return this.dockerAvailabilityCache;
    } catch {
      this.dockerAvailabilityCache = false;
      this.dockerAvailabilityCacheTime = now;
      return false;
    }
  }

  /**
   * Execute in Docker container with maximum security isolation
   */
  private async executeInDocker(
    input: SandboxExecutionInput,
    sandboxId: string,
    artifactsPath: string
  ): Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    timedOut: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    failureReason?: SandboxFailureReason;
    deniedByPolicy?: boolean;
  }> {
    // =========================================================================
    // Build Docker run command with MAXIMUM SECURITY isolation
    // =========================================================================
    const args: string[] = [
      "run",
      "--rm",                                    // Remove container after exit
      "--name", sandboxId,                       // Named for tracking/cleanup

      // Resource Limits
      "--memory", this.config.memoryLimit,       // Memory limit
      "--cpus", this.config.cpuLimit,            // CPU limit
      "--pids-limit", "100",                     // Limit number of processes

      // Filesystem Isolation
      "--read-only",                             // Read-only root filesystem
      "--tmpfs", "/tmp:size=64m,noexec,nosuid",  // Temp with no exec
      "-v", `${artifactsPath}:/artifacts:rw`,    // Artifacts output only

      // Security Hardening
      "--security-opt", "no-new-privileges",    // Prevent privilege escalation
      "--cap-drop", "ALL",                      // Drop ALL capabilities
      "--user", "nobody",                       // Run as nobody (non-root)
    ];

    // Network Isolation (DENY by default)
    if (!this.config.egressAllowed) {
      args.push("--network", "none");
    } else if (this.config.egressAllowlist.length > 0) {
      // If egress is allowed with allowlist, we'd need to set up iptables rules
      // For now, log a warning that allowlisting isn't fully implemented
      console.warn(
        `[Sandbox] Network egress allowlist not fully implemented. ` +
        `Using full network access for ${sandboxId}.`
      );
    }

    // Environment variables (filtered through blocklist)
    for (const envVar of this.config.allowedEnvVars) {
      // Double-check against blocklist (should have been caught in constructor)
      if (this.isBlockedEnvVar(envVar)) {
        console.error(`[Sandbox] BLOCKED: Attempted to pass blocked env var: ${envVar}`);
        continue;
      }

      const value = process.env[envVar];
      if (value) {
        args.push("-e", `${envVar}=${value}`);
      }
    }

    // Image and command
    args.push(this.config.image);
    args.push("node", "-e", this.buildExecutionScript(input));

    // Execute with timeout
    try {
      const result = await this.runCommandWithTimeout(
        "docker",
        args,
        this.config.timeoutSeconds * 1000
      );

      // Parse result from stdout
      let parsedResult: unknown;
      let success = result.exitCode === 0;
      let error: string | undefined;

      if (result.stdout) {
        try {
          const output = JSON.parse(result.stdout);
          parsedResult = output.result;
          error = output.error;
          success = output.success ?? success;
        } catch {
          parsedResult = result.stdout;
        }
      }

      if (result.stderr && !error) {
        error = result.stderr;
      }

      return {
        success,
        result: parsedResult,
        error,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }
  }

  /**
   * Build the execution script to run in container
   */
  private buildExecutionScript(input: SandboxExecutionInput): string {
    // Serialize the handler and args for execution
    // In practice, this would be more sophisticated
    const script = `
      const args = ${JSON.stringify(input.toolArgs)};
      const toolName = "${input.toolName}";

      async function main() {
        try {
          // Tool handler would be injected here
          // For now, we just return the args as a placeholder
          const result = { staged: true, toolName, args };
          console.log(JSON.stringify({ success: true, result }));
        } catch (error) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        }
      }

      main();
    `;
    return script;
  }

  /**
   * Execute directly without Docker (DANGEROUS fallback)
   *
   * WARNING: This bypasses sandbox isolation. Only used when
   * failClosedOnDockerUnavailable is explicitly set to false.
   */
  private async executeDirectly(
    input: SandboxExecutionInput,
    sandboxId: string
  ): Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    timedOut: boolean;
    exitCode?: number;
    failureReason?: SandboxFailureReason;
    deniedByPolicy?: boolean;
  }> {
    try {
      // Execute with timeout
      const timeoutMs = this.config.timeoutSeconds * 1000;
      const result = await Promise.race([
        input.handler(input.toolArgs),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Execution timeout")), timeoutMs)
        ),
      ]);

      // Store staged changes
      this.storeStage(sandboxId, input, result);

      return {
        success: true,
        result,
        timedOut: false,
        exitCode: 0,
        deniedByPolicy: false,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.message === "Execution timeout";
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timedOut: isTimeout,
        exitCode: isTimeout ? 124 : 1,
        failureReason: isTimeout ? "EXECUTION_TIMEOUT" : undefined,
        deniedByPolicy: false,
      };
    }
  }

  /**
   * Store staged change for later commit
   */
  private storeStage(
    sandboxId: string,
    input: SandboxExecutionInput,
    result: unknown
  ): void {
    const change: StagedChange = {
      id: randomUUID(),
      sandboxId,
      toolName: input.toolName,
      changeType: "create", // Determine from tool name or result
      entityType: this.inferEntityType(input.toolName),
      payload: {
        args: input.toolArgs,
        result,
      },
      createdAt: new Date(),
    };

    const existing = this.stagedChanges.get(sandboxId) ?? [];
    existing.push(change);
    this.stagedChanges.set(sandboxId, existing);
  }

  /**
   * Infer entity type from tool name
   */
  private inferEntityType(toolName: string): string {
    if (toolName.includes("booking")) return "booking";
    if (toolName.includes("flight")) return "flight";
    if (toolName.includes("event")) return "event";
    if (toolName.includes("brief")) return "brief";
    if (toolName.includes("alert")) return "alert";
    return "unknown";
  }

  /**
   * Run a command
   */
  private runCommand(
    command: string,
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args);
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      proc.on("error", () => {
        resolve({ exitCode: 1, stdout: "", stderr: "Command failed" });
      });
    });
  }

  /**
   * Run a command with timeout
   */
  private runCommandWithTimeout(
    command: string,
    args: string[],
    timeoutMs: number
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args);
      let stdout = "";
      let stderr = "";
      let killed = false;

      const timeout = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, timeoutMs);

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timeout);
        resolve({
          exitCode: exitCode ?? (killed ? 124 : 1),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut: killed,
        });
      });

      proc.on("error", () => {
        clearTimeout(timeout);
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Command failed",
          timedOut: false,
        });
      });
    });
  }

  /**
   * Collect artifacts from sandbox execution
   */
  private async collectArtifacts(artifactsPath: string): Promise<string[]> {
    try {
      const files = await fs.readdir(artifactsPath);
      return files.map((f) => path.join(artifactsPath, f));
    } catch {
      return [];
    }
  }

  /**
   * Get staged changes from a sandbox execution
   */
  async getStagedChanges(sandboxId: string): Promise<StagedChange[]> {
    return this.stagedChanges.get(sandboxId) ?? [];
  }

  /**
   * Commit staged changes (apply to production)
   */
  async commitChanges(sandboxId: string): Promise<void> {
    const changes = this.stagedChanges.get(sandboxId);
    if (!changes || changes.length === 0) {
      console.warn(`[Sandbox] No staged changes to commit for ${sandboxId}`);
      return;
    }

    // In production, this would apply the changes to the actual database
    console.log(
      `[Sandbox] Committing ${changes.length} changes from ${sandboxId}`
    );

    // Clear staged changes after commit
    this.stagedChanges.delete(sandboxId);
  }

  /**
   * Rollback staged changes (discard them)
   */
  async rollbackChanges(sandboxId: string): Promise<void> {
    const changes = this.stagedChanges.get(sandboxId);
    if (changes && changes.length > 0) {
      console.log(
        `[Sandbox] Rolling back ${changes.length} changes from ${sandboxId}`
      );
    }

    // Clear staged changes
    this.stagedChanges.delete(sandboxId);
  }

  /**
   * Cleanup artifacts and temporary files
   */
  async cleanup(sandboxId: string): Promise<void> {
    // Clear staged changes
    this.stagedChanges.delete(sandboxId);

    // Remove artifacts directory
    const artifactsPath = path.join(this.config.artifactsDir, sandboxId);
    try {
      await fs.rm(artifactsPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// =============================================================================
// Fail-Closed Sandbox (Production Default When Docker Unavailable)
// =============================================================================

/**
 * FailClosedSandbox ALWAYS denies execution.
 *
 * Use this when you need a sandbox instance but want to guarantee
 * that no code ever executes. This is the safest fallback.
 */
export class FailClosedSandbox implements Sandbox {
  private readonly reason: string;

  constructor(reason: string = "Sandbox execution is disabled") {
    this.reason = reason;
  }

  async execute(input: SandboxExecutionInput): Promise<SandboxExecutionResult> {
    const sandboxId = input.sandboxId ?? `fail-closed-${randomUUID()}`;

    console.error(
      `[FailClosedSandbox] DENIED execution of ${input.toolName}: ${this.reason}`
    );

    return {
      success: false,
      error: `FAIL CLOSED: ${this.reason}`,
      sandboxId,
      artifacts: [],
      durationMs: 0,
      timedOut: false,
      failureReason: "DOCKER_NOT_AVAILABLE",
      deniedByPolicy: true,
    };
  }

  async getStagedChanges(_sandboxId: string): Promise<StagedChange[]> {
    return [];
  }

  async commitChanges(_sandboxId: string): Promise<void> {
    throw new Error("FAIL CLOSED: Cannot commit changes in fail-closed sandbox");
  }

  async rollbackChanges(_sandboxId: string): Promise<void> {
    // No-op: nothing to rollback
  }

  async cleanup(_sandboxId: string): Promise<void> {
    // No-op: nothing to cleanup
  }
}

// =============================================================================
// Passthrough Sandbox (Development/Testing ONLY)
// =============================================================================

/**
 * PassthroughSandbox executes directly without isolation.
 *
 * WARNING: This bypasses ALL sandbox security. Use ONLY for:
 * - Unit tests
 * - Local development with NODE_ENV=development
 *
 * NEVER use in production.
 */
export class PassthroughSandbox implements Sandbox {
  private stagedChanges: Map<string, StagedChange[]> = new Map();

  constructor() {
    // Log a warning if not in development
    if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
      console.warn(
        "[PassthroughSandbox] WARNING: Using passthrough sandbox outside of development/test. " +
        "This bypasses ALL sandbox security!"
      );
    }
  }

  async execute(input: SandboxExecutionInput): Promise<SandboxExecutionResult> {
    const sandboxId = input.sandboxId ?? `passthrough-${randomUUID()}`;
    const startTime = performance.now();

    try {
      const result = await input.handler(input.toolArgs);

      // Store staged change
      this.stagedChanges.set(sandboxId, [
        {
          id: randomUUID(),
          sandboxId,
          toolName: input.toolName,
          changeType: "create",
          entityType: "unknown",
          payload: { args: input.toolArgs, result },
          createdAt: new Date(),
        },
      ]);

      return {
        success: true,
        result,
        sandboxId,
        artifacts: [],
        durationMs: Math.round(performance.now() - startTime),
        timedOut: false,
        exitCode: 0,
        deniedByPolicy: false,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sandboxId,
        artifacts: [],
        durationMs: Math.round(performance.now() - startTime),
        timedOut: false,
        exitCode: 1,
        deniedByPolicy: false,
      };
    }
  }

  async getStagedChanges(sandboxId: string): Promise<StagedChange[]> {
    return this.stagedChanges.get(sandboxId) ?? [];
  }

  async commitChanges(sandboxId: string): Promise<void> {
    this.stagedChanges.delete(sandboxId);
  }

  async rollbackChanges(sandboxId: string): Promise<void> {
    this.stagedChanges.delete(sandboxId);
  }

  async cleanup(sandboxId: string): Promise<void> {
    this.stagedChanges.delete(sandboxId);
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a sandbox based on environment and configuration
 *
 * Decision tree:
 * 1. If NODE_ENV=test → PassthroughSandbox (for unit tests)
 * 2. If NODE_ENV=development AND SANDBOX_ENABLED=false → PassthroughSandbox
 * 3. If SANDBOX_FAIL_CLOSED=true (or production) → DockerSandbox (will fail closed if Docker unavailable)
 * 4. Otherwise → DockerSandbox with fallback allowed
 *
 * @param config - Optional sandbox configuration
 * @returns Sandbox instance
 */
export function createSandbox(config?: Partial<SandboxConfig>): Sandbox {
  const nodeEnv = process.env.NODE_ENV;
  const sandboxEnabled = process.env.SANDBOX_ENABLED !== "false";
  const failClosed = process.env.SANDBOX_FAIL_CLOSED === "true";

  // Test environment: always use passthrough
  if (nodeEnv === "test") {
    return new PassthroughSandbox();
  }

  // Development with sandbox disabled: use passthrough
  if (nodeEnv === "development" && !sandboxEnabled) {
    return new PassthroughSandbox();
  }

  // Production or explicit fail-closed: Docker sandbox with fail-closed
  if (nodeEnv === "production" || failClosed) {
    return new DockerSandbox({
      ...config,
      failClosedOnDockerUnavailable: true,
    });
  }

  // Development with sandbox enabled: Docker with fallback allowed
  if (nodeEnv === "development" && sandboxEnabled) {
    return new DockerSandbox({
      ...config,
      failClosedOnDockerUnavailable: false,
      verboseSecurityLogging: true,
    });
  }

  // Default: fail closed (safest option)
  return new DockerSandbox({
    ...config,
    failClosedOnDockerUnavailable: true,
  });
}

/**
 * Create a Docker sandbox explicitly
 *
 * @param config - Sandbox configuration (failClosedOnDockerUnavailable defaults to true)
 */
export function createDockerSandbox(config?: Partial<SandboxConfig>): DockerSandbox {
  return new DockerSandbox(config);
}

/**
 * Create a passthrough sandbox explicitly
 *
 * WARNING: Only use for unit tests!
 */
export function createPassthroughSandbox(): PassthroughSandbox {
  return new PassthroughSandbox();
}

/**
 * Create a fail-closed sandbox that ALWAYS denies execution
 *
 * Use when you need a sandbox instance but want to guarantee
 * that no code ever executes.
 *
 * @param reason - Reason to include in denial messages
 */
export function createFailClosedSandbox(reason?: string): FailClosedSandbox {
  return new FailClosedSandbox(reason);
}
