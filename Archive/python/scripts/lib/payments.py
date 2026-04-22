"""Payments runtime for the first executable mock payment loop in Purr Suite v1."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta
from typing import Any

from scripts.db.sqlite import (
    DEFAULT_DB_PATH,
    caller_actor_id,
    caller_audit_payload,
    ensure_database,
    fetch_business_config,
    record_audit_event,
)
from scripts.lib.inventory import (
    commit_order_reservation,
    expire_reservations,
    reserve_order_items,
    restock_refunded_order,
    sync_low_stock_for_order,
)
from scripts.lib.orders import _serialize_order


PAYMENT_COMMANDS = {
    "payments.create_payment_link",
    "payments.confirm_mock_paid",
    "payments.refund_mock_payment",
    "payments.whoami",
}
MOCK_PROVIDER = "mock"
PAYMENT_RESERVATION_TTL_MINUTES = 15
PAYMENT_REUSABLE_STATUSES = {"pending", "pending_confirmation"}


def _invalid(status: str, reply: str) -> dict[str, Any]:
    """Return a stable payments runtime error payload."""

    return {"status": status, "reply": reply}


def _normalize_text(value: object, field_name: str) -> str:
    """Normalize one required text field and reject blank values."""

    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def _require_params_mapping(params: object) -> dict[str, Any]:
    """Validate the shared `params` envelope for payments runtime."""

    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    return dict(params)


def _now_timestamp() -> str:
    """Return one stable UTC timestamp string compatible with SQLite text columns."""

    return datetime.utcnow().replace(microsecond=0).isoformat(sep=" ")


def _future_timestamp(*, minutes: int) -> str:
    """Return one stable UTC future timestamp string."""

    return (datetime.utcnow() + timedelta(minutes=minutes)).replace(
        microsecond=0
    ).isoformat(sep=" ")


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


def _fetch_order_row(
    conn: sqlite3.Connection,
    *,
    order_number: str | None = None,
    order_id: int | None = None,
) -> sqlite3.Row | None:
    """Return one joined order row with customer metadata."""

    if order_number is None and order_id is None:
        raise ValueError("order_number or order_id is required")
    if order_number is not None:
        return conn.execute(
            """
            SELECT
                orders.*,
                customers.external_user_id AS customer_external_user_id,
                customers.username AS customer_username
            FROM orders
            LEFT JOIN customers ON customers.id = orders.customer_id
            WHERE orders.order_number = ?
            LIMIT 1
            """,
            (order_number,),
        ).fetchone()
    return conn.execute(
        """
        SELECT
            orders.*,
            customers.external_user_id AS customer_external_user_id,
            customers.username AS customer_username
        FROM orders
        LEFT JOIN customers ON customers.id = orders.customer_id
        WHERE orders.id = ?
        LIMIT 1
        """,
        (order_id,),
    ).fetchone()


def _fetch_payment_by_reference(
    conn: sqlite3.Connection, payment_reference: str
) -> sqlite3.Row | None:
    """Return one payment row by provider reference."""

    return conn.execute(
        """
        SELECT *
        FROM payments
        WHERE provider = ?
          AND provider_reference = ?
        LIMIT 1
        """,
        (MOCK_PROVIDER, payment_reference),
    ).fetchone()


def _list_order_payments(conn: sqlite3.Connection, *, order_id: int) -> list[sqlite3.Row]:
    """Return all payment rows for one order, newest first."""

    return conn.execute(
        """
        SELECT *
        FROM payments
        WHERE order_id = ?
        ORDER BY id DESC
        """,
        (order_id,),
    ).fetchall()


def _decode_payment_metadata(payment_row: sqlite3.Row | None) -> dict[str, Any]:
    """Decode one payment row's `metadata_json` into a dictionary."""

    if payment_row is None:
        return {}
    raw = payment_row["metadata_json"]
    if raw is None:
        return {}
    try:
        decoded = json.loads(str(raw))
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _payment_with_metadata(
    payment_row: sqlite3.Row | None,
    **updates: str | None,
) -> str:
    """Merge selected metadata fields into one serialized JSON payload."""

    metadata = _decode_payment_metadata(payment_row)
    for key, value in updates.items():
        if value is None:
            metadata.pop(key, None)
        else:
            metadata[key] = value
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True)


def _serialize_payment(payment_row: sqlite3.Row) -> dict[str, Any]:
    """Return one stable payment payload for runtime responses."""

    metadata = _decode_payment_metadata(payment_row)
    payload = {
        "provider": payment_row["provider"],
        "payment_reference": payment_row["provider_reference"],
        "payment_link_url": payment_row["payment_link_url"],
        "status": payment_row["status"],
        "amount_minor": int(payment_row["amount_minor"]),
        "currency": payment_row["currency"],
        "paid_at": payment_row["paid_at"],
        "refunded_at": payment_row["refunded_at"],
    }
    if "payment_request_id" in metadata:
        payload["payment_request_id"] = metadata["payment_request_id"]
    if "refund_reference" in metadata:
        payload["refund_reference"] = metadata["refund_reference"]
    return payload


def _ensure_mock_provider_enabled(conn: sqlite3.Connection) -> None:
    """Reject mock payment commands when business config no longer points to mock."""

    business_config = fetch_business_config(conn)
    if business_config.get("payment_provider") != MOCK_PROVIDER:
        raise ValueError("business_config.payment_provider must be mock for v1 payments.")


def _find_payment_by_request_id(
    conn: sqlite3.Connection, *, order_id: int, payment_request_id: str
) -> sqlite3.Row | None:
    """Return one order payment whose metadata already records the request id."""

    for payment_row in _list_order_payments(conn, order_id=order_id):
        if _decode_payment_metadata(payment_row).get("payment_request_id") == payment_request_id:
            return payment_row
    return None


def _find_payment_by_refund_reference(
    conn: sqlite3.Connection, *, order_id: int, refund_reference: str
) -> sqlite3.Row | None:
    """Return one refunded payment that already recorded the refund reference."""

    for payment_row in _list_order_payments(conn, order_id=order_id):
        if _decode_payment_metadata(payment_row).get("refund_reference") == refund_reference:
            return payment_row
    return None


def _latest_pending_payment(conn: sqlite3.Connection, *, order_id: int) -> sqlite3.Row | None:
    """Return the newest reusable pending payment row for one order."""

    return conn.execute(
        """
        SELECT *
        FROM payments
        WHERE order_id = ?
          AND status IN ('pending', 'pending_confirmation')
        ORDER BY id DESC
        LIMIT 1
        """,
        (order_id,),
    ).fetchone()


def _latest_paid_like_payment(conn: sqlite3.Connection, *, order_id: int) -> sqlite3.Row | None:
    """Return the newest paid-or-refunded payment row for one order."""

    return conn.execute(
        """
        SELECT *
        FROM payments
        WHERE order_id = ?
          AND status IN ('paid', 'refunded')
        ORDER BY id DESC
        LIMIT 1
        """,
        (order_id,),
    ).fetchone()


def _next_payment_reference(conn: sqlite3.Connection, *, order_id: int, order_number: str) -> str:
    """Generate the next deterministic mock payment reference for one order."""

    count = conn.execute(
        "SELECT COUNT(*) FROM payments WHERE order_id = ?",
        (order_id,),
    ).fetchone()[0]
    return f"mock-pay-{order_number.lower()}-{int(count) + 1:03d}"


def _mock_payment_link_url(payment_reference: str) -> str:
    """Build one deterministic fake payment link URL."""

    return f"https://mock-pay.purrsuite.local/pay/{payment_reference}"


def _require_owner(
    conn: sqlite3.Connection, *, channel: str, external_user_id: str
) -> sqlite3.Row:
    """Require the caller to be the active owner."""

    owner = _fetch_active_owner(conn, channel=channel, external_user_id=external_user_id)
    if owner is None:
        raise PermissionError("Only the active owner can run payments commands.")
    return owner


def _require_store_representative(
    conn: sqlite3.Connection,
    *,
    channel: str,
    actor_external_user_id: str,
    customer_external_user_id: str | None,
) -> None:
    """Block direct customer identities from running store-representative commands."""

    if customer_external_user_id is not None and actor_external_user_id == customer_external_user_id:
        owner = _fetch_active_owner(conn, channel=channel, external_user_id=actor_external_user_id)
        if owner is not None:
            return
        raise PermissionError("Customer identity cannot run this payments command.")
        
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
        raise PermissionError("Only an active store representative can run this payments command.")


def _create_payment_link(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Create or replay one mock payment link for a draft order."""

    _ensure_mock_provider_enabled(conn)
    order_number = _normalize_text(params.get("order_number"), "params.order_number")
    payment_request_id = _normalize_text(
        params.get("payment_request_id"), "params.payment_request_id"
    )
    order_row = _fetch_order_row(conn, order_number=order_number)
    if order_row is None:
        return _invalid("not_found", f"Order {order_number} was not found.")
    
    _require_store_representative(
        conn,
        channel=channel,
        actor_external_user_id=external_user_id,
        customer_external_user_id=order_row["customer_external_user_id"],
    )

    existing_by_request = _find_payment_by_request_id(
        conn, order_id=int(order_row["id"]), payment_request_id=payment_request_id
    )
    if existing_by_request is not None:
        refreshed_order = _fetch_order_row(conn, order_id=int(order_row["id"]))
        assert refreshed_order is not None
        return {
            "status": "created",
            "reply": f"Reused existing mock payment link for order {order_number}.",
            "idempotent_replay": True,
            "payment": _serialize_payment(existing_by_request),
            "order": _serialize_order(conn, refreshed_order),
        }

    pending_payment = _latest_pending_payment(conn, order_id=int(order_row["id"]))
    if (
        pending_payment is not None
        and str(order_row["status"]) == "pending_payment"
        and order_row["reserved_until"] is not None
    ):
        return {
            "status": "created",
            "reply": f"Loaded existing pending payment link for order {order_number}.",
            "idempotent_replay": True,
            "payment": _serialize_payment(pending_payment),
            "order": _serialize_order(conn, order_row),
        }

    if str(order_row["status"]) != "draft":
        return _invalid(
            "invalid_state",
            f"Order {order_number} cannot create a payment link from status {order_row['status']}.",
        )

    payment_reference = _next_payment_reference(
        conn, order_id=int(order_row["id"]), order_number=order_number
    )
    payment_link_url = _mock_payment_link_url(payment_reference)
    reserved_until = _future_timestamp(minutes=PAYMENT_RESERVATION_TTL_MINUTES)

    cursor = conn.execute(
        """
        INSERT INTO payments(
            order_id,
            provider,
            provider_reference,
            payment_link_url,
            status,
            amount_minor,
            currency,
            metadata_json
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
        """,
        (
            int(order_row["id"]),
            MOCK_PROVIDER,
            payment_reference,
            payment_link_url,
            int(order_row["total_minor"]),
            str(order_row["currency"]),
            _payment_with_metadata(None, payment_request_id=payment_request_id),
        ),
    )
    payment_id = int(cursor.lastrowid)
    conn.execute(
        """
        UPDATE orders
        SET status = 'pending_payment',
            reserved_until = ?
        WHERE id = ?
        """,
        (reserved_until, int(order_row["id"])),
    )
    reserve_movement_count = reserve_order_items(conn, order_id=int(order_row["id"]))
    sync_low_stock_for_order(conn, order_id=int(order_row["id"]))
    record_audit_event(
        conn,
        event_type="payments.payment_link_created",
        actor_type="caller",
        actor_id=caller_actor_id(channel, external_user_id),
        entity_type="payment",
        entity_id=payment_reference,
        idempotency_key=f"payments.create_link:payment_request_id={payment_request_id}",
        payload=caller_audit_payload(
            {
                "order_number": order_number,
                "payment_id": payment_id,
                "payment_request_id": payment_request_id,
                "reserved_until": reserved_until,
            },
            channel=channel,
            external_user_id=external_user_id,
        ),
    )
    record_audit_event(
        conn,
        event_type="orders.order_status_changed",
        actor_type="caller",
        actor_id=caller_actor_id(channel, external_user_id),
        entity_type="order",
        entity_id=order_number,
        payload=caller_audit_payload(
            {
                "from_status": "draft",
                "to_status": "pending_payment",
                "payment_reference": payment_reference,
            },
            channel=channel,
            external_user_id=external_user_id,
        ),
    )
    conn.commit()

    payment_row = _fetch_payment_by_reference(conn, payment_reference)
    refreshed_order = _fetch_order_row(conn, order_id=int(order_row["id"]))
    assert payment_row is not None
    assert refreshed_order is not None
    return {
        "status": "created",
        "reply": f"Created mock payment link for order {order_number}.",
        "payment": _serialize_payment(payment_row),
        "order": _serialize_order(conn, refreshed_order),
        "inventory_actions": {
            "reserve_movement_count": reserve_movement_count,
        },
    }


def _confirm_mock_paid(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Confirm one mock payment as paid and commit inventory effects."""

    _ensure_mock_provider_enabled(conn)
    payment_reference = _normalize_text(
        params.get("payment_reference"), "params.payment_reference"
    )
    payment_row = _fetch_payment_by_reference(conn, payment_reference)
    if payment_row is None:
        return _invalid("not_found", f"Payment {payment_reference} was not found.")

    if str(payment_row["status"]) == "paid":
        order_row = _fetch_order_row(conn, order_id=int(payment_row["order_id"]))
        assert order_row is not None
        _require_store_representative(
            conn,
            channel=channel,
            actor_external_user_id=external_user_id,
            customer_external_user_id=order_row["customer_external_user_id"],
        )
        return {
            "status": "paid",
            "reply": f"Mock payment {payment_reference} is already paid.",
            "idempotent_replay": True,
            "payment": _serialize_payment(payment_row),
            "order": _serialize_order(conn, order_row),
        }

    order_row = _fetch_order_row(conn, order_id=int(payment_row["order_id"]))
    assert order_row is not None
    
    _require_store_representative(
        conn,
        channel=channel,
        actor_external_user_id=external_user_id,
        customer_external_user_id=order_row["customer_external_user_id"],
    )
    if str(order_row["status"]) != "pending_payment" or str(payment_row["status"]) not in PAYMENT_REUSABLE_STATUSES:
        return _invalid(
            "invalid_state",
            (
                f"Payment {payment_reference} cannot be confirmed from payment={payment_row['status']} "
                f"and order={order_row['status']}."
            ),
        )

    now_timestamp = _now_timestamp()
    conn.execute(
        """
        UPDATE payments
        SET status = 'paid',
            paid_at = COALESCE(paid_at, ?)
        WHERE id = ?
        """,
        (now_timestamp, int(payment_row["id"])),
    )
    conn.execute(
        """
        UPDATE orders
        SET status = 'paid',
            reserved_until = NULL,
            paid_at = COALESCE(paid_at, ?)
        WHERE id = ?
        """,
        (now_timestamp, int(order_row["id"])),
    )
    commit_stats = commit_order_reservation(
        conn,
        order_id=int(order_row["id"]),
        payment_reference=payment_reference,
    )
    sync_low_stock_for_order(conn, order_id=int(order_row["id"]))
    record_audit_event(
        conn,
        event_type="payments.payment_paid",
        actor_type="caller",
        actor_id=caller_actor_id(channel, external_user_id),
        entity_type="payment",
        entity_id=payment_reference,
        idempotency_key=f"payments.confirm_paid:payment_reference={payment_reference}",
        payload=caller_audit_payload(
            {"order_number": order_row["order_number"]},
            channel=channel,
            external_user_id=external_user_id,
        ),
    )
    record_audit_event(
        conn,
        event_type="orders.order_status_changed",
        actor_type="caller",
        actor_id=caller_actor_id(channel, external_user_id),
        entity_type="order",
        entity_id=str(order_row["order_number"]),
        payload=caller_audit_payload(
            {
                "from_status": "pending_payment",
                "to_status": "paid",
                "payment_reference": payment_reference,
            },
            channel=channel,
            external_user_id=external_user_id,
        ),
    )
    conn.commit()

    refreshed_payment = _fetch_payment_by_reference(conn, payment_reference)
    refreshed_order = _fetch_order_row(conn, order_id=int(order_row["id"]))
    assert refreshed_payment is not None
    assert refreshed_order is not None
    return {
        "status": "paid",
        "reply": f"Confirmed mock payment {payment_reference} as paid.",
        "payment": _serialize_payment(refreshed_payment),
        "order": _serialize_order(conn, refreshed_order),
        "inventory_actions": commit_stats,
    }


def _refund_mock_payment(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Refund one paid mock payment and restock refundable items."""

    _ensure_mock_provider_enabled(conn)
    _require_owner(conn, channel=channel, external_user_id=external_user_id)
    order_number = _normalize_text(params.get("order_number"), "params.order_number")
    refund_reference = _normalize_text(
        params.get("refund_reference"), "params.refund_reference"
    )
    order_row = _fetch_order_row(conn, order_number=order_number)
    if order_row is None:
        return _invalid("not_found", f"Order {order_number} was not found.")

    existing_refund = _find_payment_by_refund_reference(
        conn, order_id=int(order_row["id"]), refund_reference=refund_reference
    )
    if existing_refund is not None:
        refreshed_order = _fetch_order_row(conn, order_id=int(order_row["id"]))
        assert refreshed_order is not None
        return {
            "status": "refunded",
            "reply": f"Refund {refund_reference} was already applied.",
            "idempotent_replay": True,
            "payment": _serialize_payment(existing_refund),
            "order": _serialize_order(conn, refreshed_order),
        }

    payment_row = _latest_paid_like_payment(conn, order_id=int(order_row["id"]))
    if payment_row is None:
        return _invalid(
            "invalid_state",
            f"Order {order_number} has no paid payment that can be refunded.",
        )
    if str(order_row["status"]) != "paid" or str(payment_row["status"]) != "paid":
        return _invalid(
            "invalid_state",
            f"Order {order_number} cannot be refunded from status {order_row['status']}.",
        )

    now_timestamp = _now_timestamp()
    conn.execute(
        """
        UPDATE payments
        SET status = 'refunded',
            refunded_at = COALESCE(refunded_at, ?),
            metadata_json = ?
        WHERE id = ?
        """,
        (
            now_timestamp,
            _payment_with_metadata(payment_row, refund_reference=refund_reference),
            int(payment_row["id"]),
        ),
    )
    conn.execute(
        """
        UPDATE orders
        SET status = 'refunded',
            refunded_at = COALESCE(refunded_at, ?)
        WHERE id = ?
        """,
        (now_timestamp, int(order_row["id"])),
    )
    refund_stats = restock_refunded_order(
        conn,
        order_id=int(order_row["id"]),
        refund_reference=refund_reference,
    )
    sync_low_stock_for_order(conn, order_id=int(order_row["id"]))
    record_audit_event(
        conn,
        event_type="payments.payment_refunded",
        actor_type="owner",
        actor_id=external_user_id,
        entity_type="payment",
        entity_id=str(payment_row["provider_reference"]),
        idempotency_key=f"payments.refund:refund_reference={refund_reference}",
        payload={
            "order_number": order_number,
            "refund_reference": refund_reference,
        },
    )
    record_audit_event(
        conn,
        event_type="orders.order_status_changed",
        actor_type="owner",
        actor_id=external_user_id,
        entity_type="order",
        entity_id=order_number,
        payload={
            "from_status": "paid",
            "to_status": "refunded",
            "refund_reference": refund_reference,
        },
    )
    conn.commit()

    refreshed_payment = _fetch_payment_by_reference(
        conn, str(payment_row["provider_reference"])
    )
    refreshed_order = _fetch_order_row(conn, order_id=int(order_row["id"]))
    assert refreshed_payment is not None
    assert refreshed_order is not None
    return {
        "status": "refunded",
        "reply": f"Refunded paid order {order_number}.",
        "payment": _serialize_payment(refreshed_payment),
        "order": _serialize_order(conn, refreshed_order),
        "inventory_actions": refund_stats,
    }


def handle_payments(context: dict[str, Any]) -> dict[str, Any]:
    """Handle normalized payments runtime commands."""

    command_code = str(context.get("command_code") or "").strip().lower()

    if command_code not in PAYMENT_COMMANDS:
        return _invalid("invalid_intent", f"Unsupported payments intent: {command_code}")

    user = context.get("user") or {}
    params = context.get("params")
    channel = str(context.get("channel") or "telegram").strip() or "telegram"
    external_user_id = str(user.get("external_user_id") or "").strip()
    if not external_user_id and command_code != "payments.whoami":
        return _invalid("invalid_input", "user.external_user_id is required")

    try:
        normalized_params = _require_params_mapping(params)
    except ValueError as exc:
        return _invalid("invalid_input", str(exc))

    runtime = context.get("runtime") or {}
    db_path = str(runtime.get("db_path") or DEFAULT_DB_PATH)
    with closing(ensure_database(db_path)) as conn:
        expired_count = expire_reservations(conn)
        if expired_count:
            conn.commit()

        try:
            if command_code == "payments.whoami":
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
            if command_code == "payments.create_payment_link":
                return _create_payment_link(
                    conn,
                    channel=channel,
                    external_user_id=external_user_id,
                    params=normalized_params,
                )
            if command_code == "payments.confirm_mock_paid":
                return _confirm_mock_paid(
                    conn,
                    channel=channel,
                    external_user_id=external_user_id,
                    params=normalized_params,
                )
            if command_code == "payments.refund_mock_payment":
                return _refund_mock_payment(
                    conn,
                    channel=channel,
                    external_user_id=external_user_id,
                    params=normalized_params,
                )
        except PermissionError as exc:
            conn.rollback()
            return _invalid("forbidden", str(exc))
        except ValueError as exc:
            conn.rollback()
            return _invalid("invalid_input", str(exc))
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            return _invalid("conflict", f"Could not persist payment changes: {exc}")

    return _invalid("invalid_intent", f"Unsupported payments intent: {command_code}")
