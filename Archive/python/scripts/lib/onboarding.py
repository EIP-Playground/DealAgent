"""Onboarding handler for owner pairing and local SQLite bootstrapping.

The onboarding skill is the first runtime path in v1. Agent routing turns setup
natural language into the canonical `onboarding.setup_suite` command code before
calling this handler. The runtime then ensures the SQLite database exists and
pairs the first active owner.
"""

from __future__ import annotations

from contextlib import closing
from pathlib import Path
from typing import Any
import uuid

from scripts.db.sqlite import (
    DEFAULT_DB_PATH,
    ensure_database,
    fetch_business_config,
    record_audit_event,
    upsert_business_config,
)

DEFAULT_ENABLED_SKILLS = [
    "onboarding",
    "catalog",
    "inventory",
    "orders",
    "payments",
    "crm",
    "seller-bi",
]


def _default_config() -> dict[str, Any]:
    """Return the default `business_config` values required for v1.

    Args:
        None.

    Returns:
        Dictionary of default config keys and JSON-serializable values.
    """
    return {
        "channel_binding": "telegram_via_openclaw",
        "database_mode": "local_sqlite",
        "enabled_skills": DEFAULT_ENABLED_SKILLS,
        "payment_provider": "mock",
    }


def _is_setup_intent(command_code: object) -> bool:
    """Return whether the normalized runtime command matches onboarding setup.

    Args:
        command_code: Canonical command code provided by the host or agent.

    Returns:
        `True` when the runtime should execute onboarding logic.
    """
    return str(command_code or "").strip().lower() == "onboarding.setup_suite"


def _ensure_defaults(conn) -> dict[str, Any]:
    """Backfill required business-config keys without disturbing existing values.

    Args:
        conn: Open SQLite connection used for config writes.

    Returns:
        Fully decoded `business_config` mapping after required defaults exist.
    """
    defaults = _default_config()
    for key, value in defaults.items():
        upsert_business_config(conn, key, value)
    return fetch_business_config(conn)


def handle_onboarding(context: dict[str, Any]) -> dict[str, Any]:
    """Handle the canonical onboarding setup intent using normalized host context.

    Args:
        context: Host-normalized payload containing `channel`, `command_code`,
            and `user`.

    Returns:
        JSON-serializable result describing the setup outcome. v1 returns one of
        `initialized`, `idempotent`, `rejected`, or `ignored`.

    Raises:
        ValueError: If required fields such as `user.external_user_id` are
            missing from the normalized context.
    """
    command_code = str(context.get("command_code", "")).strip()
    if not _is_setup_intent(command_code):
        return {
            "status": "ignored",
            "reply": "Unsupported onboarding command.",
            "command_code": command_code,
        }

    user = context.get("user") or {}
    channel = str(context.get("channel") or "telegram")
    external_user_id = str(user.get("external_user_id") or "").strip()
    if not external_user_id:
        raise ValueError("user.external_user_id is required")

    username = user.get("username")
    runtime = context.get("runtime") or {}
    db_path = str(runtime.get("db_path") or DEFAULT_DB_PATH)

    with closing(ensure_database(db_path)) as conn:
        # Always record the setup attempt before branching into initialize/idempotent/rejected.
        record_audit_event(
            conn,
            event_type="onboarding.setup_requested",
            actor_type="system",
            actor_id=external_user_id,
            entity_type="owner",
            entity_id=external_user_id,
            payload={"channel": channel, "db_path": db_path},
        )

        current_owner = conn.execute(
            """
            SELECT *
            FROM identities
            WHERE channel = ? AND external_user_id = ? AND is_active = 1 AND role = 'owner'
            LIMIT 1
            """,
            (channel, external_user_id),
        ).fetchone()
        active_owner = conn.execute(
            "SELECT * FROM identities WHERE is_active = 1 AND role = 'owner' LIMIT 1"
        ).fetchone()
        active_agent = conn.execute(
            "SELECT * FROM identities WHERE is_active = 1 AND role = 'agent' LIMIT 1"
        ).fetchone()

        if active_owner is None:
            # First setup initializes the owner row and fills required defaults.
            cursor = conn.execute(
                """
                INSERT INTO identities(
                    channel,
                    external_user_id,
                    username,
                    role,
                    is_active
                ) VALUES (?, ?, ?, 'owner', 1)
                """,
                (channel, external_user_id, username),
            )
            owner_id = cursor.lastrowid
            
            # create the default agent alongside the owner
            agent_uuid = f"agent-{uuid.uuid4()}"
            conn.execute(
                """
                INSERT INTO identities(
                    channel,
                    external_user_id,
                    username,
                    role,
                    is_active
                ) VALUES (?, ?, 'Agent', 'agent', 1)
                """,
                (channel, agent_uuid),
            )
            config = _ensure_defaults(conn)
            record_audit_event(
                conn,
                event_type="onboarding.owner_paired",
                actor_type="owner",
                actor_id=external_user_id,
                entity_type="owner",
                entity_id=str(owner_id),
                payload={"channel": channel, "db_path": db_path},
            )
            conn.commit()
            return {
                "status": "initialized",
                "reply": "Purr Suite initialized. Owner paired and local SQLite is ready.",
                "db_path": str(Path(db_path)),
                "owner_id": owner_id,
                "agent_id": agent_uuid,
                "business_config": config,
            }

        if current_owner is not None and int(active_owner["id"]) == int(current_owner["id"]):
            # Re-running setup for the same owner should be safe and idempotent.
            conn.execute(
                """
                UPDATE identities
                SET username = ?, paired_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (username, current_owner["id"]),
            )
            config = _ensure_defaults(conn)
            record_audit_event(
                conn,
                event_type="onboarding.setup_idempotent",
                actor_type="owner",
                actor_id=external_user_id,
                entity_type="owner",
                entity_id=str(current_owner["id"]),
                payload={"channel": channel, "db_path": db_path},
            )
            conn.commit()
            return {
                "status": "idempotent",
                "reply": "Purr Suite is already initialized for this owner.",
                "db_path": str(Path(db_path)),
                "owner_id": int(current_owner["id"]),
                "agent_id": str(active_agent["external_user_id"]) if active_agent else "agent-001",
                "business_config": config,
            }

        # A different active owner already exists, so setup must be rejected.
        record_audit_event(
            conn,
            event_type="onboarding.setup_rejected",
            actor_type="customer",
            actor_id=external_user_id,
            entity_type="owner",
            entity_id=str(active_owner["id"]),
            payload={
                "channel": channel,
                "db_path": db_path,
                "reason": "active_owner_exists",
            },
        )
        conn.commit()
        return {
            "status": "rejected",
            "reply": "Purr Suite is already paired to another owner.",
            "db_path": str(Path(db_path)),
            "owner_id": int(active_owner["id"]),
        }
