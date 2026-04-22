import { parseDateOnly } from "./time.js";
import { isRecord } from "./types.js";

export function invalidResponse(
  status: string,
  reply: string,
): Record<string, unknown> {
  return { status, reply };
}

export function normalizeText(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

export function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

export function requireMapping(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return { ...value };
}

export function requireParamsMapping(params: unknown): Record<string, unknown> {
  if (params === null || params === undefined) {
    return {};
  }
  return requireMapping(params, "params");
}

export function coerceInt(value: unknown, fieldName: string): number {
  if (typeof value === "boolean") {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    if (/^[+-]?\d+$/.test(raw)) {
      const parsed = Number.parseInt(raw, 10);
      return parsed;
    }
  }
  throw new Error(`${fieldName} must be an integer`);
}

export function coerceNonNegativeInt(value: unknown, fieldName: string): number {
  const number = coerceInt(value, fieldName);
  if (number < 0) {
    throw new Error(`${fieldName} must be non-negative`);
  }
  return number;
}

export function coercePositiveInt(
  value: unknown,
  fieldName: string,
  defaultValue?: number,
): number {
  if (value === null || value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`${fieldName} must be an integer`);
  }
  const number = coerceInt(value, fieldName);
  if (number <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return number;
}

export function coerceBool(value: unknown, fieldName: string): boolean {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "True") {
    return true;
  }
  if (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "false" ||
    value === "False" ||
    value === null ||
    value === undefined
  ) {
    return false;
  }
  throw new Error(`${fieldName} must be a boolean`);
}

export function parseDateField(value: unknown, fieldName: string): Date {
  return parseDateOnly(normalizeText(value, fieldName), fieldName);
}
