import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DIST_RUN_ENTRY = path.join(ROOT, "dist", "scripts", "run_skill.js");
export const DIST_TEST_ENTRY = path.join(ROOT, "dist", "scripts", "test_skill.js");
export const DIST_SCAN_ENTRY = path.join(ROOT, "dist", "scripts", "run_low_stock_scan.js");
export const DIST_SYNC_CRM_ENTRY = path.join(
  ROOT,
  "dist",
  "scripts",
  "sync_crm_from_openclaw.js",
);
export const FIXTURES_DIR = path.join(ROOT, "tests", "fixtures");

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "purr-suite-ts-"));
}

export function cleanupPath(target: string): void {
  rmSync(target, { recursive: true, force: true });
}

export function tempDbPath(name = "purr_suite_test.sqlite3"): string {
  return path.join(tempDir(), name);
}

export function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

export function loadFixture(nameOrPath: string): Record<string, unknown> {
  const resolved = path.isAbsolute(nameOrPath) ? nameOrPath : fixturePath(nameOrPath);
  return JSON.parse(readFileSync(resolved, "utf-8")) as Record<string, unknown>;
}

export function getAgentId(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT external_user_id FROM identities WHERE role = 'agent' AND is_active = 1 LIMIT 1",
      )
      .get() as { external_user_id: string } | undefined;
    return row?.external_user_id ?? "agent-001";
  } finally {
    db.close();
  }
}

function injectAgentId(dbPath: string, payload: Record<string, unknown>): void {
  const user =
    payload.user !== null &&
    payload.user !== undefined &&
    typeof payload.user === "object" &&
    !Array.isArray(payload.user)
      ? (payload.user as Record<string, unknown>)
      : null;
  if (user?.external_user_id === "agent-001") {
    user.external_user_id = getAgentId(dbPath);
  }
}

export function runCommand(
  command: string[],
  options: { inputText?: string } = {},
): CommandResult {
  const result: SpawnSyncReturns<string> = spawnSync(command[0]!, command.slice(1), {
    cwd: ROOT,
    encoding: "utf-8",
    env: process.env,
    input: options.inputText,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runTestEntry(
  skill: string,
  fixture: string,
  dbPath: string,
): Record<string, unknown> {
  const payload = loadFixture(path.isAbsolute(fixture) ? fixture : fixturePath(fixture));
  injectAgentId(dbPath, payload);

  const tmpdir = tempDir();
  const tempFixture = path.join(tmpdir, "fixture.json");
  writeFileSync(tempFixture, JSON.stringify(payload), "utf-8");
  const result = runCommand([
    "node",
    DIST_TEST_ENTRY,
    "--skill",
    skill,
    "--fixture",
    tempFixture,
    "--db-path",
    dbPath,
  ]);
  cleanupPath(tmpdir);
  if (result.status !== 0) {
    throw new Error(`test_skill failed: ${result.stdout || result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function runProdEntry(
  skill: string,
  payloadOrFixture: Record<string, unknown> | string,
  dbPath: string,
): Record<string, unknown> {
  const payload =
    typeof payloadOrFixture === "string" ? loadFixture(payloadOrFixture) : structuredClone(payloadOrFixture);
  injectAgentId(dbPath, payload);
  if (
    payload.runtime === null ||
    payload.runtime === undefined ||
    typeof payload.runtime !== "object" ||
    Array.isArray(payload.runtime)
  ) {
    payload.runtime = {};
  }
  (payload.runtime as Record<string, unknown>).db_path = dbPath;

  const result = runCommand(["node", DIST_RUN_ENTRY, "--skill", skill], {
    inputText: JSON.stringify(payload),
  });
  if (result.status !== 0) {
    throw new Error(`run_skill failed: ${result.stdout || result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function runWithoutCheck(
  command: string[],
  options: { inputText?: string } = {},
): CommandResult {
  return runCommand(command, options);
}

export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}
