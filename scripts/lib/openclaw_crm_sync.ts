import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DB_PATH,
  ensureDatabase,
  execute,
  queryOne,
  recordAuditEvent,
  type SqliteDatabase,
} from "../db/sqlite.js";
import {
  appendConversation,
  isStoreRepresentative,
  type ConversationSourceKind,
} from "./crm.js";
import { parseJson } from "./json.js";
import { nowUtcTimestamp } from "./time.js";
import { isRecord } from "./types.js";

const DEFAULT_OPENCLAW_ROOT = path.join(os.homedir(), ".openclaw");
const TELEGRAM_CHANNEL = "telegram";
const SYSTEM_ACTOR_ID = "openclaw:session-sync";
const CONTEXT_HEADERS = [
  "Conversation info (untrusted metadata)",
  "Sender (untrusted metadata)",
  "Replied message (untrusted, for context)",
  "Chat history since last reply (untrusted, for context)",
] as const;

type SyncMode = "bootstrap" | "incremental";

interface SyncCursorRow {
  session_relpath: string;
  last_processed_line: number;
  bootstrapped_at: string | null;
  peer_channel: string | null;
  peer_external_user_id: string | null;
  peer_username: string | null;
}

interface PeerContext {
  peer_channel: string | null;
  peer_external_user_id: string | null;
  peer_username: string | null;
}

export interface SyncWarning {
  session_relpath: string;
  line_number: number;
  reason: string;
  session_message_id?: string;
}

export interface ParsedInboundSessionEvent {
  kind: "inbound";
  session_message_id: string;
  session_created_at: string | null;
  telegram_message_id: string | null;
  sender_id: string;
  sender_username: string | null;
  message_text: string;
}

export interface ParsedDeliveryMirrorSessionEvent {
  kind: "outbound";
  session_message_id: string;
  session_created_at: string | null;
  message_text: string;
}

export type ParsedSessionEvent =
  | ParsedInboundSessionEvent
  | ParsedDeliveryMirrorSessionEvent;

export interface SyncCrmFromOpenclawOptions {
  db_path?: string;
  openclaw_root?: string;
  mode?: SyncMode;
}

export interface SyncCrmFromOpenclawResult {
  status: "synced";
  reply: string;
  mode: SyncMode;
  db_path: string;
  openclaw_root: string;
  session_file_count: number;
  bootstrapped_session_count: number;
  scanned_line_count: number;
  inbound_synced_count: number;
  outbound_synced_count: number;
  skipped_event_count: number;
  warning_count: number;
  warnings: SyncWarning[];
}

interface SessionSyncOutcome {
  bootstrapped: boolean;
  scanned_line_count: number;
  inbound_synced_count: number;
  outbound_synced_count: number;
  skipped_event_count: number;
  warnings: SyncWarning[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockPattern(header: string, global = false): RegExp {
  return new RegExp(
    `${escapeRegExp(header)}:\\n\`\`\`(?:json)?\\n([\\s\\S]*?)\\n\`\`\`\\n*`,
    global ? "gm" : "m",
  );
}

function firstTextContent(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const textParts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type !== "text") {
      continue;
    }
    const text = typeof item.text === "string" ? item.text : null;
    if (text) {
      textParts.push(text);
    }
  }
  if (textParts.length === 0) {
    return null;
  }
  return textParts.join("\n\n").trim() || null;
}

function extractJsonBlock(
  text: string,
  header: string,
): Record<string, unknown> | null {
  const match = blockPattern(header).exec(text);
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = parseJson(match[1]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripLeadingSystemLines(text: string): string {
  return text.replace(/^(?:System:.*(?:\n|$))+/, "").trimStart();
}

function stripKnownContext(text: string): string {
  let cleaned = text.replace(/\r\n/g, "\n");
  cleaned = stripLeadingSystemLines(cleaned);
  cleaned = cleaned.replace(/^\[Queued messages while agent was busy\]\s*\n*/g, "");
  cleaned = cleaned.replace(/^---\s*$/gm, "");
  cleaned = cleaned.replace(/^Queued #\d+\s*$/gm, "");
  for (const header of CONTEXT_HEADERS) {
    cleaned = cleaned.replace(blockPattern(header, true), "");
  }
  cleaned = stripLeadingSystemLines(cleaned);
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

function isGroupConversation(conversationInfo: Record<string, unknown>): boolean {
  if (conversationInfo.is_group_chat === true) {
    return true;
  }
  if (typeof conversationInfo.group_subject === "string" && conversationInfo.group_subject.trim()) {
    return true;
  }
  return false;
}

function isControlUiSender(sender: Record<string, unknown>): boolean {
  if (sender.id === "openclaw-control-ui") {
    return true;
  }
  return sender.label === "openclaw-control-ui";
}

function parseOpenclawSessionRecord(record: Record<string, unknown>): ParsedSessionEvent | null {
  if (record.type !== "message") {
    return null;
  }
  const sessionMessageId = typeof record.id === "string" ? record.id : null;
  if (!sessionMessageId) {
    return null;
  }
  const sessionCreatedAt = typeof record.timestamp === "string" ? record.timestamp : null;
  const message = isRecord(record.message) ? record.message : null;
  if (message === null) {
    return null;
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "user") {
    const rawText = firstTextContent(message.content);
    if (!rawText) {
      return null;
    }
    const conversationInfo = extractJsonBlock(rawText, CONTEXT_HEADERS[0]);
    const sender = extractJsonBlock(rawText, CONTEXT_HEADERS[1]);
    if (conversationInfo === null || sender === null || isControlUiSender(sender)) {
      return null;
    }
    if (isGroupConversation(conversationInfo)) {
      return null;
    }
    const senderId = typeof sender.id === "string" ? sender.id.trim() : "";
    if (!senderId) {
      return null;
    }
    const messageText = stripKnownContext(rawText);
    if (!messageText) {
      return null;
    }
    return {
      kind: "inbound",
      session_message_id: sessionMessageId,
      session_created_at: sessionCreatedAt,
      telegram_message_id:
        typeof conversationInfo.message_id === "string"
          ? conversationInfo.message_id
          : null,
      sender_id: senderId,
      sender_username:
        typeof sender.username === "string" && sender.username.trim()
          ? sender.username.trim()
          : null,
      message_text: messageText,
    };
  }

  if (
    role === "assistant" &&
    message.provider === "openclaw" &&
    message.model === "delivery-mirror"
  ) {
    const messageText = firstTextContent(message.content);
    if (!messageText) {
      return null;
    }
    return {
      kind: "outbound",
      session_message_id: sessionMessageId,
      session_created_at: sessionCreatedAt,
      message_text: messageText,
    };
  }

  return null;
}

export function parseOpenclawSessionLine(rawLine: string): ParsedSessionEvent | null {
  try {
    const parsed = parseJson(rawLine);
    if (!isRecord(parsed)) {
      return null;
    }
    return parseOpenclawSessionRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeRelpath(value: string): string {
  return value.split(path.sep).join("/");
}

function expandUserPath(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolveOpenclawRoot(rawRoot?: string): string {
  const input = rawRoot && rawRoot.trim() ? rawRoot.trim() : DEFAULT_OPENCLAW_ROOT;
  return path.resolve(expandUserPath(input));
}

function collectSessionFiles(openclawRoot: string): string[] {
  const agentsRoot = path.join(openclawRoot, "agents");
  if (!existsSync(agentsRoot)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionsDir = path.join(agentsRoot, entry.name, "sessions");
    if (!existsSync(sessionsDir)) {
      continue;
    }
    for (const sessionEntry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith(".jsonl")) {
        continue;
      }
      files.push(path.join(sessionsDir, sessionEntry.name));
    }
  }
  files.sort((left, right) => normalizeRelpath(left).localeCompare(normalizeRelpath(right)));
  return files;
}

function readJsonlLines(sessionFile: string): string[] {
  const raw = readFileSync(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function fetchCursor(
  db: SqliteDatabase,
  sessionRelpath: string,
): SyncCursorRow | null {
  return queryOne<SyncCursorRow>(
    db,
    `
      SELECT
        session_relpath,
        last_processed_line,
        bootstrapped_at,
        peer_channel,
        peer_external_user_id,
        peer_username
      FROM crm_sync_cursors
      WHERE session_relpath = ?
      LIMIT 1
    `,
    [sessionRelpath],
  );
}

function saveCursor(db: SqliteDatabase, cursor: SyncCursorRow): void {
  execute(
    db,
    `
      INSERT INTO crm_sync_cursors(
        session_relpath,
        last_processed_line,
        bootstrapped_at,
        peer_channel,
        peer_external_user_id,
        peer_username
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_relpath) DO UPDATE SET
        last_processed_line = excluded.last_processed_line,
        bootstrapped_at = COALESCE(crm_sync_cursors.bootstrapped_at, excluded.bootstrapped_at),
        peer_channel = excluded.peer_channel,
        peer_external_user_id = excluded.peer_external_user_id,
        peer_username = excluded.peer_username
    `,
    [
      cursor.session_relpath,
      cursor.last_processed_line,
      cursor.bootstrapped_at,
      cursor.peer_channel,
      cursor.peer_external_user_id,
      cursor.peer_username,
    ],
  );
}

function sourceEventKey(
  sessionRelpath: string,
  sessionMessageId: string,
  suffix?: string,
): string {
  const base = `openclaw:${sessionRelpath}:${sessionMessageId}`;
  return suffix ? `${base}:${suffix}` : base;
}

function sourceAuditPayload(
  sourceKind: ConversationSourceKind,
  sessionRelpath: string,
  sessionMessageId: string,
  telegramSenderId: string,
  extra: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    source_kind: sourceKind,
    session_file: sessionRelpath,
    session_message_id: sessionMessageId,
    telegram_sender_id: telegramSenderId,
    ...(extra ?? {}),
  };
}

function derivePeerContext(
  db: SqliteDatabase,
  lines: string[],
): PeerContext {
  let peer: PeerContext = {
    peer_channel: null,
    peer_external_user_id: null,
    peer_username: null,
  };
  for (const rawLine of lines) {
    const parsed = parseOpenclawSessionLine(rawLine);
    if (parsed?.kind !== "inbound") {
      continue;
    }
    if (
      isStoreRepresentative(db, {
        channel: TELEGRAM_CHANNEL,
        external_user_id: parsed.sender_id,
      })
    ) {
      continue;
    }
    peer = {
      peer_channel: TELEGRAM_CHANNEL,
      peer_external_user_id: parsed.sender_id,
      peer_username: parsed.sender_username,
    };
  }
  return peer;
}

function appendSyncedConversation(
  db: SqliteDatabase,
  options: {
    customer_external_user_id: string;
    customer_username: string | null;
    channel_message_id: string | null;
    direction: "inbound" | "outbound";
    message_text: string;
    source_kind: ConversationSourceKind;
    source_event_key: string;
    audit_event_type: "crm.inquiry_synced" | "crm.reply_synced";
    session_relpath: string;
    session_message_id: string;
    telegram_sender_id: string;
    extra_audit_payload?: Record<string, unknown>;
  },
): boolean {
  const appended = appendConversation(db, {
    channel: TELEGRAM_CHANNEL,
    customer_external_user_id: options.customer_external_user_id,
    customer_username: options.customer_username,
    channel_message_id: options.channel_message_id,
    direction: options.direction,
    message_text: options.message_text,
    intent: null,
    sku_id: null,
    order_id: null,
    summary: null,
    source_kind: options.source_kind,
    source_event_key: options.source_event_key,
  });
  if (!appended.inserted) {
    return false;
  }
  recordAuditEvent(db, {
    event_type: options.audit_event_type,
    actor_type: "system",
    actor_id: SYSTEM_ACTOR_ID,
    entity_type: "conversation",
    entity_id: String(appended.conversation.id),
    payload: sourceAuditPayload(
      options.source_kind,
      options.session_relpath,
      options.session_message_id,
      options.telegram_sender_id,
      options.extra_audit_payload ?? null,
    ),
  });
  return true;
}

function bootstrapCursorState(
  db: SqliteDatabase,
  sessionRelpath: string,
  lines: string[],
  existing: SyncCursorRow | null,
): SyncCursorRow {
  const peer = derivePeerContext(db, lines);
  return {
    session_relpath: sessionRelpath,
    last_processed_line: lines.length,
    bootstrapped_at: existing?.bootstrapped_at ?? nowUtcTimestamp(),
    peer_channel: peer.peer_channel,
    peer_external_user_id: peer.peer_external_user_id,
    peer_username: peer.peer_username,
  };
}

function syncSessionFile(
  db: SqliteDatabase,
  options: {
    session_file: string;
    openclaw_root: string;
    mode: SyncMode;
  },
): SessionSyncOutcome {
  const sessionRelpath = normalizeRelpath(
    path.relative(options.openclaw_root, options.session_file),
  );
  const lines = readJsonlLines(options.session_file);
  const warnings: SyncWarning[] = [];
  let skippedEventCount = 0;
  let scannedLineCount = 0;
  let inboundSyncedCount = 0;
  let outboundSyncedCount = 0;
  const existing = fetchCursor(db, sessionRelpath);

  if (options.mode === "bootstrap" || existing === null) {
    const cursor = bootstrapCursorState(db, sessionRelpath, lines, existing);
    saveCursor(db, cursor);
    return {
      bootstrapped: true,
      scanned_line_count: 0,
      inbound_synced_count: 0,
      outbound_synced_count: 0,
      skipped_event_count: 0,
      warnings,
    };
  }

  if (existing.last_processed_line > lines.length) {
    warnings.push({
      session_relpath: sessionRelpath,
      line_number: 0,
      reason: "Session file shrank; cursor reset to end-of-file.",
    });
    const resetCursor = bootstrapCursorState(db, sessionRelpath, lines, existing);
    saveCursor(db, resetCursor);
    return {
      bootstrapped: true,
      scanned_line_count: 0,
      inbound_synced_count: 0,
      outbound_synced_count: 0,
      skipped_event_count: 0,
      warnings,
    };
  }

  const cursor: SyncCursorRow = { ...existing };
  for (
    let lineIndex = existing.last_processed_line;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    const rawLine = lines[lineIndex]!;
    const lineNumber = lineIndex + 1;
    scannedLineCount += 1;
    let parsedRecord: unknown;
    try {
      parsedRecord = parseJson(rawLine);
    } catch {
      warnings.push({
        session_relpath: sessionRelpath,
        line_number: lineNumber,
        reason: "Skipping invalid JSONL line.",
      });
      cursor.last_processed_line = lineNumber;
      continue;
    }
    if (!isRecord(parsedRecord)) {
      skippedEventCount += 1;
      cursor.last_processed_line = lineNumber;
      continue;
    }
    const parsed = parseOpenclawSessionRecord(parsedRecord);
    if (parsed === null) {
      skippedEventCount += 1;
      cursor.last_processed_line = lineNumber;
      continue;
    }

    if (parsed.kind === "inbound") {
      if (
        isStoreRepresentative(db, {
          channel: TELEGRAM_CHANNEL,
          external_user_id: parsed.sender_id,
        })
      ) {
        cursor.peer_channel = null;
        cursor.peer_external_user_id = null;
        cursor.peer_username = null;
        skippedEventCount += 1;
        cursor.last_processed_line = lineNumber;
        continue;
      }
      cursor.peer_channel = TELEGRAM_CHANNEL;
      cursor.peer_external_user_id = parsed.sender_id;
      cursor.peer_username = parsed.sender_username;
      const inserted = appendSyncedConversation(db, {
        customer_external_user_id: parsed.sender_id,
        customer_username: parsed.sender_username,
        channel_message_id: parsed.telegram_message_id,
        direction: "inbound",
        message_text: parsed.message_text,
        source_kind: "openclaw_inbound",
        source_event_key: sourceEventKey(sessionRelpath, parsed.session_message_id),
        audit_event_type: "crm.inquiry_synced",
        session_relpath: sessionRelpath,
        session_message_id: parsed.session_message_id,
        telegram_sender_id: parsed.sender_id,
        extra_audit_payload: {
          telegram_message_id: parsed.telegram_message_id,
        },
      });
      if (inserted) {
        inboundSyncedCount += 1;
      } else {
        skippedEventCount += 1;
      }
      cursor.last_processed_line = lineNumber;
      continue;
    }

    const peerExternalUserId = cursor.peer_external_user_id;
    if (!peerExternalUserId || cursor.peer_channel !== TELEGRAM_CHANNEL) {
      warnings.push({
        session_relpath: sessionRelpath,
        line_number: lineNumber,
        reason: "Skipping delivery-mirror reply without a resolved private-chat peer.",
        session_message_id: parsed.session_message_id,
      });
      cursor.last_processed_line = lineNumber;
      continue;
    }
    if (
      isStoreRepresentative(db, {
        channel: TELEGRAM_CHANNEL,
        external_user_id: peerExternalUserId,
      })
    ) {
      cursor.peer_channel = null;
      cursor.peer_external_user_id = null;
      cursor.peer_username = null;
      skippedEventCount += 1;
      cursor.last_processed_line = lineNumber;
      continue;
    }
    const inserted = appendSyncedConversation(db, {
      customer_external_user_id: peerExternalUserId,
      customer_username: cursor.peer_username,
      channel_message_id: null,
      direction: "outbound",
      message_text: parsed.message_text,
      source_kind: "openclaw_delivery_mirror",
      source_event_key: sourceEventKey(sessionRelpath, parsed.session_message_id, "delivery"),
      audit_event_type: "crm.reply_synced",
      session_relpath: sessionRelpath,
      session_message_id: parsed.session_message_id,
      telegram_sender_id: peerExternalUserId,
    });
    if (inserted) {
      outboundSyncedCount += 1;
    } else {
      skippedEventCount += 1;
    }
    cursor.last_processed_line = lineNumber;
  }

  saveCursor(db, cursor);
  return {
    bootstrapped: false,
    scanned_line_count: scannedLineCount,
    inbound_synced_count: inboundSyncedCount,
    outbound_synced_count: outboundSyncedCount,
    skipped_event_count: skippedEventCount,
    warnings,
  };
}

export function syncCrmFromOpenclaw(
  options: SyncCrmFromOpenclawOptions = {},
): SyncCrmFromOpenclawResult {
  const dbPath = options.db_path ?? DEFAULT_DB_PATH;
  const openclawRoot = resolveOpenclawRoot(options.openclaw_root);
  const mode: SyncMode = options.mode ?? "incremental";
  const sessionFiles = collectSessionFiles(openclawRoot);
  const db = ensureDatabase(dbPath);
  try {
    let bootstrappedSessionCount = 0;
    let scannedLineCount = 0;
    let inboundSyncedCount = 0;
    let outboundSyncedCount = 0;
    let skippedEventCount = 0;
    const warnings: SyncWarning[] = [];

    for (const sessionFile of sessionFiles) {
      const outcome = db.transaction(() =>
        syncSessionFile(db, {
          session_file: sessionFile,
          openclaw_root: openclawRoot,
          mode,
        }),
      )();
      if (outcome.bootstrapped) {
        bootstrappedSessionCount += 1;
      }
      scannedLineCount += outcome.scanned_line_count;
      inboundSyncedCount += outcome.inbound_synced_count;
      outboundSyncedCount += outcome.outbound_synced_count;
      skippedEventCount += outcome.skipped_event_count;
      warnings.push(...outcome.warnings);
    }

    return {
      status: "synced",
      reply: `CRM sync completed in ${mode} mode across ${sessionFiles.length} OpenClaw session file(s).`,
      mode,
      db_path: dbPath,
      openclaw_root: openclawRoot,
      session_file_count: sessionFiles.length,
      bootstrapped_session_count: bootstrappedSessionCount,
      scanned_line_count: scannedLineCount,
      inbound_synced_count: inboundSyncedCount,
      outbound_synced_count: outboundSyncedCount,
      skipped_event_count: skippedEventCount,
      warning_count: warnings.length,
      warnings,
    };
  } finally {
    db.close();
  }
}
