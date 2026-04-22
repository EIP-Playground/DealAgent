"""CRM runtime for inquiry logging, customer summaries, and reply context."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import date
from typing import Any

from scripts.db.sqlite import (
    DEFAULT_DB_PATH,
    caller_actor_id,
    caller_audit_payload,
    ensure_database,
    record_audit_event,
)
from scripts.lib.catalog import _serialize_customer_sku
from scripts.lib.customer_store import (
    decode_customer_summary_json,
    fetch_customer_by_identity,
    upsert_customer_identity,
    update_customer_summary,
)


CRM_COMMANDS = {
    "crm.log_inquiry",
    "crm.log_reply",
    "crm.show_history",
    "crm.get_response_context",
    "crm.upsert_customer_summary",
    "crm.whoami",
}
DEFAULT_SHOW_HISTORY_LIMIT = 20
DEFAULT_CONTEXT_HISTORY_LIMIT = 10
HISTORICAL_SKU_REF_SOURCE = "conversation_history"
CURRENT_SKU_SNAPSHOT_SOURCE = "catalog_live_read"


def _invalid(status: str, reply: str) -> dict[str, Any]:
    """Return a stable CRM runtime error payload."""

    return {"status": status, "reply": reply}


def _normalize_text(value: object, field_name: str) -> str:
    """Normalize one required text field and reject blank values."""

    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def _optional_text(value: object) -> str | None:
    """Normalize optional text into stripped text or `None`."""

    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _require_mapping(value: object, field_name: str) -> dict[str, Any]:
    """Validate that one JSON field is an object-like mapping."""

    if not isinstance(value, dict):
        raise ValueError(f"{field_name} must be an object")
    return dict(value)


def _require_params_mapping(params: object) -> dict[str, Any]:
    """Validate the shared `params` envelope for CRM runtime."""

    if params is None:
        return {}
    return _require_mapping(params, "params")


def _coerce_positive_int(value: object, field_name: str, *, default: int) -> int:
    """Coerce an optional JSON value into a strictly positive integer."""

    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be an integer")
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and value.strip():
        try:
            number = int(value.strip())
        except ValueError as exc:
            raise ValueError(f"{field_name} must be an integer") from exc
    else:
        raise ValueError(f"{field_name} must be an integer")
    if number <= 0:
        raise ValueError(f"{field_name} must be a positive integer")
    return number


def _parse_optional_context_dates(
    params: dict[str, Any]
) -> tuple[date | None, date | None]:
    """Parse optional date bounds used when enriching a date-based SKU."""

    check_in_text = _optional_text(params.get("check_in_date"))
    check_out_text = _optional_text(params.get("check_out_date"))
    if bool(check_in_text) != bool(check_out_text):
        raise ValueError(
            "params.check_in_date and params.check_out_date must be provided together"
        )
    if not check_in_text or not check_out_text:
        return None, None
    try:
        check_in_date = date.fromisoformat(check_in_text)
        check_out_date = date.fromisoformat(check_out_text)
    except ValueError as exc:
        raise ValueError(
            "params.check_in_date and params.check_out_date must be ISO dates like YYYY-MM-DD"
        ) from exc
    if check_out_date <= check_in_date:
        raise ValueError("params.check_out_date must be after check_in_date")
    return check_in_date, check_out_date


def _customer_anchor(params: dict[str, Any]) -> tuple[str, str | None]:
    """Extract the target customer anchor from CRM params."""

    customer = _require_mapping(params.get("customer"), "params.customer")
    external_user_id = _normalize_text(
        customer.get("external_user_id"),
        "params.customer.external_user_id",
    )
    username = _optional_text(customer.get("username"))
    return external_user_id, username


def _fetch_active_owner(
    conn: sqlite3.Connection, *, channel: str, external_user_id: str
) -> sqlite3.Row | None:
    """Return the active owner row for the caller, if one exists."""

    return conn.execute(
        """
        SELECT *
        FROM identities
        WHERE channel = ? AND external_user_id = ? AND is_active = 1 AND role = 'owner'
        LIMIT 1
        """,
        (channel, external_user_id),
    ).fetchone()


def _require_owner(
    conn: sqlite3.Connection, *, channel: str, external_user_id: str
) -> sqlite3.Row:
    """Require the current caller to resolve to the active owner identity."""

    owner = _fetch_active_owner(conn, channel=channel, external_user_id=external_user_id)
    if owner is None:
        raise PermissionError("Only the active owner can run crm commands.")
    return owner


def _require_store_representative(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    customer_external_user_id: str,
) -> None:
    """Block direct customer identities from running store-representative commands."""

    if actor_external_user_id == customer_external_user_id:
        owner = _fetch_active_owner(conn, channel=channel, external_user_id=actor_external_user_id)
        if owner is not None:
            return
        raise PermissionError("Customer identity cannot run this crm command.")
        
    rep = conn.execute(
        """
        SELECT 1
        FROM identities
        WHERE channel = ? AND external_user_id = ? AND is_active = 1 AND role IN ('owner', 'agent')
        LIMIT 1
        """,
        (channel, actor_external_user_id),
    ).fetchone()
    if rep is None:
        raise PermissionError("Only an active store representative can run this crm command.")


def _fetch_sku_by_code(conn: sqlite3.Connection, sku_code: str) -> sqlite3.Row | None:
    """Return one SKU row by its external code."""

    return conn.execute(
        "SELECT * FROM skus WHERE sku_code = ? LIMIT 1",
        (sku_code,),
    ).fetchone()


def _fetch_sku_by_id(conn: sqlite3.Connection, *, sku_id: int) -> sqlite3.Row | None:
    """Return one SKU row by primary key."""

    return conn.execute(
        "SELECT * FROM skus WHERE id = ? LIMIT 1",
        (sku_id,),
    ).fetchone()


def _fetch_order_by_number(
    conn: sqlite3.Connection, *, order_number: str
) -> sqlite3.Row | None:
    """Return one order row by business order number."""

    return conn.execute(
        """
        SELECT id, order_number
        FROM orders
        WHERE order_number = ?
        LIMIT 1
        """,
        (order_number,),
    ).fetchone()


def _resolve_primary_sku(
    conn: sqlite3.Connection, *, sku_code: object
) -> tuple[int | None, str | None]:
    """Resolve an optional primary SKU code into `(sku_id, normalized_sku_code)`."""

    normalized_sku_code = _optional_text(sku_code)
    if normalized_sku_code is None:
        return None, None
    normalized_sku_code = normalized_sku_code.upper()
    sku = _fetch_sku_by_code(conn, normalized_sku_code)
    if sku is None:
        raise LookupError(f"SKU {normalized_sku_code} was not found.")
    return int(sku["id"]), str(sku["sku_code"])


def _resolve_order(
    conn: sqlite3.Connection, *, order_number: object
) -> tuple[int | None, str | None]:
    """Resolve an optional order number into `(order_id, order_number)`."""

    normalized_order_number = _optional_text(order_number)
    if normalized_order_number is None:
        return None, None
    order_row = _fetch_order_by_number(conn, order_number=normalized_order_number)
    if order_row is None:
        raise LookupError(f"Order {normalized_order_number} was not found.")
    return int(order_row["id"]), str(order_row["order_number"])


def _serialize_customer(
    customer_row: sqlite3.Row | None,
    *,
    channel: str,
    external_user_id: str,
    username: str | None = None,
    include_summary: bool = False,
) -> dict[str, Any]:
    """Serialize one existing or not-yet-created customer anchor."""

    payload: dict[str, Any] = {
        "channel": channel,
        "external_user_id": external_user_id,
        "username": username,
    }
    if customer_row is not None:
        payload["username"] = customer_row["username"]
        payload["customer_id"] = int(customer_row["id"])
        payload["created_at"] = customer_row["created_at"]
        payload["updated_at"] = customer_row["updated_at"]
        if include_summary:
            payload["summary_json"] = decode_customer_summary_json(
                customer_row["summary_json"]
            )
    return payload


def _conversation_rows(
    conn: sqlite3.Connection, *, customer_id: int, limit: int
) -> list[sqlite3.Row]:
    """Return the newest `limit` conversation rows in ascending display order."""

    return conn.execute(
        """
        SELECT *
        FROM (
            SELECT
                conversations.*,
                skus.sku_code AS sku_code,
                orders.order_number AS order_number
            FROM conversations
            LEFT JOIN skus ON skus.id = conversations.sku_id
            LEFT JOIN orders ON orders.id = conversations.order_id
            WHERE conversations.customer_id = ?
            ORDER BY conversations.created_at DESC, conversations.id DESC
            LIMIT ?
        ) AS recent
        ORDER BY recent.created_at ASC, recent.id ASC
        """,
        (customer_id, limit),
    ).fetchall()


def _latest_primary_sku_row(
    conn: sqlite3.Connection, *, customer_id: int
) -> sqlite3.Row | None:
    """Return the latest conversation that carries a primary SKU reference."""

    return conn.execute(
        """
        SELECT
            conversations.id,
            conversations.customer_id,
            conversations.direction,
            conversations.created_at,
            conversations.sku_id,
            skus.sku_code AS sku_code
        FROM conversations
        LEFT JOIN skus ON skus.id = conversations.sku_id
        WHERE conversations.customer_id = ?
          AND conversations.sku_id IS NOT NULL
        ORDER BY conversations.created_at DESC, conversations.id DESC
        LIMIT 1
        """,
        (customer_id,),
    ).fetchone()


def _fetch_conversation_by_id(
    conn: sqlite3.Connection, *, conversation_id: int
) -> sqlite3.Row | None:
    """Return one conversation row plus resolved SKU/order references."""

    return conn.execute(
        """
        SELECT
            conversations.*,
            skus.sku_code AS sku_code,
            orders.order_number AS order_number
        FROM conversations
        LEFT JOIN skus ON skus.id = conversations.sku_id
        LEFT JOIN orders ON orders.id = conversations.order_id
        WHERE conversations.id = ?
        LIMIT 1
        """,
        (conversation_id,),
    ).fetchone()


def _serialize_conversation(conversation_row: sqlite3.Row) -> dict[str, Any]:
    """Serialize one CRM conversation row for runtime responses."""

    payload: dict[str, Any] = {
        "conversation_id": int(conversation_row["id"]),
        "direction": conversation_row["direction"],
        "message_text": conversation_row["message_text"],
        "intent": conversation_row["intent"],
        "summary": conversation_row["summary"],
        "channel_message_id": conversation_row["channel_message_id"],
        "created_at": conversation_row["created_at"],
    }
    if conversation_row["sku_id"] is not None:
        payload["primary_sku_ref"] = {
            "sku_id": int(conversation_row["sku_id"]),
            "sku_code": conversation_row["sku_code"],
            "reference_source": HISTORICAL_SKU_REF_SOURCE,
        }
    if conversation_row["order_id"] is not None:
        payload["order_ref"] = {
            "order_id": int(conversation_row["order_id"]),
            "order_number": conversation_row["order_number"],
        }
    return payload


def _serialize_primary_sku_ref(primary_sku_row: sqlite3.Row | None) -> dict[str, Any] | None:
    """Serialize the latest historical primary SKU reference for one customer."""

    if primary_sku_row is None:
        return None
    return {
        "sku_id": int(primary_sku_row["sku_id"]),
        "sku_code": primary_sku_row["sku_code"],
        "reference_source": HISTORICAL_SKU_REF_SOURCE,
        "source_conversation_id": int(primary_sku_row["id"]),
        "source_direction": primary_sku_row["direction"],
        "source_created_at": primary_sku_row["created_at"],
    }


def _current_sku_snapshot(
    conn: sqlite3.Connection,
    *,
    primary_sku_row: sqlite3.Row | None,
    check_in_date: date | None,
    check_out_date: date | None,
) -> dict[str, Any] | None:
    """Build the current catalog snapshot for the latest referenced primary SKU."""

    if primary_sku_row is None:
        return None
    sku_row = _fetch_sku_by_id(conn, sku_id=int(primary_sku_row["sku_id"]))
    if sku_row is None:
        return None
    if str(sku_row["inventory_mode"]) != "date_quantity":
        check_in_date = None
        check_out_date = None
    return {
        "snapshot_source": CURRENT_SKU_SNAPSHOT_SOURCE,
        "is_historical_truth": False,
        "sku": _serialize_customer_sku(
            conn,
            sku_row,
            check_in_date=check_in_date,
            check_out_date=check_out_date,
        ),
    }


def _log_conversation(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    params: dict[str, Any],
    direction: str,
    event_type: str,
) -> dict[str, Any]:
    """Create one inbound or outbound CRM conversation row."""

    customer_external_user_id, customer_username = _customer_anchor(params)
    _require_store_representative(
        conn,
        channel=channel,
        actor_external_user_id=actor_external_user_id,
        customer_external_user_id=customer_external_user_id,
    )
    message_text = _normalize_text(params.get("message_text"), "params.message_text")
    channel_message_id = _optional_text(params.get("channel_message_id"))
    intent = _optional_text(params.get("intent"))
    summary = _optional_text(params.get("summary"))
    sku_id, sku_code = _resolve_primary_sku(conn, sku_code=params.get("sku_code"))
    order_id, order_number = _resolve_order(conn, order_number=params.get("order_number"))

    customer = upsert_customer_identity(
        conn,
        channel=channel,
        external_user_id=customer_external_user_id,
        username=customer_username,
    )
    cursor = conn.execute(
        """
        INSERT INTO conversations(
            customer_id,
            channel_message_id,
            direction,
            message_text,
            intent,
            sku_id,
            order_id,
            summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(customer["id"]),
            channel_message_id,
            direction,
            message_text,
            intent,
            sku_id,
            order_id,
            summary,
        ),
    )
    conversation_id = int(cursor.lastrowid)
    conversation = _fetch_conversation_by_id(conn, conversation_id=conversation_id)
    assert conversation is not None
    record_audit_event(
        conn,
        event_type=event_type,
        actor_type="caller",
        actor_id=caller_actor_id(channel, actor_external_user_id),
        entity_type="conversation",
        entity_id=str(conversation_id),
        payload=caller_audit_payload(
            {
                "customer_external_user_id": customer_external_user_id,
                "direction": direction,
                "intent": intent,
                "sku_code": sku_code,
                "order_number": order_number,
            },
            channel=channel,
            external_user_id=actor_external_user_id,
        ),
    )
    conn.commit()
    return {
        "status": "logged",
        "reply": (
            f"Logged {direction} CRM conversation for customer {customer_external_user_id}."
        ),
        "audit_event_type": event_type,
        "customer": _serialize_customer(
            customer,
            channel=channel,
            external_user_id=customer_external_user_id,
            username=customer_username,
        ),
        "conversation": _serialize_conversation(conversation),
    }


def _log_inquiry(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Log one inbound inquiry conversation row."""

    return _log_conversation(
        conn,
        channel=channel,
        actor_external_user_id=actor_external_user_id,
        params=params,
        direction="inbound",
        event_type="crm.inquiry_logged",
    )


def _log_reply(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Log one outbound CRM reply row."""

    return _log_conversation(
        conn,
        channel=channel,
        actor_external_user_id=actor_external_user_id,
        params=params,
        direction="outbound",
        event_type="crm.reply_logged",
    )


def _show_history(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Return the recent CRM history window for one target customer."""

    _require_owner(conn, channel=channel, external_user_id=actor_external_user_id)
    customer_external_user_id, customer_username = _customer_anchor(params)
    limit = _coerce_positive_int(
        params.get("limit"),
        "params.limit",
        default=DEFAULT_SHOW_HISTORY_LIMIT,
    )
    customer = fetch_customer_by_identity(
        conn,
        channel=channel,
        external_user_id=customer_external_user_id,
    )
    if customer is None:
        return {
            "status": "listed",
            "reply": (
                f"Loaded 0 CRM conversations for customer {customer_external_user_id}."
            ),
            "customer": _serialize_customer(
                None,
                channel=channel,
                external_user_id=customer_external_user_id,
                username=customer_username,
            ),
            "customer_exists": False,
            "conversations": [],
            "conversation_count": 0,
        }

    rows = _conversation_rows(conn, customer_id=int(customer["id"]), limit=limit)
    conversations = [_serialize_conversation(row) for row in rows]
    return {
        "status": "listed",
        "reply": f"Loaded {len(conversations)} CRM conversations for customer {customer_external_user_id}.",
        "customer": _serialize_customer(
            customer,
            channel=channel,
            external_user_id=customer_external_user_id,
            username=customer_username,
        ),
        "customer_exists": True,
        "conversations": conversations,
        "conversation_count": len(conversations),
    }


def _upsert_customer_summary(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Replace one customer's stored summary JSON."""

    customer_external_user_id, customer_username = _customer_anchor(params)
    _require_store_representative(
        conn,
        channel=channel,
        actor_external_user_id=actor_external_user_id,
        customer_external_user_id=customer_external_user_id,
    )
    summary_json = _require_mapping(params.get("summary_json"), "params.summary_json")
    customer = upsert_customer_identity(
        conn,
        channel=channel,
        external_user_id=customer_external_user_id,
        username=customer_username,
    )
    updated_customer = update_customer_summary(
        conn,
        customer_id=int(customer["id"]),
        summary_json=summary_json,
    )
    record_audit_event(
        conn,
        event_type="crm.customer_summary_upserted",
        actor_type="caller",
        actor_id=caller_actor_id(channel, actor_external_user_id),
        entity_type="customer",
        entity_id=customer_external_user_id,
        payload=caller_audit_payload(
            {
                "customer_external_user_id": customer_external_user_id,
                "summary_keys": sorted(summary_json.keys()),
            },
            channel=channel,
            external_user_id=actor_external_user_id,
        ),
    )
    conn.commit()
    return {
        "status": "updated",
        "reply": f"Updated CRM summary for customer {customer_external_user_id}.",
        "audit_event_type": "crm.customer_summary_upserted",
        "customer": _serialize_customer(
            updated_customer,
            channel=channel,
            external_user_id=customer_external_user_id,
            username=customer_username,
            include_summary=True,
        ),
    }


def _get_response_context(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Return customer summary, recent CRM history, and current SKU context."""

    customer_external_user_id, customer_username = _customer_anchor(params)
    _require_store_representative(
        conn,
        channel=channel,
        actor_external_user_id=actor_external_user_id,
        customer_external_user_id=customer_external_user_id,
    )
    history_limit = _coerce_positive_int(
        params.get("history_limit"),
        "params.history_limit",
        default=DEFAULT_CONTEXT_HISTORY_LIMIT,
    )
    check_in_date, check_out_date = _parse_optional_context_dates(params)
    customer = fetch_customer_by_identity(
        conn,
        channel=channel,
        external_user_id=customer_external_user_id,
    )
    if customer is None:
        return {
            "status": "found",
            "reply": (
                f"Built empty CRM response context for customer {customer_external_user_id}."
            ),
            "customer": _serialize_customer(
                None,
                channel=channel,
                external_user_id=customer_external_user_id,
                username=customer_username,
            ),
            "customer_exists": False,
            "customer_summary_json": None,
            "recent_conversations": [],
            "primary_sku_ref": None,
            "current_sku_snapshot": None,
            "context_window_size": 0,
        }

    recent_rows = _conversation_rows(
        conn,
        customer_id=int(customer["id"]),
        limit=history_limit,
    )
    primary_sku_row = _latest_primary_sku_row(conn, customer_id=int(customer["id"]))
    return {
        "status": "found",
        "reply": f"Built CRM response context for customer {customer_external_user_id}.",
        "customer": _serialize_customer(
            customer,
            channel=channel,
            external_user_id=customer_external_user_id,
            username=customer_username,
        ),
        "customer_exists": True,
        "customer_summary_json": decode_customer_summary_json(customer["summary_json"]),
        "recent_conversations": [
            _serialize_conversation(row) for row in recent_rows
        ],
        "primary_sku_ref": _serialize_primary_sku_ref(primary_sku_row),
        "current_sku_snapshot": _current_sku_snapshot(
            conn,
            primary_sku_row=primary_sku_row,
            check_in_date=check_in_date,
            check_out_date=check_out_date,
        ),
        "context_window_size": len(recent_rows),
    }


def handle_crm(context: dict[str, Any]) -> dict[str, Any]:
    """Handle normalized CRM runtime commands."""

    command_code = str(context.get("command_code") or "").strip().lower()

    if command_code not in CRM_COMMANDS:
        return _invalid("invalid_intent", f"Unsupported crm intent: {command_code}")

    user = context.get("user") or {}
    params = context.get("params")
    channel = str(context.get("channel") or "telegram").strip() or "telegram"
    actor_external_user_id = str(user.get("external_user_id") or "").strip()
    if not actor_external_user_id and command_code != "crm.whoami":
        return _invalid("invalid_input", "user.external_user_id is required")

    try:
        normalized_params = _require_params_mapping(params)
    except ValueError as exc:
        return _invalid("invalid_input", str(exc))

    runtime = context.get("runtime") or {}
    db_path = str(runtime.get("db_path") or DEFAULT_DB_PATH)
    with closing(ensure_database(db_path)) as conn:
        try:
            if command_code == "crm.whoami":
                agent = conn.execute(
                    "SELECT external_user_id FROM identities WHERE channel = ? AND role = 'agent' AND is_active = 1 LIMIT 1",
                    (channel,)
                ).fetchone()
                if agent:
                    return {
                        "status": "found",
                        "reply": f"Your Agent Identity -> Channel: {channel}, Agent ID: {agent['external_user_id']}"
                    }
                return _invalid("not_found", f"No active agent found for channel {channel}.")
            if command_code == "crm.log_inquiry":
                return _log_inquiry(
                    conn,
                    channel=channel,
                    actor_external_user_id=actor_external_user_id,
                    params=normalized_params,
                )
            if command_code == "crm.log_reply":
                return _log_reply(
                    conn,
                    channel=channel,
                    actor_external_user_id=actor_external_user_id,
                    params=normalized_params,
                )
            if command_code == "crm.show_history":
                return _show_history(
                    conn,
                    channel=channel,
                    actor_external_user_id=actor_external_user_id,
                    params=normalized_params,
                )
            if command_code == "crm.get_response_context":
                return _get_response_context(
                    conn,
                    channel=channel,
                    actor_external_user_id=actor_external_user_id,
                    params=normalized_params,
                )
            if command_code == "crm.upsert_customer_summary":
                return _upsert_customer_summary(
                    conn,
                    channel=channel,
                    actor_external_user_id=actor_external_user_id,
                    params=normalized_params,
                )
        except PermissionError as exc:
            conn.rollback()
            return _invalid("forbidden", str(exc))
        except LookupError as exc:
            conn.rollback()
            return _invalid("not_found", str(exc))
        except ValueError as exc:
            conn.rollback()
            return _invalid("invalid_input", str(exc))
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            return _invalid("conflict", f"Could not persist crm changes: {exc}")

    return _invalid("invalid_intent", f"Unsupported crm intent: {command_code}")
