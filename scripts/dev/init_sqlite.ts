import { DEFAULT_DB_PATH, ensureDatabase, queryAll } from "../db/sqlite.js";

function parseArgs(argv: string[]): { dbPath: string } {
  let dbPath = DEFAULT_DB_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--db-path") {
      dbPath = argv[index + 1] ?? dbPath;
      index += 1;
    }
  }
  return { dbPath };
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = ensureDatabase(args.dbPath);
  try {
    const tables = queryAll<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row.name);

    process.stdout.write(`Initialized SQLite at ${args.dbPath}\n`);
    process.stdout.write("Tables:\n");
    for (const table of tables) {
      process.stdout.write(`- ${table}\n`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
