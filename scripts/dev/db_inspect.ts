import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { DEFAULT_DB_PATH, queryAll } from "../db/sqlite.js";
import { parseJson } from "../lib/json.js";

function parseArgs(argv: string[]): {
  dbPath: string;
  showIndexes: boolean;
  showAuditEvents: boolean;
  limit: number;
} {
  let dbPath = DEFAULT_DB_PATH;
  let showIndexes = false;
  let showAuditEvents = false;
  let limit = 20;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--db-path") {
      dbPath = argv[index + 1] ?? dbPath;
      index += 1;
      continue;
    }
    if (current === "--show-indexes") {
      showIndexes = true;
      continue;
    }
    if (current === "--show-audit-events") {
      showAuditEvents = true;
      continue;
    }
    if (current === "--limit") {
      limit = Number.parseInt(argv[index + 1] ?? String(limit), 10);
      index += 1;
    }
  }

  return { dbPath, showIndexes, showAuditEvents, limit };
}

function listIndexes(db: Database.Database): Array<[string, string | null]> {
  return queryAll<{ name: string; tbl_name: string | null }>(
    db,
    `
      SELECT name, tbl_name
      FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
      ORDER BY tbl_name, name
    `,
  ).map((row) => [row.name, row.tbl_name]);
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) {
    throw new Error(`Database does not exist: ${args.dbPath}`);
  }

  const db = new Database(args.dbPath, { readonly: true });
  try {
    const tables = queryAll<{ name: string }>(
      db,
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `,
    ).map((row) => row.name);

    process.stdout.write(`DB: ${args.dbPath}\n`);
    for (const table of tables) {
      const count = queryAll<{ count: number }>(
        db,
        `SELECT COUNT(*) AS count FROM ${table}`,
      )[0]!.count;
      process.stdout.write(`${table}: ${count}\n`);
    }

    const configRows = queryAll<{ config_key: string; config_value_json: string }>(
      db,
      "SELECT config_key, config_value_json FROM business_config ORDER BY config_key",
    );
    if (configRows.length > 0) {
      process.stdout.write("business_config:\n");
      for (const row of configRows) {
        process.stdout.write(`- ${row.config_key}: ${JSON.stringify(parseJson(row.config_value_json))}\n`);
      }
    }

    if (args.showIndexes) {
      const indexes = listIndexes(db);
      if (indexes.length > 0) {
        process.stdout.write("indexes:\n");
        for (const [indexName, tableName] of indexes) {
          process.stdout.write(`- ${tableName}: ${indexName}\n`);
        }
      }
    }

    if (args.showAuditEvents) {
      const rows = queryAll<{
        id: number;
        event_type: string;
        actor_type: string;
        actor_id: string | null;
        entity_type: string | null;
        entity_id: string | null;
        created_at: string;
      }>(
        db,
        `
          SELECT id, event_type, actor_type, actor_id, entity_type, entity_id, created_at
          FROM audit_events
          ORDER BY id DESC
          LIMIT ?
        `,
        [args.limit],
      );
      process.stdout.write("audit_events:\n");
      for (const row of rows) {
        process.stdout.write(
          `- id=${row.id} event_type=${row.event_type} actor_type=${row.actor_type} actor_id=${row.actor_id} entity_type=${row.entity_type} entity_id=${row.entity_id} created_at=${row.created_at}\n`,
        );
      }
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
