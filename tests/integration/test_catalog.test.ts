import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { formatMinorAmount } from "../../scripts/lib/money.js";
import { runProdEntry, runTestEntry } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-catalog-"));
  tempDirs.push(tmpdir);
  return path.join(tmpdir, "catalog.sqlite3");
}

function setupOwner(dbPath: string): void {
  runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
}

describe("Catalog runtime", () => {
  it("owner can create and show sku", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);

    const created = runTestEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
    expect(created.status).toBe("created");
    expect((created.sku as any).display_price).toBe("USD 289.00");
    expect((created.sku as any).sku_code).toBe("DELUXE-SEAVIEW-KING");
    expect((created.sku as any).inventory_mode).toBe("date_quantity");
    expect((created.sku as any).stock_quantity_semantics).toBe("default_nightly_capacity");

    runProdEntry("catalog", "catalog_owner_add_room_family_suite.json", dbPath);
    const shown = runTestEntry("catalog", "catalog_owner_show_room.json", dbPath);
    expect(shown.status).toBe("found");
    expect((shown.sku as any).title).toBe("Family Suite 4P");
    expect((shown.sku as any).display_price).toBe("USD 359.00");
    expect((shown.sku as any).inventory_mode).toBe("date_quantity");
    expect((shown.sku as any).stock_quantity_semantics).toBe("default_nightly_capacity");
  });

  it("inventory mode defaults, validates, and can switch safely", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);

    const defaultMode = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.add_sku",
        params: {
          sku_code: "WELCOME-COOKIE-TIN",
          title: "Welcome Cookie Tin",
          price_minor: 2500,
          currency: "USD",
          stock_quantity: 12,
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    const explicitDate = runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
    const invalidMode = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.add_sku",
        params: {
          sku_code: "BAD-MODE-SKU",
          title: "Bad Mode SKU",
          price_minor: 1000,
          currency: "USD",
          inventory_mode: "calendar_quantity",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    const switchMode = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.update_inventory_mode",
        params: {
          sku_code: "DELUXE-SEAVIEW-KING",
          inventory_mode: "quantity",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );

    expect(defaultMode.status).toBe("created");
    expect((defaultMode.sku as any).inventory_mode).toBe("quantity");
    expect((defaultMode.sku as any).stock_quantity_semantics).toBe("on_hand_quantity");
    expect(explicitDate.status).toBe("created");
    expect((explicitDate.sku as any).inventory_mode).toBe("date_quantity");
    expect(switchMode.status).toBe("updated");
    expect((switchMode.sku as any).inventory_mode).toBe("quantity");
    expect((switchMode.sku as any).stock_quantity_semantics).toBe("on_hand_quantity");
    expect(invalidMode.status).toBe("invalid_input");
  });

  it("money helper formats supported fiat currencies", () => {
    expect(formatMinorAmount(1999, "USD")).toBe("USD 19.99");
    expect(formatMinorAmount(8850, "CNY")).toBe("CNY 88.50");
    expect(formatMinorAmount(1200, "JPY")).toBe("JPY 1200");
    expect(formatMinorAmount(15000, "KRW")).toBe("KRW 15000");
  });

  it("create rejects duplicate sku code, invalid code, and currency", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);

    const first = runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
    const duplicate = runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
    expect(first.status).toBe("created");
    expect(duplicate.status).toBe("conflict");

    const invalidSku = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.add_sku",
        params: {
          sku_code: "bad code",
          title: "Broken SKU",
          price_minor: 1000,
          currency: "USD",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    expect(invalidSku.status).toBe("invalid_input");

    const invalidCurrency = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.add_sku",
        params: {
          sku_code: "VALID-SKU-2",
          title: "Unsupported Currency SKU",
          price_minor: 1000,
          currency: "USDT",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    expect(invalidCurrency.status).toBe("invalid_input");
  });

  it("owner can update details, price, status, and archive", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_room_standard_city.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);

    const details = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.update_details",
        params: {
          sku_code: "DELUXE-SEAVIEW-KING",
          title: "Deluxe Seaview King Room",
          description: "Updated description",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    const price = runTestEntry("catalog", "catalog_owner_update_room_price_peak_season.json", dbPath);
    const status = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.update_status",
        params: {
          sku_code: "STANDARD-CITY-QUEEN",
          sellable_status: "unavailable",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    const archived = runTestEntry("catalog", "catalog_owner_archive_room_type.json", dbPath);
    const archivedAgain = runTestEntry("catalog", "catalog_owner_archive_room_type.json", dbPath);

    expect(details.status).toBe("updated");
    expect(price.status).toBe("updated");
    expect((price.sku as any).display_price).toBe("USD 329.00");
    expect(status.status).toBe("updated");
    expect((status.sku as any).sku_code).toBe("STANDARD-CITY-QUEEN");
    expect((status.sku as any).sellable_status).toBe("unavailable");
    expect(archived.status).toBe("archived");
    expect((archived.sku as any).sellable_status).toBe("archived");
    expect((archived.sku as any).archived_at).not.toBeNull();
    expect(archivedAgain.status).toBe("archived");
    expect((price.sku as any).inventory_mode).toBe("date_quantity");

    const db = new Database(dbPath);
    try {
      const events = db
        .prepare(
          `
            SELECT event_type
            FROM audit_events
            WHERE event_type LIKE 'catalog.%'
            ORDER BY created_at, id
          `,
        )
        .all()
        .map((row: any) => row.event_type);
      expect(events).toContain("catalog.sku_created");
      expect(events).toContain("catalog.sku_updated");
      expect(events).toContain("catalog.sku_archived");
    } finally {
      db.close();
    }
  });

  it("owner show_catalog lists all skus", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);

    runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_room_standard_city.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_room_family_suite.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_room_single_seaview_unavailable.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
    runTestEntry("catalog", "catalog_owner_update_room_price_peak_season.json", dbPath);
    runTestEntry("catalog", "catalog_owner_update_room_status_unavailable.json", dbPath);
    runTestEntry("catalog", "catalog_owner_archive_room_type.json", dbPath);

    const listed = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.show_catalog",
        params: {},
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );

    expect(listed.status).toBe("listed");
    expect((listed.skus as any[])).toHaveLength(5);
    const statuses = Object.fromEntries((listed.skus as any[]).map((sku) => [sku.sku_code, sku.sellable_status]));
    expect(statuses["DELUXE-SEAVIEW-KING"]).toBe("archived");
    expect(statuses["STANDARD-CITY-QUEEN"]).toBe("unavailable");
    expect(statuses["SINGLE-SEAVIEW"]).toBe("unavailable");
    expect(statuses["FAMILY-SUITE-4P"]).toBe("active");
    expect(statuses["MINIBAR-SNACK-BOX"]).toBe("active");

    const prices = Object.fromEntries((listed.skus as any[]).map((sku) => [sku.sku_code, sku.display_price]));
    expect(prices["DELUXE-SEAVIEW-KING"]).toBe("USD 329.00");
    expect(prices["STANDARD-CITY-QUEEN"]).toBe("USD 189.00");
    expect(prices["SINGLE-SEAVIEW"]).toBe("USD 209.00");
    expect(prices["FAMILY-SUITE-4P"]).toBe("USD 359.00");
    expect(prices["MINIBAR-SNACK-BOX"]).toBe("USD 18.00");

    const inventoryModes = Object.fromEntries((listed.skus as any[]).map((sku) => [sku.sku_code, sku.inventory_mode]));
    expect(inventoryModes["DELUXE-SEAVIEW-KING"]).toBe("date_quantity");
    expect(inventoryModes["STANDARD-CITY-QUEEN"]).toBe("date_quantity");
    expect(inventoryModes["FAMILY-SUITE-4P"]).toBe("date_quantity");
    expect(inventoryModes["SINGLE-SEAVIEW"]).toBe("date_quantity");
    expect(inventoryModes["MINIBAR-SNACK-BOX"]).toBe("quantity");

    const semantics = Object.fromEntries(
      (listed.skus as any[]).map((sku) => [sku.sku_code, sku.stock_quantity_semantics]),
    );
    expect(semantics["DELUXE-SEAVIEW-KING"]).toBe("default_nightly_capacity");
    expect(semantics["MINIBAR-SNACK-BOX"]).toBe("on_hand_quantity");
  });

  it("inventory_mode switch conflicts after real usage", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_room_family_suite.json", dbPath);

    const movementConflict = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.adjust_stock",
        params: {
          sku_code: "MINIBAR-SNACK-BOX",
          delta: -2,
          reason: "restock_count",
          operation_id: "minibar-adjust-001",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    const movementModeChange = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.update_inventory_mode",
        params: {
          sku_code: "MINIBAR-SNACK-BOX",
          inventory_mode: "date_quantity",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );

    const overrideConflict = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.set_date_stock",
        params: {
          sku_code: "FAMILY-SUITE-4P",
          date_from: "2099-07-01",
          date_to: "2099-07-02",
          stock_quantity: 2,
          reason: "holiday_hold",
          operation_id: "family-hold-001",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );
    const overrideModeChange = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.update_inventory_mode",
        params: {
          sku_code: "FAMILY-SUITE-4P",
          inventory_mode: "quantity",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );

    const db = new Database(dbPath);
    try {
      const customerInsert = db
        .prepare(
          `
            INSERT INTO customers(channel, external_user_id, username)
            VALUES ('telegram', 'customer-001', 'guest-anna')
          `,
        )
        .run();
      const customerId =
        typeof customerInsert.lastInsertRowid === "bigint"
          ? Number(customerInsert.lastInsertRowid)
          : customerInsert.lastInsertRowid;
      const orderInsert = db
        .prepare(
          `
            INSERT INTO orders(
              order_number,
              customer_id,
              source_channel,
              status,
              currency,
              subtotal_minor,
              total_minor
            ) VALUES ('PO-2001', ?, 'telegram', 'draft', 'USD', 1800, 1800)
          `,
        )
        .run(customerId);
      const orderId =
        typeof orderInsert.lastInsertRowid === "bigint"
          ? Number(orderInsert.lastInsertRowid)
          : orderInsert.lastInsertRowid;
      const familySkuId = Number(
        (db
          .prepare("SELECT id FROM skus WHERE sku_code = 'FAMILY-SUITE-4P'")
          .get() as any).id,
      );
      db.prepare(
        `
          INSERT INTO order_items(
            order_id,
            sku_id,
            sku_title,
            unit_price_minor,
            currency,
            quantity,
            line_total_minor
          ) VALUES (?, ?, 'Family Suite 4P', 35900, 'USD', 1, 35900)
        `,
      ).run(orderId, familySkuId);
    } finally {
      db.close();
    }

    const orderItemModeChange = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.update_inventory_mode",
        params: {
          sku_code: "FAMILY-SUITE-4P",
          inventory_mode: "quantity",
        },
        user: { external_user_id: "owner-001" },
      },
      dbPath,
    );

    expect(movementConflict.status).toBe("adjusted");
    expect(movementModeChange.status).toBe("conflict");
    expect(overrideConflict.status).toBe("updated");
    expect(overrideModeChange.status).toBe("conflict");
    expect(orderItemModeChange.status).toBe("conflict");
  });

  it("non-owner write is forbidden and customer reads inventory-backed catalog", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    runProdEntry("catalog", "catalog_owner_add_room_family_suite.json", dbPath);
    runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
    runProdEntry("inventory", "inventory_owner_set_family_suite_holiday_stock.json", dbPath);
    runProdEntry("inventory", "inventory_owner_adjust_minibar_stock_low.json", dbPath);

    const forbidden = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.add_sku",
        params: {
          sku_code: "CUSTOMER-FAIL",
          title: "Forbidden write",
          price_minor: 1000,
          currency: "USD",
        },
        user: { external_user_id: "customer-001" },
      },
      dbPath,
    );
    const showCatalog = runTestEntry("catalog", "catalog_customer_show_room_catalog.json", dbPath);
    const showCatalogWithDates = runTestEntry(
      "catalog",
      "catalog_customer_show_room_catalog_with_dates.json",
      dbPath,
    );
    const showProduct = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.show_product",
        params: { sku_code: "FAMILY-SUITE-4P" },
        user: { external_user_id: "customer-001" },
      },
      dbPath,
    );
    const showProductWithDates = runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.show_product",
        params: {
          sku_code: "FAMILY-SUITE-4P",
          check_in_date: "2099-07-01",
          check_out_date: "2099-07-04",
        },
        user: { external_user_id: "customer-001" },
      },
      dbPath,
    );

    expect(forbidden.status).toBe("forbidden");
    expect(showCatalog.status).toBe("listed");
    expect(showCatalogWithDates.status).toBe("listed");
    expect(showProduct.status).toBe("found");
    expect(showProductWithDates.status).toBe("found");

    const noDateStatus = Object.fromEntries(
      ((showCatalog.skus as any[]) ?? []).map((sku) => [sku.sku_code, sku.availability_status]),
    );
    expect(noDateStatus["FAMILY-SUITE-4P"]).toBe("dates_required");
    expect(noDateStatus["MINIBAR-SNACK-BOX"]).toBe("only_a_few_left");

    const datedStatus = Object.fromEntries(
      ((showCatalogWithDates.skus as any[]) ?? []).map((sku) => [sku.sku_code, sku.availability_status]),
    );
    expect(datedStatus["FAMILY-SUITE-4P"]).toBe("only_a_few_left");
    expect(datedStatus["MINIBAR-SNACK-BOX"]).toBe("only_a_few_left");
    expect((showProduct.sku as any).availability_status).toBe("dates_required");
    expect((showProductWithDates.sku as any).availability_status).toBe("only_a_few_left");
  });
});
