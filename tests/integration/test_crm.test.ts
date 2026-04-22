import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentId, loadFixture, runProdEntry, runTestEntry } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), "purr-suite-crm-"));
  tempDirs.push(tmpdir);
  return path.join(tmpdir, "crm.sqlite3");
}

function setupOwner(dbPath: string): void {
  runProdEntry("onboarding", "onboarding_first_setup.json", dbPath);
}

function seedCatalog(dbPath: string): void {
  runProdEntry("catalog", "catalog_owner_add_room_deluxe_seaview.json", dbPath);
}

describe("CRM runtime", () => {
  it("log inquiry/reply and show history persist customer and audit", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedCatalog(dbPath);

    const inquiry = runTestEntry("crm", "crm_caller_log_inquiry_deluxe_room.json", dbPath);
    const reply = runTestEntry("crm", "crm_caller_log_reply_deluxe_room.json", dbPath);
    const history = runTestEntry("crm", "crm_owner_show_history_customer_001.json", dbPath);

    expect(inquiry.status).toBe("logged");
    expect((inquiry.conversation as any).direction).toBe("inbound");
    expect(reply.status).toBe("logged");
    expect((reply.conversation as any).direction).toBe("outbound");
    expect(history.status).toBe("listed");
    expect(history.customer_exists).toBe(true);
    expect(history.conversation_count).toBe(2);
    expect((history.conversations as any[])[0].direction).toBe("inbound");
    expect((history.conversations as any[])[1].direction).toBe("outbound");
    expect((history.conversations as any[])[0].primary_sku_ref.sku_code).toBe(
      "DELUXE-SEAVIEW-KING",
    );
    expect((history.conversations as any[])[0].primary_sku_ref.reference_source).toBe(
      "conversation_history",
    );

    const db = new Database(dbPath);
    try {
      const customerCount = Number(
        (
          db
            .prepare(
              `
                SELECT COUNT(*) AS row_count
                FROM customers
                WHERE channel = 'telegram' AND external_user_id = 'customer-001'
              `,
            )
            .get() as { row_count: number }
        ).row_count,
      );
      const conversationRows = db
        .prepare(
          `
            SELECT direction, message_text, summary
            FROM conversations
            ORDER BY id ASC
          `,
        )
        .all() as Array<{ direction: string; message_text: string; summary: string | null }>;
      const auditRows = db
        .prepare(
          `
            SELECT event_type, actor_type, actor_id, payload_json
            FROM audit_events
            WHERE event_type LIKE 'crm.%'
            ORDER BY id ASC
          `,
        )
        .all() as Array<{
          event_type: string;
          actor_type: string;
          actor_id: string;
          payload_json: string;
        }>;

      expect(customerCount).toBe(1);
      expect(conversationRows).toHaveLength(2);
      expect(conversationRows[0]?.direction).toBe("inbound");
      expect(conversationRows[1]?.direction).toBe("outbound");

      const agentId = getAgentId(dbPath);
      expect(auditRows.map((row) => row.event_type)).toEqual([
        "crm.inquiry_logged",
        "crm.reply_logged",
      ]);
      expect(auditRows.map((row) => row.actor_type)).toEqual(["caller", "caller"]);
      expect(auditRows.map((row) => row.actor_id)).toEqual([
        `telegram:${agentId}`,
        `telegram:${agentId}`,
      ]);
      expect(JSON.parse(auditRows[0]!.payload_json).actor_identity).toEqual({
        channel: "telegram",
        external_user_id: agentId,
        auth_identity_model: "caller_identity",
      });
    } finally {
      db.close();
    }
  });

  it("upsert summary and response context use current sku snapshot", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedCatalog(dbPath);
    runTestEntry("crm", "crm_caller_log_inquiry_deluxe_room.json", dbPath);

    const firstSummary = runTestEntry(
      "crm",
      "crm_caller_upsert_customer_summary_customer_001.json",
      dbPath,
    );
    const replacementSummary = runProdEntry(
      "crm",
      {
        channel: "telegram",
        command_code: "crm.upsert_customer_summary",
        params: {
          customer: {
            external_user_id: "customer-001",
            username: "guest-anna",
          },
          summary_json: {
            preferred_language: "en",
            priority: "vip",
          },
        },
        user: {
          external_user_id: "agent-001",
          username: "alice",
        },
      },
      dbPath,
    );
    const context = runTestEntry(
      "crm",
      "crm_caller_get_response_context_customer_001.json",
      dbPath,
    );
    const forbidden = runProdEntry(
      "crm",
      {
        channel: "telegram",
        command_code: "crm.get_response_context",
        params: {
          customer: {
            external_user_id: "customer-001",
          },
          check_in_date: "2099-07-01",
          check_out_date: "2099-07-04",
        },
        user: {
          external_user_id: "customer-001",
          username: "guest-anna",
        },
      },
      dbPath,
    );

    expect(firstSummary.status).toBe("updated");
    expect(replacementSummary.status).toBe("updated");
    expect(context.status).toBe("found");
    expect(context.customer_exists).toBe(true);
    expect((context.customer as any).channel).toBe("telegram");
    expect(context.customer_summary_json).toEqual({
      preferred_language: "en",
      priority: "vip",
    });
    expect(context.context_window_size).toBe(1);
    expect((context.recent_conversations as any[])).toHaveLength(1);
    expect((context.primary_sku_ref as any).sku_code).toBe("DELUXE-SEAVIEW-KING");
    expect((context.primary_sku_ref as any).reference_source).toBe("conversation_history");
    expect((context.current_sku_snapshot as any).snapshot_source).toBe("catalog_live_read");
    expect((context.current_sku_snapshot as any).is_historical_truth).toBe(false);
    expect((context.current_sku_snapshot as any).sku.sku_code).toBe("DELUXE-SEAVIEW-KING");
    expect((context.current_sku_snapshot as any).sku.availability_status).toBe("available");
    expect((context.current_sku_snapshot as any).sku.check_in_date).toBe("2099-07-01");
    expect((context.current_sku_snapshot as any).sku.check_out_date).toBe("2099-07-04");
    expect(forbidden.status).toBe("forbidden");

    const db = new Database(dbPath);
    try {
      const summaryAudit = db
        .prepare(
          `
            SELECT actor_type, actor_id, payload_json
            FROM audit_events
            WHERE event_type = 'crm.customer_summary_upserted'
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get() as
        | {
            actor_type: string;
            actor_id: string;
            payload_json: string;
          }
        | undefined;

      expect(summaryAudit).toBeDefined();
      if (!summaryAudit) {
        throw new Error("Missing crm.customer_summary_upserted audit row");
      }

      const agentId = getAgentId(dbPath);
      expect(summaryAudit.actor_type).toBe("caller");
      expect(summaryAudit.actor_id).toBe(`telegram:${agentId}`);
      expect(JSON.parse(summaryAudit.payload_json).actor_identity).toEqual({
        channel: "telegram",
        external_user_id: agentId,
        auth_identity_model: "caller_identity",
      });
    } finally {
      db.close();
    }
  });

  it("show_history empty stays stable and customer reads are forbidden", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);

    const empty = runProdEntry(
      "crm",
      {
        channel: "telegram",
        command_code: "crm.show_history",
        params: {
          customer: {
            external_user_id: "customer-404",
          },
        },
        user: {
          external_user_id: "owner-001",
          username: "alice",
        },
      },
      dbPath,
    );
    const forbidden = runProdEntry(
      "crm",
      {
        channel: "telegram",
        command_code: "crm.show_history",
        params: {
          customer: {
            external_user_id: "customer-404",
          },
        },
        user: {
          external_user_id: "customer-404",
          username: "guest-missing",
        },
      },
      dbPath,
    );

    expect(empty.status).toBe("listed");
    expect(empty.customer_exists).toBe(false);
    expect(empty.conversation_count).toBe(0);
    expect(empty.conversations).toEqual([]);
    expect(forbidden.status).toBe("forbidden");
  });

  it("context separates historical sku ref from current catalog snapshot", () => {
    const dbPath = tempDbPath();
    setupOwner(dbPath);
    seedCatalog(dbPath);

    const inquiryPayload = loadFixture("crm_caller_log_inquiry_deluxe_room.json");
    runProdEntry("crm", inquiryPayload, dbPath);

    const before = runTestEntry(
      "crm",
      "crm_caller_get_response_context_customer_001.json",
      dbPath,
    );
    runProdEntry(
      "catalog",
      {
        channel: "telegram",
        command_code: "catalog.update_details",
        params: {
          sku_code: "DELUXE-SEAVIEW-KING",
          title: "Deluxe Seaview King Renovated",
        },
        user: {
          external_user_id: "owner-001",
          username: "alice",
        },
      },
      dbPath,
    );
    const after = runTestEntry(
      "crm",
      "crm_caller_get_response_context_customer_001.json",
      dbPath,
    );

    expect((before.primary_sku_ref as any).source_conversation_id).toBe(
      (after.primary_sku_ref as any).source_conversation_id,
    );
    expect((before.current_sku_snapshot as any).snapshot_source).toBe("catalog_live_read");
    expect((before.current_sku_snapshot as any).sku.title).toBe("Deluxe Seaview King");
    expect((after.current_sku_snapshot as any).sku.title).toBe("Deluxe Seaview King Renovated");
    expect((after.recent_conversations as any[])[0].message_text).toBe(
      (inquiryPayload.params as any).message_text,
    );
    expect((after.recent_conversations as any[])[0].summary).toBe(
      (inquiryPayload.params as any).summary,
    );
  });
});
