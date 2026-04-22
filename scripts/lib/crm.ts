import {
  DEFAULT_DB_PATH,
  callerActorId,
  callerAuditPayload,
  ensureDatabase,
  execute,
  lastInsertRowidAsNumber,
  queryAll,
  queryOne,
  recordAuditEvent,
  type SqliteDatabase,
} from "../db/sqlite.js";
import { serializeCustomerSku } from "./catalog.js";
import {
  decodeCustomerSummaryJson,
  fetchCustomerByIdentity,
  upsertCustomerIdentity,
  updateCustomerSummary,
} from "./customer_store.js";
import {
  coercePositiveInt,
  invalidResponse,
  normalizeText,
  optionalText,
  requireMapping,
  requireParamsMapping,
} from "./runtime.js";
import { parseDateOnly } from "./time.js";
import { isRecord } from "./types.js";

const CRM_COMMANDS = new Set([
  "crm.log_inquiry",
  "crm.log_reply",
  "crm.show_history",
  "crm.get_response_context",
  "crm.upsert_customer_summary",
  "crm.whoami",
]);
const DEFAULT_SHOW_HISTORY_LIMIT = 20;
const DEFAULT_CONTEXT_HISTORY_LIMIT = 10;
const HISTORICAL_SKU_REF_SOURCE = "conversation_history";
const CURRENT_SKU_SNAPSHOT_SOURCE = "catalog_live_read";

export type ConversationSourceKind =
  | "manual"
  | "openclaw_inbound"
  | "openclaw_delivery_mirror";

class PermissionError extends Error {}

interface IdentityRow {
  id: number;
}

interface CustomerRow {
  id: number;
  username: string | null;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
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

interface OrderRefRow {
  id: number;
  order_number: string;
}

export interface ConversationRow {
  id: number;
  customer_id: number;
  channel_message_id: string | null;
  direction: string;
  message_text: string;
  intent: string | null;
  sku_id: number | null;
  order_id: number | null;
  summary: string | null;
  source_kind: ConversationSourceKind;
  source_event_key: string | null;
  created_at: string;
  sku_code: string | null;
  order_number: string | null;
}

export interface AppendConversationOptions {
  channel: string;
  customer_external_user_id: string;
  customer_username: string | null;
  channel_message_id: string | null;
  direction: "inbound" | "outbound";
  message_text: string;
  intent: string | null;
  sku_id: number | null;
  order_id: number | null;
  summary: string | null;
  source_kind?: ConversationSourceKind;
  source_event_key?: string | null;
}

export interface AppendConversationResult {
  customer_id: number;
  customer_external_user_id: string;
  customer_username: string | null;
  conversation: ConversationRow;
  inserted: boolean;
}

interface PrimarySkuHistoryRow {
  id: number;
  customer_id: number;
  direction: string;
  created_at: string;
  sku_id: number;
  sku_code: string | null;
}

function parseOptionalContextDates(
  params: Record<string, unknown>,
): [Date | null, Date | null] {
  const checkInText = optionalText(params.check_in_date);
  const checkOutText = optionalText(params.check_out_date);
  if (Boolean(checkInText) !== Boolean(checkOutText)) {
    throw new Error(
      "params.check_in_date and params.check_out_date must be provided together",
    );
  }
  if (!checkInText || !checkOutText) {
    return [null, null];
  }
  try {
    const checkInDate = parseDateOnly(checkInText, "params.check_in_date");
    const checkOutDate = parseDateOnly(checkOutText, "params.check_out_date");
    if (checkOutDate.getTime() <= checkInDate.getTime()) {
      throw new Error("params.check_out_date must be after check_in_date");
    }
    return [checkInDate, checkOutDate];
  } catch (error) {
    if (error instanceof Error && error.message === "params.check_out_date must be after check_in_date") {
      throw error;
    }
    throw new Error(
      "params.check_in_date and params.check_out_date must be ISO dates like YYYY-MM-DD",
    );
  }
}

function customerAnchor(params: Record<string, unknown>): [string, string | null] {
  const customer = requireMapping(params.customer, "params.customer");
  const externalUserId = normalizeText(
    customer.external_user_id,
    "params.customer.external_user_id",
  );
  const username = optionalText(customer.username);
  return [externalUserId, username];
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

function requireOwner(
  db: SqliteDatabase,
  options: { channel: string; external_user_id: string },
): IdentityRow {
  const owner = fetchActiveOwner(db, options);
  if (owner === null) {
    throw new PermissionError("Only the active owner can run crm commands.");
  }
  return owner;
}

export function isStoreRepresentative(
  db: SqliteDatabase,
  options: { channel: string; external_user_id: string },
): boolean {
  const rep = queryOne<{ matched: number }>(
    db,
    `
      SELECT 1 AS matched
      FROM identities
      WHERE channel = ? AND external_user_id = ? AND is_active = 1 AND role IN ('owner', 'agent')
      LIMIT 1
    `,
    [options.channel, options.external_user_id],
  );
  return rep !== null;
}

function requireStoreRepresentative(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    customer_external_user_id: string;
  },
): void {
  if (options.actor_external_user_id === options.customer_external_user_id) {
    const owner = fetchActiveOwner(db, {
      channel: options.channel,
      external_user_id: options.actor_external_user_id,
    });
    if (owner !== null) {
      return;
    }
    throw new PermissionError("Customer identity cannot run this crm command.");
  }

  if (
    !isStoreRepresentative(db, {
      channel: options.channel,
      external_user_id: options.actor_external_user_id,
    })
  ) {
    throw new PermissionError("Only an active store representative can run this crm command.");
  }
}

function fetchSkuByCode(db: SqliteDatabase, skuCode: string): SkuRow | null {
  return queryOne<SkuRow>(
    db,
    "SELECT * FROM skus WHERE sku_code = ? LIMIT 1",
    [skuCode],
  );
}

function fetchSkuById(
  db: SqliteDatabase,
  options: { sku_id: number },
): SkuRow | null {
  return queryOne<SkuRow>(
    db,
    "SELECT * FROM skus WHERE id = ? LIMIT 1",
    [options.sku_id],
  );
}

function fetchOrderByNumber(
  db: SqliteDatabase,
  options: { order_number: string },
): OrderRefRow | null {
  return queryOne<OrderRefRow>(
    db,
    `
      SELECT id, order_number
      FROM orders
      WHERE order_number = ?
      LIMIT 1
    `,
    [options.order_number],
  );
}

function resolvePrimarySku(
  db: SqliteDatabase,
  options: { sku_code: unknown },
): [number | null, string | null] {
  let normalizedSkuCode = optionalText(options.sku_code);
  if (normalizedSkuCode === null) {
    return [null, null];
  }
  normalizedSkuCode = normalizedSkuCode.toUpperCase();
  const sku = fetchSkuByCode(db, normalizedSkuCode);
  if (sku === null) {
    throw new LookupError(`SKU ${normalizedSkuCode} was not found.`);
  }
  return [sku.id, sku.sku_code];
}

class LookupError extends Error {}

function resolveOrder(
  db: SqliteDatabase,
  options: { order_number: unknown },
): [number | null, string | null] {
  const normalizedOrderNumber = optionalText(options.order_number);
  if (normalizedOrderNumber === null) {
    return [null, null];
  }
  const orderRow = fetchOrderByNumber(db, { order_number: normalizedOrderNumber });
  if (orderRow === null) {
    throw new LookupError(`Order ${normalizedOrderNumber} was not found.`);
  }
  return [orderRow.id, orderRow.order_number];
}

function serializeCustomer(
  customerRow: CustomerRow | null,
  options: {
    channel: string;
    external_user_id: string;
    username?: string | null;
    include_summary?: boolean;
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    channel: options.channel,
    external_user_id: options.external_user_id,
    username: options.username ?? null,
  };
  if (customerRow !== null) {
    payload.username = customerRow.username;
    payload.customer_id = customerRow.id;
    payload.created_at = customerRow.created_at;
    payload.updated_at = customerRow.updated_at;
    if (options.include_summary) {
      payload.summary_json = decodeCustomerSummaryJson(customerRow.summary_json);
    }
  }
  return payload;
}

function conversationRows(
  db: SqliteDatabase,
  options: { customer_id: number; limit: number },
): ConversationRow[] {
  return queryAll<ConversationRow>(
    db,
    `
      SELECT *
      FROM (
        SELECT
          conversations.*,
          skus.sku_code AS sku_code,
          orders.order_number AS order_number
        FROM conversations
        LEFT JOIN skus ON skus.id = conversations.sku_id
        LEFT JOIN orders ON orders.id = conversations.order_id
        WHERE conversations.customer_id = ?
        ORDER BY conversations.created_at DESC, conversations.id DESC
        LIMIT ?
      ) AS recent
      ORDER BY recent.created_at ASC, recent.id ASC
    `,
    [options.customer_id, options.limit],
  );
}

function latestPrimarySkuRow(
  db: SqliteDatabase,
  options: { customer_id: number },
): PrimarySkuHistoryRow | null {
  return queryOne<PrimarySkuHistoryRow>(
    db,
    `
      SELECT
        conversations.id,
        conversations.customer_id,
        conversations.direction,
        conversations.created_at,
        conversations.sku_id,
        skus.sku_code AS sku_code
      FROM conversations
      LEFT JOIN skus ON skus.id = conversations.sku_id
      WHERE conversations.customer_id = ?
        AND conversations.sku_id IS NOT NULL
      ORDER BY conversations.created_at DESC, conversations.id DESC
      LIMIT 1
    `,
    [options.customer_id],
  );
}

function fetchConversationById(
  db: SqliteDatabase,
  options: { conversation_id: number },
): ConversationRow | null {
  return queryOne<ConversationRow>(
    db,
    `
      SELECT
        conversations.*,
        skus.sku_code AS sku_code,
        orders.order_number AS order_number
      FROM conversations
      LEFT JOIN skus ON skus.id = conversations.sku_id
      LEFT JOIN orders ON orders.id = conversations.order_id
      WHERE conversations.id = ?
      LIMIT 1
    `,
    [options.conversation_id],
  );
}

function fetchConversationBySourceEventKey(
  db: SqliteDatabase,
  options: { source_event_key: string },
): ConversationRow | null {
  return queryOne<ConversationRow>(
    db,
    `
      SELECT
        conversations.*,
        skus.sku_code AS sku_code,
        orders.order_number AS order_number
      FROM conversations
      LEFT JOIN skus ON skus.id = conversations.sku_id
      LEFT JOIN orders ON orders.id = conversations.order_id
      WHERE conversations.source_event_key = ?
      LIMIT 1
    `,
    [options.source_event_key],
  );
}

function serializeConversation(conversationRow: ConversationRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    conversation_id: conversationRow.id,
    direction: conversationRow.direction,
    message_text: conversationRow.message_text,
    intent: conversationRow.intent,
    summary: conversationRow.summary,
    channel_message_id: conversationRow.channel_message_id,
    created_at: conversationRow.created_at,
  };
  if (conversationRow.sku_id !== null) {
    payload.primary_sku_ref = {
      sku_id: conversationRow.sku_id,
      sku_code: conversationRow.sku_code,
      reference_source: HISTORICAL_SKU_REF_SOURCE,
    };
  }
  if (conversationRow.order_id !== null) {
    payload.order_ref = {
      order_id: conversationRow.order_id,
      order_number: conversationRow.order_number,
    };
  }
  return payload;
}

function serializePrimarySkuRef(
  primarySkuRow: PrimarySkuHistoryRow | null,
): Record<string, unknown> | null {
  if (primarySkuRow === null) {
    return null;
  }
  return {
    sku_id: primarySkuRow.sku_id,
    sku_code: primarySkuRow.sku_code,
    reference_source: HISTORICAL_SKU_REF_SOURCE,
    source_conversation_id: primarySkuRow.id,
    source_direction: primarySkuRow.direction,
    source_created_at: primarySkuRow.created_at,
  };
}

function currentSkuSnapshot(
  db: SqliteDatabase,
  options: {
    primary_sku_row: PrimarySkuHistoryRow | null;
    check_in_date: Date | null;
    check_out_date: Date | null;
  },
): Record<string, unknown> | null {
  if (options.primary_sku_row === null) {
    return null;
  }
  const skuRow = fetchSkuById(db, { sku_id: options.primary_sku_row.sku_id });
  if (skuRow === null) {
    return null;
  }
  let checkInDate = options.check_in_date;
  let checkOutDate = options.check_out_date;
  if (skuRow.inventory_mode !== "date_quantity") {
    checkInDate = null;
    checkOutDate = null;
  }
  return {
    snapshot_source: CURRENT_SKU_SNAPSHOT_SOURCE,
    is_historical_truth: false,
    sku: serializeCustomerSku(db, skuRow, {
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
    }),
  };
}

export function appendConversation(
  db: SqliteDatabase,
  options: AppendConversationOptions,
): AppendConversationResult {
  const customer = upsertCustomerIdentity(db, {
    channel: options.channel,
    external_user_id: options.customer_external_user_id,
    username: options.customer_username,
  });
  const sourceKind = options.source_kind ?? "manual";
  const sourceEventKey = options.source_event_key ?? null;
  if (sourceEventKey !== null) {
    const existing = fetchConversationBySourceEventKey(db, {
      source_event_key: sourceEventKey,
    });
    if (existing !== null) {
      return {
        customer_id: customer.id,
        customer_external_user_id: options.customer_external_user_id,
        customer_username: customer.username,
        conversation: existing,
        inserted: false,
      };
    }
  }

  const insert = execute(
    db,
    `
      INSERT INTO conversations(
        customer_id,
        channel_message_id,
        direction,
        message_text,
        intent,
        sku_id,
        order_id,
        summary,
        source_kind,
        source_event_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      customer.id,
      options.channel_message_id,
      options.direction,
      options.message_text,
      options.intent,
      options.sku_id,
      options.order_id,
      options.summary,
      sourceKind,
      sourceEventKey,
    ],
  );
  const conversation = fetchConversationById(db, {
    conversation_id: lastInsertRowidAsNumber(insert),
  });
  if (conversation === null) {
    throw new Error("Conversation row was not found after insert");
  }

  return {
    customer_id: customer.id,
    customer_external_user_id: options.customer_external_user_id,
    customer_username: customer.username,
    conversation,
    inserted: true,
  };
}

function logConversation(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    params: Record<string, unknown>;
    direction: string;
    event_type: string;
  },
): Record<string, unknown> {
  const [customerExternalUserId, customerUsername] = customerAnchor(options.params);
  requireStoreRepresentative(db, {
    channel: options.channel,
    actor_external_user_id: options.actor_external_user_id,
    customer_external_user_id: customerExternalUserId,
  });
  const messageText = normalizeText(options.params.message_text, "params.message_text");
  const channelMessageId = optionalText(options.params.channel_message_id);
  const intent = optionalText(options.params.intent);
  const summary = optionalText(options.params.summary);
  const [skuId, skuCode] = resolvePrimarySku(db, {
    sku_code: options.params.sku_code,
  });
  const [orderId, orderNumber] = resolveOrder(db, {
    order_number: options.params.order_number,
  });
  const appended = appendConversation(db, {
    channel: options.channel,
    customer_external_user_id: customerExternalUserId,
    customer_username: customerUsername,
    channel_message_id: channelMessageId,
    direction: options.direction as "inbound" | "outbound",
    message_text: messageText,
    intent,
    sku_id: skuId,
    order_id: orderId,
    summary,
    source_kind: "manual",
  });
  const customer = fetchCustomerByIdentity(db, {
    channel: options.channel,
    external_user_id: customerExternalUserId,
  }) as CustomerRow | null;
  if (customer === null) {
    throw new Error(`Customer ${customerExternalUserId} was not found after conversation insert.`);
  }
  recordAuditEvent(db, {
    event_type: options.event_type,
    actor_type: "caller",
    actor_id: callerActorId(options.channel, options.actor_external_user_id),
    entity_type: "conversation",
    entity_id: String(appended.conversation.id),
    payload: callerAuditPayload(
      {
        customer_external_user_id: customerExternalUserId,
        direction: options.direction,
        intent,
        sku_code: skuCode,
        order_number: orderNumber,
      },
      {
        channel: options.channel,
        external_user_id: options.actor_external_user_id,
      },
    ),
  });
  return {
    status: "logged",
    reply: `Logged ${options.direction} CRM conversation for customer ${customerExternalUserId}.`,
    audit_event_type: options.event_type,
    customer: serializeCustomer(customer as CustomerRow, {
      channel: options.channel,
      external_user_id: customerExternalUserId,
      username: customerUsername,
    }),
    conversation: serializeConversation(appended.conversation),
  };
}

function showHistory(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  requireOwner(db, {
    channel: options.channel,
    external_user_id: options.actor_external_user_id,
  });
  const [customerExternalUserId, customerUsername] = customerAnchor(options.params);
  const limit = coercePositiveInt(
    options.params.limit,
    "params.limit",
    DEFAULT_SHOW_HISTORY_LIMIT,
  );
  const customer = fetchCustomerByIdentity(db, {
    channel: options.channel,
    external_user_id: customerExternalUserId,
  }) as CustomerRow | null;
  if (customer === null) {
    return {
      status: "listed",
      reply: `Loaded 0 CRM conversations for customer ${customerExternalUserId}.`,
      customer: serializeCustomer(null, {
        channel: options.channel,
        external_user_id: customerExternalUserId,
        username: customerUsername,
      }),
      customer_exists: false,
      conversations: [],
      conversation_count: 0,
    };
  }

  const rows = conversationRows(db, { customer_id: customer.id, limit });
  const conversations = rows.map((row) => serializeConversation(row));
  return {
    status: "listed",
    reply: `Loaded ${conversations.length} CRM conversations for customer ${customerExternalUserId}.`,
    customer: serializeCustomer(customer, {
      channel: options.channel,
      external_user_id: customerExternalUserId,
      username: customerUsername,
    }),
    customer_exists: true,
    conversations,
    conversation_count: conversations.length,
  };
}

function upsertCustomerSummaryCommand(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  const [customerExternalUserId, customerUsername] = customerAnchor(options.params);
  requireStoreRepresentative(db, {
    channel: options.channel,
    actor_external_user_id: options.actor_external_user_id,
    customer_external_user_id: customerExternalUserId,
  });
  const summaryJson = requireMapping(options.params.summary_json, "params.summary_json");
  const customer = upsertCustomerIdentity(db, {
    channel: options.channel,
    external_user_id: customerExternalUserId,
    username: customerUsername,
  });
  const updatedCustomer = updateCustomerSummary(db, {
    customer_id: customer.id,
    summary_json: summaryJson,
  });
  recordAuditEvent(db, {
    event_type: "crm.customer_summary_upserted",
    actor_type: "caller",
    actor_id: callerActorId(options.channel, options.actor_external_user_id),
    entity_type: "customer",
    entity_id: customerExternalUserId,
    payload: callerAuditPayload(
      {
        customer_external_user_id: customerExternalUserId,
        summary_keys: Object.keys(summaryJson).sort(),
      },
      {
        channel: options.channel,
        external_user_id: options.actor_external_user_id,
      },
    ),
  });
  return {
    status: "updated",
    reply: `Updated CRM summary for customer ${customerExternalUserId}.`,
    audit_event_type: "crm.customer_summary_upserted",
    customer: serializeCustomer(updatedCustomer as CustomerRow, {
      channel: options.channel,
      external_user_id: customerExternalUserId,
      username: customerUsername,
      include_summary: true,
    }),
  };
}

function getResponseContext(
  db: SqliteDatabase,
  options: {
    channel: string;
    actor_external_user_id: string;
    params: Record<string, unknown>;
  },
): Record<string, unknown> {
  const [customerExternalUserId, customerUsername] = customerAnchor(options.params);
  requireStoreRepresentative(db, {
    channel: options.channel,
    actor_external_user_id: options.actor_external_user_id,
    customer_external_user_id: customerExternalUserId,
  });
  const historyLimit = coercePositiveInt(
    options.params.history_limit,
    "params.history_limit",
    DEFAULT_CONTEXT_HISTORY_LIMIT,
  );
  const [checkInDate, checkOutDate] = parseOptionalContextDates(options.params);
  const customer = fetchCustomerByIdentity(db, {
    channel: options.channel,
    external_user_id: customerExternalUserId,
  }) as CustomerRow | null;
  if (customer === null) {
    return {
      status: "found",
      reply: `Built empty CRM response context for customer ${customerExternalUserId}.`,
      customer: serializeCustomer(null, {
        channel: options.channel,
        external_user_id: customerExternalUserId,
        username: customerUsername,
      }),
      customer_exists: false,
      customer_summary_json: null,
      recent_conversations: [],
      primary_sku_ref: null,
      current_sku_snapshot: null,
      context_window_size: 0,
    };
  }

  const recentRows = conversationRows(db, {
    customer_id: customer.id,
    limit: historyLimit,
  });
  const primarySkuRow = latestPrimarySkuRow(db, { customer_id: customer.id });
  return {
    status: "found",
    reply: `Built CRM response context for customer ${customerExternalUserId}.`,
    customer: serializeCustomer(customer, {
      channel: options.channel,
      external_user_id: customerExternalUserId,
      username: customerUsername,
    }),
    customer_exists: true,
    customer_summary_json: decodeCustomerSummaryJson(customer.summary_json),
    recent_conversations: recentRows.map((row) => serializeConversation(row)),
    primary_sku_ref: serializePrimarySkuRef(primarySkuRow),
    current_sku_snapshot: currentSkuSnapshot(db, {
      primary_sku_row: primarySkuRow,
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
    }),
    context_window_size: recentRows.length,
  };
}

export function handleCrm(context: Record<string, unknown>): Record<string, unknown> {
  const commandCode = String(context.command_code ?? "").trim().toLowerCase();
  if (!CRM_COMMANDS.has(commandCode)) {
    return invalidResponse("invalid_intent", `Unsupported crm intent: ${commandCode}`);
  }

  const user = isRecord(context.user) ? context.user : {};
  const params = context.params;
  const channel = String(context.channel ?? "telegram").trim() || "telegram";
  const actorExternalUserId = String(user.external_user_id ?? "").trim();
  if (!actorExternalUserId && commandCode !== "crm.whoami") {
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
      if (commandCode === "crm.whoami") {
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
      if (commandCode === "crm.log_inquiry") {
        return logConversation(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
          direction: "inbound",
          event_type: "crm.inquiry_logged",
        });
      }
      if (commandCode === "crm.log_reply") {
        return logConversation(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
          direction: "outbound",
          event_type: "crm.reply_logged",
        });
      }
      if (commandCode === "crm.show_history") {
        return showHistory(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
        });
      }
      if (commandCode === "crm.get_response_context") {
        return getResponseContext(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
        });
      }
      if (commandCode === "crm.upsert_customer_summary") {
        return upsertCustomerSummaryCommand(db, {
          channel,
          actor_external_user_id: actorExternalUserId,
          params: normalizedParams,
        });
      }
      return invalidResponse("invalid_intent", `Unsupported crm intent: ${commandCode}`);
    })();
  } catch (error) {
    if (error instanceof PermissionError) {
      return invalidResponse("forbidden", error.message);
    }
    if (error instanceof LookupError) {
      return invalidResponse("not_found", error.message);
    }
    if (error instanceof Error) {
      return invalidResponse("invalid_input", error.message);
    }
    return invalidResponse("conflict", `Could not persist crm changes: ${String(error)}`);
  } finally {
    db.close();
  }
}
