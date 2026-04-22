import { stableStringify } from "./json.js";

export interface ErrorEnvelope {
  status: "error";
  error_type: string;
  reply: string;
}

export function emitJson(payload: Record<string, unknown>, indent = 2): void {
  process.stdout.write(`${stableStringify(payload, indent)}\n`);
}

export function emitError(errorType: string, reply: string): number {
  emitJson({
    status: "error",
    error_type: errorType,
    reply,
  });
  return 1;
}
