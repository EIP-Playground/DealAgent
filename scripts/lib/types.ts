export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonObject
  | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type RuntimeContext = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}
