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

function dbPath(): string {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-seller-bi-"));
  tempDirs.push(tmpdir);
  return path.join(tmpdir, "seller-bi.sqlite3");
}

function setupOwner(targetDbPath: string): Record<string, unknown> {
  return runProdEntry("onboarding", "onboarding_first_setup.json", targetDbPath);
}

function seedUsdCatalog(targetDbPath: string): void {
  runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", targetDbPath);
  runProdEntry("catalog", "catalog_owner_add_minibar_snack_box.json", targetDbPath);
}

function createPaidOrder(
  targetDbPath: string,
  options: {
    orderPayload: Record<string, unknown>;
    paymentRequestId: string;
  },
): [string, string] {
  const created = runProdEntry("orders", options.orderPayload, targetDbPath);
  const orderNumber = String((created.order as any).order_number);
  const paymentCreated = runProdEntry(
    "payments",
    {
      channel: "telegram",
      command_code: "payments.create_payment_link",
      params: {
        order_number: orderNumber,
        payment_request_id: options.paymentRequestId,
      },
      user: {
        external_user_id: "owner-001",
        username: "alice",
      },
    },
    targetDbPath,
  );
  const paymentReference = String((paymentCreated.payment as any).payment_reference);
  runProdEntry(
    "payments",
    {
      channel: "telegram",
      command_code: "payments.confirm_mock_paid",
      params: { payment_reference: paymentReference },
      user: {
        external_user_id: "owner-001",
        username: "alice",
      },
    },
    targetDbPath,
  );
  return [orderNumber, paymentReference];
}

function refundPaidOrder(
  targetDbPath: string,
  options: { orderNumber: string; refundReference: string },
): Record<string, unknown> {
  return runProdEntry(
    "payments",
    {
      channel: "telegram",
      command_code: "payments.refund_mock_payment",
      params: {
        order_number: options.orderNumber,
        refund_reference: options.refundReference,
      },
      user: {
        external_user_id: "owner-001",
        username: "alice",
      },
    },
    targetDbPath,
  );
}

function setPaymentTimes(
  targetDbPath: string,
  options: {
    orderNumber: string;
    paymentReference: string;
    paidAt: string;
    refundedAt?: string | null;
  },
): void {
  const db = new Database(targetDbPath);
  try {
    db.prepare(
      `
        UPDATE orders
        SET paid_at = ?, refunded_at = COALESCE(?, refunded_at)
        WHERE order_number = ?
      `,
    ).run(options.paidAt, options.refundedAt ?? null, options.orderNumber);
    db.prepare(
      `
        UPDATE payments
        SET paid_at = ?, refunded_at = COALESCE(?, refunded_at)
        WHERE provider_reference = ?
      `,
    ).run(options.paidAt, options.refundedAt ?? null, options.paymentReference);
  } finally {
    db.close();
  }
}

describe("Seller BI runtime", () => {
  it("owner can read zero metrics and legacy aliases still work", () => {
    const targetDbPath = dbPath();
    setupOwner(targetDbPath);

    const sales = runProdEntry(
      "seller-bi",
      {
        channel: "telegram",
        command_code: "seller-bi.sales_today",
        params: { anchor_date: "2099-07-02" },
        user: {
          external_user_id: "owner-001",
          username: "alice",
        },
      },
      targetDbPath,
    );
    const revenue = runTestEntry(
      "seller-bi",
      "seller_bi_owner_revenue_this_month.json",
      targetDbPath,
    );

    expect(sales.status).toBe("computed");
    expect(sales.metric_code).toBe("seller_bi.sales_today");
    expect(sales.sales_count).toBe(0);
    expect(revenue.status).toBe("computed");
    expect(revenue.currency_count).toBe(0);
    expect(revenue.multi_currency).toBe(false);
    expect(revenue.revenue_rows).toEqual([]);
  });

  it("sales_today counts paid orders even if later refunded", () => {
    const targetDbPath = dbPath();
    setupOwner(targetDbPath);
    seedUsdCatalog(targetDbPath);

    const [orderNumber, paymentReference] = createPaidOrder(targetDbPath, {
      orderPayload: loadFixture("orders_customer_create_deluxe_room_and_minibar.json"),
      paymentRequestId: "seller-bi-po-1001-001",
    });
    refundPaidOrder(targetDbPath, {
      orderNumber,
      refundReference: "seller-bi-refund-po-1001-001",
    });
    setPaymentTimes(targetDbPath, {
      orderNumber,
      paymentReference,
      paidAt: "2099-07-02 10:15:00",
      refundedAt: "2099-07-03 09:00:00",
    });

    const sales = runTestEntry(
      "seller-bi",
      "seller_bi_owner_sales_today.json",
      targetDbPath,
    );
    const revenue = runTestEntry(
      "seller-bi",
      "seller_bi_owner_revenue_this_month.json",
      targetDbPath,
    );

    expect(sales.status).toBe("computed");
    expect(sales.sales_count).toBe(1);
    expect(sales.window_start).toBe("2099-07-02 00:00:00");
    expect(sales.window_end_exclusive).toBe("2099-07-03 00:00:00");

    expect(revenue.status).toBe("computed");
    expect(revenue.currency_count).toBe(0);
    expect(revenue.revenue_rows).toEqual([]);
  });

  it("revenue_this_month groups by currency", () => {
    const targetDbPath = dbPath();
    setupOwner(targetDbPath);
    seedUsdCatalog(targetDbPath);

    const [usdOrderNumber, usdPaymentReference] = createPaidOrder(targetDbPath, {
      orderPayload: loadFixture("orders_customer_create_deluxe_room_and_minibar.json"),
      paymentRequestId: "seller-bi-po-1001-001",
    });
    setPaymentTimes(targetDbPath, {
      orderNumber: usdOrderNumber,
      paymentReference: usdPaymentReference,
      paidAt: "2099-07-02 10:15:00",
    });

    runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.add_sku",
        params: {
          sku_code: "WELCOME-BENTO-JPY",
          title: "Welcome Bento",
          price_minor: 3500,
          currency: "JPY",
          stock_quantity: 30,
        },
        user: {
          external_user_id: "owner-001",
          username: "alice",
        },
      },
      targetDbPath,
    );
    const [jpyOrderNumber, jpyPaymentReference] = createPaidOrder(targetDbPath, {
      orderPayload: {
        channel: "telegram",
        command_code: "orders.create_session_draft",
        params: {
          session_id: "telegram:customer-002:retail-001",
          booking_contact: {
            guest_name: "Ben",
            phone: "13900139000",
          },
          items: [{ sku_code: "WELCOME-BENTO-JPY", quantity: 2 }],
        },
        user: {
          external_user_id: "customer-002",
          username: "guest-ben",
        },
      },
      paymentRequestId: "seller-bi-po-1002-001",
    });
    setPaymentTimes(targetDbPath, {
      orderNumber: jpyOrderNumber,
      paymentReference: jpyPaymentReference,
      paidAt: "2099-07-10 19:30:00",
    });

    const revenue = runTestEntry(
      "seller-bi",
      "seller_bi_owner_revenue_this_month.json",
      targetDbPath,
    );

    expect(revenue.status).toBe("computed");
    expect(revenue.month).toBe("2099-07");
    expect(revenue.currency_count).toBe(2);
    expect(revenue.multi_currency).toBe(true);
    expect(revenue.revenue_rows).toEqual([
      {
        currency: "JPY",
        amount_minor: 7000,
        display_amount: "JPY 7000",
      },
      {
        currency: "USD",
        amount_minor: 88500,
        display_amount: "USD 885.00",
      },
    ]);
  });

  it("customer cannot query seller-bi metrics", () => {
    const targetDbPath = dbPath();
    setupOwner(targetDbPath);

    const forbidden = runProdEntry(
      "seller-bi",
      {
        channel: "telegram",
        command_code: "seller_bi.sales_today",
        params: { anchor_date: "2099-07-02" },
        user: {
          external_user_id: "customer-001",
          username: "guest-anna",
        },
      },
      targetDbPath,
    );

    expect(forbidden.status).toBe("forbidden");
  });
});
