import {
  DEFAULT_DB_PATH,
  ensureDatabase,
  execute,
  lastInsertRowidAsNumber,
  queryAll,
  queryOne,
  recordAuditEvent,
  type SqliteDatabase,
} from "../db/sqlite.js";
import {
  fetchCustomerByIdentity,
  upsertCustomerIdentity,
} from "./customer_store.js";
import {
  DATE_INVENTORY_MODE,
  expireReservations,
  getSellableQuantity,
  releaseOrderReservation,
  syncLowStockForOrder,
} from "./inventory.js";
import {
  coercePositiveInt,
  invalidResponse,
  normalizeText,
  optionalText,
  parseDateField,
  requireMapping,
  requireParamsMapping,
} from "./runtime.js";
import { addDays, dateRangeExclusiveEnd, formatDateOnly } from "./time.js";
import { isRecord } from "./types.js";
import { createUuid } from "./uuid.js";

const ORDER_COMMANDS = new Set([
  "orders.create_session_draft",
  "orders.show_my_orders",
  "orders.list_orders",
  "orders.show_order",
  "orders.cancel_order",
]);
const ORDER_STATUS_VALUES = new Set([
  "draft",
  "pending_payment",
  "paid",
  "cancelled",
  "refunded",
  "fulfilled",
]);
const CANCELLABLE_STATUSES = new Set(["draft", "pending_payment"]);
const FORBIDDEN_SESSION_FIELDS = new Set([
  "budget_per_night",
  "guests",
  "room_type_intent",
]);
const ORDER_NUMBER_PATTERN = /(\d+)$/;

interface IdentityRow {
  id: number;
}

interface CustomerRow {
  id: number;
}

interface SkuRow {
  id: number;
  sku_code: string;
  title: string;
  price_minor: number;
  currency: string;
  inventory_mode: string;
  stock_quantity: number;
  sellable_status: string;
}

interface OrderRow {
  id: number;
  customer_id: number | null;
  order_number: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  total_minor: number;
  reserved_until: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
  fulfilled_at: string | null;
  notes: string | null;
  session_id: string | null;
  booking_contact_name: string | null;
  booking_contact_phone: string | null;
  customer_external_user_id: string | null;
  customer_username: string | null;
}

interface OrderItemRow {
  sku_code: string | null;
  sku_title: string;
  unit_price_minor: number;
  currency: string;
  quantity: number;
  line_total_minor: number;
  check_in_date: string | null;
  check_out_date: string | null;
}

interface PreparedItem {
  sku: SkuRow;
  quantity: number;
  check_in_date: Date | null;
  check_out_date: Date | null;
  line_total_minor: number;
}

function validateStatusFilter(value: unknown): string | null {
  const normalized = optionalText(value);
  if (normalized === null) {
    return null;
  }
  const status = normalized.toLowerCase();
  if (!ORDER_STATUS_VALUES.has(status)) {
    const allowed = [...ORDER_STATUS_VALUES].sort().join(", ");
    throw new Error(`params.status must be one of: ${allowed}`);
  }
  return status;
}

function generateSessionId(channel: string, externalUserId: string): string {
  return `${channel}:${externalUserId}:${createUuid()}`;
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

function fetchSkuByCode(db: SqliteDatabase, skuCode: string): SkuRow | null {
  return queryOne<SkuRow>(
    db,
    "SELECT * FROM skus WHERE sku_code = ? LIMIT 1",
    [skuCode],
  );
}

function nextOrderNumber(db: SqliteDatabase): string {
  let maxNumber = 1000;
  for (const row of queryAll<{ order_number: string }>(
    db,
    "SELECT order_number FROM orders ORDER BY id",
  )) {
    const match = ORDER_NUMBER_PATTERN.exec(String(row.order_number));
    if (match) {
      maxNumber = Math.max(maxNumber, Number.parseInt(match[1]!, 10));
    }
  }
  return `PO-${String(maxNumber + 1).padStart(4, "0")}`;
}

export function serializeOrder(
  db: SqliteDatabase,
  orderRow: OrderRow,
): Record<string, unknown> {
  const itemRows = queryAll<OrderItemRow>(
    db,
    `
      SELECT
        item.*,
        skus.sku_code AS sku_code
      FROM order_items AS item
      LEFT JOIN skus ON skus.id = item.sku_id
      WHERE item.order_id = ?
      ORDER BY item.id ASC
    `,
    [orderRow.id],
  );

  const items = itemRows.map((row) => {
    const payload: Record<string, unknown> = {
      sku_code: row.sku_code,
      sku_title: row.sku_title,
      unit_price_minor: row.unit_price_minor,
      currency: row.currency,
      quantity: row.quantity,
      line_total_minor: row.line_total_minor,
    };
    if (row.check_in_date !== null) {
      payload.check_in_date = row.check_in_date;
      payload.check_out_date = row.check_out_date;
    }
    return payload;
  });

  const orderPayload: Record<string, unknown> = {
    order_number: orderRow.order_number,
    status: orderRow.status,
    currency: orderRow.currency,
    subtotal_minor: orderRow.subtotal_minor,
    total_minor: orderRow.total_minor,
    reserved_until: orderRow.reserved_until,
    paid_at: orderRow.paid_at,
    cancelled_at: orderRow.cancelled_at,
    refunded_at: orderRow.refunded_at,
    fulfilled_at: orderRow.fulfilled_at,
    notes: orderRow.notes,
    items,
  };
  if (orderRow.session_id !== null) {
    orderPayload.session_id = orderRow.session_id;
  }
  if (
    orderRow.booking_contact_name !== null ||
    orderRow.booking_contact_phone !== null
  ) {
    orderPayload.booking_contact = {
      guest_name: orderRow.booking_contact_name,
      phone: orderRow.booking_contact_phone,
    };
  }
  if (orderRow.customer_external_user_id !== null) {
    orderPayload.customer = {
      external_user_id: orderRow.customer_external_user_id,
      username: orderRow.customer_username,
    };
  }
  return orderPayload;
}

function fetchOrderRowByNumber(
  db: SqliteDatabase,
  orderNumber: string,
): OrderRow | null {
  return queryOne<OrderRow>(
    db,
    `
      SELECT
        orders.*,
        customers.external_user_id AS customer_external_user_id,
        customers.username AS customer_username
      FROM orders
      LEFT JOIN customers ON customers.id = orders.customer_id
      WHERE orders.order_number = ?
      LIMIT 1
    `,
    [orderNumber],
  );
}

function listOrderRows(
  db: SqliteDatabase,
  options: { customer_id?: number | null; status?: string | null } = {},
): OrderRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.customer_id !== undefined && options.customer_id !== null) {
    clauses.push("orders.customer_id = ?");
    params.push(options.customer_id);
  }
  if (options.status !== undefined && options.status !== null) {
    clauses.push("orders.status = ?");
    params.push(options.status);
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return queryAll<OrderRow>(
    db,
    `
      SELECT
        orders.*,
        customers.external_user_id AS customer_external_user_id,
        customers.username AS customer_username
      FROM orders
      LEFT JOIN customers ON customers.id = orders.customer_id
      ${whereSql}
      ORDER BY orders.created_at DESC, orders.id DESC
    `,
    params,
  );
}

function ensureForbiddenSessionFieldsAbsent(params: Record<string, unknown>): void {
  for (const fieldName of [...FORBIDDEN_SESSION_FIELDS].sort()) {
    if (fieldName in params) {
      throw new Error(`params.${fieldName} is not accepted by orders runtime`);
    }
  }
}

function normalizeCreateItems(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const rawItems = params.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("params.items must be a non-empty array");
  }

  return rawItems.map((rawItem, index) => {
    const item = requireMapping(rawItem, `params.items[${index}]`);
    for (const fieldName of [...FORBIDDEN_SESSION_FIELDS].sort()) {
      if (fieldName in item) {
        throw new Error(
          `params.items[${index}].${fieldName} is not accepted by orders runtime`,
        );
      }
    }

    const skuCode = normalizeText(
      item.sku_code,
      `params.items[${index}].sku_code`,
    ).toUpperCase();
    const quantity = coercePositiveInt(
      item.quantity,
      `params.items[${index}].quantity`,
    );
    const checkInText = optionalText(item.check_in_date);
    const checkOutText = optionalText(item.check_out_date);
    if (Boolean(checkInText) !== Boolean(checkOutText)) {
      throw new Error(
        `params.items[${index}].check_in_date and check_out_date must be provided together`,
      );
    }

    const normalized: Record<string, unknown> = {
      sku_code: skuCode,
      quantity,
    };
    if (checkInText && checkOutText) {
      const checkInDate = parseDateField(
        checkInText,
        `params.items[${index}].check_in_date`,
      );
      const checkOutDate = parseDateField(
        checkOutText,
        `params.items[${index}].check_out_date`,
      );
      if (checkOutDate.getTime() <= checkInDate.getTime()) {
        throw new Error(
          `params.items[${index}].check_out_date must be after check_in_date`,
        );
      }
      normalized.check_in_date = checkInDate;
      normalized.check_out_date = checkOutDate;
    }
    return normalized;
  });
}

function validateStatusForCreate(
  db: SqliteDatabase,
  sku: SkuRow,
  item: Record<string, unknown>,
): [number, Date | null, Date | null] {
  const quantity = Number(item.quantity);
  const checkInDate = (item.check_in_date as Date | undefined) ?? null;
  const checkOutDate = (item.check_out_date as Date | undefined) ?? null;

  if (sku.inventory_mode === DATE_INVENTORY_MODE) {
    if (checkInDate === null || checkOutDate === null) {
      throw new Error(
        `params.items for ${sku.sku_code} must include check_in_date/check_out_date`,
      );
    }
    const nightlySellable = dateRangeExclusiveEnd(checkInDate, checkOutDate).map(
      (inventoryDate) =>
        getSellableQuantity(db, sku, { inventory_date: inventoryDate }),
    );
    const requestedWindowSellableQuantity =
      nightlySellable.length > 0 ? Math.min(...nightlySellable) : 0;
    return [requestedWindowSellableQuantity, checkInDate, checkOutDate];
  }

  if (checkInDate !== null || checkOutDate !== null) {
    throw new Error(
      `params.items for ${sku.sku_code} must not include dates for quantity inventory`,
    );
  }
  return [getSellableQuantity(db, sku), null, null];
}

function buildCreatePayload(
  db: SqliteDatabase,
  options: { normalized_items: Array<Record<string, unknown>> },
): [PreparedItem[], string] | Record<string, unknown> {
  const preparedItems: PreparedItem[] = [];
  const currencies = new Set<string>();

  for (const item of options.normalized_items) {
    const sku = fetchSkuByCode(db, String(item.sku_code));
    if (sku === null) {
      return invalidResponse("not_found", `SKU ${String(item.sku_code)} was not found.`);
    }

    const [availableQuantity, checkInDate, checkOutDate] = validateStatusForCreate(
      db,
      sku,
      item,
    );
    if (availableQuantity < Number(item.quantity)) {
      if (sku.inventory_mode === DATE_INVENTORY_MODE) {
        return invalidResponse(
          "conflict",
          `SKU ${sku.sku_code} only has ${availableQuantity} available for the requested stay.`,
        );
      }
      return invalidResponse(
        "conflict",
        `SKU ${sku.sku_code} only has ${availableQuantity} sellable now.`,
      );
    }

    currencies.add(sku.currency);
    let lineTotalMinor = sku.price_minor * Number(item.quantity);
    if (sku.inventory_mode === DATE_INVENTORY_MODE && checkInDate && checkOutDate) {
      lineTotalMinor *= dateRangeExclusiveEnd(checkInDate, checkOutDate).length;
    }
    preparedItems.push({
      sku,
      quantity: Number(item.quantity),
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
      line_total_minor: lineTotalMinor,
    });
  }

  if (currencies.size !== 1) {
    return invalidResponse("invalid_input", "All order items must use the same currency.");
  }

  return [preparedItems, [...currencies][0]!];
}

function createSessionDraft(
  db: SqliteDatabase,
  options: {
    channel: string;
    external_user_id: string;
    username: string | null;
    params: Record<string, unknown>;
    is_owner: boolean;
  },
): Record<string, unknown> {
  if (options.is_owner) {
    return invalidResponse(
      "forbidden",
      "Owners should use owner-side order operations instead of create_session_draft.",
    );
  }

  ensureForbiddenSessionFieldsAbsent(options.params);
  const sessionId =
    optionalText(options.params.session_id) ??
    generateSessionId(options.channel, options.external_user_id);
  const bookingContact = requireMapping(
    options.params.booking_contact,
    "params.booking_contact",
  );
  const guestName = normalizeText(
    bookingContact.guest_name,
    "params.booking_contact.guest_name",
  );
  const phone = normalizeText(
    bookingContact.phone,
    "params.booking_contact.phone",
  );
  const notes = optionalText(options.params.notes);
  const normalizedItems = normalizeCreateItems(options.params);

  const resolved = buildCreatePayload(db, { normalized_items: normalizedItems });
  if (!Array.isArray(resolved)) {
    return resolved;
  }
  const [preparedItems, currency] = resolved;

  const customer = upsertCustomerIdentity(db, {
    channel: options.channel,
    external_user_id: options.external_user_id,
    username: options.username,
  });
  const orderNumber = nextOrderNumber(db);
  const subtotalMinor = preparedItems.reduce(
    (sum, item) => sum + item.line_total_minor,
    0,
  );

  const insert = execute(
    db,
    `
      INSERT INTO orders(
        order_number,
        customer_id,
        source_channel,
        status,
        currency,
        subtotal_minor,
        total_minor,
        notes,
        session_id,
        booking_contact_name,
        booking_contact_phone
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      orderNumber,
      customer.id,
      options.channel,
      currency,
      subtotalMinor,
      subtotalMinor,
      notes,
      sessionId,
      guestName,
      phone,
    ],
  );
  const orderId = lastInsertRowidAsNumber(insert);

  for (const item of preparedItems) {
    execute(
      db,
      `
        INSERT INTO order_items(
          order_id,
          sku_id,
          sku_title,
          unit_price_minor,
          currency,
          quantity,
          line_total_minor,
          check_in_date,
          check_out_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        orderId,
        item.sku.id,
        item.sku.title,
        item.sku.price_minor,
        item.sku.currency,
        item.quantity,
        item.line_total_minor,
        item.check_in_date ? formatDateOnly(item.check_in_date) : null,
        item.check_out_date ? formatDateOnly(item.check_out_date) : null,
      ],
    );
  }

  recordAuditEvent(db, {
    event_type: "orders.order_draft_created",
    actor_type: "customer",
    actor_id: options.external_user_id,
    entity_type: "order",
    entity_id: orderNumber,
    payload: {
      customer_external_user_id: options.external_user_id,
      item_count: preparedItems.length,
      session_id: sessionId,
    },
  });

  const orderRow = fetchOrderRowByNumber(db, orderNumber);
  if (orderRow === null) {
    throw new Error(`Order ${orderNumber} was not found after create.`);
  }
  return {
    status: "created",
    reply: `Created draft order ${orderNumber}.`,
    audit_event_type: "orders.order_draft_created",
    order: serializeOrder(db, orderRow),
  };
}

function showMyOrders(
  db: SqliteDatabase,
  options: {
    channel: string;
    external_user_id: string;
    is_owner: boolean;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  if (options.is_owner) {
    return invalidResponse("forbidden", "Owners should use orders.list_orders instead.");
  }

  const status = validateStatusFilter(options.params.status);
  const customer = fetchCustomerByIdentity(db, {
    channel: options.channel,
    external_user_id: options.external_user_id,
  }) as CustomerRow | null;
  if (customer === null) {
    return { status: "listed", reply: "Loaded 0 order(s).", orders: [] };
  }
  const rows = listOrderRows(db, { customer_id: customer.id, status });
  return {
    status: "listed",
    reply: `Loaded ${rows.length} order(s).`,
    orders: rows.map((row) => serializeOrder(db, row)),
  };
}

function listOrders(
  db: SqliteDatabase,
  options: { is_owner: boolean; params: Record<string, unknown> },
): Record<string, unknown> {
  if (!options.is_owner) {
    return invalidResponse("forbidden", "Only the active owner can list all orders.");
  }
  const status = validateStatusFilter(options.params.status);
  const rows = listOrderRows(db, { status });
  return {
    status: "listed",
    reply: `Loaded ${rows.length} order(s).`,
    orders: rows.map((row) => serializeOrder(db, row)),
  };
}

function showOrder(
  db: SqliteDatabase,
  options: {
    channel: string;
    external_user_id: string;
    is_owner: boolean;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  const orderNumber = normalizeText(options.params.order_number, "params.order_number");
  const orderRow = fetchOrderRowByNumber(db, orderNumber);
  if (orderRow === null) {
    return invalidResponse("not_found", `Order ${orderNumber} was not found.`);
  }

  if (!options.is_owner) {
    const customer = fetchCustomerByIdentity(db, {
      channel: options.channel,
      external_user_id: options.external_user_id,
    }) as CustomerRow | null;
    if (customer === null || customer.id !== orderRow.customer_id) {
      return invalidResponse("forbidden", "You can only view your own orders.");
    }
  }

  return {
    status: "found",
    reply: `Loaded order ${orderNumber}.`,
    order: serializeOrder(db, orderRow),
  };
}

function cancelOrder(
  db: SqliteDatabase,
  options: {
    channel: string;
    external_user_id: string;
    is_owner: boolean;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  const orderNumber = normalizeText(options.params.order_number, "params.order_number");
  const reason = optionalText(options.params.reason) ?? "manual_cancel";
  const orderRow = fetchOrderRowByNumber(db, orderNumber);
  if (orderRow === null) {
    return invalidResponse("not_found", `Order ${orderNumber} was not found.`);
  }

  const actorType = options.is_owner ? "owner" : "customer";
  if (!options.is_owner) {
    const customer = fetchCustomerByIdentity(db, {
      channel: options.channel,
      external_user_id: options.external_user_id,
    }) as CustomerRow | null;
    if (customer === null || customer.id !== orderRow.customer_id) {
      return invalidResponse("forbidden", "You can only cancel your own orders.");
    }
  }

  if (!CANCELLABLE_STATUSES.has(orderRow.status)) {
    return invalidResponse(
      "invalid_state",
      `Order ${orderNumber} cannot be cancelled from status ${orderRow.status}.`,
    );
  }

  execute(
    db,
    `
      UPDATE orders
      SET status = 'cancelled',
          reserved_until = NULL,
          cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `,
    [orderRow.id],
  );
  if (orderRow.status === "pending_payment") {
    releaseOrderReservation(db, {
      order_id: orderRow.id,
      reason,
    });
    syncLowStockForOrder(db, { order_id: orderRow.id });
  }
  recordAuditEvent(db, {
    event_type: "orders.order_cancelled",
    actor_type: actorType,
    actor_id: options.external_user_id,
    entity_type: "order",
    entity_id: orderNumber,
    payload: { reason },
  });
  recordAuditEvent(db, {
    event_type: "orders.order_status_changed",
    actor_type: actorType,
    actor_id: options.external_user_id,
    entity_type: "order",
    entity_id: orderNumber,
    payload: {
      from_status: orderRow.status,
      to_status: "cancelled",
      reason,
    },
  });

  const refreshed = fetchOrderRowByNumber(db, orderNumber);
  if (refreshed === null) {
    throw new Error(`Order ${orderNumber} was not found after cancel.`);
  }
  return {
    status: "cancelled",
    reply: `Cancelled order ${orderNumber}.`,
    audit_event_type: "orders.order_cancelled",
    order: serializeOrder(db, refreshed),
  };
}

export function handleOrders(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const commandCode = String(context.command_code ?? "").trim().toLowerCase();
  if (!ORDER_COMMANDS.has(commandCode)) {
    return invalidResponse("invalid_intent", `Unsupported orders intent: ${commandCode}`);
  }

  const user = isRecord(context.user) ? context.user : {};
  const params = context.params;
  const channel = String(context.channel ?? "telegram").trim() || "telegram";
  const externalUserId = String(user.external_user_id ?? "").trim();
  if (!externalUserId) {
    return invalidResponse("invalid_input", "user.external_user_id is required");
  }

  const username = optionalText(user.username);
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
      const owner = fetchActiveOwner(db, {
        channel,
        external_user_id: externalUserId,
      });
      const isOwner = owner !== null;

      if (commandCode === "orders.create_session_draft") {
        return createSessionDraft(db, {
          channel,
          external_user_id: externalUserId,
          username,
          params: normalizedParams,
          is_owner: isOwner,
        });
      }
      if (commandCode === "orders.show_my_orders") {
        return showMyOrders(db, {
          channel,
          external_user_id: externalUserId,
          is_owner: isOwner,
          params: normalizedParams,
        });
      }
      if (commandCode === "orders.list_orders") {
        return listOrders(db, {
          is_owner: isOwner,
          params: normalizedParams,
        });
      }
      if (commandCode === "orders.show_order") {
        return showOrder(db, {
          channel,
          external_user_id: externalUserId,
          is_owner: isOwner,
          params: normalizedParams,
        });
      }
      if (commandCode === "orders.cancel_order") {
        return cancelOrder(db, {
          channel,
          external_user_id: externalUserId,
          is_owner: isOwner,
          params: normalizedParams,
        });
      }
      return invalidResponse("invalid_intent", `Unsupported orders intent: ${commandCode}`);
    })();
  } catch (error) {
    if (error instanceof Error && error.name === "SqliteError") {
      return invalidResponse("conflict", `Could not persist order changes: ${error.message}`);
    }
    if (error instanceof Error) {
      return invalidResponse("invalid_input", error.message);
    }
    return invalidResponse("invalid_input", String(error));
  } finally {
    db.close();
  }
}
