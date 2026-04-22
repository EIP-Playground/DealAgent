import Database from "better-sqlite3";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DEFAULT_DB_PATH } from "../db/sqlite.js";
import { parseJson } from "../lib/json.js";
import { resolveSkillPackageRoot } from "../lib/paths.js";
import { availableSkills, dispatchSkill } from "../lib/skill_runner.js";
import { isRecord } from "../lib/types.js";

const ROOT = resolveSkillPackageRoot(import.meta.url);
const REVIEW_CATALOG_PRESET = "review-catalog";
const DEMO_REPLAY_PRESET = "demo-replay";
const DEMO_PAID_AT = "2099-07-02 10:15:00";
const DEMO_REFUNDED_AT = "2099-07-12 09:00:00";

type ReplayAction =
  | { type: "fixture"; path: string }
  | { type: "hook"; name: keyof typeof HOOKS };

function fixtureAction(...segments: string[]): ReplayAction {
  return {
    type: "fixture",
    path: path.join(ROOT, ...segments),
  };
}

function hookAction(name: keyof typeof HOOKS): ReplayAction {
  return { type: "hook", name };
}

const REVIEW_CATALOG_ACTIONS: ReplayAction[] = [
  fixtureAction("tests", "fixtures", "catalog_owner_add_room_deluxe_seaview.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_room_standard_city.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_room_family_suite.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_room_single_seaview_unavailable.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_minibar_snack_box.json"),
  fixtureAction("tests", "fixtures", "inventory_owner_set_family_suite_holiday_stock.json"),
  fixtureAction("tests", "fixtures", "inventory_owner_adjust_minibar_stock_low.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_update_room_price_peak_season.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_update_room_status_unavailable.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_archive_room_type.json"),
];

const DEMO_REPLAY_ACTIONS: ReplayAction[] = [
  fixtureAction("tests", "fixtures", "onboarding_first_setup.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_room_deluxe_seaview.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_room_standard_city.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_room_single_seaview_unavailable.json"),
  fixtureAction("tests", "fixtures", "catalog_owner_add_minibar_snack_box.json"),
  fixtureAction("tests", "fixtures", "inventory_owner_adjust_minibar_stock_low.json"),
  fixtureAction("tests", "fixtures", "inventory_owner_show_inventory.json"),
  fixtureAction("tests", "fixtures", "catalog_customer_show_room_catalog_with_dates.json"),
  fixtureAction("tests", "fixtures", "crm_caller_log_inquiry_deluxe_room.json"),
  fixtureAction("tests", "fixtures", "crm_caller_log_reply_deluxe_room.json"),
  fixtureAction("tests", "fixtures", "crm_caller_upsert_customer_summary_customer_001.json"),
  fixtureAction("tests", "fixtures", "crm_owner_show_history_customer_001.json"),
  fixtureAction("tests", "fixtures", "crm_caller_get_response_context_customer_001.json"),
  fixtureAction("tests", "fixtures", "orders_customer_create_deluxe_room_and_minibar.json"),
  fixtureAction("tests", "fixtures", "payments_caller_create_payment_link.json"),
  fixtureAction("tests", "fixtures", "payments_caller_confirm_mock_paid.json"),
  hookAction("set_demo_paid_timestamps"),
  fixtureAction("tests", "fixtures", "inventory_owner_show_inventory.json"),
  fixtureAction("tests", "fixtures", "orders_customer_show_my_orders.json"),
  fixtureAction("tests", "fixtures", "seller_bi_owner_sales_today.json"),
  fixtureAction("tests", "fixtures", "seller_bi_owner_revenue_this_month.json"),
  fixtureAction("tests", "fixtures", "payments_owner_refund_mock_payment.json"),
  hookAction("set_demo_refund_timestamps"),
  fixtureAction("tests", "fixtures", "seller_bi_owner_sales_today.json"),
  fixtureAction("tests", "fixtures", "seller_bi_owner_revenue_this_month.json"),
];

const PRESETS = {
  [REVIEW_CATALOG_PRESET]: REVIEW_CATALOG_ACTIONS,
  [DEMO_REPLAY_PRESET]: DEMO_REPLAY_ACTIONS,
} as const;

type PresetName = keyof typeof PRESETS;

function getAgentId(dbPath: string): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT external_user_id FROM identities WHERE role = 'agent' AND is_active = 1 LIMIT 1",
      )
      .get() as { external_user_id: string } | undefined;
    return row?.external_user_id ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function inferSkillFromFixture(fixturePath: string): string {
  const stem = path.basename(fixturePath, path.extname(fixturePath));
  const aliases = Object.fromEntries(
    availableSkills().map((skill) => [skill.replaceAll("-", "_"), skill]),
  );
  for (const [normalizedPrefix, skillName] of Object.entries(aliases).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    if (stem === normalizedPrefix || stem.startsWith(`${normalizedPrefix}_`)) {
      return skillName;
    }
  }

  const prefix = stem.split("_", 1)[0]!;
  if (availableSkills().includes(prefix)) {
    return prefix;
  }
  throw new Error(
    `Could not infer a registered skill from fixture name: ${path.basename(fixturePath)}`,
  );
}

function loadPayload(fixturePath: string, dbPath: string): Record<string, unknown> {
  const payload = parseJson(readFileSync(fixturePath, "utf-8"));
  if (!isRecord(payload)) {
    throw new Error(`Fixture JSON root must be an object: ${fixturePath}`);
  }
  if (!isRecord(payload.runtime)) {
    payload.runtime = {};
  }
  (payload.runtime as Record<string, unknown>).db_path = dbPath;

  if (isRecord(payload.user) && payload.user.external_user_id === "agent-001") {
    const agentId = getAgentId(dbPath);
    if (agentId) {
      payload.user.external_user_id = agentId;
    }
  }

  return payload;
}

function hasActiveOwner(dbPath: string): boolean {
  if (!existsSync(dbPath)) {
    return false;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `
          SELECT 1 AS matched
          FROM identities
          WHERE is_active = 1 AND role = 'owner'
          LIMIT 1
        `,
      )
      .get() as { matched: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function resolveReplayActions(rawFixtures: string[], preset: PresetName | null): ReplayAction[] {
  const resolved: ReplayAction[] = [];
  if (preset) {
    resolved.push(...PRESETS[preset]);
  }
  for (const item of rawFixtures) {
    resolved.push({ type: "fixture", path: path.resolve(item) });
  }
  return resolved;
}

function requireDemoRow(db: Database.Database, sql: string, params: string[]): void {
  const result = db.prepare(sql).run(...params);
  if (result.changes === 0) {
    throw new Error("Demo replay preset could not locate the expected order/payment row.");
  }
}

function setDemoPaidTimestamps(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    requireDemoRow(
      db,
      `
        UPDATE orders
        SET paid_at = ?
        WHERE order_number = 'PO-1001'
      `,
      [DEMO_PAID_AT],
    );
    requireDemoRow(
      db,
      `
        UPDATE payments
        SET paid_at = ?
        WHERE provider_reference = 'mock-pay-po-1001-001'
      `,
      [DEMO_PAID_AT],
    );
  } finally {
    db.close();
  }
}

function setDemoRefundTimestamps(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    requireDemoRow(
      db,
      `
        UPDATE orders
        SET paid_at = ?, refunded_at = ?
        WHERE order_number = 'PO-1001'
      `,
      [DEMO_PAID_AT, DEMO_REFUNDED_AT],
    );
    requireDemoRow(
      db,
      `
        UPDATE payments
        SET paid_at = ?, refunded_at = ?
        WHERE provider_reference = 'mock-pay-po-1001-001'
      `,
      [DEMO_PAID_AT, DEMO_REFUNDED_AT],
    );
  } finally {
    db.close();
  }
}

const HOOKS = {
  set_demo_paid_timestamps: setDemoPaidTimestamps,
  set_demo_refund_timestamps: setDemoRefundTimestamps,
} as const;

function parseArgs(argv: string[]): {
  fixtures: string[];
  preset: PresetName | null;
  dbPath: string;
  skill: string | null;
  fresh: boolean;
} {
  const fixtures: string[] = [];
  let preset: PresetName | null = null;
  let dbPath = DEFAULT_DB_PATH;
  let skill: string | null = null;
  let fresh = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--preset") {
      const value = argv[index + 1] ?? "";
      if (!(value in PRESETS)) {
        throw new Error(`--preset must be one of: ${Object.keys(PRESETS).sort().join(", ")}`);
      }
      preset = value as PresetName;
      index += 1;
      continue;
    }
    if (current === "--db-path") {
      dbPath = argv[index + 1] ?? dbPath;
      index += 1;
      continue;
    }
    if (current === "--skill") {
      const value = argv[index + 1] ?? "";
      if (!availableSkills().includes(value)) {
        throw new Error(`--skill must be one of: ${availableSkills().join(", ")}`);
      }
      skill = value;
      index += 1;
      continue;
    }
    if (current === "--fresh") {
      fresh = true;
      continue;
    }
    if (current.startsWith("--")) {
      throw new Error(`Unknown CLI argument: ${current}`);
    }
    fixtures.push(current);
  }

  return { fixtures, preset, dbPath, skill, fresh };
}

export function main(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.preset && args.skill) {
      throw new Error("--preset cannot be combined with --skill override.");
    }

    if (args.fresh && existsSync(args.dbPath)) {
      rmSync(args.dbPath, { force: true });
    }

    let actions = resolveReplayActions(args.fixtures, args.preset);
    if (actions.length === 0) {
      throw new Error("Provide at least one fixture path or a --preset value.");
    }

    if (
      args.preset === REVIEW_CATALOG_PRESET &&
      !hasActiveOwner(args.dbPath)
    ) {
      actions = [
        fixtureAction("tests", "fixtures", "onboarding_first_setup.json"),
        ...actions,
      ];
    }

    let failures = 0;
    for (const action of actions) {
      try {
        if (action.type === "hook") {
          HOOKS[action.name](args.dbPath);
          process.stdout.write(`[ok] <hook:${action.name}>\n`);
          continue;
        }

        const skill = args.skill ?? inferSkillFromFixture(action.path);
        const payload = loadPayload(action.path, args.dbPath);
        const result = dispatchSkill(skill, payload);
        const status = String(result.status ?? "unknown");
        const reply = result.reply ? String(result.reply) : "";
        process.stdout.write(`[ok] ${action.path} -> ${skill}: ${status}\n`);
        if (reply) {
          process.stdout.write(`  reply: ${reply}\n`);
        }
      } catch (error) {
        failures += 1;
        const label =
          action.type === "fixture" ? action.path : `<hook:${action.name}>`;
        process.stderr.write(
          `[error] ${label}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    if (failures > 0) {
      process.stderr.write(`Replay finished with ${failures} failure(s).\n`);
      return 1;
    }

    process.stdout.write(`Replay finished successfully. DB: ${args.dbPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
