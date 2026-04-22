import {
  DEFAULT_DB_PATH,
  ensureDatabase,
  queryAll,
  queryOne,
} from "../db/sqlite.js";
import { formatMinorAmount } from "./money.js";
import {
  addDays,
  formatDateOnly,
  parseDateOnly,
} from "./time.js";
import { isRecord } from "./types.js";

const COMMAND_ALIASES: Record<string, string> = {
  "seller-bi.sales_today": "seller_bi.sales_today",
  "seller-bi.revenue_this_month": "seller_bi.revenue_this_month",
};

const SELLER_BI_COMMANDS = new Set([
  "seller_bi.sales_today",
  "seller_bi.revenue_this_month",
]);

const SALES_COUNTABLE_ORDER_STATUSES = ["paid", "refunded", "fulfilled"] as const;

interface IdentityRow {
  id: number;
}

function invalid(status: string, reply: string): Record<string, unknown> {
  return { status, reply };
}

function normalizeText(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function requireParamsMapping(params: unknown): Record<string, unknown> {
  if (params === null || params === undefined) {
    return {};
  }
  if (!isRecord(params)) {
    throw new Error("params must be an object");
  }
  return { ...params };
}

function canonicalCommandCode(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return COMMAND_ALIASES[normalized] ?? normalized;
}

function parseAnchorDate(params: Record<string, unknown>): Date {
  const raw = normalizeText(params.anchor_date, "params.anchor_date");
  try {
    return parseDateOnly(raw, "params.anchor_date");
  } catch (error) {
    throw new Error("params.anchor_date must be an ISO date like YYYY-MM-DD");
  }
}

function dayWindow(anchorDate: Date): [string, string] {
  const start = `${formatDateOnly(anchorDate)} 00:00:00`;
  const end = `${formatDateOnly(addDays(anchorDate, 1))} 00:00:00`;
  return [start, end];
}

function monthWindow(anchorDate: Date): [string, string] {
  const year = anchorDate.getUTCFullYear();
  const monthIndex = anchorDate.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const nextMonthStart =
    monthIndex === 11
      ? new Date(Date.UTC(year + 1, 0, 1))
      : new Date(Date.UTC(year, monthIndex + 1, 1));
  return [
    `${formatDateOnly(monthStart)} 00:00:00`,
    `${formatDateOnly(nextMonthStart)} 00:00:00`,
  ];
}

function fetchActiveOwner(
  db: ReturnType<typeof ensureDatabase>,
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

function salesToday(
  db: ReturnType<typeof ensureDatabase>,
  anchorDate: Date,
): Record<string, unknown> {
  const [windowStart, windowEndExclusive] = dayWindow(anchorDate);
  const row = queryOne<{ sales_count: number }>(
    db,
    `
      SELECT COUNT(*) AS sales_count
      FROM orders
      WHERE status IN (?, ?, ?)
        AND paid_at IS NOT NULL
        AND paid_at >= ?
        AND paid_at < ?
    `,
    [
      SALES_COUNTABLE_ORDER_STATUSES[0],
      SALES_COUNTABLE_ORDER_STATUSES[1],
      SALES_COUNTABLE_ORDER_STATUSES[2],
      windowStart,
      windowEndExclusive,
    ],
  );
  const salesCount = row?.sales_count ?? 0;
  return {
    status: "computed",
    reply: `Sales count for ${formatDateOnly(anchorDate)} is ${salesCount}.`,
    metric_code: "seller_bi.sales_today",
    anchor_date: formatDateOnly(anchorDate),
    window_start: windowStart,
    window_end_exclusive: windowEndExclusive,
    sales_count: salesCount,
  };
}

function revenueThisMonth(
  db: ReturnType<typeof ensureDatabase>,
  anchorDate: Date,
): Record<string, unknown> {
  const [windowStart, windowEndExclusive] = monthWindow(anchorDate);
  const month = formatDateOnly(anchorDate).slice(0, 7);
  const rows = queryAll<{ currency: string; amount_minor: number }>(
    db,
    `
      SELECT currency, SUM(amount_minor) AS amount_minor
      FROM payments
      WHERE status = 'paid'
        AND paid_at IS NOT NULL
        AND paid_at >= ?
        AND paid_at < ?
      GROUP BY currency
      ORDER BY currency ASC
    `,
    [windowStart, windowEndExclusive],
  );

  const revenueRows = rows.map((row) => ({
    currency: String(row.currency),
    amount_minor: row.amount_minor,
    display_amount: formatMinorAmount(row.amount_minor, row.currency),
  }));

  const currencyCount = revenueRows.length;
  let reply = `No net paid revenue found for ${month}.`;
  if (currencyCount === 1) {
    reply = `Revenue for ${month} is ${revenueRows[0]!.display_amount}.`;
  } else if (currencyCount > 1) {
    reply = `Revenue for ${month} spans ${currencyCount} currencies.`;
  }

  return {
    status: "computed",
    reply,
    metric_code: "seller_bi.revenue_this_month",
    anchor_date: formatDateOnly(anchorDate),
    month,
    window_start: windowStart,
    window_end_exclusive: windowEndExclusive,
    currency_count: currencyCount,
    multi_currency: currencyCount > 1,
    revenue_rows: revenueRows,
  };
}

export function handleSellerBi(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const commandCode = canonicalCommandCode(context.command_code);
  if (!SELLER_BI_COMMANDS.has(commandCode)) {
    return invalid("invalid_intent", `Unsupported seller-bi intent: ${commandCode}`);
  }

  const user = isRecord(context.user) ? context.user : {};
  const params = context.params;
  const channel = String(context.channel ?? "telegram").trim() || "telegram";
  const externalUserId = String(user.external_user_id ?? "").trim();
  if (!externalUserId) {
    return invalid("invalid_input", "user.external_user_id is required");
  }

  let normalizedParams: Record<string, unknown>;
  let anchorDate: Date;
  try {
    normalizedParams = requireParamsMapping(params);
    anchorDate = parseAnchorDate(normalizedParams);
  } catch (error) {
    return invalid("invalid_input", error instanceof Error ? error.message : String(error));
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
      return invalid("forbidden", "Only the active owner can query seller-bi metrics.");
    }

    if (commandCode === "seller_bi.sales_today") {
      return salesToday(db, anchorDate);
    }
    if (commandCode === "seller_bi.revenue_this_month") {
      return revenueThisMonth(db, anchorDate);
    }
    return invalid("invalid_intent", `Unsupported seller-bi intent: ${commandCode}`);
  } finally {
    db.close();
  }
}
