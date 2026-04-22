"""Shared SQLite helpers for migrations, config access, and audit logging.

This module is the common entry for opening the local SQLite database and for
writing small, reusable persistence helpers that multiple skills can call.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
# DEFAULT_DB_PATH = PROJECT_ROOT / "data/prod/purr_suite_prod.sqlite3"
DEFAULT_DB_PATH = PROJECT_ROOT / "data/dev/purr_suite_dev.sqlite3"
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
CALLER_AUTH_IDENTITY_MODEL = "caller_identity"


def _ensure_schema_migrations_table(conn: sqlite3.Connection) -> None:
    """Create the migration bookkeeping table if it does not exist.

    Args:
        conn: Open SQLite connection used for schema setup.

    Returns:
        None. The function creates the table in-place and commits immediately.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()


def apply_migrations(conn: sqlite3.Connection) -> None:
    """Apply every SQL migration once, in filename order.

    Args:
        conn: Open SQLite connection that should receive all pending migrations.

    Returns:
        None. The function mutates the database schema and records applied
        versions in `schema_migrations`.
    """
    _ensure_schema_migrations_table(conn)
    applied = {
        row[0]
        for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")
    }

    for migration_path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if migration_path.name in applied:
            continue

        sql = migration_path.read_text(encoding="utf-8")
        conn.executescript(sql)
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)",
            (migration_path.name,),
        )
        conn.commit()


def ensure_database(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Open a SQLite connection, enable FK checks, and apply pending migrations.

    Args:
        db_path: Optional database file path. When omitted, the project default
            path under `data/dev/` is used.

    Returns:
        A ready-to-use SQLite connection with row access by column name.
    """
    resolved = Path(db_path or DEFAULT_DB_PATH)
    resolved.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn


def upsert_business_config(
    conn: sqlite3.Connection, config_key: str, config_value: Any
) -> None:
    """Insert or replace a JSON business-config value.

    Args:
        conn: Open SQLite connection used for the write.
        config_key: Stable configuration key such as `enabled_skills`.
        config_value: JSON-serializable value to persist.

    Returns:
        None. The caller controls when the surrounding transaction is committed.
    """
    payload = json.dumps(config_value, ensure_ascii=False, sort_keys=True)
    conn.execute(
        """
        INSERT INTO business_config(config_key, config_value_json)
        VALUES (?, ?)
        ON CONFLICT(config_key) DO UPDATE SET
            config_value_json = excluded.config_value_json
        """,
        (config_key, payload),
    )


def fetch_business_config(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return `business_config` as a decoded key/value mapping.

    Args:
        conn: Open SQLite connection used for the read.

    Returns:
        Dictionary keyed by `config_key`, with JSON values decoded into Python
        objects.
    """
    rows = conn.execute(
        "SELECT config_key, config_value_json FROM business_config ORDER BY config_key"
    ).fetchall()
    result: dict[str, Any] = {}
    for row in rows:
        result[row["config_key"]] = json.loads(row["config_value_json"])
    return result


def caller_actor_id(channel: str, external_user_id: str) -> str:
    """Return the stable audit identifier for caller-triggered actions."""

    return f"{channel}:{external_user_id}"


def caller_audit_payload(
    payload: dict[str, Any] | None,
    *,
    channel: str,
    external_user_id: str,
) -> dict[str, Any]:
    """Attach the current caller identity model to one audit payload."""

    normalized = dict(payload or {})
    normalized["actor_identity"] = {
        "channel": channel,
        "external_user_id": external_user_id,
        "auth_identity_model": CALLER_AUTH_IDENTITY_MODEL,
    }
    return normalized


def record_audit_event(
    conn: sqlite3.Connection,
    *,
    event_type: str,
    actor_type: str,
    actor_id: str | None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    idempotency_key: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Persist a normalized audit record for later debugging and reconciliation.

    Args:
        conn: Open SQLite connection used for the write.
        event_type: Stable event name such as `onboarding.setup_requested`.
        actor_type: Who triggered the action, for example `owner`, `caller`, or
            `system`.
        actor_id: Channel/user identifier for the actor, when available.
        entity_type: Optional business entity type affected by the action.
        entity_id: Optional entity identifier affected by the action.
        idempotency_key: Optional unique key used to deduplicate repeated writes.
        payload: Optional JSON-serializable context payload.

    Returns:
        None. The row is inserted into `audit_events`; commit timing is left to
        the caller so multiple writes can stay in one transaction.
    """
    conn.execute(
        """
        INSERT INTO audit_events(
            event_type,
            actor_type,
            actor_id,
            entity_type,
            entity_id,
            idempotency_key,
            payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_type,
            actor_type,
            actor_id,
            entity_type,
            entity_id,
            idempotency_key,
            json.dumps(payload or {}, ensure_ascii=False, sort_keys=True),
        ),
    )
