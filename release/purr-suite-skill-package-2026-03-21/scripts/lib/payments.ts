import {
  DEFAULT_DB_PATH,
  callerActorId,
  callerAuditPayload,
  ensureDatabase,
  execute,
  fetchBusinessConfig,
  queryAll,
  queryOne,
  recordAuditEvent,
  type SqliteDatabase,
} from "../db/sqlite.js";
import { parseJson, stableStringify } from "./json.js";
import {
  commitOrderReservation,
  expireReservations,
  reserveOrderItems,
  restockRefundedOrder,
  syncLowStockForOrder,
} from "./inventory.js";
import { serializeOrder } from "./orders.js";
import {
  invalidResponse,
  normalizeText,
  optionalText,
  requireParamsMapping,
} from "./runtime.js";
import { futureUtcTimestamp, nowUtcTimestamp } from "./time.js";
import { isRecord } from "./types.js";

const PAYMENT_COMMANDS = new Set([
  "payments.create_payment_link",
  "payments.confirm_mock_paid",
  "payments.refund_mock_payment",
  "payments.whoami",
]);
const MOCK_PROVIDER = "mock";
const PAYMENT_RESERVATION_TTL_MINUTES = 15;
const PAYMENT_REUSABLE_STATUSES = new Set(["pending", "pending_confirmation"]);

interface IdentityRow {
  id: number;
}

type ActorRole = "owner" | "agent";

interface OrderRow {
  id: number;
  customer_id: number | null;
  order_number: string;
  status: string;
  total_minor: number;
  subtotal_minor: number;
  currency: string;
  reserved_until: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
  fulfilled_at: string | null;
  notes: string | null;
  session_id: string | null;
  booking_contact_name: string | null;
  booking_contact_phone: string | null;
  order_customer_external_user_id: string | null;
  order_customer_username: string | null;
}

interface PaymentRow {
  id: number;
  order_id: number;
  provider: string;
  provider_reference: string;
  payment_link_url: string | null;
  status: string;
  amount_minor: number;
  currency: string;
  paid_at: string | null;
  refunded_at: string | null;
  metadata_json: string | null;
}

function fetchActiveOwner(
  db: SqliteDatabase,
  options: { channel: string; external_user_id: string },
): IdentityRow | null {
  return queryOne<IdentityRow>(
    db,
    `
      SELECT *
      FROM identities
      WHERE channel = ? AND external_user_id = ? AND is_active = 1 AND role = 'owner'
      LIMIT 1
    `,
    [options.channel, options.external_user_id],
  );
}

function fetchActiveAgent(
  db: SqliteDatabase,
  options: { channel: string; external_user_id: string },
): IdentityRow | null {
  return queryOne<IdentityRow>(
    db,
    `
      SELECT *
      FROM identities
      WHERE channel = ? AND external_user_id = ? AND is_active = 1 AND role = 'agent'
      LIMIT 1
    `,
    [options.channel, options.external_user_id],
  );
}

function fetchOrderRow(
  db: SqliteDatabase,
  options: { order_number?: string | null; order_id?: number | null },
): OrderRow | null {
  if (!options.order_number && !options.order_id) {
    throw new Error("order_number or order_id is required");
  }
  if (options.order_number) {
    return queryOne<OrderRow>(
      db,
      `
        SELECT
          orders.*,
          customers.external_user_id AS order_customer_external_user_id,
          customers.username AS order_customer_username
        FROM orders
        LEFT JOIN customers ON customers.id = orders.customer_id
        WHERE orders.order_number = ?
        LIMIT 1
      `,
      [options.order_number],
    );
  }
  return queryOne<OrderRow>(
    db,
    `
      SELECT
        orders.*,
        customers.external_user_id AS order_customer_external_user_id,
        customers.username AS order_customer_username
      FROM orders
      LEFT JOIN customers ON customers.id = orders.customer_id
      WHERE orders.id = ?
      LIMIT 1
    `,
    [options.order_id!],
  );
}

function fetchPaymentByReference(
  db: SqliteDatabase,
  paymentReference: string,
): PaymentRow | null {
  return queryOne<PaymentRow>(
    db,
    `
      SELECT *
      FROM payments
      WHERE provider = ?
        AND provider_reference = ?
      LIMIT 1
    `,
    [MOCK_PROVIDER, paymentReference],
  );
}

function listOrderPayments(
  db: SqliteDatabase,
  options: { order_id: number },
): PaymentRow[] {
  return queryAll<PaymentRow>(
    db,
    `
      SELECT *
      FROM payments
      WHERE order_id = ?
      ORDER BY id DESC
    `,
    [options.order_id],
  );
}

function decodePaymentMetadata(paymentRow: PaymentRow | null): Record<string, unknown> {
  if (paymentRow === null || paymentRow.metadata_json === null) {
    return {};
  }
  try {
    const decoded = parseJson(paymentRow.metadata_json);
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function paymentWithMetadata(
  paymentRow: PaymentRow | null,
  updates: Record<string, string | null | undefined>,
): string {
  const metadata = decodePaymentMetadata(paymentRow);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      delete metadata[key];
    } else {
      metadata[key] = value;
    }
  }
  return stableStringify(metadata);
}

function serializePayment(paymentRow: PaymentRow): Record<string, unknown> {
  const metadata = decodePaymentMetadata(paymentRow);
  const payload: Record<string, unknown> = {
    provider: paymentRow.provider,
    payment_reference: paymentRow.provider_reference,
    payment_link_url: paymentRow.payment_link_url,
    status: paymentRow.status,
    amount_minor: paymentRow.amount_minor,
    currency: paymentRow.currency,
    paid_at: paymentRow.paid_at,
    refunded_at: paymentRow.refunded_at,
  };
  if ("payment_request_id" in metadata) {
    payload.payment_request_id = metadata.payment_request_id;
  }
  if ("refund_reference" in metadata) {
    payload.refund_reference = metadata.refund_reference;
  }
  return payload;
}

function ensureMockProviderEnabled(db: SqliteDatabase): void {
  const businessConfig = fetchBusinessConfig(db);
  if (businessConfig.payment_provider !== MOCK_PROVIDER) {
    throw new Error("business_config.payment_provider must be mock for v1 payments.");
  }
}

function findPaymentByRequestId(
  db: SqliteDatabase,
  options: { order_id: number; payment_request_id: string },
): PaymentRow | null {
  return (
    listOrderPayments(db, { order_id: options.order_id }).find(
      (paymentRow) =>
        decodePaymentMetadata(paymentRow).payment_request_id === options.payment_request_id,
    ) ?? null
  );
}

function findPaymentByRefundReference(
  db: SqliteDatabase,
  options: { order_id: number; refund_reference: string },
): PaymentRow | null {
  return (
    listOrderPayments(db, { order_id: options.order_id }).find(
      (paymentRow) =>
        decodePaymentMetadata(paymentRow).refund_reference === options.refund_reference,
    ) ?? null
  );
}

function latestPendingPayment(
  db: SqliteDatabase,
  options: { order_id: number },
): PaymentRow | null {
  return queryOne<PaymentRow>(
    db,
    `
      SELECT *
      FROM payments
      WHERE order_id = ?
        AND status IN ('pending', 'pending_confirmation')
      ORDER BY id DESC
      LIMIT 1
    `,
    [options.order_id],
  );
}

function latestPaidLikePayment(
  db: SqliteDatabase,
  options: { order_id: number },
): PaymentRow | null {
  return queryOne<PaymentRow>(
    db,
    `
      SELECT *
      FROM payments
      WHERE order_id = ?
        AND status IN ('paid', 'refunded')
      ORDER BY id DESC
      LIMIT 1
    `,
    [options.order_id],
  );
}

function nextPaymentReference(
  db: SqliteDatabase,
  options: { order_id: number; order_number: string },
): string {
  const count = queryOne<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM payments WHERE order_id = ?",
    [options.order_id],
  )?.count ?? 0;
  return `mock-pay-${options.order_number.toLowerCase()}-${String(count + 1).padStart(3, "0")}`;
}

function mockPaymentLinkUrl(paymentReference: string): string {
  return `https://mock-pay.purrsuite.local/pay/${paymentReference}`;
}

function requireOwner(
  db: SqliteDatabase,
  options: { channel: string; external_user_id: string },
): IdentityRow {
  const owner = fetchActiveOwner(db, options);
  if (owner === null) {
    throw new PermissionError("Only the active owner can run payments commands.");
  }
  return owner;
}

class PermissionError extends Error {}

class InvalidStateError extends Error {}

interface CustomerExecutionContext {
  requested_customer_external_user_id: string | null;
  order_customer_external_user_id: string;
  acting_for_customer: boolean;
}

function requireStoreRepresentativeRole(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
  },
) : ActorRole {
  if (
    fetchActiveOwner(db, {
      channel: options.channel,
      external_user_id: options.actor_external_user_id,
    }) !== null
  ) {
    return "owner";
  }
  if (
    fetchActiveAgent(db, {
      channel: options.channel,
      external_user_id: options.actor_external_user_id,
    }) !== null
  ) {
    return "agent";
  }
  throw new PermissionError("Only an active store representative can run this payments command.");
}

function requireCustomerExecutionContext(options: {
  command_code: "payments.create_payment_link" | "payments.confirm_mock_paid";
  actor_role: ActorRole;
  order_number: string;
  requested_customer_external_user_id: string | null;
  order_customer_external_user_id: string | null;
}): CustomerExecutionContext {
  if (!options.order_customer_external_user_id) {
    throw new InvalidStateError(
      `Order ${options.order_number} has no customer_external_user_id linked in the database.`,
    );
  }
  if (options.actor_role === "agent" && !options.requested_customer_external_user_id) {
    throw new Error(
      `params.customer_external_user_id is required when an agent runs ${options.command_code}.`,
    );
  }
  if (
    options.requested_customer_external_user_id !== null &&
    options.requested_customer_external_user_id !== options.order_customer_external_user_id
  ) {
    throw new Error(
      `params.customer_external_user_id must match order ${options.order_number} customer_external_user_id.`,
    );
  }
  return {
    requested_customer_external_user_id: options.requested_customer_external_user_id,
    order_customer_external_user_id: options.order_customer_external_user_id,
    acting_for_customer:
      options.actor_role === "agent" &&
      options.requested_customer_external_user_id === options.order_customer_external_user_id,
  };
}

function paymentsCallerAuditPayload(
  payload: Record<string, unknown>,
  options: {
    channel: string;
    actor_external_user_id: string;
    requested_customer_external_user_id: string | null;
    order_customer_external_user_id: string;
    acting_for_customer: boolean;
  },
): Record<string, unknown> {
  return callerAuditPayload(
    {
      ...payload,
      requested_customer_external_user_id: options.requested_customer_external_user_id,
      order_customer_external_user_id: options.order_customer_external_user_id,
      acting_for_customer: options.acting_for_customer,
    },
    {
      channel: options.channel,
      external_user_id: options.actor_external_user_id,
    },
  );
}

function serializePaymentsOrder(
  db: SqliteDatabase,
  orderRow: OrderRow,
): Record<string, unknown> {
  return serializeOrder(db, {
    ...orderRow,
    customer_external_user_id: orderRow.order_customer_external_user_id,
    customer_username: orderRow.order_customer_username,
  });
}

function createPaymentLink(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  ensureMockProviderEnabled(db);
  const orderNumber = normalizeText(options.params.order_number, "params.order_number");
  const paymentRequestId = normalizeText(
    options.params.payment_request_id,
    "params.payment_request_id",
  );
  const requestedCustomerExternalUserId = optionalText(options.params.customer_external_user_id);
  const orderRow = fetchOrderRow(db, { order_number: orderNumber });
  if (orderRow === null) {
    return invalidResponse("not_found", `Order ${orderNumber} was not found.`);
  }

  const actorRole = requireStoreRepresentativeRole(db, {
    channel: options.channel,
    actor_external_user_id: options.actor_external_user_id,
  });
  const customerContext = requireCustomerExecutionContext({
    command_code: "payments.create_payment_link",
    actor_role: actorRole,
    order_number: orderNumber,
    requested_customer_external_user_id: requestedCustomerExternalUserId,
    order_customer_external_user_id: orderRow.order_customer_external_user_id,
  });

  const existingByRequest = findPaymentByRequestId(db, {
    order_id: orderRow.id,
    payment_request_id: paymentRequestId,
  });
  if (existingByRequest !== null) {
    const refreshedOrder = fetchOrderRow(db, { order_id: orderRow.id });
    if (refreshedOrder === null) {
      throw new Error(`Order ${orderNumber} was not found after replay lookup.`);
    }
    return {
      status: "created",
      reply: `Reused existing mock payment link for order ${orderNumber}.`,
      idempotent_replay: true,
      payment: serializePayment(existingByRequest),
      order: serializePaymentsOrder(db, refreshedOrder),
    };
  }

  const pendingPayment = latestPendingPayment(db, { order_id: orderRow.id });
  if (
    pendingPayment !== null &&
    orderRow.status === "pending_payment" &&
    orderRow.reserved_until !== null
  ) {
    return {
      status: "created",
      reply: `Loaded existing pending payment link for order ${orderNumber}.`,
      idempotent_replay: true,
      payment: serializePayment(pendingPayment),
      order: serializePaymentsOrder(db, orderRow),
    };
  }

  if (orderRow.status !== "draft") {
    return invalidResponse(
      "invalid_state",
      `Order ${orderNumber} cannot create a payment link from status ${orderRow.status}.`,
    );
  }

  const paymentReference = nextPaymentReference(db, {
    order_id: orderRow.id,
    order_number: orderNumber,
  });
  const paymentLinkUrl = mockPaymentLinkUrl(paymentReference);
  const reservedUntil = futureUtcTimestamp(PAYMENT_RESERVATION_TTL_MINUTES);

  const paymentInsert = execute(
    db,
    `
      INSERT INTO payments(
        order_id,
        provider,
        provider_reference,
        payment_link_url,
        status,
        amount_minor,
        currency,
        metadata_json
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `,
    [
      orderRow.id,
      MOCK_PROVIDER,
      paymentReference,
      paymentLinkUrl,
      orderRow.total_minor,
      orderRow.currency,
      paymentWithMetadata(null, { payment_request_id: paymentRequestId }),
    ],
  );
  execute(
    db,
    `
      UPDATE orders
      SET status = 'pending_payment',
          reserved_until = ?
      WHERE id = ?
    `,
    [reservedUntil, orderRow.id],
  );
  const reserveMovementCount = reserveOrderItems(db, { order_id: orderRow.id });
  syncLowStockForOrder(db, { order_id: orderRow.id });
  recordAuditEvent(db, {
    event_type: "payments.payment_link_created",
    actor_type: "caller",
    actor_id: callerActorId(options.channel, options.actor_external_user_id),
    entity_type: "payment",
    entity_id: paymentReference,
    idempotency_key: `payments.create_link:payment_request_id=${paymentRequestId}`,
    payload: paymentsCallerAuditPayload(
      {
        order_number: orderNumber,
        payment_id: paymentInsert.lastInsertRowid,
        payment_request_id: paymentRequestId,
        reserved_until: reservedUntil,
      },
      {
        channel: options.channel,
        actor_external_user_id: options.actor_external_user_id,
        requested_customer_external_user_id: customerContext.requested_customer_external_user_id,
        order_customer_external_user_id: customerContext.order_customer_external_user_id,
        acting_for_customer: customerContext.acting_for_customer,
      },
    ),
  });
  recordAuditEvent(db, {
    event_type: "orders.order_status_changed",
    actor_type: "caller",
    actor_id: callerActorId(options.channel, options.actor_external_user_id),
    entity_type: "order",
    entity_id: orderNumber,
    payload: callerAuditPayload(
      {
        from_status: "draft",
        to_status: "pending_payment",
        payment_reference: paymentReference,
      },
      {
        channel: options.channel,
        external_user_id: options.actor_external_user_id,
      },
    ),
  });

  const paymentRow = fetchPaymentByReference(db, paymentReference);
  const refreshedOrder = fetchOrderRow(db, { order_id: orderRow.id });
  if (paymentRow === null || refreshedOrder === null) {
    throw new Error(`Payment link state was not found after create for ${orderNumber}.`);
  }
  return {
    status: "created",
    reply: `Created mock payment link for order ${orderNumber}.`,
    payment: serializePayment(paymentRow),
    order: serializePaymentsOrder(db, refreshedOrder),
    inventory_actions: {
      reserve_movement_count: reserveMovementCount,
    },
  };
}

function confirmMockPaid(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  ensureMockProviderEnabled(db);
  const paymentReference = normalizeText(
    options.params.payment_reference,
    "params.payment_reference",
  );
  const requestedCustomerExternalUserId = optionalText(options.params.customer_external_user_id);
  const paymentRow = fetchPaymentByReference(db, paymentReference);
  if (paymentRow === null) {
    return invalidResponse("not_found", `Payment ${paymentReference} was not found.`);
  }

  const orderRow = fetchOrderRow(db, { order_id: paymentRow.order_id });
  if (orderRow === null) {
    throw new Error(`Order ${paymentRow.order_id} was not found.`);
  }
  const actorRole = requireStoreRepresentativeRole(db, {
    channel: options.channel,
    actor_external_user_id: options.actor_external_user_id,
  });
  const customerContext = requireCustomerExecutionContext({
    command_code: "payments.confirm_mock_paid",
    actor_role: actorRole,
    order_number: orderRow.order_number,
    requested_customer_external_user_id: requestedCustomerExternalUserId,
    order_customer_external_user_id: orderRow.order_customer_external_user_id,
  });

  if (paymentRow.status === "paid") {
    return {
      status: "paid",
      reply: `Mock payment ${paymentReference} is already paid.`,
      idempotent_replay: true,
      payment: serializePayment(paymentRow),
      order: serializePaymentsOrder(db, orderRow),
    };
  }

  if (
    orderRow.status !== "pending_payment" ||
    !PAYMENT_REUSABLE_STATUSES.has(paymentRow.status)
  ) {
    return invalidResponse(
      "invalid_state",
      `Payment ${paymentReference} cannot be confirmed from payment=${paymentRow.status} and order=${orderRow.status}.`,
    );
  }

  const nowTimestamp = nowUtcTimestamp();
  execute(
    db,
    `
      UPDATE payments
      SET status = 'paid',
          paid_at = COALESCE(paid_at, ?)
      WHERE id = ?
    `,
    [nowTimestamp, paymentRow.id],
  );
  execute(
    db,
    `
      UPDATE orders
      SET status = 'paid',
          reserved_until = NULL,
          paid_at = COALESCE(paid_at, ?)
      WHERE id = ?
    `,
    [nowTimestamp, orderRow.id],
  );
  const commitStats = commitOrderReservation(db, {
    order_id: orderRow.id,
    payment_reference: paymentReference,
  });
  syncLowStockForOrder(db, { order_id: orderRow.id });
  recordAuditEvent(db, {
    event_type: "payments.payment_paid",
    actor_type: "caller",
    actor_id: callerActorId(options.channel, options.actor_external_user_id),
    entity_type: "payment",
    entity_id: paymentReference,
    idempotency_key: `payments.confirm_paid:payment_reference=${paymentReference}`,
    payload: paymentsCallerAuditPayload(
      { order_number: orderRow.order_number },
      {
        channel: options.channel,
        actor_external_user_id: options.actor_external_user_id,
        requested_customer_external_user_id: customerContext.requested_customer_external_user_id,
        order_customer_external_user_id: customerContext.order_customer_external_user_id,
        acting_for_customer: customerContext.acting_for_customer,
      },
    ),
  });
  recordAuditEvent(db, {
    event_type: "orders.order_status_changed",
    actor_type: "caller",
    actor_id: callerActorId(options.channel, options.actor_external_user_id),
    entity_type: "order",
    entity_id: orderRow.order_number,
    payload: callerAuditPayload(
      {
        from_status: "pending_payment",
        to_status: "paid",
        payment_reference: paymentReference,
      },
      {
        channel: options.channel,
        external_user_id: options.actor_external_user_id,
      },
    ),
  });

  const refreshedPayment = fetchPaymentByReference(db, paymentReference);
  const refreshedOrder = fetchOrderRow(db, { order_id: orderRow.id });
  if (refreshedPayment === null || refreshedOrder === null) {
    throw new Error(`Payment ${paymentReference} state was not found after confirm.`);
  }
  return {
    status: "paid",
    reply: `Confirmed mock payment ${paymentReference} as paid.`,
    payment: serializePayment(refreshedPayment),
    order: serializePaymentsOrder(db, refreshedOrder),
    inventory_actions: commitStats,
  };
}

function refundMockPayment(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  ensureMockProviderEnabled(db);
  requireOwner(db, {
    channel: options.channel,
    external_user_id: options.actor_external_user_id,
  });
  const orderNumber = normalizeText(options.params.order_number, "params.order_number");
  const refundReference = normalizeText(
    options.params.refund_reference,
    "params.refund_reference",
  );
  const orderRow = fetchOrderRow(db, { order_number: orderNumber });
  if (orderRow === null) {
    return invalidResponse("not_found", `Order ${orderNumber} was not found.`);
  }

  const existingRefund = findPaymentByRefundReference(db, {
    order_id: orderRow.id,
    refund_reference: refundReference,
  });
  if (existingRefund !== null) {
    const refreshedOrder = fetchOrderRow(db, { order_id: orderRow.id });
    if (refreshedOrder === null) {
      throw new Error(`Order ${orderNumber} was not found after refund replay.`);
    }
    return {
      status: "refunded",
      reply: `Refund ${refundReference} was already applied.`,
      idempotent_replay: true,
      payment: serializePayment(existingRefund),
      order: serializePaymentsOrder(db, refreshedOrder),
    };
  }

  const paymentRow = latestPaidLikePayment(db, { order_id: orderRow.id });
  if (paymentRow === null) {
    return invalidResponse(
      "invalid_state",
      `Order ${orderNumber} has no paid payment that can be refunded.`,
    );
  }
  if (orderRow.status !== "paid" || paymentRow.status !== "paid") {
    return invalidResponse(
      "invalid_state",
      `Order ${orderNumber} cannot be refunded from status ${orderRow.status}.`,
    );
  }

  const nowTimestamp = nowUtcTimestamp();
  execute(
    db,
    `
      UPDATE payments
      SET status = 'refunded',
          refunded_at = COALESCE(refunded_at, ?),
          metadata_json = ?
      WHERE id = ?
    `,
    [
      nowTimestamp,
      paymentWithMetadata(paymentRow, { refund_reference: refundReference }),
      paymentRow.id,
    ],
  );
  execute(
    db,
    `
      UPDATE orders
      SET status = 'refunded',
          refunded_at = COALESCE(refunded_at, ?)
      WHERE id = ?
    `,
    [nowTimestamp, orderRow.id],
  );
  const refundStats = restockRefundedOrder(db, {
    order_id: orderRow.id,
    refund_reference: refundReference,
  });
  syncLowStockForOrder(db, { order_id: orderRow.id });
  recordAuditEvent(db, {
    event_type: "payments.payment_refunded",
    actor_type: "owner",
    actor_id: options.actor_external_user_id,
    entity_type: "payment",
    entity_id: paymentRow.provider_reference,
    idempotency_key: `payments.refund:refund_reference=${refundReference}`,
    payload: {
      order_number: orderNumber,
      refund_reference: refundReference,
    },
  });
  recordAuditEvent(db, {
    event_type: "orders.order_status_changed",
    actor_type: "owner",
    actor_id: options.actor_external_user_id,
    entity_type: "order",
    entity_id: orderNumber,
    payload: {
      from_status: "paid",
      to_status: "refunded",
      refund_reference: refundReference,
    },
  });

  const refreshedPayment = fetchPaymentByReference(db, paymentRow.provider_reference);
  const refreshedOrder = fetchOrderRow(db, { order_id: orderRow.id });
  if (refreshedPayment === null || refreshedOrder === null) {
    throw new Error(`Refund state for order ${orderNumber} was not found after update.`);
  }
  return {
    status: "refunded",
    reply: `Refunded paid order ${orderNumber}.`,
    payment: serializePayment(refreshedPayment),
    order: serializePaymentsOrder(db, refreshedOrder),
    inventory_actions: refundStats,
  };
}

export function handlePayments(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const commandCode = String(context.command_code ?? "").trim().toLowerCase();
  if (!PAYMENT_COMMANDS.has(commandCode)) {
    return invalidResponse("invalid_intent", `Unsupported payments intent: ${commandCode}`);
  }

  const user = isRecord(context.user) ? context.user : {};
  const params = context.params;
  const channel = String(context.channel ?? "telegram").trim() || "telegram";
  const actorExternalUserId = String(user.external_user_id ?? "").trim();
  if (!actorExternalUserId && commandCode !== "payments.whoami") {
    return invalidResponse("invalid_input", "user.external_user_id is required");
  }

  let normalizedParams: Record<string, unknown>;
  try {
    normalizedParams = requireParamsMapping(params);
  } catch (error) {
    return invalidResponse("invalid_input", error instanceof Error ? error.message : String(error));
  }

  const runtime = isRecord(context.runtime) ? context.runtime : {};
  const dbPath = String(runtime.db_path ?? DEFAULT_DB_PATH);
  const db = ensureDatabase(dbPath);

  try {
    return db.transaction(() => {
      expireReservations(db);

      if (commandCode === "payments.whoami") {
        const agent = queryOne<{ external_user_id: string }>(
          db,
          `
            SELECT external_user_id
            FROM identities
            WHERE channel = ? AND role = 'agent' AND is_active = 1
            LIMIT 1
          `,
          [channel],
        );
        if (agent !== null) {
          return {
            status: "found",
            reply: `Your Agent Identity -> Channel: ${channel}, Agent ID: ${agent.external_user_id}`,
          };
        }
        return invalidResponse("not_found", `No active agent found for channel ${channel}.`);
      }
      if (commandCode === "payments.create_payment_link") {
        return createPaymentLink(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
        });
      }
      if (commandCode === "payments.confirm_mock_paid") {
        return confirmMockPaid(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
        });
      }
      if (commandCode === "payments.refund_mock_payment") {
        return refundMockPayment(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
        });
      }
      return invalidResponse("invalid_intent", `Unsupported payments intent: ${commandCode}`);
    })();
  } catch (error) {
    if (error instanceof PermissionError) {
      return invalidResponse("forbidden", error.message);
    }
    if (error instanceof InvalidStateError) {
      return invalidResponse("invalid_state", error.message);
    }
    if (error instanceof Error) {
      return invalidResponse("invalid_input", error.message);
    }
    return invalidResponse("conflict", `Could not persist payment changes: ${String(error)}`);
  } finally {
    db.close();
  }
}
