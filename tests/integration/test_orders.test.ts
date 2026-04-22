import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture, runProdEntry, runTestEntry } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-orders-"));
  tempDirs.push(tmpdir);
  return path.join(tmpdir, "orders.sqlite3");
}

function setupOwner(dbPath: string): Record<string, unknown> {
  return runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
}

function seedOrdersSample(dbPath: string): void {
  runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
  runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
}

describe("Orders runtime", () => {
  it("customer can create draft and query it", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const created = runTestEntry(
      "orders",
      "orders_customer_create_deluxe_room_and_minibar.json",
      dbPath,
    );
    const shown = runTestEntry("orders", "orders_customer_show_order.json", dbPath);
    const myOrders = runTestEntry("orders", "orders_customer_show_my_orders.json", dbPath);
    const listed = runTestEntry("orders", "orders_owner_list_orders.json", dbPath);

    expect(created.status).toBe("created");
    expect((created.order as any).order_number).toBe("PO-1001");
    expect((created.order as any).status).toBe("draft");
    expect((created.order as any).currency).toBe("USD");
    expect((created.order as any).subtotal_minor).toBe(88500);
    expect((created.order as any).total_minor).toBe(88500);
    expect((created.order as any).session_id).toBe("telegram:customer-001:stay-001");
    expect((created.order as any).booking_contact.guest_name).toBe("Anna");
    expect((created.order as any).booking_contact.phone).toBe("13800138000");
    expect((created.order as any).items).toHaveLength(2);
    expect((created.order as any).items[0].sku_code).toBe("DELUXE-SEAVIEW-KING");
    expect((created.order as any).items[0].check_in_date).toBe("2099-07-01");
    expect((created.order as any).items[1].check_in_date).toBeUndefined();

    expect(shown.status).toBe("found");
    expect((shown.order as any).order_number).toBe("PO-1001");
    expect(myOrders.status).toBe("listed");
    expect((myOrders.orders as any[])).toHaveLength(1);
    expect(listed.status).toBe("listed");
    expect((listed.orders as any[])).toHaveLength(1);
    expect((listed.orders as any[])[0].customer.external_user_id).toBe("customer-001");

    const db = new Database(dbPath);
    try {
      const order = db
        .prepare(
          `
            SELECT session_id, booking_contact_name, booking_contact_phone
            FROM orders
            WHERE order_number = 'PO-1001'
          `,
        )
        .get() as any;
      const rows = db
        .prepare(
          `
            SELECT check_in_date, check_out_date, currency
            FROM order_items
            ORDER BY id
          `,
        )
        .all() as any[];

      expect(order.session_id).toBe("telegram:customer-001:stay-001");
      expect(order.booking_contact_name).toBe("Anna");
      expect(order.booking_contact_phone).toBe("13800138000");
      expect(rows[0].check_in_date).toBe("2099-07-01");
      expect(rows[0].check_out_date).toBe("2099-07-04");
      expect(rows[1].check_in_date).toBeNull();
      expect(rows[1].currency).toBe("USD");
    } finally {
      db.close();
    }
  });

  it("create generates session_id when missing", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const payload = loadFixture("orders_customer_create_deluxe_room_and_minibar.json");
    delete (payload.params as any).session_id;

    const created = runProdEntry("orders", payload, dbPath);
    expect(created.status).toBe("created");
    const generated = String((created.order as any).session_id);
    expect(generated).toMatch(
      /^telegram:customer-001:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const uuidPart = generated.split(":").at(-1)!;
    expect(uuidPart).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          `
            SELECT session_id
            FROM orders
            WHERE order_number = 'PO-1001'
          `,
        )
        .get() as any;
      expect(row.session_id).toBe(generated);
    } finally {
      db.close();
    }
  });

  it("owner can cancel draft and status persists", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);
    runTestEntry("orders", "orders_customer_create_deluxe_room_and_minibar.json", dbPath);

    const cancelled = runTestEntry("orders", "orders_owner_cancel_order.json", dbPath);
    const shown = runTestEntry("orders", "orders_customer_show_order.json", dbPath);

    expect(cancelled.status).toBe("cancelled");
    expect((cancelled.order as any).status).toBe("cancelled");
    expect((shown.order as any).status).toBe("cancelled");

    const db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          `
            SELECT status, cancelled_at, reserved_until
            FROM orders
            WHERE order_number = 'PO-1001'
          `,
        )
        .get() as any;
      expect(row.status).toBe("cancelled");
      expect(row.cancelled_at).not.toBeNull();
      expect(row.reserved_until).toBeNull();
    } finally {
      db.close();
    }
  });

  it("customer cannot view other customer order", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);
    runTestEntry("orders", "orders_customer_create_deluxe_room_and_minibar.json", dbPath);

    const forbidden = runProdEntry(
      "orders",
      {
        channel: "telegram",
        command_code: "orders.show_order",
        params: { order_number: "PO-1001" },
        user: {
          external_user_id: "customer-002",
          username: "guest-ben",
        },
      },
      dbPath,
    );
    const ownerView = runProdEntry(
      "orders",
      {
        channel: "telegram",
        command_code: "orders.show_order",
        params: { order_number: "PO-1001" },
        user: {
          external_user_id: "owner-001",
          username: "alice",
        },
      },
      dbPath,
    );

    expect(forbidden.status).toBe("forbidden");
    expect(ownerView.status).toBe("found");
  });

  it("create rejects invalid dates and session-only fields", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const missingDates = loadFixture("orders_customer_create_deluxe_room_and_minibar.json");
    delete ((missingDates.params as any).items[0] as any).check_in_date;
    delete ((missingDates.params as any).items[0] as any).check_out_date;

    const quantityWithDates = loadFixture("orders_customer_create_deluxe_room_and_minibar.json");
    (quantityWithDates.params as any).items[1].check_in_date = "2099-07-01";
    (quantityWithDates.params as any).items[1].check_out_date = "2099-07-04";

    const topLevelBudget = loadFixture("orders_customer_create_deluxe_room_and_minibar.json");
    (topLevelBudget.params as any).budget_per_night = 30000;

    const missingDatesResult = runProdEntry("orders", missingDates, dbPath);
    const quantityDatesResult = runProdEntry("orders", quantityWithDates, dbPath);
    const budgetResult = runProdEntry("orders", topLevelBudget, dbPath);

    expect(missingDatesResult.status).toBe("invalid_input");
    expect(String(missingDatesResult.reply)).toContain("check_in_date/check_out_date");
    expect(quantityDatesResult.status).toBe("invalid_input");
    expect(String(quantityDatesResult.reply)).toContain("must not include dates");
    expect(budgetResult.status).toBe("invalid_input");
    expect(String(budgetResult.reply)).toContain("budget_per_night");
  });

  it("create rejects insufficient availability and owner misuse", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const insufficient = loadFixture("orders_customer_create_deluxe_room_and_minibar.json");
    (insufficient.params as any).items[0].quantity = 7;

    const ownerAttempt = loadFixture("orders_customer_create_deluxe_room_and_minibar.json");
    (ownerAttempt.user as any).external_user_id = "owner-001";
    (ownerAttempt.user as any).username = "alice";

    const insufficientResult = runProdEntry("orders", insufficient, dbPath);
    const ownerResult = runProdEntry("orders", ownerAttempt, dbPath);

    expect(insufficientResult.status).toBe("conflict");
    expect(String(insufficientResult.reply)).toContain("only has 6 available");
    expect(ownerResult.status).toBe("forbidden");
  });

  it("existing customer is reused and username updates", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const db = new Database(dbPath);
    try {
      db.exec(`
        INSERT INTO customers(channel, external_user_id, username)
        VALUES ('telegram', 'customer-001', 'old-guest-name')
      `);
    } finally {
      db.close();
    }

    const created = runTestEntry(
      "orders",
      "orders_customer_create_deluxe_room_and_minibar.json",
      dbPath,
    );
    expect(created.status).toBe("created");

    const verifyDb = new Database(dbPath);
    try {
      const row = verifyDb
        .prepare(
          `
            SELECT COUNT(*) AS row_count, MIN(username) AS username
            FROM customers
            WHERE channel = 'telegram' AND external_user_id = 'customer-001'
          `,
        )
        .get() as any;
      expect(Number(row.row_count)).toBe(1);
      expect(row.username).toBe("guest-anna");
    } finally {
      verifyDb.close();
    }
  });
});
