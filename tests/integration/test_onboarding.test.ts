import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOnboarding } from "../../scripts/lib/onboarding.js";
import * as sqliteModule from "../../scripts/db/sqlite.js";
import { runProdEntry, runTestEntry } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function withTempDb(): string {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-onboarding-"));
  tempDirs.push(tmpdir);
  return path.join(tmpdir, "purr_suite_test.sqlite3");
}

function context(
  dbPath: string,
  options: { external_user_id?: string; username?: string } = {},
): Record<string, unknown> {
  return {
    channel: "telegram",
    command_code: "onboarding.setup_suite",
    runtime: { db_path: dbPath },
    user: {
      external_user_id: options.external_user_id ?? "owner-001",
      username: options.username ?? "alice",
    },
  };
}

function dbCounts(dbPath: string): {
  ownerCount: number;
  configCount: number;
  auditCount: number;
} {
  const db = new Database(dbPath);
  try {
    const ownerCount = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM identities WHERE role = 'owner'").get() as any)
        .count,
    );
    const configCount = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM business_config").get() as any).count,
    );
    const auditCount = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as any).count,
    );
    return { ownerCount, configCount, auditCount };
  } finally {
    db.close();
  }
}

describe("Onboarding entrypoints", () => {
  it("test entry first setup creates database and records", () => {
    const dbPath = withTempDb();
    const result = runTestEntry("onboarding", "onboarding_first_setup.json", dbPath);
    expect(result.status).toBe("initialized");

    const counts = dbCounts(dbPath);
    expect(counts.ownerCount).toBe(1);
    expect(counts.configCount).toBeGreaterThanOrEqual(4);
    expect(counts.auditCount).toBeGreaterThanOrEqual(2);
  });

  it("run entry first setup reads stdin payload", () => {
    const dbPath = withTempDb();
    const result = runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
    expect(result.status).toBe("initialized");
    expect(result).not.toHaveProperty("background_jobs");
  });

  it("same owner setup is idempotent", () => {
    const dbPath = withTempDb();
    const first = runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
    const second = runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
    expect(first.status).toBe("initialized");
    expect(second.status).toBe("idempotent");

    const db = new Database(dbPath);
    try {
      const ownerCount = Number(
        (db.prepare("SELECT COUNT(*) AS count FROM identities WHERE role = 'owner'").get() as any)
          .count,
      );
      expect(ownerCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("second owner is rejected", () => {
    const dbPath = withTempDb();
    runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
    const rejected = runProdEntry("onboarding", "onboarding_second_user.json", dbPath);
    expect(rejected.status).toBe("rejected");

    const db = new Database(dbPath);
    try {
      const ownerCount = Number(
        (db.prepare("SELECT COUNT(*) AS count FROM identities WHERE role = 'owner'").get() as any)
          .count,
      );
      expect(ownerCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("legacy slash command is ignored", () => {
    const dbPath = withTempDb();
    const payload = {
      channel: "telegram",
      command_code: "/setup_purrfect_suite",
      user: { external_user_id: "owner-001", username: "alice" },
      runtime: { db_path: dbPath },
    };
    const result = runProdEntry("onboarding", payload, dbPath);
    expect(result.status).toBe("ignored");
  });

  it("ignores runtime.install_cron without changing onboarding behavior", () => {
    const dbPath = withTempDb();
    const result = runProdEntry(
      "onboarding",
      {
        channel: "telegram",
        command_code: "onboarding.setup_suite",
        runtime: { db_path: dbPath, install_cron: false },
        user: { external_user_id: "owner-001", username: "alice" },
      },
      dbPath,
    );
    expect(result.status).toBe("initialized");
    expect(result).not.toHaveProperty("background_jobs");
  });

  it("first setup rolls back if owner_paired audit fails", () => {
    const dbPath = withTempDb();
    const originalRecordAuditEvent = sqliteModule.recordAuditEvent;
    vi.spyOn(sqliteModule, "recordAuditEvent").mockImplementation((db, options) => {
      if (options.event_type === "onboarding.owner_paired") {
        throw new Error("forced audit failure");
      }
      return originalRecordAuditEvent(db, options);
    });

    expect(() => handleOnboarding(context(dbPath))).toThrowError("forced audit failure");

    const counts = dbCounts(dbPath);
    expect(counts.ownerCount).toBe(0);
    expect(counts.configCount).toBe(0);
    expect(counts.auditCount).toBe(0);
  });

  it("idempotent setup rolls back if audit fails", () => {
    const dbPath = withTempDb();
    const initialized = handleOnboarding(context(dbPath, { username: "alice" }));
    expect(initialized.status).toBe("initialized");

    let db = new Database(dbPath);
    try {
      db.exec("DELETE FROM business_config WHERE config_key = 'payment_provider'");
    } finally {
      db.close();
    }

    const originalRecordAuditEvent = sqliteModule.recordAuditEvent;
    vi.spyOn(sqliteModule, "recordAuditEvent").mockImplementation((database, options) => {
      if (options.event_type === "onboarding.setup_idempotent") {
        throw new Error("forced idempotent audit failure");
      }
      return originalRecordAuditEvent(database, options);
    });

    expect(() =>
      handleOnboarding(context(dbPath, { username: "alice-updated" })),
    ).toThrowError("forced idempotent audit failure");

    db = new Database(dbPath);
    try {
      const owner = db
        .prepare("SELECT username FROM identities WHERE id = 1")
        .get() as { username: string };
      const paymentProvider = Number(
        (db
          .prepare(
            "SELECT COUNT(*) AS count FROM business_config WHERE config_key = 'payment_provider'",
          )
          .get() as any).count,
      );
      const auditCount = Number(
        (db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as any).count,
      );
      expect(owner.username).toBe("alice");
      expect(paymentProvider).toBe(0);
      expect(auditCount).toBe(2);
    } finally {
      db.close();
    }
  });
});
