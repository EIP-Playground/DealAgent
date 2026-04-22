import Database from "better-sqlite3";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOpenclawSessionLine } from "../../scripts/lib/openclaw_crm_sync.js";
import {
  DIST_SYNC_CRM_ENTRY,
  runCommand,
  runProdEntry,
  tempDbPath,
} from "./helpers.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

function tempOpenclawRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "purr-suite-openclaw-"));
  tempPaths.push(root);
  return root;
}

function tempDb(): string {
  const dbPath = tempDbPath();
  tempPaths.push(path.dirname(dbPath));
  return dbPath;
}

function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

function sessionFile(
  openclawRoot: string,
  agentName: string,
  fileName: string,
): string {
  const dir = path.join(openclawRoot, "agents", agentName, "sessions");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

function writeSessionLines(target: string, lines: string[]): void {
  writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function appendSessionLines(target: string, lines: string[]): void {
  appendFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function syncCrm(
  dbPath: string,
  openclawRoot: string,
  mode: "bootstrap" | "incremental",
): Record<string, unknown> {
  const result = runCommand([
    "node",
    DIST_SYNC_CRM_ENTRY,
    "--db-path",
    dbPath,
    "--openclaw-root",
    openclawRoot,
    "--mode",
    mode,
  ]);
  if (result.status !== 0) {
    throw new Error(`sync_crm_from_openclaw failed: ${result.stdout || result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function userMessageLine(options: {
  session_message_id: string;
  telegram_message_id: string;
  sender_id: string;
  username?: string | null;
  body: string;
  include_system_prefix?: boolean;
  include_reply_context?: boolean;
  is_group_chat?: boolean;
  sender_label?: string;
}): string {
  const conversationInfo: Record<string, unknown> = {
    message_id: options.telegram_message_id,
    sender_id: options.sender_id,
    sender: options.sender_label ?? options.sender_id,
    timestamp: "Fri 2026-03-20 09:24 GMT+8",
  };
  if (options.is_group_chat === true) {
    conversationInfo.group_subject = "Test Group";
    conversationInfo.conversation_label = "Test Group id:-1001";
    conversationInfo.is_group_chat = true;
  }
  let text = "";
  if (options.include_system_prefix) {
    text += "System: [2026-03-20 09:24 GMT+8] Exec completed (quiet-ba, code 0)\n\n";
  }
  text += `Conversation info (untrusted metadata):
\`\`\`json
${JSON.stringify(conversationInfo, null, 2)}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
${JSON.stringify(
    {
      label: options.sender_label ?? `${options.sender_id} (${options.sender_id})`,
      id: options.sender_id,
      username: options.username ?? null,
    },
    null,
    2,
  )}
\`\`\`
`;
  if (options.include_reply_context) {
    text += `

Replied message (untrusted, for context):
\`\`\`json
${JSON.stringify({ sender_label: "bot", body: "Earlier message" }, null, 2)}
\`\`\`

Chat history since last reply (untrusted, for context):
\`\`\`json
${JSON.stringify([{ sender_label: "bot", body: "Older context" }], null, 2)}
\`\`\`
`;
  }
  text += `\n\n${options.body}`;
  return JSON.stringify({
    type: "message",
    id: options.session_message_id,
    timestamp: "2026-03-20T01:24:57.790Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1773969897789,
    },
  });
}

function deliveryMirrorLine(
  sessionMessageId: string,
  messageText: string,
): string {
  return JSON.stringify({
    type: "message",
    id: sessionMessageId,
    timestamp: "2026-03-20T01:16:28.781Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: messageText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      stopReason: "stop",
    },
  });
}

function rawAssistantLine(
  sessionMessageId: string,
  messageText: string,
): string {
  return JSON.stringify({
    type: "message",
    id: sessionMessageId,
    timestamp: "2026-03-20T01:16:20.384Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: messageText }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      stopReason: "stop",
    },
  });
}

function setupOwner(dbPath: string): void {
  runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
}

describe("OpenClaw CRM parser", () => {
  it("parses private user messages and strips metadata noise", () => {
    const parsed = parseOpenclawSessionLine(
      userMessageLine({
        session_message_id: "session-user-001",
        telegram_message_id: "301",
        sender_id: "customer-telegram-1",
        username: "guest-anna",
        body: "我想订 Deluxe Seaview King",
        include_system_prefix: true,
        include_reply_context: true,
      }),
    );

    expect(parsed).toEqual({
      kind: "inbound",
      session_message_id: "session-user-001",
      session_created_at: "2026-03-20T01:24:57.790Z",
      telegram_message_id: "301",
      sender_id: "customer-telegram-1",
      sender_username: "guest-anna",
      message_text: "我想订 Deluxe Seaview King",
    });
  });

  it("ignores group, control-ui, and raw assistant lines while keeping delivery mirror", () => {
    expect(
      parseOpenclawSessionLine(
        userMessageLine({
          session_message_id: "group-001",
          telegram_message_id: "401",
          sender_id: "customer-telegram-2",
          body: "@bot 还有房吗",
          is_group_chat: true,
        }),
      ),
    ).toBeNull();
    expect(
      parseOpenclawSessionLine(
        userMessageLine({
          session_message_id: "control-ui-001",
          telegram_message_id: "402",
          sender_id: "openclaw-control-ui",
          sender_label: "openclaw-control-ui",
          body: "你好",
        }),
      ),
    ).toBeNull();
    expect(parseOpenclawSessionLine(rawAssistantLine("assistant-raw-001", "Draft reply"))).toBeNull();
    expect(parseOpenclawSessionLine(deliveryMirrorLine("delivery-001", "已为你确认可订。"))).toEqual({
      kind: "outbound",
      session_message_id: "delivery-001",
      session_created_at: "2026-03-20T01:16:28.781Z",
      message_text: "已为你确认可订。",
    });
  });
});

describe("OpenClaw CRM sync", () => {
  it("bootstrap stores cursor state without importing history and later reuses peer context for delivery mirror", () => {
    const dbPath = tempDb();
    const openclawRoot = tempOpenclawRoot();
    const target = sessionFile(openclawRoot, "hotel-desk", "customer-dm.jsonl");
    setupOwner(dbPath);

    writeSessionLines(target, [
      userMessageLine({
        session_message_id: "history-inbound-001",
        telegram_message_id: "501",
        sender_id: "customer-telegram-3",
        username: "guest-bob",
        body: "Hi, I need a room next week.",
      }),
    ]);

    const bootstrapped = syncCrm(dbPath, openclawRoot, "bootstrap");
    expect(bootstrapped.status).toBe("synced");
    expect(bootstrapped.bootstrapped_session_count).toBe(1);
    expect(bootstrapped.inbound_synced_count).toBe(0);
    expect(bootstrapped.outbound_synced_count).toBe(0);

    appendSessionLines(target, [
      deliveryMirrorLine("delivery-002", "Deluxe Seaview King is still available."),
    ]);

    const synced = syncCrm(dbPath, openclawRoot, "incremental");
    expect(synced.outbound_synced_count).toBe(1);
    expect(synced.inbound_synced_count).toBe(0);

    const db = openDb(dbPath);
    try {
      const conversations = db
        .prepare(
          `
            SELECT direction, message_text, source_kind, source_event_key
            FROM conversations
            ORDER BY id ASC
          `,
        )
        .all() as Array<{
          direction: string;
          message_text: string;
          source_kind: string;
          source_event_key: string;
        }>;
      const cursor = db
        .prepare(
          `
            SELECT last_processed_line, peer_external_user_id, peer_username
            FROM crm_sync_cursors
            WHERE session_relpath = 'agents/hotel-desk/sessions/customer-dm.jsonl'
          `,
        )
        .get() as
        | {
            last_processed_line: number;
            peer_external_user_id: string;
            peer_username: string | null;
          }
        | undefined;

      expect(conversations).toEqual([
        {
          direction: "outbound",
          message_text: "Deluxe Seaview King is still available.",
          source_kind: "openclaw_delivery_mirror",
          source_event_key:
            "openclaw:agents/hotel-desk/sessions/customer-dm.jsonl:delivery-002:delivery",
        },
      ]);
      expect(cursor).toEqual({
        last_processed_line: 2,
        peer_external_user_id: "customer-telegram-3",
        peer_username: "guest-bob",
      });
    } finally {
      db.close();
    }
  });

  it("incremental sync imports inbound and outbound, ignores non-customer lines, and stays idempotent", () => {
    const dbPath = tempDb();
    const openclawRoot = tempOpenclawRoot();
    const target = sessionFile(openclawRoot, "main", "mixed-session.jsonl");
    setupOwner(dbPath);

    writeSessionLines(target, []);
    syncCrm(dbPath, openclawRoot, "bootstrap");

    appendSessionLines(target, [
      userMessageLine({
        session_message_id: "owner-inbound-001",
        telegram_message_id: "601",
        sender_id: "owner-001",
        username: "alice",
        body: "帮我看看店铺",
      }),
      userMessageLine({
        session_message_id: "group-inbound-001",
        telegram_message_id: "602",
        sender_id: "customer-telegram-group",
        username: "group-user",
        body: "@bot 还有房吗",
        is_group_chat: true,
      }),
      userMessageLine({
        session_message_id: "customer-inbound-001",
        telegram_message_id: "603",
        sender_id: "customer-telegram-4",
        username: "guest-cathy",
        body: "Can you hold Deluxe Seaview King for me?",
      }),
      rawAssistantLine("assistant-raw-002", "Internal draft reply"),
      deliveryMirrorLine("delivery-003", "Yes, I can hold it for today."),
    ]);

    const firstRun = syncCrm(dbPath, openclawRoot, "incremental");
    expect(firstRun.inbound_synced_count).toBe(1);
    expect(firstRun.outbound_synced_count).toBe(1);
    expect(firstRun.warning_count).toBe(0);

    const secondRun = syncCrm(dbPath, openclawRoot, "incremental");
    expect(secondRun.inbound_synced_count).toBe(0);
    expect(secondRun.outbound_synced_count).toBe(0);

    const history = runProdEntry(
      "crm",
      {
        channel: "telegram",
        command_code: "crm.show_history",
        params: {
          customer: {
            external_user_id: "customer-telegram-4",
          },
        },
        user: {
          external_user_id: "owner-001",
          username: "alice",
        },
      },
      dbPath,
    );
    expect(history.status).toBe("listed");
    expect(history.conversation_count).toBe(2);
    expect((history.conversations as Array<Record<string, unknown>>).map((row) => row.direction)).toEqual([
      "inbound",
      "outbound",
    ]);

    const db = openDb(dbPath);
    try {
      const conversations = db
        .prepare(
          `
            SELECT direction, message_text, source_kind, channel_message_id
            FROM conversations
            ORDER BY id ASC
          `,
        )
        .all() as Array<{
          direction: string;
          message_text: string;
          source_kind: string;
          channel_message_id: string | null;
        }>;
      const auditEvents = db
        .prepare(
          `
            SELECT event_type, actor_type, actor_id
            FROM audit_events
            WHERE event_type LIKE 'crm.%_synced'
            ORDER BY id ASC
          `,
        )
        .all() as Array<{
          event_type: string;
          actor_type: string;
          actor_id: string;
        }>;

      expect(conversations).toEqual([
        {
          direction: "inbound",
          message_text: "Can you hold Deluxe Seaview King for me?",
          source_kind: "openclaw_inbound",
          channel_message_id: "603",
        },
        {
          direction: "outbound",
          message_text: "Yes, I can hold it for today.",
          source_kind: "openclaw_delivery_mirror",
          channel_message_id: null,
        },
      ]);
      expect(auditEvents).toEqual([
        {
          event_type: "crm.inquiry_synced",
          actor_type: "system",
          actor_id: "openclaw:session-sync",
        },
        {
          event_type: "crm.reply_synced",
          actor_type: "system",
          actor_id: "openclaw:session-sync",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("skips delivery mirror without a known peer context", () => {
    const dbPath = tempDb();
    const openclawRoot = tempOpenclawRoot();
    const target = sessionFile(openclawRoot, "main", "orphan-reply.jsonl");
    setupOwner(dbPath);

    writeSessionLines(target, []);
    syncCrm(dbPath, openclawRoot, "bootstrap");

    appendSessionLines(target, [
      deliveryMirrorLine("delivery-004", "I can help with that."),
    ]);

    const synced = syncCrm(dbPath, openclawRoot, "incremental");
    expect(synced.inbound_synced_count).toBe(0);
    expect(synced.outbound_synced_count).toBe(0);
    expect(synced.warning_count).toBe(1);
    expect((synced.warnings as Array<Record<string, unknown>>)[0]?.reason).toContain(
      "without a resolved private-chat peer",
    );

    const db = openDb(dbPath);
    try {
      const rowCount = Number(
        (
          db.prepare("SELECT COUNT(*) AS row_count FROM conversations").get() as {
            row_count: number;
          }
        ).row_count,
      );
      expect(rowCount).toBe(0);
    } finally {
      db.close();
    }
  });
});
