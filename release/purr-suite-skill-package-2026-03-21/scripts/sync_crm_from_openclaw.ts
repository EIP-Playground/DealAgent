import { emitError, emitJson } from "./lib/cli.js";
import { syncCrmFromOpenclaw } from "./lib/openclaw_crm_sync.js";

type SyncMode = "bootstrap" | "incremental";

function parseArgs(argv: string[]): {
  dbPath: string | null;
  openclawRoot: string | null;
  mode: SyncMode;
  unknown: string[];
} {
  let dbPath: string | null = null;
  let openclawRoot: string | null = null;
  let mode: SyncMode = "incremental";
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--db-path") {
      dbPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (current === "--openclaw-root") {
      openclawRoot = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (current === "--mode") {
      const candidate = argv[index + 1] ?? "";
      if (candidate === "bootstrap" || candidate === "incremental") {
        mode = candidate;
        index += 1;
        continue;
      }
      unknown.push(`${current} ${candidate}`.trim());
      index += 1;
      continue;
    }
    unknown.push(current);
  }

  return { dbPath, openclawRoot, mode, unknown };
}

export function main(): number {
  const { dbPath, openclawRoot, mode, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    return emitError("invalid_cli", `Unknown CLI arguments: ${unknown.join(" ")}`);
  }

  try {
    const options: {
      db_path?: string;
      openclaw_root?: string;
      mode: SyncMode;
    } = { mode };
    if (dbPath !== null) {
      options.db_path = dbPath;
    }
    if (openclawRoot !== null) {
      options.openclaw_root = openclawRoot;
    }
    const result = syncCrmFromOpenclaw(options);
    emitJson(result as unknown as Record<string, unknown>);
    return 0;
  } catch (error) {
    return emitError(
      "runtime_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
