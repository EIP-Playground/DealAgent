import { readFileSync } from "node:fs";
import { emitError, emitJson } from "./lib/cli.js";
import { parseJson } from "./lib/json.js";
import { availableSkills, dispatchSkill } from "./lib/skill_runner.js";

function parseArgs(argv: string[]): {
  skill: string | null;
  unknown: string[];
} {
  let skill: string | null = null;
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--skill") {
      skill = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    unknown.push(current);
  }

  return { skill, unknown };
}

export function main(): number {
  const { skill, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    return emitError("invalid_cli", `Unknown CLI arguments: ${unknown.join(" ")}`);
  }
  if (!skill) {
    return emitError("invalid_cli", "--skill is required");
  }
  if (!availableSkills().includes(skill)) {
    return emitError("invalid_cli", `Unsupported skill: ${skill}`);
  }

  const rawPayload = readFileSync(0, "utf-8").trim();
  if (!rawPayload) {
    return emitError("missing_stdin", "stdin JSON payload is required");
  }

  try {
    const payload = parseJson(rawPayload);
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new Error("Root JSON payload must be an object");
    }
    const result = dispatchSkill(skill, payload as Record<string, unknown>);
    emitJson(result);
    return 0;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return emitError("invalid_json", `Invalid JSON payload: ${error.message}`);
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
