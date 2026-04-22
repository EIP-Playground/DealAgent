import { readFileSync } from "node:fs";
import { emitError, emitJson } from "./lib/cli.js";
import { parseJson } from "./lib/json.js";
import { availableSkills, dispatchSkill } from "./lib/skill_runner.js";
import { isRecord } from "./lib/types.js";

function parseArgs(argv: string[]): {
  skill: string | null;
  fixture: string | null;
  dbPath: string | null;
  unknown: string[];
} {
  let skill: string | null = null;
  let fixture: string | null = null;
  let dbPath: string | null = null;
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--skill") {
      skill = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (current === "--fixture") {
      fixture = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (current === "--db-path") {
      dbPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    unknown.push(current);
  }

  return { skill, fixture, dbPath, unknown };
}

export function main(): number {
  const { skill, fixture, dbPath, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    return emitError("invalid_cli", `Unknown CLI arguments: ${unknown.join(" ")}`);
  }
  if (!skill) {
    return emitError("invalid_cli", "--skill is required");
  }
  if (!availableSkills().includes(skill)) {
    return emitError("invalid_cli", `Unsupported skill: ${skill}`);
  }
  if (!fixture) {
    return emitError("invalid_cli", "--fixture is required");
  }

  try {
    const payload = parseJson(readFileSync(fixture, "utf-8"));
    if (!isRecord(payload)) {
      throw new Error("Fixture JSON root must be an object");
    }
    if (!isRecord(payload.runtime)) {
      payload.runtime = {};
    }
    if (dbPath) {
      (payload.runtime as Record<string, unknown>).db_path = dbPath;
    }
    const result = dispatchSkill(skill, payload);
    emitJson(result);
    return 0;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return emitError("invalid_json", `Invalid fixture JSON: ${error.message}`);
    }
    return emitError(
      "runtime_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
