"""Orders runtime for Purr Suite v1.

This module implements the first executable Orders slice: create a draft order
from OpenClaw-normalized session output, read order details/lists, and cancel
draft or pending-payment orders. It intentionally stops before payment-driven
reservation or inventory-movement automation, which remain in later phases.
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from contextlib import closing
from datetime import date, timedelta
from typing import Any

from scripts.db.sqlite import DEFAULT_DB_PATH, ensure_database, record_audit_event
from scripts.lib.customer_store import (
    fetch_customer_by_identity,
    upsert_customer_identity,
)
from scripts.lib.inventory import (
    DATE_INVENTORY_MODE,
    QUANTITY_INVENTORY_MODE,
    release_order_reservation,
    expire_reservations,
    get_sellable_quantity,
    sync_low_stock_for_order,
)


ORDER_COMMANDS = {
    "orders.create_session_draft",
    "orders.show_my_orders",
    "orders.list_orders",
    "orders.show_order",
    "orders.cancel_order",
}
ORDER_STATUS_VALUES = {
    "draft",
    "pending_payment",
    "paid",
    "cancelled",
    "refunded",
    "fulfilled",
}
CANCELLABLE_STATUSES = {"draft", "pending_payment"}
FORBIDDEN_SESSION_FIELDS = {"budget_per_night", "guests", "room_type_intent"}
ORDER_NUMBER_PATTERN = re.compile(r"(\d+)$")


def _invalid(status: str, reply: str) -> dict[str, Any]:
    """Return a stable JSON error payload for orders runtime responses."""

    return {"status": status, "reply": reply}


def _normalize_text(value: object, field_name: str) -> str:
    """Normalize a required text field and reject blank values."""

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
    """Validate the shared `params` payload envelope."""

    if params is None:
        return {}
    return _require_mapping(params, "params")


def _coerce_positive_int(value: object, field_name: str) -> int:
    """Coerce a JSON value into a strictly positive integer."""

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


def _parse_date(value: object, field_name: str) -> date:
    """Parse an ISO date string into a local `date` object."""

    raw = _normalize_text(value, field_name)
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO date like YYYY-MM-DD") from exc


def _stay_dates(check_in_date: date, check_out_date: date) -> list[date]:
    """Expand a hotel stay into nightly dates using end-exclusive checkout."""

    if check_out_date <= check_in_date:
        raise ValueError("check_out_date must be after check_in_date")
    day = check_in_date
    rows: list[date] = []
    while day < check_out_date:
        rows.append(day)
        day += timedelta(days=1)
    return rows


def _validate_status_filter(value: object | None) -> str | None:
    """Validate an optional order-status filter."""

    normalized = _optional_text(value)
    if normalized is None:
        return None
    status = normalized.lower()
    if status not in ORDER_STATUS_VALUES:
        allowed = ", ".join(sorted(ORDER_STATUS_VALUES))
        raise ValueError(f"params.status must be one of: {allowed}")
    return status


def _generate_session_id(channel: str, external_user_id: str) -> str:
    """Return a stable order-session identifier for draft creation flows."""

    return f"{channel}:{external_user_id}:{uuid.uuid4()}"


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


def _fetch_sku_by_code(conn: sqlite3.Connection, sku_code: str) -> sqlite3.Row | None:
    """Return a SKU row by its external `sku_code`."""

    return conn.execute(
        "SELECT * FROM skus WHERE sku_code = ? LIMIT 1",
        (sku_code,),
    ).fetchone()


def _next_order_number(conn: sqlite3.Connection) -> str:
    """Generate the next human-facing order number using a stable PO prefix."""

    max_number = 1000
    rows = conn.execute("SELECT order_number FROM orders ORDER BY id").fetchall()
    for row in rows:
        match = ORDER_NUMBER_PATTERN.search(str(row["order_number"]))
        if match:
            max_number = max(max_number, int(match.group(1)))
    return f"PO-{max_number + 1:04d}"


def _serialize_order(conn: sqlite3.Connection, order_row: sqlite3.Row) -> dict[str, Any]:
    """Serialize one order row plus its item rows for runtime responses."""

    item_rows = conn.execute(
        """
        SELECT
            item.*,
            skus.sku_code AS sku_code
        FROM order_items AS item
        LEFT JOIN skus ON skus.id = item.sku_id
        WHERE item.order_id = ?
        ORDER BY item.id ASC
        """,
        (int(order_row["id"]),),
    ).fetchall()

    items: list[dict[str, Any]] = []
    for row in item_rows:
        payload = {
            "sku_code": row["sku_code"],
            "sku_title": row["sku_title"],
            "unit_price_minor": int(row["unit_price_minor"]),
            "currency": row["currency"],
            "quantity": int(row["quantity"]),
            "line_total_minor": int(row["line_total_minor"]),
        }
        if row["check_in_date"] is not None:
            payload["check_in_date"] = row["check_in_date"]
            payload["check_out_date"] = row["check_out_date"]
        items.append(payload)

    order_payload = {
        "order_number": order_row["order_number"],
        "status": order_row["status"],
        "currency": order_row["currency"],
        "subtotal_minor": int(order_row["subtotal_minor"]),
        "total_minor": int(order_row["total_minor"]),
        "reserved_until": order_row["reserved_until"],
        "paid_at": order_row["paid_at"],
        "cancelled_at": order_row["cancelled_at"],
        "refunded_at": order_row["refunded_at"],
        "fulfilled_at": order_row["fulfilled_at"],
        "notes": order_row["notes"],
        "items": items,
    }
    if order_row["session_id"] is not None:
        order_payload["session_id"] = order_row["session_id"]
    if (
        order_row["booking_contact_name"] is not None
        or order_row["booking_contact_phone"] is not None
    ):
        order_payload["booking_contact"] = {
            "guest_name": order_row["booking_contact_name"],
            "phone": order_row["booking_contact_phone"],
        }
    if order_row["customer_external_user_id"] is not None:
        order_payload["customer"] = {
            "external_user_id": order_row["customer_external_user_id"],
            "username": order_row["customer_username"],
        }
    return order_payload


def _fetch_order_row_by_number(
    conn: sqlite3.Connection, order_number: str
) -> sqlite3.Row | None:
    """Return one order row plus customer identity metadata by order number."""

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


def _list_order_rows(
    conn: sqlite3.Connection,
    *,
    customer_id: int | None = None,
    status: str | None = None,
) -> list[sqlite3.Row]:
    """Return filtered order rows with customer identity metadata."""

    clauses = []
    params: list[Any] = []
    if customer_id is not None:
        clauses.append("orders.customer_id = ?")
        params.append(customer_id)
    if status is not None:
        clauses.append("orders.status = ?")
        params.append(status)
    where_sql = ""
    if clauses:
        where_sql = "WHERE " + " AND ".join(clauses)
    return conn.execute(
        f"""
        SELECT
            orders.*,
            customers.external_user_id AS customer_external_user_id,
            customers.username AS customer_username
        FROM orders
        LEFT JOIN customers ON customers.id = orders.customer_id
        {where_sql}
        ORDER BY orders.created_at DESC, orders.id DESC
        """,
        params,
    ).fetchall()


def _ensure_forbidden_session_fields_absent(params: dict[str, Any]) -> None:
    """Reject session-only helper fields that should not reach orders runtime."""

    for field_name in sorted(FORBIDDEN_SESSION_FIELDS):
        if field_name in params:
            raise ValueError(f"params.{field_name} is not accepted by orders runtime")


def _normalize_create_items(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate and normalize the incoming `params.items` array."""

    raw_items = params.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("params.items must be a non-empty array")

    normalized_items: list[dict[str, Any]] = []
    for index, raw_item in enumerate(raw_items):
        item = _require_mapping(raw_item, f"params.items[{index}]")
        for field_name in sorted(FORBIDDEN_SESSION_FIELDS):
            if field_name in item:
                raise ValueError(
                    f"params.items[{index}].{field_name} is not accepted by orders runtime"
                )

        sku_code = _normalize_text(
            item.get("sku_code"), f"params.items[{index}].sku_code"
        ).upper()
        quantity = _coerce_positive_int(
            item.get("quantity"), f"params.items[{index}].quantity"
        )
        check_in_text = _optional_text(item.get("check_in_date"))
        check_out_text = _optional_text(item.get("check_out_date"))
        if bool(check_in_text) != bool(check_out_text):
            raise ValueError(
                f"params.items[{index}].check_in_date and check_out_date must be provided together"
            )

        normalized: dict[str, Any] = {
            "sku_code": sku_code,
            "quantity": quantity,
        }
        if check_in_text and check_out_text:
            check_in_date = _parse_date(
                check_in_text, f"params.items[{index}].check_in_date"
            )
            check_out_date = _parse_date(
                check_out_text, f"params.items[{index}].check_out_date"
            )
            if check_out_date <= check_in_date:
                raise ValueError(
                    f"params.items[{index}].check_out_date must be after check_in_date"
                )
            normalized["check_in_date"] = check_in_date
            normalized["check_out_date"] = check_out_date
        normalized_items.append(normalized)

    return normalized_items


def _validate_status_for_create(
    conn: sqlite3.Connection, sku: sqlite3.Row, item: dict[str, Any]
) -> tuple[int, date | None, date | None]:
    """Validate sellability for one draft-order item and return line-total inputs."""

    quantity = int(item["quantity"])
    inventory_mode = str(sku["inventory_mode"])
    check_in_date = item.get("check_in_date")
    check_out_date = item.get("check_out_date")

    if inventory_mode == DATE_INVENTORY_MODE:
        if check_in_date is None or check_out_date is None:
            raise ValueError(
                f"params.items for {sku['sku_code']} must include check_in_date/check_out_date"
            )
        nightly_sellable = [
            get_sellable_quantity(conn, sku, inventory_date=inventory_date)
            for inventory_date in _stay_dates(check_in_date, check_out_date)
        ]
        requested_window_sellable_quantity = min(nightly_sellable) if nightly_sellable else 0
        if requested_window_sellable_quantity < quantity:
            return requested_window_sellable_quantity, check_in_date, check_out_date
        return requested_window_sellable_quantity, check_in_date, check_out_date

    if check_in_date is not None or check_out_date is not None:
        raise ValueError(
            f"params.items for {sku['sku_code']} must not include dates for quantity inventory"
        )
    sellable_quantity = get_sellable_quantity(conn, sku)
    return sellable_quantity, None, None


def _build_create_payload(
    conn: sqlite3.Connection, *, normalized_items: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], str] | dict[str, Any]:
    """Resolve runtime items into SKU rows, prices, and availability decisions."""

    prepared_items: list[dict[str, Any]] = []
    currencies: set[str] = set()

    for item in normalized_items:
        sku = _fetch_sku_by_code(conn, str(item["sku_code"]))
        if sku is None:
            return _invalid("not_found", f"SKU {item['sku_code']} was not found.")

        available_quantity, check_in_date, check_out_date = _validate_status_for_create(
            conn, sku, item
        )
        if available_quantity < int(item["quantity"]):
            if sku["inventory_mode"] == DATE_INVENTORY_MODE:
                return _invalid(
                    "conflict",
                    (
                        f"SKU {sku['sku_code']} only has {available_quantity} available "
                        "for the requested stay."
                    ),
                )
            return _invalid(
                "conflict",
                f"SKU {sku['sku_code']} only has {available_quantity} sellable now.",
            )

        currency = str(sku["currency"])
        currencies.add(currency)
        line_total_minor = int(sku["price_minor"]) * int(item["quantity"])
        if sku["inventory_mode"] == DATE_INVENTORY_MODE:
            stay_nights = len(_stay_dates(check_in_date, check_out_date))
            line_total_minor *= stay_nights
        prepared_items.append(
            {
                "sku": sku,
                "quantity": int(item["quantity"]),
                "check_in_date": check_in_date,
                "check_out_date": check_out_date,
                "line_total_minor": line_total_minor,
            }
        )

    if len(currencies) != 1:
        return _invalid("invalid_input", "All order items must use the same currency.")

    return prepared_items, next(iter(currencies))


def _create_session_draft(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    username: str | None,
    params: dict[str, Any],
    is_owner: bool,
) -> dict[str, Any]:
    """Create a draft order from normalized OpenClaw session output."""

    if is_owner:
        return _invalid(
            "forbidden",
            "Owners should use owner-side order operations instead of create_session_draft.",
        )

    _ensure_forbidden_session_fields_absent(params)
    session_id = _optional_text(params.get("session_id")) or _generate_session_id(
        channel, external_user_id
    )
    booking_contact = _require_mapping(params.get("booking_contact"), "params.booking_contact")
    guest_name = _normalize_text(
        booking_contact.get("guest_name"), "params.booking_contact.guest_name"
    )
    phone = _normalize_text(
        booking_contact.get("phone"), "params.booking_contact.phone"
    )
    notes = _optional_text(params.get("notes"))
    normalized_items = _normalize_create_items(params)

    resolved = _build_create_payload(conn, normalized_items=normalized_items)
    if isinstance(resolved, dict):
        return resolved
    prepared_items, currency = resolved

    customer = upsert_customer_identity(
        conn,
        channel=channel,
        external_user_id=external_user_id,
        username=username,
    )
    order_number = _next_order_number(conn)
    subtotal_minor = sum(int(item["line_total_minor"]) for item in prepared_items)

    cursor = conn.execute(
        """
        INSERT INTO orders(
            order_number,
            customer_id,
            source_channel,
            status,
            currency,
            subtotal_minor,
            total_minor,
            notes,
            session_id,
            booking_contact_name,
            booking_contact_phone
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            order_number,
            int(customer["id"]),
            channel,
            currency,
            subtotal_minor,
            subtotal_minor,
            notes,
            session_id,
            guest_name,
            phone,
        ),
    )
    order_id = int(cursor.lastrowid)

    for item in prepared_items:
        sku = item["sku"]
        conn.execute(
            """
            INSERT INTO order_items(
                order_id,
                sku_id,
                sku_title,
                unit_price_minor,
                currency,
                quantity,
                line_total_minor,
                check_in_date,
                check_out_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order_id,
                int(sku["id"]),
                str(sku["title"]),
                int(sku["price_minor"]),
                str(sku["currency"]),
                int(item["quantity"]),
                int(item["line_total_minor"]),
                item["check_in_date"].isoformat()
                if item["check_in_date"] is not None
                else None,
                item["check_out_date"].isoformat()
                if item["check_out_date"] is not None
                else None,
            ),
        )

    record_audit_event(
        conn,
        event_type="orders.order_draft_created",
        actor_type="customer",
        actor_id=external_user_id,
        entity_type="order",
        entity_id=order_number,
        payload={
            "customer_external_user_id": external_user_id,
            "item_count": len(prepared_items),
            "session_id": session_id,
        },
    )
    conn.commit()

    order_row = _fetch_order_row_by_number(conn, order_number)
    assert order_row is not None
    return {
        "status": "created",
        "reply": f"Created draft order {order_number}.",
        "audit_event_type": "orders.order_draft_created",
        "order": _serialize_order(conn, order_row),
    }


def _show_my_orders(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    is_owner: bool,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Return the caller's own orders for customer-facing reads."""

    if is_owner:
        return _invalid("forbidden", "Owners should use orders.list_orders instead.")

    status = _validate_status_filter(params.get("status"))
    customer = fetch_customer_by_identity(
        conn,
        channel=channel,
        external_user_id=external_user_id,
    )
    if customer is None:
        return {"status": "listed", "reply": "Loaded 0 order(s).", "orders": []}

    rows = _list_order_rows(conn, customer_id=int(customer["id"]), status=status)
    return {
        "status": "listed",
        "reply": f"Loaded {len(rows)} order(s).",
        "orders": [_serialize_order(conn, row) for row in rows],
    }


def _list_orders(
    conn: sqlite3.Connection, *, is_owner: bool, params: dict[str, Any]
) -> dict[str, Any]:
    """Return the owner-facing order list."""

    if not is_owner:
        return _invalid("forbidden", "Only the active owner can list all orders.")

    status = _validate_status_filter(params.get("status"))
    rows = _list_order_rows(conn, status=status)
    return {
        "status": "listed",
        "reply": f"Loaded {len(rows)} order(s).",
        "orders": [_serialize_order(conn, row) for row in rows],
    }


def _show_order(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    is_owner: bool,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Return one order if the caller has permission to read it."""

    order_number = _normalize_text(params.get("order_number"), "params.order_number")
    order_row = _fetch_order_row_by_number(conn, order_number)
    if order_row is None:
        return _invalid("not_found", f"Order {order_number} was not found.")

    if not is_owner:
        customer = fetch_customer_by_identity(
            conn,
            channel=channel,
            external_user_id=external_user_id,
        )
        if customer is None or int(customer["id"]) != int(order_row["customer_id"]):
            return _invalid("forbidden", "You can only view your own orders.")

    return {
        "status": "found",
        "reply": f"Loaded order {order_number}.",
        "order": _serialize_order(conn, order_row),
    }


def _cancel_order(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    is_owner: bool,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Cancel one draft or pending-payment order when the caller is allowed."""

    order_number = _normalize_text(params.get("order_number"), "params.order_number")
    reason = _optional_text(params.get("reason")) or "manual_cancel"
    order_row = _fetch_order_row_by_number(conn, order_number)
    if order_row is None:
        return _invalid("not_found", f"Order {order_number} was not found.")

    actor_type = "owner" if is_owner else "customer"
    if not is_owner:
        customer = fetch_customer_by_identity(
            conn,
            channel=channel,
            external_user_id=external_user_id,
        )
        if customer is None or int(customer["id"]) != int(order_row["customer_id"]):
            return _invalid("forbidden", "You can only cancel your own orders.")

    if str(order_row["status"]) not in CANCELLABLE_STATUSES:
        return _invalid(
            "invalid_state",
            f"Order {order_number} cannot be cancelled from status {order_row['status']}.",
        )

    conn.execute(
        """
        UPDATE orders
        SET status = 'cancelled',
            reserved_until = NULL,
            cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP)
        WHERE id = ?
        """,
        (int(order_row["id"]),),
    )
    if str(order_row["status"]) == "pending_payment":
        release_order_reservation(
            conn,
            order_id=int(order_row["id"]),
            reason=reason,
        )
        sync_low_stock_for_order(conn, order_id=int(order_row["id"]))
    record_audit_event(
        conn,
        event_type="orders.order_cancelled",
        actor_type=actor_type,
        actor_id=external_user_id,
        entity_type="order",
        entity_id=order_number,
        payload={"reason": reason},
    )
    record_audit_event(
        conn,
        event_type="orders.order_status_changed",
        actor_type=actor_type,
        actor_id=external_user_id,
        entity_type="order",
        entity_id=order_number,
        payload={
            "from_status": order_row["status"],
            "to_status": "cancelled",
            "reason": reason,
        },
    )
    conn.commit()

    refreshed = _fetch_order_row_by_number(conn, order_number)
    assert refreshed is not None
    return {
        "status": "cancelled",
        "reply": f"Cancelled order {order_number}.",
        "audit_event_type": "orders.order_cancelled",
        "order": _serialize_order(conn, refreshed),
    }


def handle_orders(context: dict[str, Any]) -> dict[str, Any]:
    """Handle normalized orders runtime commands.

    Args:
        context: Host-normalized payload containing `channel`, `command_code`,
            `user`, and optional `params`.

    Returns:
        JSON-serializable runtime response for the requested orders command.
    """

    command_code = str(context.get("command_code") or "").strip().lower()
    if command_code not in ORDER_COMMANDS:
        return _invalid("invalid_intent", f"Unsupported orders intent: {command_code}")

    user = context.get("user") or {}
    params = context.get("params")
    channel = str(context.get("channel") or "telegram").strip() or "telegram"
    external_user_id = str(user.get("external_user_id") or "").strip()
    if not external_user_id:
        return _invalid("invalid_input", "user.external_user_id is required")

    username = _optional_text(user.get("username"))
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

        owner = _fetch_active_owner(
            conn, channel=channel, external_user_id=external_user_id
        )
        is_owner = owner is not None

        try:
            if command_code == "orders.create_session_draft":
                return _create_session_draft(
                    conn,
                    channel=channel,
                    external_user_id=external_user_id,
                    username=username,
                    params=normalized_params,
                    is_owner=is_owner,
                )
            if command_code == "orders.show_my_orders":
                return _show_my_orders(
                    conn,
                    channel=channel,
                    external_user_id=external_user_id,
                    is_owner=is_owner,
                    params=normalized_params,
                )
            if command_code == "orders.list_orders":
                return _list_orders(conn, is_owner=is_owner, params=normalized_params)
            if command_code == "orders.show_order":
                return _show_order(
                    conn,
                    channel=channel,
                    external_user_id=external_user_id,
                    is_owner=is_owner,
                    params=normalized_params,
                )
            if command_code == "orders.cancel_order":
                return _cancel_order(
                    conn,
                    channel=channel,
                    external_user_id=external_user_id,
                    is_owner=is_owner,
                    params=normalized_params,
                )
        except ValueError as exc:
            conn.rollback()
            return _invalid("invalid_input", str(exc))
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            return _invalid("conflict", f"Could not persist order changes: {exc}")

    return _invalid("invalid_intent", f"Unsupported orders intent: {command_code}")
