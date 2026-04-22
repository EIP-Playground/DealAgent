import BetterSqlite3 from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  isInstalledSkillPackageRoot,
  resolveDefaultDbPath,
  resolveLegacyInstalledDbPath,
  resolveSkillDataRoot,
  resolveSkillPackageRoot,
} from "../lib/paths.js";
import { parseJson, stableStringify } from "../lib/json.js";

export type SqliteDatabase = BetterSqlite3.Database;
export type SqliteRow = Record<string, unknown>;
export type SqlParams = readonly unknown[] | Record<string, unknown>;

const SKILL_PACKAGE_ROOT = resolveSkillPackageRoot(import.meta.url);

export const PROJECT_ROOT = SKILL_PACKAGE_ROOT;
export const DATA_ROOT = resolveSkillDataRoot(PROJECT_ROOT);
export const DEFAULT_DB_PATH = resolveDefaultDbPath(PROJECT_ROOT);
export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "scripts", "db", "migrations");
export const CALLER_AUTH_IDENTITY_MODEL = "caller_identity";

export function resolveMigrationsDir(skillPackageRoot: string): string {
  return path.join(path.resolve(skillPackageRoot), "scripts", "db", "migrations");
}

export function ensureResolvedDefaultDbPath(skillPackageRoot: string): string {
  const resolvedRoot = path.resolve(skillPackageRoot);
  const defaultDbPath = resolveDefaultDbPath(resolvedRoot);
  if (!isInstalledSkillPackageRoot(resolvedRoot) || existsSync(defaultDbPath)) {
    return defaultDbPath;
  }

  const legacyDbPath = resolveLegacyInstalledDbPath(resolvedRoot);
  if (!existsSync(legacyDbPath)) {
    return defaultDbPath;
  }

  mkdirSync(path.dirname(defaultDbPath), { recursive: true });
  copyFileSync(legacyDbPath, defaultDbPath);
  return defaultDbPath;
}

function normalizeScalar(value: unknown): unknown {
  if (typeof value === "bigint") {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) {
      throw new Error(`SQLite integer exceeds Number.MAX_SAFE_INTEGER: ${value.toString()}`);
    }
    return normalized;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeScalar(item));
  }

  if (value !== null && typeof value === "object") {
    const normalized: SqliteRow = {};
    for (const [key, nested] of Object.entries(value as SqliteRow)) {
      normalized[key] = normalizeScalar(nested);
    }
    return normalized;
  }

  return value;
}

function bindStatement<Result>(
  statement: BetterSqlite3.Statement,
  mode: "run" | "get" | "all",
  params?: SqlParams,
): Result {
  if (params === undefined) {
    return statement[mode]() as Result;
  }
  if (Array.isArray(params)) {
    return statement[mode](...params) as Result;
  }
  return statement[mode](params) as Result;
}

function normalizeRow<T extends object>(row: SqliteRow | undefined): T | null {
  if (row === undefined) {
    return null;
  }
  return normalizeScalar(row) as T;
}

function ensureSchemaMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function queryOne<T extends object>(
  db: SqliteDatabase,
  sql: string,
  params?: SqlParams,
): T | null {
  const statement = db.prepare(sql).safeIntegers();
  return normalizeRow<T>(bindStatement<SqliteRow | undefined>(statement, "get", params));
}

export function queryAll<T extends object>(
  db: SqliteDatabase,
  sql: string,
  params?: SqlParams,
): T[] {
  const statement = db.prepare(sql).safeIntegers();
  return bindStatement<SqliteRow[]>(statement, "all", params).map((row) =>
    normalizeScalar(row) as T,
  );
}

export function execute(
  db: SqliteDatabase,
  sql: string,
  params?: SqlParams,
): BetterSqlite3.RunResult {
  const statement = db.prepare(sql);
  return bindStatement<BetterSqlite3.RunResult>(statement, "run", params);
}

export function lastInsertRowidAsNumber(result: BetterSqlite3.RunResult): number {
  const raw = result.lastInsertRowid;
  if (typeof raw === "number") {
    return raw;
  }
  const normalized = Number(raw);
  if (!Number.isSafeInteger(normalized)) {
    throw new Error(`SQLite rowid exceeds Number.MAX_SAFE_INTEGER: ${raw.toString()}`);
  }
  return normalized;
}

export function inTransaction<TArgs extends unknown[], TResult>(
  db: SqliteDatabase,
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return db.transaction(fn);
}

export function applyMigrations(
  db: SqliteDatabase,
  options: { skill_package_root?: string } = {},
): void {
  const skillPackageRoot = path.resolve(options.skill_package_root ?? SKILL_PACKAGE_ROOT);
  const migrationsDir = resolveMigrationsDir(skillPackageRoot);
  ensureSchemaMigrationsTable(db);
  const appliedRows = queryAll<{ version: string }>(
    db,
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  const applied = new Set(appliedRows.map((row) => String(row.version)));

  for (const migrationName of readdirSync(migrationsDir).sort()) {
    if (!migrationName.endsWith(".sql") || applied.has(migrationName)) {
      continue;
    }

    const sql = readFileSync(path.join(migrationsDir, migrationName), "utf-8");
    db.exec(sql);
    execute(
      db,
      "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)",
      [migrationName],
    );
  }
}

export function ensureDatabase(
  dbPath?: string,
  options: { skill_package_root?: string } = {},
): SqliteDatabase {
  const skillPackageRoot = path.resolve(options.skill_package_root ?? SKILL_PACKAGE_ROOT);
  const resolved = dbPath ?? ensureResolvedDefaultDbPath(skillPackageRoot);
  mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new BetterSqlite3(resolved);
  db.pragma("foreign_keys = ON");
  applyMigrations(db, { skill_package_root: skillPackageRoot });
  return db;
}

export function upsertBusinessConfig(
  db: SqliteDatabase,
  configKey: string,
  configValue: unknown,
): void {
  execute(
    db,
    `
      INSERT INTO business_config(config_key, config_value_json)
      VALUES (?, ?)
      ON CONFLICT(config_key) DO UPDATE SET
          config_value_json = excluded.config_value_json
    `,
    [configKey, stableStringify(configValue)],
  );
}

export function fetchBusinessConfig(db: SqliteDatabase): Record<string, unknown> {
  const rows = queryAll<{ config_key: string; config_value_json: string }>(
    db,
    "SELECT config_key, config_value_json FROM business_config ORDER BY config_key",
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.config_key] = parseJson(row.config_value_json);
  }
  return result;
}

export function callerActorId(channel: string, externalUserId: string): string {
  return `${channel}:${externalUserId}`;
}

export function callerAuditPayload(
  payload: Record<string, unknown> | null | undefined,
  options: {
    channel: string;
    external_user_id: string;
  },
): Record<string, unknown> {
  return {
    ...(payload ?? {}),
    actor_identity: {
      channel: options.channel,
      external_user_id: options.external_user_id,
      auth_identity_model: CALLER_AUTH_IDENTITY_MODEL,
    },
  };
}

export function recordAuditEvent(
  db: SqliteDatabase,
  options: {
    event_type: string;
    actor_type: string;
    actor_id: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    idempotency_key?: string | null;
    payload?: Record<string, unknown> | null;
  },
): void {
  execute(
    db,
    `
      INSERT INTO audit_events(
        event_type,
        actor_type,
        actor_id,
        entity_type,
        entity_id,
        idempotency_key,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      options.event_type,
      options.actor_type,
      options.actor_id,
      options.entity_type ?? null,
      options.entity_id ?? null,
      options.idempotency_key ?? null,
      stableStringify(options.payload ?? {}),
    ],
  );
}
