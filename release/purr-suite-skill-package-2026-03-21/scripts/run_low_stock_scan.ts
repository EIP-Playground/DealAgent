import { DEFAULT_DB_PATH, ensureDatabase } from "./db/sqlite.js";
import { emitJson } from "./lib/cli.js";
import { LOW_STOCK_SCAN_DAYS, scanLowStockAlerts } from "./lib/inventory.js";

function parseArgs(argv: string[]): {
  dbPath: string;
  daysAhead: number;
} {
  let dbPath = DEFAULT_DB_PATH;
  let daysAhead = LOW_STOCK_SCAN_DAYS;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--db-path") {
      dbPath = argv[index + 1] ?? dbPath;
      index += 1;
      continue;
    }
    if (current === "--days-ahead") {
      const raw = argv[index + 1];
      if (raw) {
        daysAhead = Number.parseInt(raw, 10);
      }
      index += 1;
    }
  }

  return { dbPath, daysAhead };
}

export function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const db = ensureDatabase(args.dbPath);
  try {
    const alerts = db.transaction(() =>
      scanLowStockAlerts(db, {
        mark_sent: true,
        days_ahead: args.daysAhead,
      }),
    )();
    emitJson(
      {
        status: "scanned",
        reply: `Detected ${alerts.length} low-stock alert(s).`,
        alerts,
      },
      0,
    );
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
