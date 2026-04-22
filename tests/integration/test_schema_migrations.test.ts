import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../scripts/db/sqlite.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDb(): Database.Database {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-migrations-"));
  tempDirs.push(tmpdir);
  return new Database(path.join(tmpdir, "migration.sqlite3"));
}

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row: any) => String(row.name)),
  );
}

describe("Schema migrations", () => {
  it("single baseline creates current schema", () => {
    const db = tempDb();
    try {
      db.pragma("foreign_keys = ON");
      applyMigrations(db);

      const tableNames = new Set(
        db
          .prepare(
            `
              SELECT name
              FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            `,
          )
          .all()
          .map((row: any) => String(row.name)),
      );
      expect(tableNames).toEqual(
        new Set([
          "audit_events",
          "business_config",
          "conversations",
          "crm_sync_cursors",
          "customers",
          "identities",
          "inventory_movements",
          "low_stock_alerts",
          "order_items",
          "orders",
          "payments",
          "schema_migrations",
          "sku_date_overrides",
          "skus",
          "webhook_events",
        ]),
      );

      const identityColumns = tableColumnNames(db, "identities");
      const orderColumns = tableColumnNames(db, "orders");
      const orderItemColumns = tableColumnNames(db, "order_items");
      const skuColumns = tableColumnNames(db, "skus");
      const alertColumns = tableColumnNames(db, "low_stock_alerts");
      const conversationColumns = tableColumnNames(db, "conversations");
      const cursorColumns = tableColumnNames(db, "crm_sync_cursors");

      expect(identityColumns.has("role")).toBe(true);
      expect(orderColumns.has("session_id")).toBe(true);
      expect(orderColumns.has("booking_contact_name")).toBe(true);
      expect(orderColumns.has("booking_contact_phone")).toBe(true);
      expect(orderItemColumns.has("sku_title")).toBe(true);
      expect(orderItemColumns.has("currency")).toBe(true);
      expect(orderItemColumns.has("check_in_date")).toBe(true);
      expect(orderItemColumns.has("check_out_date")).toBe(true);
      expect(skuColumns.has("inventory_mode")).toBe(true);
      expect(alertColumns.has("inventory_mode")).toBe(true);
      expect(alertColumns.has("status")).toBe(true);
      expect(conversationColumns.has("source_kind")).toBe(true);
      expect(conversationColumns.has("source_event_key")).toBe(true);
      expect(cursorColumns.has("last_processed_line")).toBe(true);
      expect(cursorColumns.has("peer_external_user_id")).toBe(true);

      const indexNames = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .map((row: any) => String(row.name)),
      );
      expect(indexNames.has("idx_identities_single_active")).toBe(true);
      expect(indexNames.has("idx_orders_session_id")).toBe(true);
      expect(indexNames.has("idx_orders_status_reserved_until")).toBe(true);
      expect(indexNames.has("idx_order_items_unique_without_dates")).toBe(true);
      expect(indexNames.has("idx_order_items_unique_with_dates")).toBe(true);
      expect(indexNames.has("idx_low_stock_alerts_sku_date_status")).toBe(true);
      expect(indexNames.has("idx_conversations_source_event_key")).toBe(true);

      const triggerNames = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
          .all()
          .map((row: any) => String(row.name)),
      );
      expect(triggerNames.has("trg_identities_updated_at")).toBe(true);
      expect(triggerNames.has("trg_sku_date_overrides_updated_at")).toBe(true);
      expect(triggerNames.has("trg_orders_updated_at")).toBe(true);
      expect(triggerNames.has("trg_crm_sync_cursors_updated_at")).toBe(true);

      const migratedVersions = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row: any) => String(row.version));
      expect(migratedVersions).toEqual(["0001_init.sql"]);
    } finally {
      db.close();
    }
  });

  it("applyMigrations is idempotent", () => {
    const db = tempDb();
    try {
      db.pragma("foreign_keys = ON");
      applyMigrations(db);
      db.exec(`
        INSERT INTO business_config(config_key, config_value_json)
        VALUES ('enabled_skills', '["onboarding","catalog"]')
      `);

      applyMigrations(db);

      const versions = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row: any) => String(row.version));
      expect(versions).toEqual(["0001_init.sql"]);

      const saved = db
        .prepare(
          `
            SELECT config_value_json
            FROM business_config
            WHERE config_key = 'enabled_skills'
          `,
        )
        .get() as { config_value_json: string } | undefined;
      expect(saved).toBeDefined();
      expect(saved!.config_value_json).toBe('["onboarding","catalog"]');
    } finally {
      db.close();
    }
  });
});
