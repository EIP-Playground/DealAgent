import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDatabase } from "../../scripts/db/sqlite.js";
import {
  resolveDefaultDbPath,
  resolveInstalledSkillDataRoot,
  resolveLegacyInstalledDbPath,
  resolveScheduledJobLogDir,
  resolveSkillDataRoot,
  resolveSkillPackageRootFromDir,
} from "../../scripts/lib/paths.js";

const tempDirs: string[] = [];
const ROOT = path.resolve(import.meta.dirname, "..", "..");

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedSkillPackageRoot(skillPackageRoot: string): void {
  mkdirSync(path.join(skillPackageRoot, "scripts", "db", "migrations"), { recursive: true });
  mkdirSync(path.join(skillPackageRoot, "skills"), { recursive: true });
  writeFileSync(path.join(skillPackageRoot, "SKILL.md"), "# test\n", "utf-8");
  writeFileSync(
    path.join(skillPackageRoot, "scripts", "db", "migrations", "0001_init.sql"),
    readFileSync(path.join(ROOT, "scripts", "db", "migrations", "0001_init.sql"), "utf-8"),
    "utf-8",
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storage layout", () => {
  it("resolves repo and installed data roots correctly and no longer requires inner data markers", () => {
    const workspace = tempDir("purr-suite-layout-");
    const repoRoot = path.join(workspace, "repo", "purr-suite");
    seedSkillPackageRoot(repoRoot);
    const nestedDir = path.join(repoRoot, "scripts", "lib", "nested");
    mkdirSync(nestedDir, { recursive: true });

    expect(resolveSkillPackageRootFromDir(nestedDir)).toBe(repoRoot);
    expect(resolveSkillDataRoot(repoRoot)).toBe(path.join(repoRoot, "data"));
    expect(resolveDefaultDbPath(repoRoot)).toBe(
      path.join(repoRoot, "data", "dev", "purr_suite_dev.sqlite3"),
    );

    const installedRoot = path.join(workspace, ".openclaw", "skills", "purr-suite");
    seedSkillPackageRoot(installedRoot);

    expect(resolveInstalledSkillDataRoot(installedRoot)).toBe(
      path.join(workspace, ".openclaw", "data", "purr-suite"),
    );
    expect(resolveSkillDataRoot(installedRoot)).toBe(
      path.join(workspace, ".openclaw", "data", "purr-suite"),
    );
    expect(resolveDefaultDbPath(installedRoot)).toBe(
      path.join(workspace, ".openclaw", "data", "purr-suite", "purr_suite_prod.sqlite3"),
    );
    expect(resolveScheduledJobLogDir(installedRoot)).toBe(
      path.join(workspace, ".openclaw", "data", "purr-suite", "logs", "scheduled-jobs"),
    );
  });

  it("copies the legacy installed prod database to the external path on first default open", () => {
    const workspace = tempDir("purr-suite-installed-db-");
    const installedRoot = path.join(workspace, ".openclaw", "skills", "purr-suite");
    seedSkillPackageRoot(installedRoot);

    const legacyDbPath = resolveLegacyInstalledDbPath(installedRoot);
    const externalDbPath = resolveDefaultDbPath(installedRoot);
    const legacyDb = ensureDatabase(legacyDbPath, { skill_package_root: installedRoot });
    try {
      legacyDb.exec(
        "INSERT INTO business_config(config_key, config_value_json) VALUES ('migrated_marker', '\"legacy\"')",
      );
    } finally {
      legacyDb.close();
    }

    expect(existsSync(externalDbPath)).toBe(false);

    const externalDb = ensureDatabase(undefined, { skill_package_root: installedRoot });
    try {
      const row = externalDb
        .prepare("SELECT config_value_json FROM business_config WHERE config_key = 'migrated_marker'")
        .get() as { config_value_json: string } | undefined;
      expect(row?.config_value_json).toBe("\"legacy\"");
    } finally {
      externalDb.close();
    }

    expect(existsSync(externalDbPath)).toBe(true);
    expect(existsSync(legacyDbPath)).toBe(true);
  });

  it("keeps the existing external installed database and bypasses migration for explicit db paths", () => {
    const workspace = tempDir("purr-suite-installed-db-existing-");
    const installedRoot = path.join(workspace, ".openclaw", "skills", "purr-suite");
    seedSkillPackageRoot(installedRoot);

    const legacyDbPath = resolveLegacyInstalledDbPath(installedRoot);
    const externalDbPath = resolveDefaultDbPath(installedRoot);

    const legacyDb = ensureDatabase(legacyDbPath, { skill_package_root: installedRoot });
    try {
      legacyDb.exec(
        "INSERT INTO business_config(config_key, config_value_json) VALUES ('externalization_marker', '\"legacy\"')",
      );
    } finally {
      legacyDb.close();
    }

    const seededExternalDb = ensureDatabase(externalDbPath, { skill_package_root: installedRoot });
    try {
      seededExternalDb.exec(
        "INSERT INTO business_config(config_key, config_value_json) VALUES ('externalization_marker', '\"external\"')",
      );
    } finally {
      seededExternalDb.close();
    }

    const defaultDb = ensureDatabase(undefined, { skill_package_root: installedRoot });
    try {
      const row = defaultDb
        .prepare(
          "SELECT config_value_json FROM business_config WHERE config_key = 'externalization_marker'",
        )
        .get() as { config_value_json: string } | undefined;
      expect(row?.config_value_json).toBe("\"external\"");
    } finally {
      defaultDb.close();
    }

    const explicitDbPath = path.join(workspace, "explicit.sqlite3");
    const explicitDb = ensureDatabase(explicitDbPath, { skill_package_root: installedRoot });
    try {
      explicitDb.exec(
        "INSERT INTO business_config(config_key, config_value_json) VALUES ('explicit_marker', '\"custom\"')",
      );
    } finally {
      explicitDb.close();
    }

    const legacyMirrorPath = path.join(workspace, ".openclaw", "data", "purr-suite", "custom.sqlite3");
    expect(existsSync(legacyMirrorPath)).toBe(false);

    const db = new Database(explicitDbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT config_value_json FROM business_config WHERE config_key = 'explicit_marker'")
        .get() as { config_value_json: string } | undefined;
      expect(row?.config_value_json).toBe("\"custom\"");
    } finally {
      db.close();
    }
  });
});
