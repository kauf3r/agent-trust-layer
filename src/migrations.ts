/**
 * Agent Trust Layer - SQL Migrations
 *
 * Provides programmatic access to SQL migration files for database setup.
 *
 * @example
 * ```typescript
 * import { getMigrationPaths, MIGRATIONS } from '@andykaufman/agent-trust-layer/migrations';
 *
 * // Get all migration paths in order
 * const paths = getMigrationPaths();
 *
 * // Access specific migrations
 * console.log(MIGRATIONS.AGENT_ACTION_EVENTS);
 * ```
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to migrations directory (relative to dist)
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Migration file identifiers
 */
export const MIGRATIONS = {
  AGENT_ACTION_EVENTS: '001_agent_action_events.sql',
  EVAL_RUNS: '002_eval_runs.sql',
  APPROVAL_REQUESTS: '003_approval_requests.sql',
  APPROVAL_DECISIONS: '004_approval_decisions.sql',
} as const;

/**
 * Ordered list of all migrations
 */
export const MIGRATION_ORDER = [
  MIGRATIONS.AGENT_ACTION_EVENTS,
  MIGRATIONS.EVAL_RUNS,
  MIGRATIONS.APPROVAL_REQUESTS,
  MIGRATIONS.APPROVAL_DECISIONS,
] as const;

/**
 * Get the directory path containing migration files
 */
export function getMigrationsDir(): string {
  return MIGRATIONS_DIR;
}

/**
 * Get full paths to all migration files in correct order
 */
export function getMigrationPaths(): string[] {
  return MIGRATION_ORDER.map((file) => join(MIGRATIONS_DIR, file));
}

/**
 * Get the full path to a specific migration file
 */
export function getMigrationPath(
  migration: (typeof MIGRATIONS)[keyof typeof MIGRATIONS]
): string {
  return join(MIGRATIONS_DIR, migration);
}

/**
 * Read the SQL content of a migration file
 */
export function readMigration(
  migration: (typeof MIGRATIONS)[keyof typeof MIGRATIONS]
): string {
  const path = getMigrationPath(migration);
  if (!existsSync(path)) {
    throw new Error(`Migration file not found: ${path}`);
  }
  return readFileSync(path, 'utf-8');
}

/**
 * Read all migrations as an array of { name, sql } objects
 */
export function readAllMigrations(): Array<{ name: string; sql: string }> {
  return MIGRATION_ORDER.map((name) => ({
    name,
    sql: readMigration(name),
  }));
}

/**
 * Check if all migration files exist
 */
export function validateMigrations(): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];

  for (const file of MIGRATION_ORDER) {
    const path = join(MIGRATIONS_DIR, file);
    if (!existsSync(path)) {
      missing.push(file);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}
