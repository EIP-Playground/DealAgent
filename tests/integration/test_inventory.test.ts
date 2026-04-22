import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManualAdjustReferenceKey,
  buildOrderReferenceKey,
  buildSetDateStockReferenceKey,
  getSellableQuantity,
} from "../../scripts/lib/inventory.js";
import { DIST_SCAN_ENTRY, runCommand, runProdEntry, runTestEntry } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-inventory-"));
  tempDirs.push(tmpdir);
  return path.join(tmpdir, "inventory.sqlite3");
}

function setupOwner(dbPath: string): void {
  runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
}

function seedInventorySample(dbPath: string): void {
  runProdEntry("catalog", "catalog_owner_add_room_family_suite.json", dbPath);
  runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
}

describe("Inventory runtime", () => {
  it("owner can show inventory and stock for both modes", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedInventorySample(dbPath);
    runProdEntry("inventory", "inventory_owner_set_family_suite_holiday_stock.json", dbPath);
    runProdEntry("inventory", "inventory_owner_adjust_minibar_stock_low.json", dbPath);

    const listed = runTestEntry("inventory", "inventory_owner_show_inventory.json", dbPath);
    const minibar = runTestEntry("inventory", "inventory_owner_show_stock_minibar.json", dbPath);
    const family = runTestEntry("inventory", "inventory_owner_show_stock_family_suite_dates.json", dbPath);

    expect(listed.status).toBe("listed");
    expect(minibar.status).toBe("found");
    expect(family.status).toBe("found");

    const rows = Object.fromEntries(
      ((listed.inventory_rows as any[]) ?? []).map((row) => [row.sku_code, row]),
    );
    expect(rows["MINIBAR-SNACK-BOX"].inventory_mode).toBe("quantity");
    expect(rows["MINIBAR-SNACK-BOX"].sellable_quantity).toBe(2);
    expect(rows["MINIBAR-SNACK-BOX"].low_stock).toBe(true);
    expect(rows["FAMILY-SUITE-4P"].inventory_mode).toBe("date_quantity");
    expect(rows["FAMILY-SUITE-4P"].stock_quantity_semantics).toBe("default_nightly_capacity");

    expect((minibar.sku as any).sellable_quantity).toBe(2);
    expect((family.sku as any).date_inventory).toHaveLength(3);
    expect((family.sku as any).requested_window_sellable_quantity).toBe(2);
  });

  it("adjust_stock is idempotent and duplicate safe", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);

    const basePayload = {
      channel: "telegram",
      command_code: "inventory.adjust_stock",
      params: {
        sku_code: "MINIBAR-SNACK-BOX",
        delta: 2,
        reason: "manual_recount",
        operation_id: "recount-001",
      },
      user: { external_user_id: "owner-001" },
    };
    const first = runProdEntry("inventory", basePayload, dbPath);
    const replay = runProdEntry("inventory", basePayload, dbPath);
    const needsConfirmation = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.adjust_stock",
        params: {
          sku_code: "MINIBAR-SNACK-BOX",
          delta: 2,
          reason: "manual_recount",
          operation_id: "recount-002",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    const confirmed = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.adjust_stock",
        params: {
          sku_code: "MINIBAR-SNACK-BOX",
          delta: 2,
          reason: "manual_recount",
          operation_id: "recount-003",
          confirm_duplicate: true,
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );

    expect(first.status).toBe("adjusted");
    expect(replay.status).toBe("adjusted");
    expect(replay.idempotent_replay).toBe(true);
    expect(needsConfirmation.status).toBe("needs_confirmation");
    expect((needsConfirmation.duplicate_check as any).window_seconds).toBe(60);
    expect(confirmed.status).toBe("adjusted");
    expect((confirmed.sku as any).stock_quantity).toBe(28);
  });

  it("adjust_stock after duplicate window no longer needs confirmation", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);

    const first = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.adjust_stock",
        params: {
          sku_code: "MINIBAR-SNACK-BOX",
          delta: -1,
          reason: "manual_recount",
          operation_id: "inventory-adjust-stock-minibar-snack-box-001",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    expect(first.status).toBe("adjusted");

    const db = new Database(dbPath);
    try {
      const skuId = Number(
        (db
          .prepare("SELECT id FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'")
          .get() as any).id,
      );
      db.prepare(
        `
          UPDATE inventory_movements
          SET created_at = datetime('now', '-61 seconds')
          WHERE reference_key = ?
        `,
      ).run(
        `manual_adjust:operation_id=inventory-adjust-stock-minibar-snack-box-001:sku_id=${skuId}`,
      );
    } finally {
      db.close();
    }

    const second = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.adjust_stock",
        params: {
          sku_code: "MINIBAR-SNACK-BOX",
          delta: -1,
          reason: "manual_recount",
          operation_id: "inventory-adjust-stock-minibar-snack-box-002",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    expect(second.status).toBe("adjusted");
    expect(second.duplicate_check).toBeUndefined();
  });

  it("low_stock_scan marks alerts sent and resolution happens after restock", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
    runProdEntry("inventory", "inventory_owner_adjust_minibar_stock_low.json", dbPath);

    let db = new Database(dbPath);
    try {
      const pendingBefore = db.prepare("SELECT status FROM low_stock_alerts").all() as any[];
      expect(pendingBefore.map((row) => row.status)).toEqual(["pending"]);
    } finally {
      db.close();
    }

    const result = runCommand(["node", DIST_SCAN_ENTRY, "--db-path", dbPath]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as any;
    expect(payload.status).toBe("scanned");
    expect(payload.alerts).toHaveLength(1);
    expect(payload.alerts[0].sku_code).toBe("MINIBAR-SNACK-BOX");

    runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.adjust_stock",
        params: {
          sku_code: "MINIBAR-SNACK-BOX",
          delta: 3,
          reason: "restock_delivery",
          operation_id: "restock-001",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );

    db = new Database(dbPath);
    try {
      const statuses = db
        .prepare("SELECT status FROM low_stock_alerts ORDER BY id")
        .all()
        .map((row: any) => row.status);
      expect(statuses).toEqual(["resolved"]);
    } finally {
      db.close();
    }
  });

  it("show_low_stock refreshes but does not mark alerts sent", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
    runProdEntry("inventory", "inventory_owner_adjust_minibar_stock_low.json", dbPath);

    const shown = runTestEntry("inventory", "inventory_owner_show_low_stock.json", dbPath);
    expect(shown.status).toBe("listed");
    expect((shown.low_stock_rows as any[])).toHaveLength(1);
    expect((shown.low_stock_rows as any[])[0].sku_code).toBe("MINIBAR-SNACK-BOX");
    expect((shown.low_stock_rows as any[])[0].alert_status).toBe("pending");

    const db = new Database(dbPath);
    try {
      const statuses = db
        .prepare("SELECT status FROM low_stock_alerts ORDER BY id")
        .all()
        .map((row: any) => row.status);
      expect(statuses).toEqual(["pending"]);
    } finally {
      db.close();
    }
  });

  it("reference key builders include mode-specific fields", () => {
    expect(buildManualAdjustReferenceKey("op-1", 7)).toBe(
      "manual_adjust:operation_id=op-1:sku_id=7",
    );
    expect(
      buildSetDateStockReferenceKey("op-2", 8, new Date(Date.UTC(2099, 6, 1))),
    ).toBe("set_date_stock:operation_id=op-2:sku_id=8:inventory_date=2099-07-01");
    expect(
      buildOrderReferenceKey("reserve", {
        order_id: 11,
        order_item_id: 22,
        sku_id: 33,
      }),
    ).toBe("reserve:order_id=11:order_item_id=22:sku_id=33");
    expect(
      buildOrderReferenceKey("commit", {
        order_id: 11,
        order_item_id: 22,
        sku_id: 33,
        payment_reference: "pay-001",
        inventory_date: new Date(Date.UTC(2099, 6, 1)),
      }),
    ).toBe(
      "commit:payment_reference=pay-001:order_id=11:order_item_id=22:sku_id=33:inventory_date=2099-07-01",
    );
  });

  it("non-owner inventory read is forbidden", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedInventorySample(dbPath);

    const forbidden = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.show_inventory",
        params: {},
        user: { external_user_id: "customer-001" },
      },
      dbPath,
    );
    expect(forbidden.status).toBe("forbidden");
  });
});
