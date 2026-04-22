import path from "node:path";
import {
  DEFAULT_DB_PATH,
  ensureDatabase,
  execute,
  fetchBusinessConfig,
  inTransaction,
  lastInsertRowidAsNumber,
  queryOne,
  recordAuditEvent,
  upsertBusinessConfig,
  type SqliteDatabase,
} from "../db/sqlite.js";
import { createUuid } from "./uuid.js";
import { isRecord } from "./types.js";

const DEFAULT_ENABLED_SKILLS = [
  "onboarding",
  "catalog",
  "inventory",
  "orders",
  "payments",
  "crm",
  "seller-bi",
];

interface IdentityRow {
  id: number;
  external_user_id: string;
}

interface OnboardingResponse extends Record<string, unknown> {
  status: "initialized" | "idempotent" | "rejected" | "ignored";
  reply: string;
  command_code?: string;
  db_path?: string;
  owner_id?: number;
  agent_id?: string;
  business_config?: Record<string, unknown>;
}

function defaultConfig(): Record<string, unknown> {
  return {
    channel_binding: "telegram_via_openclaw",
    database_mode: "local_sqlite",
    enabled_skills: DEFAULT_ENABLED_SKILLS,
    payment_provider: "mock",
  };
}

function isSetupIntent(commandCode: unknown): boolean {
  return String(commandCode ?? "").trim().toLowerCase() === "onboarding.setup_suite";
}

function ensureDefaults(db: SqliteDatabase): Record<string, unknown> {
  const defaults = defaultConfig();
  for (const [key, value] of Object.entries(defaults)) {
    upsertBusinessConfig(db, key, value);
  }
  return fetchBusinessConfig(db);
}

export function handleOnboarding(context: Record<string, unknown>): Record<string, unknown> {
  const commandCode = String(context.command_code ?? "").trim();
  if (!isSetupIntent(commandCode)) {
    return {
      status: "ignored",
      reply: "Unsupported onboarding command.",
      command_code: commandCode,
    };
  }

  const user = isRecord(context.user) ? context.user : {};
  const channel = String(context.channel ?? "telegram");
  const externalUserId = String(user.external_user_id ?? "").trim();
  if (!externalUserId) {
    throw new Error("user.external_user_id is required");
  }

  const username = user.username === undefined || user.username === null
    ? null
    : String(user.username);
  const runtime = isRecord(context.runtime) ? context.runtime : {};
  const dbPath = String(runtime.db_path ?? DEFAULT_DB_PATH);
  const db = ensureDatabase(dbPath);

  try {
    const result = inTransaction(db, (): OnboardingResponse => {
      recordAuditEvent(db, {
        event_type: "onboarding.setup_requested",
        actor_type: "system",
        actor_id: externalUserId,
        entity_type: "owner",
        entity_id: externalUserId,
        payload: { channel, db_path: dbPath },
      });

      const currentOwner = queryOne<IdentityRow>(
        db,
        `
          SELECT *
          FROM identities
          WHERE channel = ? AND external_user_id = ? AND is_active = 1 AND role = 'owner'
          LIMIT 1
        `,
        [channel, externalUserId],
      );
      const activeOwner = queryOne<IdentityRow>(
        db,
        "SELECT * FROM identities WHERE is_active = 1 AND role = 'owner' LIMIT 1",
      );
      const activeAgent = queryOne<IdentityRow>(
        db,
        "SELECT * FROM identities WHERE is_active = 1 AND role = 'agent' LIMIT 1",
      );

      if (activeOwner === null) {
        const ownerInsert = execute(
          db,
          `
            INSERT INTO identities(
              channel,
              external_user_id,
              username,
              role,
              is_active
            ) VALUES (?, ?, ?, 'owner', 1)
          `,
          [channel, externalUserId, username],
        );
        const ownerId = lastInsertRowidAsNumber(ownerInsert);

        const agentUuid = `agent-${createUuid()}`;
        execute(
          db,
          `
            INSERT INTO identities(
              channel,
              external_user_id,
              username,
              role,
              is_active
            ) VALUES (?, ?, 'Agent', 'agent', 1)
          `,
          [channel, agentUuid],
        );

        const config = ensureDefaults(db);
        recordAuditEvent(db, {
          event_type: "onboarding.owner_paired",
          actor_type: "owner",
          actor_id: externalUserId,
          entity_type: "owner",
          entity_id: String(ownerId),
          payload: { channel, db_path: dbPath },
        });
        return {
          status: "initialized",
          reply: "Purr Suite initialized. Owner paired and local SQLite is ready.",
          db_path: path.normalize(dbPath),
          owner_id: ownerId,
          agent_id: agentUuid,
          business_config: config,
        };
      }

      if (currentOwner !== null && activeOwner.id === currentOwner.id) {
        execute(
          db,
          `
            UPDATE identities
            SET username = ?, paired_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `,
          [username, currentOwner.id],
        );
        const config = ensureDefaults(db);
        recordAuditEvent(db, {
          event_type: "onboarding.setup_idempotent",
          actor_type: "owner",
          actor_id: externalUserId,
          entity_type: "owner",
          entity_id: String(currentOwner.id),
          payload: { channel, db_path: dbPath },
        });
        return {
          status: "idempotent",
          reply: "Purr Suite is already initialized for this owner.",
          db_path: path.normalize(dbPath),
          owner_id: currentOwner.id,
          agent_id: activeAgent?.external_user_id ?? "agent-001",
          business_config: config,
        };
      }

      recordAuditEvent(db, {
        event_type: "onboarding.setup_rejected",
        actor_type: "customer",
        actor_id: externalUserId,
        entity_type: "owner",
        entity_id: String(activeOwner.id),
        payload: {
          channel,
          db_path: dbPath,
          reason: "active_owner_exists",
        },
      });
      return {
        status: "rejected",
        reply: "Purr Suite is already paired to another owner.",
        db_path: path.normalize(dbPath),
        owner_id: activeOwner.id,
      };
    })();

    return result;
  } finally {
    db.close();
  }
}
