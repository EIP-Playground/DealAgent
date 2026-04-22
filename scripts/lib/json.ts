import type { JsonObject, JsonValue } from "./types.js";

function stableClone(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stableClone(item));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const cloned: JsonObject = {};
    for (const [key, nested] of entries) {
      cloned[key] = stableClone(nested);
    }
    return cloned;
  }

  throw new TypeError(`Unsupported JSON value: ${String(value)}`);
}

export function stableStringify(
  value: unknown,
  indent?: number,
): string {
  return JSON.stringify(stableClone(value), null, indent);
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
