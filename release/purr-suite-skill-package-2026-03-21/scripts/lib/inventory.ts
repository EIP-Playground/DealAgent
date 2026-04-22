import {
  DEFAULT_DB_PATH,
  ensureDatabase,
  execute,
  queryAll,
  queryOne,
  recordAuditEvent,
  type SqliteDatabase,
} from "../db/sqlite.js";
import {
  addDays,
  dateRangeExclusiveEnd,
  dateRangeInclusive,
  formatDateOnly,
  parseDateOnly,
  todayLocalDateOnly,
} from "./time.js";
import {
  coerceBool,
  coerceInt,
  coerceNonNegativeInt,
  invalidResponse,
  normalizeText,
  optionalText,
  parseDateField,
  requireParamsMapping,
} from "./runtime.js";
import { isRecord } from "./types.js";

export const INVENTORY_INTENTS = new Set([
  "inventory.show_inventory",
  "inventory.show_stock",
  "inventory.adjust_stock",
  "inventory.set_date_stock",
  "inventory.show_low_stock",
]);
export const DATE_INVENTORY_MODE = "date_quantity";
export const QUANTITY_INVENTORY_MODE = "quantity";
export const LOW_STOCK_THRESHOLD = 2;
export const LOW_STOCK_SCAN_DAYS = 30;
export const DUPLICATE_CONFIRM_WINDOW_SECONDS = 60;

interface IdentityRow {
  id: number;
}

interface SkuRow {
  id: number;
  sku_code: string;
  title: string;
  inventory_mode: string;
  stock_quantity: number;
  sellable_status: string;
  restock_on_refund?: number;
}

interface SkuDateOverrideRow {
  stock_quantity_override: number;
  sellable_status_override: string | null;
}

interface OrderInventoryRow {
  id: number;
  order_id: number;
  sku_id: number;
  quantity: number;
  check_in_date: string | null;
  check_out_date: string | null;
  sku_code: string;
  inventory_mode: string;
  restock_on_refund: number;
}

interface LowStockAlertRow {
  id: number;
  status: string;
}

interface InventoryMovementRow {
  reference_key: string;
  created_at: string;
}

interface InventoryWindowRow {
  inventory_date: string;
  stock_quantity: number;
  sellable_status: string;
  reserved_quantity: number;
  sellable_quantity: number;
  low_stock: boolean;
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

function fetchSkuById(db: SqliteDatabase, skuId: number): SkuRow | null {
  return queryOne<SkuRow>(
    db,
    "SELECT * FROM skus WHERE id = ? LIMIT 1",
    [skuId],
  );
}

function fetchDateOverride(
  db: SqliteDatabase,
  options: { sku_id: number; inventory_date: Date },
): SkuDateOverrideRow | null {
  return queryOne<SkuDateOverrideRow>(
    db,
    `
      SELECT *
      FROM sku_date_overrides
      WHERE sku_id = ? AND inventory_date = ?
      LIMIT 1
    `,
    [options.sku_id, formatDateOnly(options.inventory_date)],
  );
}

function stockQuantitySemantics(inventoryMode: string): string {
  return inventoryMode === DATE_INVENTORY_MODE
    ? "default_nightly_capacity"
    : "on_hand_quantity";
}

export function buildManualAdjustReferenceKey(
  operationId: string,
  skuId: number,
): string {
  return `manual_adjust:operation_id=${operationId}:sku_id=${skuId}`;
}

export function buildSetDateStockReferenceKey(
  operationId: string,
  skuId: number,
  inventoryDate: Date,
): string {
  return [
    "set_date_stock",
    `operation_id=${operationId}`,
    `sku_id=${skuId}`,
    `inventory_date=${formatDateOnly(inventoryDate)}`,
  ].join(":");
}

export function buildOrderReferenceKey(
  action: string,
  options: {
    order_id: number;
    order_item_id: number;
    sku_id: number;
    inventory_date?: Date | null | undefined;
    payment_reference?: string | null | undefined;
    refund_reference?: string | null | undefined;
    reason?: string | null | undefined;
  },
): string {
  let parts: string[] = [action];
  if (options.payment_reference !== undefined && options.payment_reference !== null) {
    parts = [action, `payment_reference=${options.payment_reference}`];
  } else if (
    options.refund_reference !== undefined &&
    options.refund_reference !== null
  ) {
    parts = [action, `refund_reference=${options.refund_reference}`];
  }

  parts.push(
    `order_id=${options.order_id}`,
    `order_item_id=${options.order_item_id}`,
    `sku_id=${options.sku_id}`,
  );
  if (options.inventory_date !== undefined && options.inventory_date !== null) {
    parts.push(`inventory_date=${formatDateOnly(options.inventory_date)}`);
  }
  if (options.reason !== undefined && options.reason !== null) {
    parts.push(`reason=${options.reason}`);
  }
  return parts.join(":");
}

function effectiveSellableStatus(
  db: SqliteDatabase,
  sku: SkuRow,
  options: { inventory_date?: Date | null } = {},
): string {
  if (sku.inventory_mode !== DATE_INVENTORY_MODE || !options.inventory_date) {
    return String(sku.sellable_status);
  }

  const override = fetchDateOverride(db, {
    sku_id: sku.id,
    inventory_date: options.inventory_date,
  });
  if (override !== null && override.sellable_status_override) {
    return String(override.sellable_status_override);
  }
  return String(sku.sellable_status);
}

function effectiveStockQuantity(
  db: SqliteDatabase,
  sku: SkuRow,
  options: { inventory_date?: Date | null } = {},
): number {
  if (sku.inventory_mode !== DATE_INVENTORY_MODE || !options.inventory_date) {
    return Number(sku.stock_quantity);
  }

  const override = fetchDateOverride(db, {
    sku_id: sku.id,
    inventory_date: options.inventory_date,
  });
  if (override !== null) {
    return Number(override.stock_quantity_override);
  }
  return Number(sku.stock_quantity);
}

function applyDateOverrideDelta(
  db: SqliteDatabase,
  options: {
    sku_id: number;
    inventory_date: Date;
    delta: number;
    reason: string;
  },
): void {
  const sku = fetchSkuById(db, options.sku_id);
  if (sku === null) {
    throw new Error(`SKU ${options.sku_id} was not found.`);
  }

  const baseStock = Number(sku.stock_quantity);
  const override = fetchDateOverride(db, options);
  const sellableStatusOverride =
    override !== null ? override.sellable_status_override : null;
  const currentStock =
    override !== null ? Number(override.stock_quantity_override) : baseStock;
  const newStock = currentStock + options.delta;
  if (newStock < 0) {
    throw new Error(
      `SKU ${sku.sku_code} does not have enough capacity on ${formatDateOnly(
        options.inventory_date,
      )}.`,
    );
  }
  if (newStock === baseStock && sellableStatusOverride === null) {
    execute(
      db,
      `
        DELETE FROM sku_date_overrides
        WHERE sku_id = ? AND inventory_date = ?
      `,
      [options.sku_id, formatDateOnly(options.inventory_date)],
    );
    return;
  }

  execute(
    db,
    `
      INSERT INTO sku_date_overrides(
        sku_id,
        inventory_date,
        stock_quantity_override,
        sellable_status_override,
        reason,
        created_by_owner_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sku_id, inventory_date) DO UPDATE SET
        stock_quantity_override = excluded.stock_quantity_override,
        sellable_status_override = excluded.sellable_status_override,
        reason = excluded.reason,
        created_by_owner_id = excluded.created_by_owner_id
    `,
    [
      options.sku_id,
      formatDateOnly(options.inventory_date),
      newStock,
      sellableStatusOverride,
      options.reason,
      null,
    ],
  );
}

function* iterScanDates(daysAhead = LOW_STOCK_SCAN_DAYS): Iterable<Date> {
  const today = todayLocalDateOnly();
  for (let offset = 0; offset < daysAhead; offset += 1) {
    yield addDays(today, offset);
  }
}

function fetchOrderInventoryRows(
  db: SqliteDatabase,
  options: { order_id: number },
): OrderInventoryRow[] {
  return queryAll<OrderInventoryRow>(
    db,
    `
      SELECT
        item.id,
        item.order_id,
        item.sku_id,
        item.quantity,
        item.check_in_date,
        item.check_out_date,
        skus.sku_code,
        skus.inventory_mode,
        skus.restock_on_refund
      FROM order_items AS item
      JOIN skus ON skus.id = item.sku_id
      WHERE item.order_id = ?
      ORDER BY item.id ASC
    `,
    [options.order_id],
  );
}

function movementDatesForItem(item: OrderInventoryRow): Array<Date | null> {
  if (item.inventory_mode !== DATE_INVENTORY_MODE) {
    return [null];
  }

  if (item.check_in_date === null || item.check_out_date === null) {
    throw new Error(
      `date_quantity order item ${item.id} is missing check_in_date/check_out_date`,
    );
  }

  const checkInDate = parseDateOnly(item.check_in_date, "check_in_date");
  const checkOutDate = parseDateOnly(item.check_out_date, "check_out_date");
  return [...dateRangeExclusiveEnd(checkInDate, checkOutDate)];
}

function insertOrderMovement(
  db: SqliteDatabase,
  options: {
    action: string;
    order_id: number;
    item: OrderInventoryRow;
    reason: string;
    payment_reference?: string | null;
    refund_reference?: string | null;
  },
): number {
  let inserted = 0;
  for (const inventoryDate of movementDatesForItem(options.item)) {
    const referenceKey = buildOrderReferenceKey(options.action, {
      order_id: options.order_id,
      order_item_id: options.item.id,
      sku_id: options.item.sku_id,
      inventory_date: inventoryDate,
      payment_reference: options.payment_reference,
      refund_reference: options.refund_reference,
      reason: options.action === "release" ? options.reason : null,
    });

    const result = execute(
      db,
      `
        INSERT OR IGNORE INTO inventory_movements(
          sku_id,
          order_id,
          movement_type,
          delta,
          reason,
          reference_key
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        options.item.sku_id,
        options.order_id,
        options.action,
        options.item.quantity,
        options.reason,
        referenceKey,
      ],
    );
    inserted += Math.max(result.changes, 0);
  }
  return inserted;
}

export function syncLowStockForOrder(
  db: SqliteDatabase,
  options: { order_id: number },
): void {
  const skuIds = new Set(
    queryAll<{ sku_id: number }>(
      db,
      "SELECT DISTINCT sku_id FROM order_items WHERE order_id = ?",
      [options.order_id],
    ).map((row) => row.sku_id),
  );
  for (const skuId of [...skuIds].sort((left, right) => left - right)) {
    const sku = fetchSkuById(db, skuId);
    if (sku !== null) {
      syncLowStockAlertsForSku(db, sku);
    }
  }
}

function recordAuditEventIgnoreDuplicates(
  db: SqliteDatabase,
  options: {
    event_type: string;
    actor_type: string;
    actor_id: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    idempotency_key?: string | null;
    payload?: Record<string, unknown> | null;
  },
): void {
  try {
    recordAuditEvent(db, options);
  } catch (error) {
    if (
      options.idempotency_key &&
      error instanceof Error &&
      error.message.includes("audit_events.idempotency_key")
    ) {
      return;
    }
    throw error;
  }
}

export function expireReservations(db: SqliteDatabase): number {
  const expiredOrders = queryAll<{ id: number; order_number: string }>(
    db,
    `
      SELECT id, order_number
      FROM orders
      WHERE status = 'pending_payment'
        AND reserved_until IS NOT NULL
        AND reserved_until < CURRENT_TIMESTAMP
      ORDER BY id
    `,
  );

  let released = 0;
  for (const order of expiredOrders) {
    execute(
      db,
      `
        UPDATE orders
        SET status = 'cancelled',
            reserved_until = NULL,
            cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP)
        WHERE id = ?
      `,
      [order.id],
    );
    released += releaseOrderReservation(db, {
      order_id: order.id,
      reason: "expired",
    });
    syncLowStockForOrder(db, { order_id: order.id });
    recordAuditEventIgnoreDuplicates(db, {
      event_type: "inventory.reservation_expired_released",
      actor_type: "system",
      actor_id: null,
      entity_type: "order",
      entity_id: String(order.id),
      idempotency_key: `inventory.expired_release:order_id=${order.id}`,
      payload: { order_number: order.order_number },
    });
  }
  return released;
}

export function getReservedQuantity(
  db: SqliteDatabase,
  sku: SkuRow,
  options: { inventory_date?: Date | null } = {},
): number {
  expireReservations(db);
  if (sku.inventory_mode === DATE_INVENTORY_MODE) {
    if (!options.inventory_date) {
      return 0;
    }
    const row = queryOne<{ reserved_quantity: number }>(
      db,
      `
        SELECT COALESCE(SUM(item.quantity), 0) AS reserved_quantity
        FROM order_items AS item
        JOIN orders ON orders.id = item.order_id
        WHERE item.sku_id = ?
          AND item.check_in_date IS NOT NULL
          AND item.check_out_date IS NOT NULL
          AND item.check_in_date <= ?
          AND item.check_out_date > ?
          AND orders.status = 'pending_payment'
          AND orders.reserved_until IS NOT NULL
          AND orders.reserved_until > CURRENT_TIMESTAMP
      `,
      [sku.id, formatDateOnly(options.inventory_date), formatDateOnly(options.inventory_date)],
    );
    return row?.reserved_quantity ?? 0;
  }

  const row = queryOne<{ reserved_quantity: number }>(
    db,
    `
      SELECT COALESCE(SUM(item.quantity), 0) AS reserved_quantity
      FROM order_items AS item
      JOIN orders ON orders.id = item.order_id
      WHERE item.sku_id = ?
        AND orders.status = 'pending_payment'
        AND orders.reserved_until IS NOT NULL
        AND orders.reserved_until > CURRENT_TIMESTAMP
    `,
    [sku.id],
  );
  return row?.reserved_quantity ?? 0;
}

export function getSellableQuantity(
  db: SqliteDatabase,
  sku: SkuRow,
  options: { inventory_date?: Date | null } = {},
): number {
  const status = effectiveSellableStatus(db, sku, options);
  if (status !== "active") {
    return 0;
  }
  const stockQuantity = effectiveStockQuantity(db, sku, options);
  const reservedQuantity = getReservedQuantity(db, sku, options);
  return Math.max(stockQuantity - reservedQuantity, 0);
}

function isDateLowStock(options: {
  base_stock: number;
  stock_quantity: number;
  sellable_status: string;
  sellable_quantity: number;
  reserved_quantity: number;
}): boolean {
  if (options.sellable_status !== "active") {
    return false;
  }
  if (options.sellable_quantity > LOW_STOCK_THRESHOLD) {
    return false;
  }
  if (options.reserved_quantity === 0 && options.stock_quantity === options.base_stock) {
    return false;
  }
  return true;
}

function dateLowStockRows(
  db: SqliteDatabase,
  sku: SkuRow,
  options: { days_ahead?: number } = {},
): InventoryWindowRow[] {
  const rows: InventoryWindowRow[] = [];
  const baseStock = sku.stock_quantity;
  for (const inventoryDate of iterScanDates(options.days_ahead ?? LOW_STOCK_SCAN_DAYS)) {
    const stockQuantity = effectiveStockQuantity(db, sku, { inventory_date: inventoryDate });
    const sellableStatus = effectiveSellableStatus(db, sku, { inventory_date: inventoryDate });
    const reservedQuantity = getReservedQuantity(db, sku, { inventory_date: inventoryDate });
    const sellableQuantity = getSellableQuantity(db, sku, { inventory_date: inventoryDate });
    rows.push({
      inventory_date: formatDateOnly(inventoryDate),
      stock_quantity: stockQuantity,
      sellable_status: sellableStatus,
      reserved_quantity: reservedQuantity,
      sellable_quantity: sellableQuantity,
      low_stock: isDateLowStock({
        base_stock: baseStock,
        stock_quantity: stockQuantity,
        sellable_status: sellableStatus,
        sellable_quantity: sellableQuantity,
        reserved_quantity: reservedQuantity,
      }),
    });
  }
  return rows;
}

function activeLowStockAlert(
  db: SqliteDatabase,
  options: { sku_id: number; inventory_date: string | null },
): LowStockAlertRow | null {
  return queryOne<LowStockAlertRow>(
    db,
    `
      SELECT *
      FROM low_stock_alerts
      WHERE sku_id = ?
        AND ((inventory_date IS NULL AND ? IS NULL) OR inventory_date = ?)
        AND status IN ('pending', 'sent')
      ORDER BY id DESC
      LIMIT 1
    `,
    [options.sku_id, options.inventory_date, options.inventory_date],
  );
}

function resolveLowStockAlerts(
  db: SqliteDatabase,
  options: { sku_id: number; inventory_date: string | null },
): void {
  execute(
    db,
    `
      UPDATE low_stock_alerts
      SET status = 'resolved',
          resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)
      WHERE sku_id = ?
        AND ((inventory_date IS NULL AND ? IS NULL) OR inventory_date = ?)
        AND status IN ('pending', 'sent')
    `,
    [options.sku_id, options.inventory_date, options.inventory_date],
  );
}

function createOrRefreshLowStockAlert(
  db: SqliteDatabase,
  options: {
    sku: SkuRow;
    inventory_date: string | null;
    sellable_quantity: number;
  },
): void {
  const existing = activeLowStockAlert(db, {
    sku_id: options.sku.id,
    inventory_date: options.inventory_date,
  });
  if (existing === null) {
    execute(
      db,
      `
        INSERT INTO low_stock_alerts(
          sku_id,
          inventory_date,
          inventory_mode,
          threshold,
          sellable_quantity,
          status
        ) VALUES (?, ?, ?, ?, ?, 'pending')
      `,
      [
        options.sku.id,
        options.inventory_date,
        options.sku.inventory_mode,
        LOW_STOCK_THRESHOLD,
        options.sellable_quantity,
      ],
    );
    recordAuditEventIgnoreDuplicates(db, {
      event_type: "inventory.low_stock_detected",
      actor_type: "system",
      actor_id: null,
      entity_type: "sku",
      entity_id: String(options.sku.sku_code),
      payload: {
        inventory_mode: options.sku.inventory_mode,
        inventory_date: options.inventory_date,
        sellable_quantity: options.sellable_quantity,
        threshold: LOW_STOCK_THRESHOLD,
      },
    });
    return;
  }

  execute(
    db,
    `
      UPDATE low_stock_alerts
      SET sellable_quantity = ?
      WHERE id = ?
    `,
    [options.sellable_quantity, existing.id],
  );
}

function syncLowStockAlertsForSku(
  db: SqliteDatabase,
  sku: SkuRow,
  options: { days_ahead?: number } = {},
): void {
  if (sku.inventory_mode === QUANTITY_INVENTORY_MODE) {
    const sellableQuantity = getSellableQuantity(db, sku);
    if (sku.sellable_status === "active" && sellableQuantity <= LOW_STOCK_THRESHOLD) {
      createOrRefreshLowStockAlert(db, {
        sku,
        inventory_date: null,
        sellable_quantity: sellableQuantity,
      });
      return;
    }

    if (activeLowStockAlert(db, { sku_id: sku.id, inventory_date: null }) !== null) {
      resolveLowStockAlerts(db, { sku_id: sku.id, inventory_date: null });
      recordAuditEventIgnoreDuplicates(db, {
        event_type: "inventory.low_stock_resolved",
        actor_type: "system",
        actor_id: null,
        entity_type: "sku",
        entity_id: String(sku.sku_code),
        payload: { inventory_mode: sku.inventory_mode },
      });
    }
    return;
  }

  for (const row of dateLowStockRows(db, sku, options)) {
    if (row.low_stock) {
      createOrRefreshLowStockAlert(db, {
        sku,
        inventory_date: row.inventory_date,
        sellable_quantity: row.sellable_quantity,
      });
    } else if (
      activeLowStockAlert(db, {
        sku_id: sku.id,
        inventory_date: row.inventory_date,
      }) !== null
    ) {
      resolveLowStockAlerts(db, {
        sku_id: sku.id,
        inventory_date: row.inventory_date,
      });
      recordAuditEventIgnoreDuplicates(db, {
        event_type: "inventory.low_stock_resolved",
        actor_type: "system",
        actor_id: null,
        entity_type: "sku",
        entity_id: String(sku.sku_code),
        payload: {
          inventory_mode: sku.inventory_mode,
          inventory_date: row.inventory_date,
        },
      });
    }
  }
}

export function listInventoryRows(db: SqliteDatabase): Record<string, unknown>[] {
  const rows = queryAll<SkuRow>(
    db,
    `
      SELECT *
      FROM skus
      ORDER BY created_at DESC, sku_code ASC
    `,
  );
  return rows.map((row) => serializeInventoryRow(db, row));
}

function serializeInventoryRow(
  db: SqliteDatabase,
  sku: SkuRow,
): Record<string, unknown> {
  const reservedQuantity = getReservedQuantity(db, sku);
  const sellableQuantity = getSellableQuantity(db, sku);
  const lowStock =
    sku.inventory_mode === DATE_INVENTORY_MODE
      ? dateLowStockRows(db, sku).some((row) => row.low_stock)
      : sku.sellable_status === "active" && sellableQuantity <= LOW_STOCK_THRESHOLD;
  return {
    sku_code: sku.sku_code,
    title: sku.title,
    inventory_mode: sku.inventory_mode,
    stock_quantity: sku.stock_quantity,
    stock_quantity_semantics: stockQuantitySemantics(sku.inventory_mode),
    sellable_status: sku.sellable_status,
    reserved_quantity: reservedQuantity,
    sellable_quantity: sellableQuantity,
    low_stock: lowStock,
    low_stock_threshold: LOW_STOCK_THRESHOLD,
  };
}

function showStockPayload(
  db: SqliteDatabase,
  sku: SkuRow,
  options: { date_from?: Date | null; date_to?: Date | null } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = serializeInventoryRow(db, sku);
  if (sku.inventory_mode !== DATE_INVENTORY_MODE) {
    return payload;
  }

  if (!options.date_from || !options.date_to) {
    payload.date_inventory_hint =
      "Provide params.date_from and params.date_to to inspect exact date-based stock.";
    return payload;
  }

  const baseStock = sku.stock_quantity;
  const rows = dateRangeInclusive(options.date_from, options.date_to).map(
    (inventoryDate) => {
      const stockQuantity = effectiveStockQuantity(db, sku, {
        inventory_date: inventoryDate,
      });
      const sellableStatus = effectiveSellableStatus(db, sku, {
        inventory_date: inventoryDate,
      });
      const reservedQuantity = getReservedQuantity(db, sku, {
        inventory_date: inventoryDate,
      });
      const sellableQuantity = getSellableQuantity(db, sku, {
        inventory_date: inventoryDate,
      });
      return {
        inventory_date: formatDateOnly(inventoryDate),
        stock_quantity: stockQuantity,
        sellable_status: sellableStatus,
        reserved_quantity: reservedQuantity,
        sellable_quantity: sellableQuantity,
        low_stock: isDateLowStock({
          base_stock: baseStock,
          stock_quantity: stockQuantity,
          sellable_status: sellableStatus,
          sellable_quantity: sellableQuantity,
          reserved_quantity: reservedQuantity,
        }),
      };
    },
  );

  payload.date_inventory = rows;
  payload.requested_window_sellable_quantity = rows.reduce(
    (lowest, row) => Math.min(lowest, row.sellable_quantity),
    Number.POSITIVE_INFINITY,
  );
  return payload;
}

function recentDuplicateManualAdjust(
  db: SqliteDatabase,
  options: {
    sku_id: number;
    owner_id: number;
    delta: number;
    reason: string;
  },
): InventoryMovementRow | null {
  return queryOne<InventoryMovementRow>(
    db,
    `
      SELECT *
      FROM inventory_movements
      WHERE movement_type = 'manual_adjust'
        AND sku_id = ?
        AND created_by_owner_id = ?
        AND delta = ?
        AND reason = ?
        AND created_at >= datetime('now', ?)
      ORDER BY id DESC
      LIMIT 1
    `,
    [
      options.sku_id,
      options.owner_id,
      options.delta,
      options.reason,
      `-${DUPLICATE_CONFIRM_WINDOW_SECONDS} seconds`,
    ],
  );
}

export function adjustStock(
  db: SqliteDatabase,
  options: {
    sku: SkuRow;
    owner_id: number;
    actor_external_user_id: string;
    delta: number;
    reason: string;
    operation_id: string;
    confirm_duplicate: boolean;
  },
): Record<string, unknown> {
  expireReservations(db);
  const referenceKey = buildManualAdjustReferenceKey(
    options.operation_id,
    options.sku.id,
  );
  const existing = queryOne<InventoryMovementRow>(
    db,
    `
      SELECT *
      FROM inventory_movements
      WHERE movement_type = 'manual_adjust'
        AND sku_id = ?
        AND reference_key = ?
      LIMIT 1
    `,
    [options.sku.id, referenceKey],
  );
  if (existing !== null) {
    const refreshed = fetchSkuByCode(db, options.sku.sku_code);
    if (refreshed === null) {
      throw new Error(`SKU ${options.sku.sku_code} was not found.`);
    }
    return {
      status: "adjusted",
      reply: `Manual stock adjustment for ${options.sku.sku_code} was already applied.`,
      sku: showStockPayload(db, refreshed),
      reference_key: referenceKey,
      idempotent_replay: true,
    };
  }

  const duplicate = recentDuplicateManualAdjust(db, {
    sku_id: options.sku.id,
    owner_id: options.owner_id,
    delta: options.delta,
    reason: options.reason,
  });
  if (duplicate !== null && !options.confirm_duplicate) {
    return {
      status: "needs_confirmation",
      reply:
        "A matching manual stock adjustment was recorded recently. Confirm if you really want to apply the same change again.",
      duplicate_check: {
        sku_code: options.sku.sku_code,
        delta: options.delta,
        reason: options.reason,
        matched_reference_key: duplicate.reference_key,
        matched_created_at: duplicate.created_at,
        window_seconds: DUPLICATE_CONFIRM_WINDOW_SECONDS,
      },
    };
  }

  const newStockQuantity = options.sku.stock_quantity + options.delta;
  if (newStockQuantity < 0) {
    return invalidResponse(
      "invalid_input",
      "Stock adjustment would make stock_quantity negative.",
    );
  }

  execute(db, "UPDATE skus SET stock_quantity = ? WHERE id = ?", [
    newStockQuantity,
    options.sku.id,
  ]);
  execute(
    db,
    `
      INSERT INTO inventory_movements(
        sku_id,
        movement_type,
        delta,
        reason,
        reference_key,
        created_by_owner_id
      ) VALUES (?, 'manual_adjust', ?, ?, ?, ?)
    `,
    [
      options.sku.id,
      options.delta,
      options.reason,
      referenceKey,
      options.owner_id,
    ],
  );
  recordAuditEventIgnoreDuplicates(db, {
    event_type: "inventory.stock_adjusted",
    actor_type: "owner",
    actor_id: options.actor_external_user_id,
    entity_type: "sku",
    entity_id: String(options.sku.sku_code),
    idempotency_key: referenceKey,
    payload: {
      inventory_mode: options.sku.inventory_mode,
      delta: options.delta,
      reason: options.reason,
      resulting_stock_quantity: newStockQuantity,
    },
  });
  const refreshed = fetchSkuByCode(db, options.sku.sku_code);
  if (refreshed === null) {
    throw new Error(`SKU ${options.sku.sku_code} was not found after adjustment.`);
  }
  syncLowStockAlertsForSku(db, refreshed);
  return {
    status: "adjusted",
    reply: `Stock updated for ${options.sku.sku_code}.`,
    sku: showStockPayload(db, refreshed),
    reference_key: referenceKey,
  };
}

export function setDateStock(
  db: SqliteDatabase,
  options: {
    sku: SkuRow;
    owner_id: number;
    actor_external_user_id: string;
    date_from: Date;
    date_to: Date;
    stock_quantity: number;
    reason: string;
    operation_id: string;
    sellable_status: string | null;
  },
): Record<string, unknown> {
  if (options.sku.inventory_mode !== DATE_INVENTORY_MODE) {
    return invalidResponse(
      "invalid_input",
      "set date stock is only available for SKUs with inventory_mode = date_quantity.",
    );
  }

  expireReservations(db);
  const days = dateRangeInclusive(options.date_from, options.date_to);
  for (const inventoryDay of days) {
    const inventoryDayText = formatDateOnly(inventoryDay);
    const key = buildSetDateStockReferenceKey(
      options.operation_id,
      options.sku.id,
      inventoryDay,
    );
    if (
      options.stock_quantity === options.sku.stock_quantity &&
      options.sellable_status === null
    ) {
      execute(
        db,
        `
          DELETE FROM sku_date_overrides
          WHERE sku_id = ? AND inventory_date = ?
        `,
        [options.sku.id, inventoryDayText],
      );
    } else {
      execute(
        db,
        `
          INSERT INTO sku_date_overrides(
            sku_id,
            inventory_date,
            stock_quantity_override,
            sellable_status_override,
            reason,
            created_by_owner_id
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(sku_id, inventory_date) DO UPDATE SET
            stock_quantity_override = excluded.stock_quantity_override,
            sellable_status_override = excluded.sellable_status_override,
            reason = excluded.reason,
            created_by_owner_id = excluded.created_by_owner_id
        `,
        [
          options.sku.id,
          inventoryDayText,
          options.stock_quantity,
          options.sellable_status,
          options.reason,
          options.owner_id,
        ],
      );
    }
    recordAuditEventIgnoreDuplicates(db, {
      event_type: "inventory.date_stock_set",
      actor_type: "owner",
      actor_id: options.actor_external_user_id,
      entity_type: "sku",
      entity_id: String(options.sku.sku_code),
      idempotency_key: key,
      payload: {
        inventory_date: inventoryDayText,
        stock_quantity: options.stock_quantity,
        sellable_status: options.sellable_status,
        reason: options.reason,
      },
    });
  }

  const refreshed = fetchSkuByCode(db, options.sku.sku_code);
  if (refreshed === null) {
    throw new Error(`SKU ${options.sku.sku_code} was not found after date update.`);
  }
  syncLowStockAlertsForSku(db, refreshed);
  return {
    status: "updated",
    reply: `Date stock updated for ${options.sku.sku_code}.`,
    sku: showStockPayload(db, refreshed, {
      date_from: options.date_from,
      date_to: options.date_to,
    }),
    days_updated: days.length,
  };
}

export function scanLowStockAlerts(
  db: SqliteDatabase,
  options: {
    mark_sent: boolean;
    days_ahead?: number;
  },
): Array<Record<string, unknown>> {
  expireReservations(db);
  const skus = queryAll<SkuRow>(
    db,
    `
      SELECT *
      FROM skus
      ORDER BY id
    `,
  );
  for (const sku of skus) {
    syncLowStockAlertsForSku(db, sku, {
      days_ahead: options.days_ahead ?? LOW_STOCK_SCAN_DAYS,
    });
  }

  const pending = queryAll<{
    id: number;
    sku_code: string;
    title: string;
    inventory_mode: string;
    inventory_date: string | null;
    threshold: number;
    sellable_quantity: number;
    status: string;
  }>(
    db,
    `
      SELECT alerts.*, skus.sku_code, skus.title
      FROM low_stock_alerts AS alerts
      JOIN skus ON skus.id = alerts.sku_id
      WHERE alerts.status = 'pending'
      ORDER BY alerts.detected_at, alerts.id
    `,
  );
  if (options.mark_sent && pending.length > 0) {
    for (const row of pending) {
      execute(
        db,
        `
          UPDATE low_stock_alerts
          SET status = 'sent',
              sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP)
          WHERE id = ?
        `,
        [row.id],
      );
    }
  }
  return pending.map((row) => ({
    sku_code: row.sku_code,
    title: row.title,
    inventory_mode: row.inventory_mode,
    inventory_date: row.inventory_date,
    threshold: row.threshold,
    sellable_quantity: row.sellable_quantity,
    status: options.mark_sent ? "sent" : row.status,
  }));
}

export function getCustomerAvailability(
  db: SqliteDatabase,
  sku: SkuRow,
  options: {
    check_in_date?: Date | null | undefined;
    check_out_date?: Date | null | undefined;
  } = {},
): Record<string, unknown> {
  if (sku.sellable_status !== "active") {
    return { availability_status: "hidden", availability_hint: null };
  }

  if (sku.inventory_mode === QUANTITY_INVENTORY_MODE) {
    const sellableQuantity = getSellableQuantity(db, sku);
    if (sellableQuantity <= 0) {
      return {
        availability_status: "unavailable",
        availability_hint: "Currently unavailable.",
      };
    }
    if (sellableQuantity <= LOW_STOCK_THRESHOLD) {
      return {
        availability_status: "only_a_few_left",
        availability_hint: "Only a few left.",
      };
    }
    return {
      availability_status: "available",
      availability_hint: "Available now.",
    };
  }

  if (Boolean(options.check_in_date) !== Boolean(options.check_out_date)) {
    throw new Error(
      "params.check_in_date and params.check_out_date must be provided together",
    );
  }

  if (!options.check_in_date || !options.check_out_date) {
    return {
      availability_status: "dates_required",
      availability_hint:
        "Provide check-in and check-out dates to confirm exact availability.",
    };
  }

  const nightlyRows = dateRangeExclusiveEnd(
    options.check_in_date,
    options.check_out_date,
  ).map((inventoryDay) =>
    getSellableQuantity(db, sku, { inventory_date: inventoryDay }),
  );
  const sellableQuantity =
    nightlyRows.length > 0 ? Math.min(...nightlyRows) : 0;
  if (sellableQuantity <= 0) {
    return {
      availability_status: "unavailable",
      availability_hint: "Unavailable for the requested stay dates.",
    };
  }
  if (sellableQuantity <= LOW_STOCK_THRESHOLD) {
    return {
      availability_status: "only_a_few_left",
      availability_hint: "Only a few left for the requested stay dates.",
    };
  }
  return {
    availability_status: "available",
    availability_hint: "Available for the requested stay dates.",
  };
}

export function reserveOrderItems(
  db: SqliteDatabase,
  options: { order_id: number },
): number {
  let inserted = 0;
  for (const item of fetchOrderInventoryRows(db, options)) {
    inserted += insertOrderMovement(db, {
      action: "reserve",
      order_id: options.order_id,
      item,
      reason: "pending_payment",
    });
  }
  return inserted;
}

export function releaseOrderReservation(
  db: SqliteDatabase,
  options: { order_id: number; reason: string },
): number {
  let inserted = 0;
  for (const item of fetchOrderInventoryRows(db, { order_id: options.order_id })) {
    inserted += insertOrderMovement(db, {
      action: "release",
      order_id: options.order_id,
      item,
      reason: options.reason,
    });
  }
  return inserted;
}

export function commitOrderReservation(
  db: SqliteDatabase,
  options: { order_id: number; payment_reference: string },
): { movement_count: number; quantity_stock_updates: number } {
  let movementCount = 0;
  let quantityStockUpdates = 0;
  for (const item of fetchOrderInventoryRows(db, { order_id: options.order_id })) {
    movementCount += insertOrderMovement(db, {
      action: "commit",
      order_id: options.order_id,
      item,
      reason: "payment_captured",
      payment_reference: options.payment_reference,
    });
    if (item.inventory_mode === QUANTITY_INVENTORY_MODE) {
      const sku = fetchSkuById(db, item.sku_id);
      if (sku === null) {
        throw new Error(`SKU ${item.sku_id} was not found.`);
      }
      const currentStockQuantity = sku.stock_quantity;
      if (currentStockQuantity < item.quantity) {
        throw new Error(
          `SKU ${sku.sku_code} no longer has enough on-hand stock to commit.`,
        );
      }
      execute(
        db,
        `
          UPDATE skus
          SET stock_quantity = stock_quantity - ?
          WHERE id = ?
        `,
        [item.quantity, item.sku_id],
      );
      quantityStockUpdates += 1;
    } else if (item.inventory_mode === DATE_INVENTORY_MODE) {
      for (const inventoryDate of movementDatesForItem(item)) {
        if (inventoryDate === null) {
          continue;
        }
        applyDateOverrideDelta(db, {
          sku_id: item.sku_id,
          inventory_date: inventoryDate,
          delta: -item.quantity,
          reason: "system_commit",
        });
      }
    }
  }
  return {
    movement_count: movementCount,
    quantity_stock_updates: quantityStockUpdates,
  };
}

export function restockRefundedOrder(
  db: SqliteDatabase,
  options: { order_id: number; refund_reference: string },
): { movement_count: number; quantity_stock_updates: number } {
  let movementCount = 0;
  let quantityStockUpdates = 0;
  for (const item of fetchOrderInventoryRows(db, { order_id: options.order_id })) {
    if (!Boolean(item.restock_on_refund)) {
      continue;
    }
    movementCount += insertOrderMovement(db, {
      action: "refund_restock",
      order_id: options.order_id,
      item,
      reason: "refund",
      refund_reference: options.refund_reference,
    });
    if (item.inventory_mode === QUANTITY_INVENTORY_MODE) {
      execute(
        db,
        `
          UPDATE skus
          SET stock_quantity = stock_quantity + ?
          WHERE id = ?
        `,
        [item.quantity, item.sku_id],
      );
      quantityStockUpdates += 1;
    } else if (item.inventory_mode === DATE_INVENTORY_MODE) {
      for (const inventoryDate of movementDatesForItem(item)) {
        if (inventoryDate === null) {
          continue;
        }
        applyDateOverrideDelta(db, {
          sku_id: item.sku_id,
          inventory_date: inventoryDate,
          delta: item.quantity,
          reason: "system_refund_restock",
        });
      }
    }
  }
  return {
    movement_count: movementCount,
    quantity_stock_updates: quantityStockUpdates,
  };
}

function showInventory(db: SqliteDatabase): Record<string, unknown> {
  const rows = listInventoryRows(db);
  return {
    status: "listed",
    reply: `Loaded ${rows.length} inventory row(s).`,
    inventory_rows: rows,
  };
}

function showStock(
  db: SqliteDatabase,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const skuCode = normalizeText(params.sku_code, "params.sku_code").toUpperCase();
  const sku = fetchSkuByCode(db, skuCode);
  if (sku === null) {
    return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
  }

  let dateFrom: Date | null = null;
  let dateTo: Date | null = null;
  if ("date_from" in params || "date_to" in params) {
    dateFrom = parseDateField(params.date_from, "params.date_from");
    dateTo = parseDateField(params.date_to, "params.date_to");
  }

  return {
    status: "found",
    reply: `Loaded stock view for ${skuCode}.`,
    sku: showStockPayload(db, sku, { date_from: dateFrom, date_to: dateTo }),
  };
}

function showLowStock(db: SqliteDatabase): Record<string, unknown> {
  expireReservations(db);
  const skus = queryAll<SkuRow>(
    db,
    `
      SELECT *
      FROM skus
      ORDER BY id
    `,
  );
  for (const sku of skus) {
    syncLowStockAlertsForSku(db, sku);
  }

  const rows = queryAll<{
    sku_code: string;
    title: string;
    inventory_mode: string;
    inventory_date: string | null;
    threshold: number;
    sellable_quantity: number;
    status: string;
  }>(
    db,
    `
      SELECT alerts.*, skus.sku_code, skus.title
      FROM low_stock_alerts AS alerts
      JOIN skus ON skus.id = alerts.sku_id
      WHERE alerts.status IN ('pending', 'sent')
      ORDER BY skus.sku_code ASC, alerts.inventory_date ASC, alerts.id ASC
    `,
  );
  return {
    status: "listed",
    reply: `Loaded ${rows.length} low-stock row(s).`,
    low_stock_rows: rows.map((row) => ({
      sku_code: row.sku_code,
      title: row.title,
      inventory_mode: row.inventory_mode,
      inventory_date: row.inventory_date,
      threshold: row.threshold,
      sellable_quantity: row.sellable_quantity,
      alert_status: row.status,
    })),
  };
}

export function handleInventory(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const commandCode = String(context.command_code ?? "").trim().toLowerCase();
  if (!INVENTORY_INTENTS.has(commandCode)) {
    return invalidResponse("invalid_intent", `Unsupported inventory intent: ${commandCode}`);
  }

  const user = isRecord(context.user) ? context.user : {};
  const params = context.params;
  const channel = String(context.channel ?? "telegram").trim() || "telegram";
  const externalUserId = String(user.external_user_id ?? "").trim();
  if (!externalUserId) {
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
    const owner = fetchActiveOwner(db, {
      channel,
      external_user_id: externalUserId,
    });
    if (owner === null) {
      return invalidResponse(
        "forbidden",
        "Only the active owner can perform this inventory action.",
      );
    }

    try {
      if (commandCode === "inventory.show_inventory") {
        return showInventory(db);
      }
      if (commandCode === "inventory.show_stock") {
        return showStock(db, normalizedParams);
      }
      if (commandCode === "inventory.show_low_stock") {
        return showLowStock(db);
      }
      if (commandCode === "inventory.adjust_stock") {
        const skuCode = normalizeText(
          normalizedParams.sku_code,
          "params.sku_code",
        ).toUpperCase();
        const sku = fetchSkuByCode(db, skuCode);
        if (sku === null) {
          return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
        }
        return adjustStock(db, {
          sku,
          owner_id: owner.id,
          actor_external_user_id: externalUserId,
          delta: coerceInt(normalizedParams.delta, "params.delta"),
          reason: normalizeText(normalizedParams.reason, "params.reason"),
          operation_id: normalizeText(
            normalizedParams.operation_id,
            "params.operation_id",
          ),
          confirm_duplicate: coerceBool(
            normalizedParams.confirm_duplicate,
            "params.confirm_duplicate",
          ),
        });
      }
      if (commandCode === "inventory.set_date_stock") {
        const skuCode = normalizeText(
          normalizedParams.sku_code,
          "params.sku_code",
        ).toUpperCase();
        const sku = fetchSkuByCode(db, skuCode);
        if (sku === null) {
          return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
        }
        const sellableStatus = optionalText(normalizedParams.sellable_status);
        if (
          sellableStatus !== null &&
          sellableStatus !== "active" &&
          sellableStatus !== "unavailable"
        ) {
          throw new Error("params.sellable_status must be one of: active, unavailable");
        }
        return setDateStock(db, {
          sku,
          owner_id: owner.id,
          actor_external_user_id: externalUserId,
          date_from: parseDateField(normalizedParams.date_from, "params.date_from"),
          date_to: parseDateField(normalizedParams.date_to, "params.date_to"),
          stock_quantity: coerceNonNegativeInt(
            normalizedParams.stock_quantity,
            "params.stock_quantity",
          ),
          reason: normalizeText(normalizedParams.reason, "params.reason"),
          operation_id: normalizeText(
            normalizedParams.operation_id,
            "params.operation_id",
          ),
          sellable_status: sellableStatus,
        });
      }
      return invalidResponse("invalid_intent", `Unsupported inventory intent: ${commandCode}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("inventory_movements")
      ) {
        return invalidResponse(
          "conflict",
          "Inventory movement reference key already exists.",
        );
      }
      return invalidResponse("invalid_input", error instanceof Error ? error.message : String(error));
    }
  } finally {
    db.close();
  }
}
