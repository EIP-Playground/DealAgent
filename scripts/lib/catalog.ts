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
import { getCustomerAvailability } from "./inventory.js";
import { formatMinorAmount, validateSupportedCurrency } from "./money.js";
import {
  coerceNonNegativeInt,
  invalidResponse,
  normalizeText,
  optionalText,
  requireParamsMapping,
} from "./runtime.js";
import { formatDateOnly, parseDateOnly } from "./time.js";
import { isRecord } from "./types.js";

const CATALOG_INTENTS = new Set([
  "catalog.add_sku",
  "catalog.update_details",
  "catalog.update_inventory_mode",
  "catalog.update_price",
  "catalog.update_status",
  "catalog.archive_sku",
  "catalog.show_sku",
  "catalog.show_catalog",
  "catalog.show_product",
]);
const OWNER_ONLY_INTENTS = new Set([
  "catalog.add_sku",
  "catalog.update_details",
  "catalog.update_inventory_mode",
  "catalog.update_price",
  "catalog.update_status",
  "catalog.archive_sku",
  "catalog.show_sku",
]);
const SKU_CODE_PATTERN = /^[A-Z0-9_-]{1,30}$/;
const ACTIVE_STATUS_VALUES = new Set(["active", "unavailable"]);
const INVENTORY_MODE_VALUES = new Set(["quantity", "date_quantity"]);
const OUTPUT_SKU_FIELDS = [
  "sku_code",
  "title",
  "description",
  "price_minor",
  "currency",
  "inventory_mode",
  "stock_quantity",
  "sellable_status",
  "media_url",
  "product_url",
  "restock_on_refund",
  "archived_at",
  "created_at",
  "updated_at",
] as const;

interface IdentityRow {
  id: number;
}

interface SkuRow {
  id: number;
  sku_code: string;
  title: string;
  description: string | null;
  price_minor: number;
  currency: string;
  inventory_mode: string;
  stock_quantity: number;
  sellable_status: string;
  media_url: string | null;
  product_url: string | null;
  restock_on_refund: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function refundFlag(value: unknown): number {
  if (value === null || value === undefined) {
    return 1;
  }
  if (value === true || value === 1 || value === "1" || value === "true" || value === "True") {
    return 1;
  }
  if (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "false" ||
    value === "False"
  ) {
    return 0;
  }
  throw new Error("params.restock_on_refund must be a boolean or one of 0/1/true/false");
}

function validateSkuCode(value: unknown): string {
  const skuCode = normalizeText(value, "params.sku_code").toUpperCase();
  if (!SKU_CODE_PATTERN.test(skuCode)) {
    throw new Error(
      "params.sku_code must use only uppercase letters, digits, '-' or '_' and be <= 30 chars",
    );
  }
  return skuCode;
}

function validateStatus(value: unknown, options: { allow_archived?: boolean } = {}): string {
  const status = normalizeText(value, "params.sellable_status").toLowerCase();
  const allowed = new Set(ACTIVE_STATUS_VALUES);
  if (options.allow_archived) {
    allowed.add("archived");
  }
  if (!allowed.has(status)) {
    const allowedText = [...allowed].sort().join(", ");
    throw new Error(`params.sellable_status must be one of: ${allowedText}`);
  }
  return status;
}

function validateInventoryMode(value: unknown): string {
  if (value === null || value === undefined) {
    return "quantity";
  }
  const inventoryMode = normalizeText(value, "params.inventory_mode").toLowerCase();
  if (!INVENTORY_MODE_VALUES.has(inventoryMode)) {
    const allowedText = [...INVENTORY_MODE_VALUES].sort().join(", ");
    throw new Error(`params.inventory_mode must be one of: ${allowedText}`);
  }
  return inventoryMode;
}

function stockQuantitySemantics(inventoryMode: string): string {
  return inventoryMode === "date_quantity"
    ? "default_nightly_capacity"
    : "on_hand_quantity";
}

function rejectInventoryModeChange(params: Record<string, unknown>): void {
  if ("inventory_mode" in params) {
    throw new Error(
      "params.inventory_mode can only be set during add sku and cannot be changed later",
    );
  }
}

function parseOptionalCustomerDates(
  params: Record<string, unknown>,
): [Date | null, Date | null] {
  const checkIn = optionalText(params.check_in_date);
  const checkOut = optionalText(params.check_out_date);
  if (Boolean(checkIn) !== Boolean(checkOut)) {
    throw new Error(
      "params.check_in_date and params.check_out_date must be provided together",
    );
  }
  if (!checkIn || !checkOut) {
    return [null, null];
  }
  try {
    return [
      parseDateOnly(checkIn, "params.check_in_date"),
      parseDateOnly(checkOut, "params.check_out_date"),
    ];
  } catch {
    throw new Error(
      "params.check_in_date and params.check_out_date must be ISO dates like YYYY-MM-DD",
    );
  }
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

function fetchSku(db: SqliteDatabase, skuCode: string): SkuRow | null {
  return queryOne<SkuRow>(
    db,
    "SELECT * FROM skus WHERE sku_code = ? LIMIT 1",
    [skuCode],
  );
}

function serializeSku(row: SkuRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of OUTPUT_SKU_FIELDS) {
    payload[field] = row[field];
  }
  payload.display_price = formatMinorAmount(row.price_minor, row.currency);
  payload.stock_quantity_semantics = stockQuantitySemantics(row.inventory_mode);
  return payload;
}

function recordCatalogAudit(
  db: SqliteDatabase,
  options: {
    event_type: string;
    actor_external_user_id: string;
    sku_code: string;
    payload: Record<string, unknown>;
  },
): void {
  recordAuditEvent(db, {
    event_type: options.event_type,
    actor_type: "owner",
    actor_id: options.actor_external_user_id,
    entity_type: "sku",
    entity_id: options.sku_code,
    payload: options.payload,
  });
}

function inventoryModeSwitchBlockers(
  db: SqliteDatabase,
  options: { sku_id: number },
): string[] {
  const blockers: string[] = [];
  const movementCount = queryOne<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE sku_id = ?",
    [options.sku_id],
  )?.count;
  if (movementCount) {
    blockers.push("inventory_movements");
  }

  const orderItemCount = queryOne<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM order_items WHERE sku_id = ?",
    [options.sku_id],
  )?.count;
  if (orderItemCount) {
    blockers.push("order_items");
  }

  const overrideCount = queryOne<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM sku_date_overrides WHERE sku_id = ?",
    [options.sku_id],
  )?.count;
  if (overrideCount) {
    blockers.push("sku_date_overrides");
  }

  return blockers;
}

export function serializeCustomerSku(
  db: SqliteDatabase,
  sku: SkuRow,
  options: {
    check_in_date?: Date | null | undefined;
    check_out_date?: Date | null | undefined;
  } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sku_code: sku.sku_code,
    title: sku.title,
    description: sku.description,
    price_minor: sku.price_minor,
    currency: sku.currency,
    display_price: formatMinorAmount(sku.price_minor, sku.currency),
    inventory_mode: sku.inventory_mode,
    media_url: sku.media_url,
    product_url: sku.product_url,
  };
  Object.assign(
    payload,
    getCustomerAvailability(db, sku, {
      check_in_date: options.check_in_date,
      check_out_date: options.check_out_date,
    }),
  );
  if (options.check_in_date && options.check_out_date) {
    payload.check_in_date = formatDateOnly(options.check_in_date);
    payload.check_out_date = formatDateOnly(options.check_out_date);
  }
  return payload;
}

function addSku(
  db: SqliteDatabase,
  options: {
    params: Record<string, unknown>;
    owner_id: number;
    actor_external_user_id: string;
  },
): Record<string, unknown> {
  const skuCode = validateSkuCode(options.params.sku_code);
  const title = normalizeText(options.params.title, "params.title");
  const priceMinor = coerceNonNegativeInt(
    options.params.price_minor,
    "params.price_minor",
  );
  const currency = validateSupportedCurrency(options.params.currency);
  const inventoryMode = validateInventoryMode(options.params.inventory_mode);
  const sellableStatus = validateStatus(
    options.params.sellable_status ?? "active",
  );
  const stockQuantity = coerceNonNegativeInt(
    options.params.stock_quantity ?? 0,
    "params.stock_quantity",
  );
  const restockOnRefund = refundFlag(options.params.restock_on_refund);
  const description = optionalText(options.params.description);
  const mediaUrl = optionalText(options.params.media_url);
  const productUrl = optionalText(options.params.product_url);

  if (fetchSku(db, skuCode) !== null) {
    return invalidResponse("conflict", `SKU ${skuCode} already exists.`);
  }

  const insert = execute(
    db,
    `
      INSERT INTO skus(
        sku_code,
        title,
        description,
        price_minor,
        currency,
        inventory_mode,
        stock_quantity,
        sellable_status,
        media_url,
        product_url,
        restock_on_refund,
        created_by_owner_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      skuCode,
      title,
      description,
      priceMinor,
      currency,
      inventoryMode,
      stockQuantity,
      sellableStatus,
      mediaUrl,
      productUrl,
      restockOnRefund,
      options.owner_id,
    ],
  );
  const created = queryOne<SkuRow>(
    db,
    "SELECT * FROM skus WHERE id = ? LIMIT 1",
    [lastInsertRowidAsNumber(insert)],
  );
  if (created === null) {
    throw new Error(`SKU ${skuCode} was not found after insert.`);
  }

  recordCatalogAudit(db, {
    event_type: "catalog.sku_created",
    actor_external_user_id: options.actor_external_user_id,
    sku_code: skuCode,
    payload: {
      title,
      currency,
      inventory_mode: inventoryMode,
      price_minor: priceMinor,
      stock_quantity: stockQuantity,
      sellable_status: sellableStatus,
    },
  });
  return {
    status: "created",
    reply: `SKU ${skuCode} created successfully.`,
    audit_event_type: "catalog.sku_created",
    sku: serializeSku(created),
  };
}

function updateDetails(
  db: SqliteDatabase,
  options: { params: Record<string, unknown>; actor_external_user_id: string },
): Record<string, unknown> {
  rejectInventoryModeChange(options.params);
  const skuCode = validateSkuCode(options.params.sku_code);
  const sku = fetchSku(db, skuCode);
  if (sku === null) {
    return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
  }

  const changes: Record<string, unknown> = {};
  for (const field of ["title", "description", "media_url", "product_url"] as const) {
    if (field in options.params) {
      if (field === "title") {
        changes[field] = normalizeText(options.params[field], `params.${field}`);
      } else {
        changes[field] = optionalText(options.params[field]);
      }
    }
  }

  if (Object.keys(changes).length === 0) {
    return invalidResponse(
      "invalid_input",
      "update details requires at least one of title, description, media_url, or product_url.",
    );
  }

  const assignments = Object.keys(changes)
    .map((field) => `${field} = ?`)
    .join(", ");
  execute(db, `UPDATE skus SET ${assignments} WHERE sku_code = ?`, [
    ...Object.values(changes),
    skuCode,
  ]);
  const updated = fetchSku(db, skuCode);
  if (updated === null) {
    throw new Error(`SKU ${skuCode} was not found after details update.`);
  }
  recordCatalogAudit(db, {
    event_type: "catalog.sku_updated",
    actor_external_user_id: options.actor_external_user_id,
    sku_code: skuCode,
    payload: {
      changed_fields: Object.keys(changes).sort(),
      change_type: "details",
    },
  });
  return {
    status: "updated",
    reply: `SKU ${skuCode} details updated successfully.`,
    audit_event_type: "catalog.sku_updated",
    sku: serializeSku(updated),
  };
}

function updateInventoryMode(
  db: SqliteDatabase,
  options: { params: Record<string, unknown>; actor_external_user_id: string },
): Record<string, unknown> {
  const skuCode = validateSkuCode(options.params.sku_code);
  const inventoryMode = validateInventoryMode(options.params.inventory_mode);
  const sku = fetchSku(db, skuCode);
  if (sku === null) {
    return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
  }
  if (sku.inventory_mode === inventoryMode) {
    return {
      status: "updated",
      reply: `SKU ${skuCode} already uses inventory_mode=${inventoryMode}.`,
      audit_event_type: "catalog.sku_updated",
      sku: serializeSku(sku),
    };
  }

  const blockers = inventoryModeSwitchBlockers(db, { sku_id: sku.id });
  if (blockers.length > 0) {
    return invalidResponse(
      "conflict",
      `SKU ${skuCode} can no longer switch inventory_mode because it already has ${blockers.join(", ")}.`,
    );
  }

  execute(db, "UPDATE skus SET inventory_mode = ? WHERE sku_code = ?", [
    inventoryMode,
    skuCode,
  ]);
  const updated = fetchSku(db, skuCode);
  if (updated === null) {
    throw new Error(`SKU ${skuCode} was not found after inventory mode update.`);
  }
  recordCatalogAudit(db, {
    event_type: "catalog.sku_updated",
    actor_external_user_id: options.actor_external_user_id,
    sku_code: skuCode,
    payload: {
      changed_fields: ["inventory_mode"],
      change_type: "inventory_mode",
      inventory_mode: inventoryMode,
    },
  });
  return {
    status: "updated",
    reply: `SKU ${skuCode} inventory mode updated to ${inventoryMode}.`,
    audit_event_type: "catalog.sku_updated",
    sku: serializeSku(updated),
  };
}

function updatePrice(
  db: SqliteDatabase,
  options: { params: Record<string, unknown>; actor_external_user_id: string },
): Record<string, unknown> {
  rejectInventoryModeChange(options.params);
  const skuCode = validateSkuCode(options.params.sku_code);
  if (fetchSku(db, skuCode) === null) {
    return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
  }
  const priceMinor = coerceNonNegativeInt(
    options.params.price_minor,
    "params.price_minor",
  );
  const currency = validateSupportedCurrency(options.params.currency);
  execute(
    db,
    `
      UPDATE skus
      SET price_minor = ?, currency = ?
      WHERE sku_code = ?
    `,
    [priceMinor, currency, skuCode],
  );
  const updated = fetchSku(db, skuCode);
  if (updated === null) {
    throw new Error(`SKU ${skuCode} was not found after price update.`);
  }
  recordCatalogAudit(db, {
    event_type: "catalog.sku_updated",
    actor_external_user_id: options.actor_external_user_id,
    sku_code: skuCode,
    payload: {
      changed_fields: ["currency", "price_minor"],
      change_type: "price",
      price_minor: priceMinor,
      currency,
    },
  });
  return {
    status: "updated",
    reply: `SKU ${skuCode} price updated successfully.`,
    audit_event_type: "catalog.sku_updated",
    sku: serializeSku(updated),
  };
}

function updateStatus(
  db: SqliteDatabase,
  options: { params: Record<string, unknown>; actor_external_user_id: string },
): Record<string, unknown> {
  rejectInventoryModeChange(options.params);
  const skuCode = validateSkuCode(options.params.sku_code);
  const sku = fetchSku(db, skuCode);
  if (sku === null) {
    return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
  }

  const sellableStatus = validateStatus(options.params.sellable_status);
  const archivedAt = ACTIVE_STATUS_VALUES.has(sellableStatus)
    ? null
    : sku.archived_at;
  execute(
    db,
    `
      UPDATE skus
      SET sellable_status = ?, archived_at = ?
      WHERE sku_code = ?
    `,
    [sellableStatus, archivedAt, skuCode],
  );
  const updated = fetchSku(db, skuCode);
  if (updated === null) {
    throw new Error(`SKU ${skuCode} was not found after status update.`);
  }
  recordCatalogAudit(db, {
    event_type: "catalog.sku_updated",
    actor_external_user_id: options.actor_external_user_id,
    sku_code: skuCode,
    payload: {
      changed_fields: ["sellable_status"],
      change_type: "status",
      sellable_status: sellableStatus,
    },
  });
  return {
    status: "updated",
    reply: `SKU ${skuCode} status updated to ${sellableStatus}.`,
    audit_event_type: "catalog.sku_updated",
    sku: serializeSku(updated),
  };
}

function archiveSku(
  db: SqliteDatabase,
  options: { params: Record<string, unknown>; actor_external_user_id: string },
): Record<string, unknown> {
  rejectInventoryModeChange(options.params);
  const skuCode = validateSkuCode(options.params.sku_code);
  const sku = fetchSku(db, skuCode);
  if (sku === null) {
    return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
  }

  if (sku.sellable_status !== "archived") {
    execute(
      db,
      `
        UPDATE skus
        SET sellable_status = 'archived',
            archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)
        WHERE sku_code = ?
      `,
      [skuCode],
    );
    recordCatalogAudit(db, {
      event_type: "catalog.sku_archived",
      actor_external_user_id: options.actor_external_user_id,
      sku_code: skuCode,
      payload: { change_type: "archive" },
    });
  }

  const archived = fetchSku(db, skuCode);
  if (archived === null) {
    throw new Error(`SKU ${skuCode} was not found after archive.`);
  }
  return {
    status: "archived",
    reply: `SKU ${skuCode} archived successfully.`,
    audit_event_type: "catalog.sku_archived",
    sku: serializeSku(archived),
  };
}

function showSku(
  db: SqliteDatabase,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const skuCode = validateSkuCode(params.sku_code);
  const sku = fetchSku(db, skuCode);
  if (sku === null) {
    return invalidResponse("not_found", `SKU ${skuCode} was not found.`);
  }
  return {
    status: "found",
    reply: `SKU ${skuCode} loaded successfully.`,
    sku: serializeSku(sku),
  };
}

function showCatalog(db: SqliteDatabase): Record<string, unknown> {
  const rows = queryAll<SkuRow>(
    db,
    `
      SELECT *
      FROM skus
      ORDER BY created_at DESC, sku_code ASC
    `,
  );
  return {
    status: "listed",
    reply: `Loaded ${rows.length} SKU(s).`,
    skus: rows.map((row) => serializeSku(row)),
  };
}

function showCustomerCatalog(
  db: SqliteDatabase,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const [checkInDate, checkOutDate] = parseOptionalCustomerDates(params);
  const rows = queryAll<SkuRow>(
    db,
    `
      SELECT *
      FROM skus
      WHERE sellable_status = 'active'
      ORDER BY created_at DESC, sku_code ASC
    `,
  );
  return {
    status: "listed",
    reply: `Loaded ${rows.length} customer-visible SKU(s).`,
    skus: rows.map((row) =>
      serializeCustomerSku(db, row, {
        check_in_date: checkInDate,
        check_out_date: checkOutDate,
      }),
    ),
  };
}

function showCustomerProduct(
  db: SqliteDatabase,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const skuCode = validateSkuCode(params.sku_code);
  const sku = fetchSku(db, skuCode);
  if (sku === null || sku.sellable_status !== "active") {
    return invalidResponse("not_found", `SKU ${skuCode} is not available.`);
  }

  const [checkInDate, checkOutDate] = parseOptionalCustomerDates(params);
  return {
    status: "found",
    reply: `Loaded customer product view for ${skuCode}.`,
    sku: serializeCustomerSku(db, sku, {
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
    }),
  };
}

export function handleCatalog(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const commandCode = String(context.command_code ?? "").trim().toLowerCase();
  if (!CATALOG_INTENTS.has(commandCode)) {
    return invalidResponse("invalid_intent", `Unsupported catalog intent: ${commandCode}`);
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
    if (owner === null && OWNER_ONLY_INTENTS.has(commandCode)) {
      return invalidResponse(
        "forbidden",
        "Only the active owner can perform this catalog action.",
      );
    }

    try {
      if (commandCode === "catalog.add_sku") {
        return addSku(db, {
          params: normalizedParams,
          owner_id: owner!.id,
          actor_external_user_id: externalUserId,
        });
      }
      if (commandCode === "catalog.update_details") {
        return updateDetails(db, {
          params: normalizedParams,
          actor_external_user_id: externalUserId,
        });
      }
      if (commandCode === "catalog.update_inventory_mode") {
        return updateInventoryMode(db, {
          params: normalizedParams,
          actor_external_user_id: externalUserId,
        });
      }
      if (commandCode === "catalog.update_price") {
        return updatePrice(db, {
          params: normalizedParams,
          actor_external_user_id: externalUserId,
        });
      }
      if (commandCode === "catalog.update_status") {
        return updateStatus(db, {
          params: normalizedParams,
          actor_external_user_id: externalUserId,
        });
      }
      if (commandCode === "catalog.archive_sku") {
        return archiveSku(db, {
          params: normalizedParams,
          actor_external_user_id: externalUserId,
        });
      }
      if (commandCode === "catalog.show_sku") {
        return showSku(db, normalizedParams);
      }
      if (commandCode === "catalog.show_catalog") {
        return owner === null
          ? showCustomerCatalog(db, normalizedParams)
          : showCatalog(db);
      }
      if (commandCode === "catalog.show_product") {
        return owner === null
          ? showCustomerProduct(db, normalizedParams)
          : showSku(db, normalizedParams);
      }
      return invalidResponse("invalid_intent", `Unsupported catalog intent: ${commandCode}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "SqliteError" &&
        error.message.toLowerCase().includes("sku_code")
      ) {
        return invalidResponse("conflict", "SKU code already exists.");
      }
      return invalidResponse("invalid_input", error instanceof Error ? error.message : String(error));
    }
  } finally {
    db.close();
  }
}
