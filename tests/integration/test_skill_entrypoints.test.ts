import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIST_RUN_ENTRY,
  DIST_TEST_ENTRY,
  ROOT,
  fixturePath,
  runWithoutCheck,
} from "./helpers.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const target = tempPaths.pop()!;
    try {
      import("node:fs").then(({ rmSync }) => rmSync(target, { recursive: true, force: true }));
    } catch {
      // no-op
    }
  }
});

function assertErrorEnvelope(
  result: ReturnType<typeof runWithoutCheck>,
  errorType: string,
): Record<string, unknown> {
  expect(result.status).not.toBe(0);
  expect(result.stdout.trim()).not.toBe("");
  expect(result.stderr).toBe("");
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(payload.status).toBe("error");
  expect(payload.error_type).toBe(errorType);
  expect(payload.reply).toBeTypeOf("string");
  return payload;
}

describe("Skill entrypoint error contracts", () => {
  it("run_skill requires --skill", () => {
    const result = runWithoutCheck(["node", DIST_RUN_ENTRY], { inputText: "{}" });
    const payload = assertErrorEnvelope(result, "invalid_cli");
    expect(String(payload.reply)).toContain("--skill is required");
  });

  it("run_skill rejects unsupported skill", () => {
    const result = runWithoutCheck(
      ["node", DIST_RUN_ENTRY, "--skill", "missing-skill"],
      { inputText: "{}" },
    );
    const payload = assertErrorEnvelope(result, "invalid_cli");
    expect(String(payload.reply)).toContain("Unsupported skill");
  });

  it("run_skill rejects missing stdin", () => {
    const result = runWithoutCheck(
      ["node", DIST_RUN_ENTRY, "--skill", "onboarding"],
      { inputText: "" },
    );
    const payload = assertErrorEnvelope(result, "missing_stdin");
    expect(String(payload.reply)).toContain("stdin JSON payload is required");
  });

  it("run_skill rejects invalid JSON", () => {
    const result = runWithoutCheck(
      ["node", DIST_RUN_ENTRY, "--skill", "onboarding"],
      { inputText: "{" },
    );
    const payload = assertErrorEnvelope(result, "invalid_json");
    expect(String(payload.reply)).toContain("Invalid JSON payload");
  });

  it("run_skill returns runtime_error for handler failure", () => {
    const payload = {
      channel: "telegram",
      command_code: "onboarding.setup_suite",
      user: {},
    };
    const result = runWithoutCheck(
      ["node", DIST_RUN_ENTRY, "--skill", "onboarding"],
      { inputText: JSON.stringify(payload) },
    );
    const parsed = assertErrorEnvelope(result, "runtime_error");
    expect(String(parsed.reply)).toContain("user.external_user_id is required");
  });

  it("test_skill rejects unsupported skill", () => {
    const result = runWithoutCheck([
      "node",
      DIST_TEST_ENTRY,
      "--skill",
      "missing-skill",
      "--fixture",
      fixturePath("onboarding_first_setup.json"),
    ]);
    const payload = assertErrorEnvelope(result, "invalid_cli");
    expect(String(payload.reply)).toContain("Unsupported skill");
  });

  it("test_skill rejects invalid fixture JSON", () => {
    const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-entry-"));
    tempPaths.push(tmpdir);
    const fixture = path.join(tmpdir, "broken.json");
    writeFileSync(fixture, "{", "utf-8");

    const result = runWithoutCheck([
      "node",
      DIST_TEST_ENTRY,
      "--skill",
      "onboarding",
      "--fixture",
      fixture,
    ]);

    const payload = assertErrorEnvelope(result, "invalid_json");
    expect(String(payload.reply)).toContain("Invalid fixture JSON");
  });

  it("test_skill returns runtime_error for handler failure", () => {
    const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-entry-"));
    tempPaths.push(tmpdir);
    const fixture = path.join(tmpdir, "runtime-error.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        channel: "telegram",
        command_code: "onboarding.setup_suite",
        user: {},
      }),
      "utf-8",
    );

    const result = runWithoutCheck([
      "node",
      DIST_TEST_ENTRY,
      "--skill",
      "onboarding",
      "--fixture",
      fixture,
    ]);

    const payload = assertErrorEnvelope(result, "runtime_error");
    expect(String(payload.reply)).toContain("user.external_user_id is required");
  });
});
