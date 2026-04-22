import {
  execute,
  lastInsertRowidAsNumber,
  queryOne,
  type SqliteDatabase,
} from "../db/sqlite.js";
import { parseJson, stableStringify } from "./json.js";

interface CustomerRow {
  id: number;
  channel: string;
  external_user_id: string;
  username: string | null;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
}

export function fetchCustomerByIdentity(
  db: SqliteDatabase,
  options: { channel: string; external_user_id: string },
): CustomerRow | null {
  return queryOne<CustomerRow>(
    db,
    `
      SELECT *
      FROM customers
      WHERE channel = ? AND external_user_id = ?
      LIMIT 1
    `,
    [options.channel, options.external_user_id],
  );
}

export function fetchCustomerById(
  db: SqliteDatabase,
  options: { customer_id: number },
): CustomerRow | null {
  return queryOne<CustomerRow>(
    db,
    "SELECT * FROM customers WHERE id = ? LIMIT 1",
    [options.customer_id],
  );
}

export function upsertCustomerIdentity(
  db: SqliteDatabase,
  options: {
    channel: string;
    external_user_id: string;
    username: string | null;
  },
): CustomerRow {
  let customer = fetchCustomerByIdentity(db, options);
  if (customer !== null) {
    if (options.username && customer.username !== options.username) {
      execute(db, "UPDATE customers SET username = ? WHERE id = ?", [
        options.username,
        customer.id,
      ]);
      customer = fetchCustomerById(db, { customer_id: customer.id });
    }
    if (customer === null) {
      throw new Error("Customer disappeared after username update");
    }
    return customer;
  }

  const result = execute(
    db,
    `
      INSERT INTO customers(channel, external_user_id, username)
      VALUES (?, ?, ?)
    `,
    [options.channel, options.external_user_id, options.username],
  );
  customer = fetchCustomerById(db, {
    customer_id: lastInsertRowidAsNumber(result),
  });
  if (customer === null) {
    throw new Error("Customer row was not found after insert");
  }
  return customer;
}

export function updateCustomerSummary(
  db: SqliteDatabase,
  options: {
    customer_id: number;
    summary_json: Record<string, unknown>;
  },
): CustomerRow {
  execute(db, "UPDATE customers SET summary_json = ? WHERE id = ?", [
    stableStringify(options.summary_json),
    options.customer_id,
  ]);
  const customer = fetchCustomerById(db, { customer_id: options.customer_id });
  if (customer === null) {
    throw new Error("Customer row was not found after summary update");
  }
  return customer;
}

export function decodeCustomerSummaryJson(
  rawValue: unknown,
): Record<string, unknown> | null {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  try {
    const decoded = parseJson(String(rawValue));
    if (
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded)
    ) {
      return decoded as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}
