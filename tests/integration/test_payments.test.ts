import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getSellableQuantity } from "../../scripts/lib/inventory.js";
import { getAgentId, runProdEntry, runTestEntry } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-payments-"));
  tempDirs.push(tmpdir);
  return path.join(tmpdir, "payments.sqlite3");
}

function setupOwner(dbPath: string): Record<string, unknown> {
  return runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
}

function seedOrdersSample(dbPath: string): void {
  runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
  runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", dbPath);
  runProdEntry("orders", "orders_customer_create_deluxe_room_and_minibar.json", dbPath);
}

function createPaymentPayload(options: {
  actor_external_user_id?: string;
  payment_request_id?: string;
  customer_external_user_id?: string | null | undefined;
} = {}): Record<string, unknown> {
  return {
    channel: "telegram",
    command_code: "payments.create_payment_link",
    params: {
      order_number: "PO-1001",
      payment_request_id:
        options.payment_request_id ?? "payments-create-link-po-1001-inline",
      customer_external_user_id:
        "customer_external_user_id" in options
          ? options.customer_external_user_id
          : "customer-001",
    },
    user: {
      external_user_id: options.actor_external_user_id ?? "agent-001",
      username: "alice",
    },
  };
}

function confirmPaymentPayload(options: {
  actor_external_user_id?: string;
  payment_reference?: string;
  customer_external_user_id?: string | null | undefined;
} = {}): Record<string, unknown> {
  return {
    channel: "telegram",
    command_code: "payments.confirm_mock_paid",
    params: {
      payment_reference: options.payment_reference ?? "mock-pay-po-1001-001",
      customer_external_user_id:
        "customer_external_user_id" in options
          ? options.customer_external_user_id
          : "customer-001",
    },
    user: {
      external_user_id: options.actor_external_user_id ?? "agent-001",
      username: "alice",
    },
  };
}

describe("Payments runtime", () => {
  it("pending payment cancel releases reservations", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);
    runTestEntry("payments", "payments_caller_create_payment_link.json", dbPath);

    const cancelled = runTestEntry("orders", "orders_owner_cancel_order.json", dbPath);
    expect(cancelled.status).toBe("cancelled");
    expect((cancelled.order as any).status).toBe("cancelled");

    const db = new Database(dbPath);
    try {
      const movementCounts = Object.fromEntries(
        db
          .prepare(
            `
              SELECT movement_type, COUNT(*) AS movement_count
              FROM inventory_movements
              GROUP BY movement_type
              ORDER BY movement_type
            `,
          )
          .all()
          .map((row: any) => [row.movement_type, Number(row.movement_count)]),
      );
      const deluxe = db
        .prepare("SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'")
        .get() as any;
      const minibar = db
        .prepare("SELECT * FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'")
        .get() as any;
      const deluxeSellable = getSellableQuantity(db, deluxe, {
        inventory_date: new Date(Date.UTC(2099, 6, 2)),
      });
      const minibarSellable = getSellableQuantity(db, minibar);

      expect(movementCounts.reserve).toBe(4);
      expect(movementCounts.release).toBe(4);
      expect(deluxeSellable).toBe(6);
      expect(minibarSellable).toBe(24);
    } finally {
      db.close();
    }
  });

  it("caller can create link, confirm paid, and owner can refund", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const created = runTestEntry("payments", "payments_caller_create_payment_link.json", dbPath);
    const confirmed = runTestEntry("payments", "payments_caller_confirm_mock_paid.json", dbPath);

    expect(created.status).toBe("created");
    expect((created.payment as any).payment_reference).toBe("mock-pay-po-1001-001");
    expect((created.payment as any).status).toBe("pending");
    expect((created.order as any).status).toBe("pending_payment");
    expect((created.inventory_actions as any).reserve_movement_count).toBe(4);

    expect(confirmed.status).toBe("paid");
    expect((confirmed.payment as any).status).toBe("paid");
    expect((confirmed.order as any).status).toBe("paid");
    expect((confirmed.inventory_actions as any).movement_count).toBe(4);
    expect((confirmed.inventory_actions as any).quantity_stock_updates).toBe(1);

    const stockAfterCommit = runProdEntry(
      "inventory",
      {
        channel: "telegram",
        command_code: "inventory.show_stock",
        params: {
          sku_code: "DELUXE-SEAVIEW-KING",
          date_from: "2099-07-01",
          date_to: "2099-07-03",
        },
        user: { external_user_id: "owner-001", username: "alice" },
      },
      dbPath,
    );
    expect((stockAfterCommit.sku as any).date_inventory.map((row: any) => row.sellable_quantity)).toEqual([5, 5, 5]);
    expect((stockAfterCommit.sku as any).requested_window_sellable_quantity).toBe(5);

    let db = new Database(dbPath);
    try {
      const deluxe = db
        .prepare("SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'")
        .get() as any;
      const deluxeSellableAfterCommit = getSellableQuantity(db, deluxe, {
        inventory_date: new Date(Date.UTC(2099, 6, 2)),
      });
      const overrideRows = db
        .prepare(
          `
            SELECT inventory_date, stock_quantity_override, sellable_status_override, reason
            FROM sku_date_overrides
            WHERE sku_id = (SELECT id FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING')
            ORDER BY inventory_date ASC
          `,
        )
        .all() as any[];

      expect(deluxeSellableAfterCommit).toBe(5);
      expect(overrideRows).toHaveLength(3);
      for (const row of overrideRows) {
        expect(Number(row.stock_quantity_override)).toBe(5);
        expect(row.sellable_status_override).toBeNull();
        expect(row.reason).toBe("system_commit");
      }
    } finally {
      db.close();
    }

    const refunded = runTestEntry("payments", "payments_owner_refund_mock_payment.json", dbPath);
    expect(refunded.status).toBe("refunded");
    expect((refunded.payment as any).status).toBe("refunded");
    expect((refunded.payment as any).refund_reference).toBe("refund-po-1001-001");
    expect((refunded.order as any).status).toBe("refunded");
    expect((refunded.inventory_actions as any).movement_count).toBe(3);
    expect((refunded.inventory_actions as any).quantity_stock_updates).toBe(0);

    db = new Database(dbPath);
    try {
      const deluxe = db
        .prepare("SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'")
        .get() as any;
      const minibar = db
        .prepare("SELECT * FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'")
        .get() as any;
      const order = db
        .prepare(
          `
            SELECT status, reserved_until, paid_at, refunded_at
            FROM orders
            WHERE order_number = 'PO-1001'
          `,
        )
        .get() as any;
      const payment = db
        .prepare(
          `
            SELECT status, provider_reference, paid_at, refunded_at
            FROM payments
            WHERE order_id = (SELECT id FROM orders WHERE order_number = 'PO-1001')
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get() as any;
      const movementCounts = Object.fromEntries(
        db
          .prepare(
            `
              SELECT movement_type, COUNT(*) AS movement_count
              FROM inventory_movements
              GROUP BY movement_type
              ORDER BY movement_type
            `,
          )
          .all()
          .map((row: any) => [row.movement_type, Number(row.movement_count)]),
      );
      const deluxeSellableAfterRefund = getSellableQuantity(db, deluxe, {
        inventory_date: new Date(Date.UTC(2099, 6, 2)),
      });
      const minibarSellableAfterRefund = getSellableQuantity(db, minibar);
      const overrideCount = Number(
        (
          db
            .prepare(
              `
                SELECT COUNT(*) AS row_count
                FROM sku_date_overrides
                WHERE sku_id = (SELECT id FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING')
              `,
            )
            .get() as any
        ).row_count,
      );
      const paymentAuditRows = db
        .prepare(
          `
            SELECT event_type, actor_type, actor_id, payload_json
            FROM audit_events
            WHERE event_type IN (
              'payments.payment_link_created',
              'payments.payment_paid',
              'payments.payment_refunded',
              'orders.order_status_changed'
            )
            ORDER BY id ASC
          `,
        )
        .all() as any[];

      expect(order.status).toBe("refunded");
      expect(order.reserved_until).toBeNull();
      expect(order.paid_at).not.toBeNull();
      expect(order.refunded_at).not.toBeNull();
      expect(payment.status).toBe("refunded");
      expect(payment.paid_at).not.toBeNull();
      expect(payment.refunded_at).not.toBeNull();
      expect(movementCounts.reserve).toBe(4);
      expect(movementCounts.commit).toBe(4);
      expect(movementCounts.refund_restock).toBe(3);
      expect(Number(minibar.stock_quantity)).toBe(23);
      expect(minibarSellableAfterRefund).toBe(23);
      expect(deluxeSellableAfterRefund).toBe(6);
      expect(overrideCount).toBe(0);

      const agentId = getAgentId(dbPath);
      expect(
        paymentAuditRows.map((row) => [row.event_type, row.actor_type, row.actor_id]),
      ).toEqual([
        ["payments.payment_link_created", "caller", `telegram:${agentId}`],
        ["orders.order_status_changed", "caller", `telegram:${agentId}`],
        ["payments.payment_paid", "caller", `telegram:${agentId}`],
        ["orders.order_status_changed", "caller", `telegram:${agentId}`],
        ["payments.payment_refunded", "owner", "owner-001"],
        ["orders.order_status_changed", "owner", "owner-001"],
      ]);
      for (const auditRow of paymentAuditRows.slice(0, 4)) {
        expect(JSON.parse(auditRow.payload_json).actor_identity).toEqual({
          channel: "telegram",
          external_user_id: agentId,
          auth_identity_model: "caller_identity",
        });
      }
      const createdPaymentAuditPayload = JSON.parse(paymentAuditRows[0].payload_json);
      expect(createdPaymentAuditPayload.requested_customer_external_user_id).toBe(
        "customer-001",
      );
      expect(createdPaymentAuditPayload.order_customer_external_user_id).toBe("customer-001");
      expect(createdPaymentAuditPayload.acting_for_customer).toBe(true);
      const paidPaymentAuditPayload = JSON.parse(paymentAuditRows[2].payload_json);
      expect(paidPaymentAuditPayload.requested_customer_external_user_id).toBe(
        "customer-001",
      );
      expect(paidPaymentAuditPayload.order_customer_external_user_id).toBe("customer-001");
      expect(paidPaymentAuditPayload.acting_for_customer).toBe(true);
      for (const auditRow of paymentAuditRows.slice(4)) {
        expect(JSON.parse(auditRow.payload_json).actor_identity).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });

  it("payment commands are idempotent by their frozen anchors", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const firstCreate = runTestEntry("payments", "payments_caller_create_payment_link.json", dbPath);
    const replayCreate = runTestEntry("payments", "payments_caller_create_payment_link.json", dbPath);
    const firstConfirm = runTestEntry("payments", "payments_caller_confirm_mock_paid.json", dbPath);
    const replayConfirm = runTestEntry("payments", "payments_caller_confirm_mock_paid.json", dbPath);
    const firstRefund = runTestEntry("payments", "payments_owner_refund_mock_payment.json", dbPath);
    const replayRefund = runTestEntry("payments", "payments_owner_refund_mock_payment.json", dbPath);

    expect(firstCreate.status).toBe("created");
    expect(replayCreate.status).toBe("created");
    expect(replayCreate.idempotent_replay).toBe(true);
    expect((firstCreate.payment as any).payment_reference).toBe(
      (replayCreate.payment as any).payment_reference,
    );

    expect(firstConfirm.status).toBe("paid");
    expect(replayConfirm.status).toBe("paid");
    expect(replayConfirm.idempotent_replay).toBe(true);

    expect(firstRefund.status).toBe("refunded");
    expect(replayRefund.status).toBe("refunded");
    expect(replayRefund.idempotent_replay).toBe(true);

    const db = new Database(dbPath);
    try {
      const movementCounts = Object.fromEntries(
        db
          .prepare(
            `
              SELECT movement_type, COUNT(*) AS movement_count
              FROM inventory_movements
              GROUP BY movement_type
              ORDER BY movement_type
            `,
          )
          .all()
          .map((row: any) => [row.movement_type, Number(row.movement_count)]),
      );
      const paymentCount = Number(
        (db.prepare("SELECT COUNT(*) AS count FROM payments").get() as any).count,
      );
      expect(paymentCount).toBe(1);
      expect(movementCounts.reserve).toBe(4);
      expect(movementCounts.commit).toBe(4);
      expect(movementCounts.refund_restock).toBe(3);
    } finally {
      db.close();
    }
  });

  it("expired pending payment is cancelled and released before confirm", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);
    runTestEntry("payments", "payments_caller_create_payment_link.json", dbPath);

    const db = new Database(dbPath);
    try {
      db.exec(`
        UPDATE orders
        SET reserved_until = datetime('now', '-5 minutes')
        WHERE order_number = 'PO-1001'
      `);
    } finally {
      db.close();
    }

    const expiredConfirm = runTestEntry("payments", "payments_caller_confirm_mock_paid.json", dbPath);
    expect(expiredConfirm.status).toBe("invalid_state");
    expect(String(expiredConfirm.reply)).toContain("order=cancelled");

    const verifyDb = new Database(dbPath);
    try {
      const order = verifyDb
        .prepare(
          `
            SELECT status, reserved_until, cancelled_at
            FROM orders
            WHERE order_number = 'PO-1001'
          `,
        )
        .get() as any;
      const movementCounts = Object.fromEntries(
        verifyDb
          .prepare(
            `
              SELECT movement_type, COUNT(*) AS movement_count
              FROM inventory_movements
              GROUP BY movement_type
              ORDER BY movement_type
            `,
          )
          .all()
          .map((row: any) => [row.movement_type, Number(row.movement_count)]),
      );
      const deluxe = verifyDb
        .prepare("SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'")
        .get() as any;
      const minibar = verifyDb
        .prepare("SELECT * FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'")
        .get() as any;
      const deluxeSellable = getSellableQuantity(verifyDb, deluxe, {
        inventory_date: new Date(Date.UTC(2099, 6, 2)),
      });
      const minibarSellable = getSellableQuantity(verifyDb, minibar);

      expect(order.status).toBe("cancelled");
      expect(order.reserved_until).toBeNull();
      expect(order.cancelled_at).not.toBeNull();
      expect(movementCounts.reserve).toBe(4);
      expect(movementCounts.release).toBe(4);
      expect(deluxeSellable).toBe(6);
      expect(minibarSellable).toBe(24);
    } finally {
      verifyDb.close();
    }
  });

  it("agent must declare the matching customer identity for create and confirm", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const missingCreate = runProdEntry(
      "payments",
      createPaymentPayload({
        payment_request_id: "payments-create-link-po-1001-missing-customer",
        customer_external_user_id: undefined,
      }),
      dbPath,
    );
    expect(missingCreate.status).toBe("invalid_input");
    expect(String(missingCreate.reply)).toContain("params.customer_external_user_id is required");

    const mismatchedCreate = runProdEntry(
      "payments",
      createPaymentPayload({
        payment_request_id: "payments-create-link-po-1001-wrong-customer",
        customer_external_user_id: "customer-999",
      }),
      dbPath,
    );
    expect(mismatchedCreate.status).toBe("invalid_input");
    expect(String(mismatchedCreate.reply)).toContain("must match order PO-1001");

    const created = runProdEntry(
      "payments",
      createPaymentPayload({
        payment_request_id: "payments-create-link-po-1001-valid-customer",
      }),
      dbPath,
    );
    expect(created.status).toBe("created");

    const mismatchedConfirm = runProdEntry(
      "payments",
      confirmPaymentPayload({
        payment_reference: String((created.payment as any).payment_reference),
        customer_external_user_id: "customer-999",
      }),
      dbPath,
    );
    expect(mismatchedConfirm.status).toBe("invalid_input");
    expect(String(mismatchedConfirm.reply)).toContain("must match order PO-1001");
  });

  it("owner may omit customer identity but cannot provide a mismatched one", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const created = runProdEntry(
      "payments",
      createPaymentPayload({
        actor_external_user_id: "owner-001",
        payment_request_id: "payments-create-link-po-1001-owner",
        customer_external_user_id: null,
      }),
      dbPath,
    );
    expect(created.status).toBe("created");

    const mismatchedCreate = runProdEntry(
      "payments",
      createPaymentPayload({
        actor_external_user_id: "owner-001",
        payment_request_id: "payments-create-link-po-1001-owner-mismatch",
        customer_external_user_id: "customer-999",
      }),
      dbPath,
    );
    expect(mismatchedCreate.status).toBe("invalid_input");
    expect(String(mismatchedCreate.reply)).toContain("must match order PO-1001");

    const confirmed = runProdEntry(
      "payments",
      confirmPaymentPayload({
        actor_external_user_id: "owner-001",
        payment_reference: String((created.payment as any).payment_reference),
        customer_external_user_id: null,
      }),
      dbPath,
    );
    expect(confirmed.status).toBe("paid");

    const mismatchedConfirm = runProdEntry(
      "payments",
      confirmPaymentPayload({
        actor_external_user_id: "owner-001",
        payment_reference: String((created.payment as any).payment_reference),
        customer_external_user_id: "customer-999",
      }),
      dbPath,
    );
    expect(mismatchedConfirm.status).toBe("invalid_input");
    expect(String(mismatchedConfirm.reply)).toContain("must match order PO-1001");
  });

  it("create_payment_link fails when the target order has no linked customer identity", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedOrdersSample(dbPath);

    const db = new Database(dbPath);
    try {
      db.exec(`
        UPDATE orders
        SET customer_id = NULL
        WHERE order_number = 'PO-1001'
      `);
    } finally {
      db.close();
    }

    const created = runProdEntry(
      "payments",
      createPaymentPayload({
        payment_request_id: "payments-create-link-po-1001-no-order-customer",
      }),
      dbPath,
    );
    expect(created.status).toBe("invalid_state");
    expect(String(created.reply)).toContain("has no customer_external_user_id linked");
  });
});
