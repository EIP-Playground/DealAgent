"""Inventory runtime and shared stock helpers for Purr Suite v1.

This module implements Inventory Phase A for both generic quantity SKUs and
hospitality-style date-based capacity SKUs. It provides owner-facing runtime
intents, shared stock math, low-stock alert lifecycle helpers, and explicit
reference-key builders that later order/payment flows can reuse.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Iterable

from scripts.db.sqlite import DEFAULT_DB_PATH, ensure_database, record_audit_event


INVENTORY_INTENTS = {
    "inventory.show_inventory",
    "inventory.show_stock",
    "inventory.adjust_stock",
    "inventory.set_date_stock",
    "inventory.show_low_stock",
}
DATE_INVENTORY_MODE = "date_quantity"
QUANTITY_INVENTORY_MODE = "quantity"
LOW_STOCK_THRESHOLD = 2
LOW_STOCK_SCAN_DAYS = 30
DUPLICATE_CONFIRM_WINDOW_SECONDS = 60
DATE_OCCUPYING_ORDER_STATUSES = ("paid", "fulfilled")


@dataclass(frozen=True)
class InventoryWindowRow:
    """Owner-facing per-date inventory row for a `date_quantity` SKU."""

    inventory_date: str
    stock_quantity: int
    sellable_status: str
    reserved_quantity: int
    sellable_quantity: int
    low_stock: bool


def _invalid(status: str, reply: str) -> dict[str, Any]:
    """Return a stable JSON error payload for inventory runtime."""

    return {"status": status, "reply": reply}


def _normalize_text(value: object, field_name: str) -> str:
    """Return stripped text and reject empty required values."""

    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def _optional_text(value: object) -> str | None:
    """Normalize optional text into stripped text or None."""

    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _require_params_mapping(params: object) -> dict[str, Any]:
    """Validate the shared `params` payload envelope."""

    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    return dict(params)


def _coerce_int(value: object, field_name: str) -> int:
    """Coerce a JSON value into an integer."""

    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError as exc:
            raise ValueError(f"{field_name} must be an integer") from exc
    raise ValueError(f"{field_name} must be an integer")


def _coerce_non_negative_int(value: object, field_name: str) -> int:
    """Coerce a JSON value into a non-negative integer."""

    number = _coerce_int(value, field_name)
    if number < 0:
        raise ValueError(f"{field_name} must be non-negative")
    return number


def _coerce_bool(value: object, field_name: str) -> bool:
    """Normalize a boolean-like JSON value."""

    if value in (True, 1, "1", "true", "True"):
        return True
    if value in (False, 0, "0", "false", "False", None):
        return False
    raise ValueError(f"{field_name} must be a boolean")


def _parse_date(value: object, field_name: str) -> date:
    """Parse an ISO date string into a `date` object."""

    raw = _normalize_text(value, field_name)
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO date like YYYY-MM-DD") from exc


def _inclusive_dates(date_from: date, date_to: date) -> list[date]:
    """Expand an inclusive date range for owner-maintained stock overrides."""

    if date_to < date_from:
        raise ValueError("params.date_to must be on or after params.date_from")
    day = date_from
    rows: list[date] = []
    while day <= date_to:
        rows.append(day)
        day += timedelta(days=1)
    return rows


def _stay_dates(check_in: date, check_out: date) -> list[date]:
    """Expand a hotel stay into nightly dates using end-exclusive checkout."""

    if check_out <= check_in:
        raise ValueError("params.check_out_date must be after params.check_in_date")
    day = check_in
    rows: list[date] = []
    while day < check_out:
        rows.append(day)
        day += timedelta(days=1)
    return rows


def _fetch_active_owner(
    conn: sqlite3.Connection, *, channel: str, external_user_id: str
) -> sqlite3.Row | None:
    """Return the active owner row for the caller, if any."""

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
    """Return a SKU row by `sku_code`."""

    return conn.execute(
        "SELECT * FROM skus WHERE sku_code = ? LIMIT 1",
        (sku_code,),
    ).fetchone()


def _fetch_sku_by_id(conn: sqlite3.Connection, sku_id: int) -> sqlite3.Row | None:
    """Return a SKU row by internal primary key."""

    return conn.execute(
        "SELECT * FROM skus WHERE id = ? LIMIT 1",
        (sku_id,),
    ).fetchone()


def _fetch_date_override(
    conn: sqlite3.Connection,
    *,
    sku_id: int,
    inventory_date: date,
) -> sqlite3.Row | None:
    """Return a date override row for the SKU and specific date."""

    return conn.execute(
        """
        SELECT *
        FROM sku_date_overrides
        WHERE sku_id = ? AND inventory_date = ?
        LIMIT 1
        """,
        (sku_id, inventory_date.isoformat()),
    ).fetchone()


def _stock_quantity_semantics(inventory_mode: str) -> str:
    """Mirror catalog semantics for owner-facing stock quantity meaning."""

    if inventory_mode == DATE_INVENTORY_MODE:
        return "default_nightly_capacity"
    return "on_hand_quantity"


def build_manual_adjust_reference_key(operation_id: str, sku_id: int) -> str:
    """Build the explicit idempotency key for manual stock adjustments.

    Args:
        operation_id: Host-generated identifier for one manual adjust request.
        sku_id: Internal SKU primary key used by `inventory_movements`.

    Returns:
        Stable `field=value` reference key for one manual adjustment replay
        boundary.
    """

    return f"manual_adjust:operation_id={operation_id}:sku_id={sku_id}"


def build_set_date_stock_reference_key(
    operation_id: str, sku_id: int, inventory_date: date
) -> str:
    """Build the explicit key for one expanded date-stock update row.

    Args:
        operation_id: Host-generated identifier for one date-stock request.
        sku_id: Internal SKU primary key used by `sku_date_overrides`.
        inventory_date: Expanded single date within the requested owner window.

    Returns:
        Stable `field=value` reference key for one per-day date-stock update.
    """

    return (
        "set_date_stock:"
        f"operation_id={operation_id}:"
        f"sku_id={sku_id}:"
        f"inventory_date={inventory_date.isoformat()}"
    )


def build_order_reference_key(
    action: str,
    *,
    order_id: int,
    order_item_id: int,
    sku_id: int,
    inventory_date: date | None = None,
    payment_reference: str | None = None,
    refund_reference: str | None = None,
    reason: str | None = None,
) -> str:
    """Build future automated movement keys using explicit field=value segments.

    Args:
        action: Inventory movement verb such as `reserve` or `commit`.
        order_id: Parent order identifier for the inventory action.
        order_item_id: Order-line identifier anchoring the movement instance.
        sku_id: Internal SKU primary key affected by the movement.
        inventory_date: Optional nightly date for `date_quantity` movements.
        payment_reference: Optional payment reference for payment-driven actions.
        refund_reference: Optional refund reference for refund-driven actions.
        reason: Optional release reason or other explicit movement qualifier.

    Returns:
        Stable `field=value` reference key describing one automated movement.
    """

    if payment_reference is not None:
        parts = [action, f"payment_reference={payment_reference}"]
    elif refund_reference is not None:
        parts = [action, f"refund_reference={refund_reference}"]
    else:
        parts = [action]
    parts.extend(
        [
            f"order_id={order_id}",
            f"order_item_id={order_item_id}",
            f"sku_id={sku_id}",
        ]
    )
    if inventory_date is not None:
        parts.append(f"inventory_date={inventory_date.isoformat()}")
    if reason is not None:
        parts.append(f"reason={reason}")
    return ":".join(parts)


def _effective_sellable_status(
    conn: sqlite3.Connection, sku: sqlite3.Row, *, inventory_date: date | None = None
) -> str:
    """Resolve the customer/owner-visible sellable status for a SKU scope."""

    if sku["inventory_mode"] != DATE_INVENTORY_MODE or inventory_date is None:
        return str(sku["sellable_status"])

    override = _fetch_date_override(conn, sku_id=int(sku["id"]), inventory_date=inventory_date)
    if override is not None and override["sellable_status_override"]:
        return str(override["sellable_status_override"])
    return str(sku["sellable_status"])


def _effective_stock_quantity(
    conn: sqlite3.Connection, sku: sqlite3.Row, *, inventory_date: date | None = None
) -> int:
    """Resolve the stock quantity for the requested mode/date scope."""

    if sku["inventory_mode"] != DATE_INVENTORY_MODE or inventory_date is None:
        return int(sku["stock_quantity"])

    override = _fetch_date_override(conn, sku_id=int(sku["id"]), inventory_date=inventory_date)
    if override is not None:
        return int(override["stock_quantity_override"])
    return int(sku["stock_quantity"])


def _apply_date_override_delta(
    conn: sqlite3.Connection,
    *,
    sku_id: int,
    inventory_date: date,
    delta: int,
    reason: str,
) -> None:
    """Adjust date-specific stock overrides by a signed delta."""

    sku = _fetch_sku_by_id(conn, sku_id)
    assert sku is not None
    base_stock = int(sku["stock_quantity"])
    override = _fetch_date_override(conn, sku_id=sku_id, inventory_date=inventory_date)
    sellable_status_override = (
        override["sellable_status_override"] if override is not None else None
    )
    current_stock = (
        int(override["stock_quantity_override"]) if override is not None else base_stock
    )
    new_stock = current_stock + delta
    if new_stock < 0:
        raise ValueError(
            f"SKU {sku['sku_code']} does not have enough capacity on {inventory_date}."
        )
    if new_stock == base_stock and sellable_status_override is None:
        conn.execute(
            """
            DELETE FROM sku_date_overrides
            WHERE sku_id = ? AND inventory_date = ?
            """,
            (sku_id, inventory_date.isoformat()),
        )
        return
    conn.execute(
        """
        INSERT INTO sku_date_overrides(
            sku_id,
            inventory_date,
            stock_quantity_override,
            sellable_status_override,
            reason,
            created_by_owner_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(sku_id, inventory_date) DO UPDATE SET
            stock_quantity_override = excluded.stock_quantity_override,
            sellable_status_override = excluded.sellable_status_override,
            reason = excluded.reason,
            created_by_owner_id = excluded.created_by_owner_id
        """,
        (
            sku_id,
            inventory_date.isoformat(),
            new_stock,
            sellable_status_override,
            reason,
            None,
        ),
    )


def _iter_scan_dates(days_ahead: int = LOW_STOCK_SCAN_DAYS) -> Iterable[date]:
    """Yield dates for future low-stock scanning, starting today."""

    today = date.today()
    for offset in range(days_ahead):
        yield today + timedelta(days=offset)


def _fetch_order_inventory_rows(
    conn: sqlite3.Connection, *, order_id: int
) -> list[sqlite3.Row]:
    """Return one order's item rows joined with SKU inventory metadata."""

    return conn.execute(
        """
        SELECT
            item.id,
            item.order_id,
            item.sku_id,
            item.quantity,
            item.check_in_date,
            item.check_out_date,
            skus.sku_code,
            skus.inventory_mode,
            skus.restock_on_refund
        FROM order_items AS item
        JOIN skus ON skus.id = item.sku_id
        WHERE item.order_id = ?
        ORDER BY item.id ASC
        """,
        (order_id,),
    ).fetchall()


def _movement_dates_for_item(item: sqlite3.Row) -> list[date | None]:
    """Return one movement scope per item, expanding hotel stays nightly."""

    if item["inventory_mode"] != DATE_INVENTORY_MODE:
        return [None]

    check_in_text = item["check_in_date"]
    check_out_text = item["check_out_date"]
    if check_in_text is None or check_out_text is None:
        raise ValueError(
            f"date_quantity order item {item['id']} is missing check_in_date/check_out_date"
        )
    check_in_date = date.fromisoformat(str(check_in_text))
    check_out_date = date.fromisoformat(str(check_out_text))
    return list(_stay_dates(check_in_date, check_out_date))


def _insert_order_movement(
    conn: sqlite3.Connection,
    *,
    action: str,
    order_id: int,
    item: sqlite3.Row,
    reason: str,
    payment_reference: str | None = None,
    refund_reference: str | None = None,
) -> int:
    """Write one or many automated order movements and return inserted-row count."""

    inserted = 0
    for inventory_date in _movement_dates_for_item(item):
        reference_key = build_order_reference_key(
            action,
            order_id=order_id,
            order_item_id=int(item["id"]),
            sku_id=int(item["sku_id"]),
            inventory_date=inventory_date,
            payment_reference=payment_reference,
            refund_reference=refund_reference,
            reason=reason if action == "release" else None,
        )
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO inventory_movements(
                sku_id,
                order_id,
                movement_type,
                delta,
                reason,
                reference_key
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                int(item["sku_id"]),
                order_id,
                action,
                int(item["quantity"]),
                reason,
                reference_key,
            ),
        )
        inserted += max(cursor.rowcount, 0)
    return inserted


def sync_low_stock_for_order(conn: sqlite3.Connection, *, order_id: int) -> None:
    """Refresh low-stock state for every SKU touched by one order."""

    sku_ids = {
        int(row["sku_id"])
        for row in conn.execute(
            "SELECT DISTINCT sku_id FROM order_items WHERE order_id = ?",
            (order_id,),
        ).fetchall()
    }
    for sku_id in sorted(sku_ids):
        sku = _fetch_sku_by_id(conn, sku_id)
        if sku is not None:
            _sync_low_stock_alerts_for_sku(conn, sku)


def _record_audit_event_ignore_duplicates(
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
    """Insert an audit row, skipping duplicate idempotency keys."""

    try:
        record_audit_event(
            conn,
            event_type=event_type,
            actor_type=actor_type,
            actor_id=actor_id,
            entity_type=entity_type,
            entity_id=entity_id,
            idempotency_key=idempotency_key,
            payload=payload,
        )
    except sqlite3.IntegrityError as exc:
        if idempotency_key and "audit_events.idempotency_key" in str(exc):
            return
        raise


def expire_reservations(conn: sqlite3.Connection) -> int:
    """Cancel expired pending-payment orders and write release movements.

    Args:
        conn: Open SQLite connection used for order updates and movement writes.

    Returns:
        Count of order-item release movements written for expired reservations.
    """

    expired_orders = conn.execute(
        """
        SELECT id, order_number
        FROM orders
        WHERE status = 'pending_payment'
          AND reserved_until IS NOT NULL
          AND reserved_until < CURRENT_TIMESTAMP
        ORDER BY id
        """
    ).fetchall()
    released = 0
    for order in expired_orders:
        conn.execute(
            """
            UPDATE orders
            SET status = 'cancelled',
                reserved_until = NULL,
                cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP)
            WHERE id = ?
            """,
            (order["id"],),
        )
        released += release_order_reservation(
            conn, order_id=int(order["id"]), reason="expired"
        )
        sync_low_stock_for_order(conn, order_id=int(order["id"]))
        _record_audit_event_ignore_duplicates(
            conn,
            event_type="inventory.reservation_expired_released",
            actor_type="system",
            actor_id=None,
            entity_type="order",
            entity_id=str(order["id"]),
            idempotency_key=f"inventory.expired_release:order_id={order['id']}",
            payload={"order_number": order["order_number"]},
        )
    return released


def get_reserved_quantity(
    conn: sqlite3.Connection, sku: sqlite3.Row, *, inventory_date: date | None = None
) -> int:
    """Return currently reserved quantity for a SKU scope.

    Args:
        conn: Open SQLite connection used for reservation lookup.
        sku: SKU row whose reserved quantity should be computed.
        inventory_date: Optional nightly scope for `date_quantity` lookups.

    Returns:
        Active reserved quantity for the requested scope after lazy expiry.
    """

    expire_reservations(conn)
    if sku["inventory_mode"] == DATE_INVENTORY_MODE:
        if inventory_date is None:
            return 0
        row = conn.execute(
            """
            SELECT COALESCE(SUM(item.quantity), 0) AS reserved_quantity
            FROM order_items AS item
            JOIN orders ON orders.id = item.order_id
            WHERE item.sku_id = ?
              AND item.check_in_date IS NOT NULL
              AND item.check_out_date IS NOT NULL
              AND item.check_in_date <= ?
              AND item.check_out_date > ?
              AND orders.status = 'pending_payment'
              AND orders.reserved_until IS NOT NULL
              AND orders.reserved_until > CURRENT_TIMESTAMP
            """,
            (
                int(sku["id"]),
                inventory_date.isoformat(),
                inventory_date.isoformat(),
            ),
        ).fetchone()
        return int(row["reserved_quantity"] or 0)

    row = conn.execute(
        """
        SELECT COALESCE(SUM(item.quantity), 0) AS reserved_quantity
        FROM order_items AS item
        JOIN orders ON orders.id = item.order_id
        WHERE item.sku_id = ?
          AND orders.status = 'pending_payment'
          AND orders.reserved_until IS NOT NULL
          AND orders.reserved_until > CURRENT_TIMESTAMP
        """,
        (int(sku["id"]),),
    ).fetchone()
    return int(row["reserved_quantity"] or 0)


def get_sellable_quantity(
    conn: sqlite3.Connection, sku: sqlite3.Row, *, inventory_date: date | None = None
) -> int:
    """Return sellable quantity after status and active reservations are applied.

    Args:
        conn: Open SQLite connection used for stock and reservation reads.
        sku: SKU row whose sellable quantity should be computed.
        inventory_date: Optional nightly scope for `date_quantity` lookups.

    Returns:
        Non-negative sellable quantity for the requested scope.
    """

    status = _effective_sellable_status(conn, sku, inventory_date=inventory_date)
    if status != "active":
        return 0
    stock_quantity = _effective_stock_quantity(conn, sku, inventory_date=inventory_date)
    reserved_quantity = get_reserved_quantity(conn, sku, inventory_date=inventory_date)
    return max(stock_quantity - reserved_quantity, 0)


def _is_date_low_stock(
    *,
    base_stock: int,
    stock_quantity: int,
    sellable_status: str,
    sellable_quantity: int,
    reserved_quantity: int,
) -> bool:
    """Return whether a date-quantity SKU should trigger a low-stock alert."""

    if sellable_status != "active":
        return False
    if sellable_quantity > LOW_STOCK_THRESHOLD:
        return False
    if reserved_quantity == 0 and stock_quantity == base_stock:
        return False
    return True


def _date_low_stock_rows(
    conn: sqlite3.Connection,
    sku: sqlite3.Row,
    *,
    days_ahead: int = LOW_STOCK_SCAN_DAYS,
) -> list[InventoryWindowRow]:
    """Return future per-date low-stock candidate rows for a date-based SKU."""

    rows: list[InventoryWindowRow] = []
    base_stock = int(sku["stock_quantity"])
    for inventory_date in _iter_scan_dates(days_ahead):
        stock_quantity = _effective_stock_quantity(
            conn, sku, inventory_date=inventory_date
        )
        sellable_status = _effective_sellable_status(
            conn, sku, inventory_date=inventory_date
        )
        reserved_quantity = get_reserved_quantity(
            conn, sku, inventory_date=inventory_date
        )
        sellable_quantity = get_sellable_quantity(
            conn, sku, inventory_date=inventory_date
        )
        rows.append(
            InventoryWindowRow(
                inventory_date=inventory_date.isoformat(),
                stock_quantity=stock_quantity,
                sellable_status=sellable_status,
                reserved_quantity=reserved_quantity,
                sellable_quantity=sellable_quantity,
                low_stock=_is_date_low_stock(
                    base_stock=base_stock,
                    stock_quantity=stock_quantity,
                    sellable_status=sellable_status,
                    sellable_quantity=sellable_quantity,
                    reserved_quantity=reserved_quantity,
                ),
            )
        )
    return rows


def _active_low_stock_alert(
    conn: sqlite3.Connection, *, sku_id: int, inventory_date: str | None
) -> sqlite3.Row | None:
    """Return the newest active alert row for a SKU/date scope."""

    return conn.execute(
        """
        SELECT *
        FROM low_stock_alerts
        WHERE sku_id = ?
          AND ((inventory_date IS NULL AND ? IS NULL) OR inventory_date = ?)
          AND status IN ('pending', 'sent')
        ORDER BY id DESC
        LIMIT 1
        """,
        (sku_id, inventory_date, inventory_date),
    ).fetchone()


def _resolve_low_stock_alerts(
    conn: sqlite3.Connection, *, sku_id: int, inventory_date: str | None
) -> None:
    """Mark active alerts as resolved for the given SKU/date scope."""

    conn.execute(
        """
        UPDATE low_stock_alerts
        SET status = 'resolved',
            resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)
        WHERE sku_id = ?
          AND ((inventory_date IS NULL AND ? IS NULL) OR inventory_date = ?)
          AND status IN ('pending', 'sent')
        """,
        (sku_id, inventory_date, inventory_date),
    )


def _create_or_refresh_low_stock_alert(
    conn: sqlite3.Connection,
    *,
    sku: sqlite3.Row,
    inventory_date: str | None,
    sellable_quantity: int,
) -> None:
    """Create or refresh an active low-stock alert row."""

    existing = _active_low_stock_alert(
        conn, sku_id=int(sku["id"]), inventory_date=inventory_date
    )
    if existing is None:
        conn.execute(
            """
            INSERT INTO low_stock_alerts(
                sku_id,
                inventory_date,
                inventory_mode,
                threshold,
                sellable_quantity,
                status
            ) VALUES (?, ?, ?, ?, ?, 'pending')
            """,
            (
                int(sku["id"]),
                inventory_date,
                str(sku["inventory_mode"]),
                LOW_STOCK_THRESHOLD,
                sellable_quantity,
            ),
        )
        _record_audit_event_ignore_duplicates(
            conn,
            event_type="inventory.low_stock_detected",
            actor_type="system",
            actor_id=None,
            entity_type="sku",
            entity_id=str(sku["sku_code"]),
            payload={
                "inventory_mode": sku["inventory_mode"],
                "inventory_date": inventory_date,
                "sellable_quantity": sellable_quantity,
                "threshold": LOW_STOCK_THRESHOLD,
            },
        )
        return

    conn.execute(
        """
        UPDATE low_stock_alerts
        SET sellable_quantity = ?
        WHERE id = ?
        """,
        (sellable_quantity, int(existing["id"])),
    )


def _sync_low_stock_alerts_for_sku(
    conn: sqlite3.Connection, sku: sqlite3.Row, *, days_ahead: int = LOW_STOCK_SCAN_DAYS
) -> None:
    """Detect or resolve low-stock alert rows for the given SKU."""

    if sku["inventory_mode"] == QUANTITY_INVENTORY_MODE:
        sellable_quantity = get_sellable_quantity(conn, sku)
        if sku["sellable_status"] == "active" and sellable_quantity <= LOW_STOCK_THRESHOLD:
            _create_or_refresh_low_stock_alert(
                conn,
                sku=sku,
                inventory_date=None,
                sellable_quantity=sellable_quantity,
            )
            return

        if _active_low_stock_alert(conn, sku_id=int(sku["id"]), inventory_date=None):
            _resolve_low_stock_alerts(conn, sku_id=int(sku["id"]), inventory_date=None)
            _record_audit_event_ignore_duplicates(
                conn,
                event_type="inventory.low_stock_resolved",
                actor_type="system",
                actor_id=None,
                entity_type="sku",
                entity_id=str(sku["sku_code"]),
                payload={"inventory_mode": sku["inventory_mode"]},
            )
        return

    seen_low_dates: set[str] = set()
    for row in _date_low_stock_rows(conn, sku, days_ahead=days_ahead):
        inventory_date = row.inventory_date
        if row.low_stock:
            seen_low_dates.add(inventory_date)
            _create_or_refresh_low_stock_alert(
                conn,
                sku=sku,
                inventory_date=inventory_date,
                sellable_quantity=row.sellable_quantity,
            )
        elif _active_low_stock_alert(
            conn, sku_id=int(sku["id"]), inventory_date=inventory_date
        ):
            _resolve_low_stock_alerts(
                conn, sku_id=int(sku["id"]), inventory_date=inventory_date
            )
            _record_audit_event_ignore_duplicates(
                conn,
                event_type="inventory.low_stock_resolved",
                actor_type="system",
                actor_id=None,
                entity_type="sku",
                entity_id=str(sku["sku_code"]),
                payload={
                    "inventory_mode": sku["inventory_mode"],
                    "inventory_date": inventory_date,
                },
            )


def list_inventory_rows(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return owner-facing inventory rows for every SKU.

    Args:
        conn: Open SQLite connection used for SKU and stock reads.

    Returns:
        Serialized owner-facing inventory rows for every SKU in the catalog.
    """

    rows = conn.execute(
        """
        SELECT *
        FROM skus
        ORDER BY created_at DESC, sku_code ASC
        """
    ).fetchall()
    return [_serialize_inventory_row(conn, row) for row in rows]


def _serialize_inventory_row(conn: sqlite3.Connection, sku: sqlite3.Row) -> dict[str, Any]:
    """Serialize one owner-facing inventory row."""

    reserved_quantity = get_reserved_quantity(conn, sku)
    sellable_quantity = get_sellable_quantity(conn, sku)
    if sku["inventory_mode"] == DATE_INVENTORY_MODE:
        low_stock = any(row.low_stock for row in _date_low_stock_rows(conn, sku))
    else:
        low_stock = sku["sellable_status"] == "active" and sellable_quantity <= LOW_STOCK_THRESHOLD
    return {
        "sku_code": sku["sku_code"],
        "title": sku["title"],
        "inventory_mode": sku["inventory_mode"],
        "stock_quantity": int(sku["stock_quantity"]),
        "stock_quantity_semantics": _stock_quantity_semantics(str(sku["inventory_mode"])),
        "sellable_status": sku["sellable_status"],
        "reserved_quantity": reserved_quantity,
        "sellable_quantity": sellable_quantity,
        "low_stock": low_stock,
        "low_stock_threshold": LOW_STOCK_THRESHOLD,
    }


def _show_stock_payload(
    conn: sqlite3.Connection,
    sku: sqlite3.Row,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict[str, Any]:
    """Build the owner-facing `show stock` payload for one SKU."""

    payload = _serialize_inventory_row(conn, sku)
    if sku["inventory_mode"] != DATE_INVENTORY_MODE:
        return payload

    if date_from is None or date_to is None:
        payload["date_inventory_hint"] = (
            "Provide params.date_from and params.date_to to inspect exact date-based stock."
        )
        return payload

    base_stock = int(sku["stock_quantity"])
    rows = []
    for inventory_date in _inclusive_dates(date_from, date_to):
        stock_quantity = _effective_stock_quantity(
            conn, sku, inventory_date=inventory_date
        )
        sellable_status = _effective_sellable_status(
            conn, sku, inventory_date=inventory_date
        )
        reserved_quantity = get_reserved_quantity(
            conn, sku, inventory_date=inventory_date
        )
        sellable_quantity = get_sellable_quantity(
            conn, sku, inventory_date=inventory_date
        )
        rows.append(
            {
                "inventory_date": inventory_date.isoformat(),
                "stock_quantity": stock_quantity,
                "sellable_status": sellable_status,
                "reserved_quantity": reserved_quantity,
                "sellable_quantity": sellable_quantity,
                "low_stock": _is_date_low_stock(
                    base_stock=base_stock,
                    stock_quantity=stock_quantity,
                    sellable_status=sellable_status,
                    sellable_quantity=sellable_quantity,
                    reserved_quantity=reserved_quantity,
                ),
            }
        )

    payload["date_inventory"] = rows
    payload["requested_window_sellable_quantity"] = min(
        row["sellable_quantity"] for row in rows
    )
    return payload


def _recent_duplicate_manual_adjust(
    conn: sqlite3.Connection,
    *,
    sku_id: int,
    owner_id: int,
    delta: int,
    reason: str,
) -> sqlite3.Row | None:
    """Return a recent same-content manual adjustment candidate for confirmation."""

    return conn.execute(
        """
        SELECT *
        FROM inventory_movements
        WHERE movement_type = 'manual_adjust'
          AND sku_id = ?
          AND created_by_owner_id = ?
          AND delta = ?
          AND reason = ?
          AND created_at >= datetime('now', ?)
        ORDER BY id DESC
        LIMIT 1
        """,
        (
            sku_id,
            owner_id,
            delta,
            reason,
            f"-{DUPLICATE_CONFIRM_WINDOW_SECONDS} seconds",
        ),
    ).fetchone()


def adjust_stock(
    conn: sqlite3.Connection,
    *,
    sku: sqlite3.Row,
    owner_id: int,
    actor_external_user_id: str,
    delta: int,
    reason: str,
    operation_id: str,
    confirm_duplicate: bool,
) -> dict[str, Any]:
    """Apply one manual stock change to either quantity or default nightly capacity.

    Args:
        conn: Open SQLite connection used for stock writes and audit logging.
        sku: Target SKU row being adjusted.
        owner_id: Internal owner primary key performing the adjustment.
        actor_external_user_id: Stable external owner identifier for audit rows.
        delta: Signed quantity change to apply.
        reason: Human-readable reason recorded with the movement.
        operation_id: Host-generated request identifier for idempotency.
        confirm_duplicate: Whether the owner confirmed a repeated adjustment.

    Returns:
        Runtime payload describing the adjustment result, idempotent replay, or
        duplicate-confirmation requirement.
    """

    expire_reservations(conn)
    reference_key = build_manual_adjust_reference_key(operation_id, int(sku["id"]))
    existing = conn.execute(
        """
        SELECT *
        FROM inventory_movements
        WHERE movement_type = 'manual_adjust'
          AND sku_id = ?
          AND reference_key = ?
        LIMIT 1
        """,
        (int(sku["id"]), reference_key),
    ).fetchone()
    if existing is not None:
        refreshed = _fetch_sku_by_code(conn, str(sku["sku_code"]))
        return {
            "status": "adjusted",
            "reply": f"Manual stock adjustment for {sku['sku_code']} was already applied.",
            "sku": _show_stock_payload(conn, refreshed),
            "reference_key": reference_key,
            "idempotent_replay": True,
        }

    duplicate = _recent_duplicate_manual_adjust(
        conn,
        sku_id=int(sku["id"]),
        owner_id=owner_id,
        delta=delta,
        reason=reason,
    )
    if duplicate is not None and not confirm_duplicate:
        return {
            "status": "needs_confirmation",
            "reply": (
                "A matching manual stock adjustment was recorded recently. "
                "Confirm if you really want to apply the same change again."
            ),
            "duplicate_check": {
                "sku_code": sku["sku_code"],
                "delta": delta,
                "reason": reason,
                "matched_reference_key": duplicate["reference_key"],
                "matched_created_at": duplicate["created_at"],
                "window_seconds": DUPLICATE_CONFIRM_WINDOW_SECONDS,
            },
        }

    new_stock_quantity = int(sku["stock_quantity"]) + delta
    if new_stock_quantity < 0:
        return _invalid(
            "invalid_input",
            "Stock adjustment would make stock_quantity negative.",
        )

    conn.execute(
        "UPDATE skus SET stock_quantity = ? WHERE id = ?",
        (new_stock_quantity, int(sku["id"])),
    )
    conn.execute(
        """
        INSERT INTO inventory_movements(
            sku_id,
            movement_type,
            delta,
            reason,
            reference_key,
            created_by_owner_id
        ) VALUES (?, 'manual_adjust', ?, ?, ?, ?)
        """,
        (
            int(sku["id"]),
            delta,
            reason,
            reference_key,
            owner_id,
        ),
    )
    _record_audit_event_ignore_duplicates(
        conn,
        event_type="inventory.stock_adjusted",
        actor_type="owner",
        actor_id=actor_external_user_id,
        entity_type="sku",
        entity_id=str(sku["sku_code"]),
        idempotency_key=reference_key,
        payload={
            "inventory_mode": sku["inventory_mode"],
            "delta": delta,
            "reason": reason,
            "resulting_stock_quantity": new_stock_quantity,
        },
    )
    refreshed = _fetch_sku_by_code(conn, str(sku["sku_code"]))
    _sync_low_stock_alerts_for_sku(conn, refreshed)
    conn.commit()
    return {
        "status": "adjusted",
        "reply": f"Stock updated for {sku['sku_code']}.",
        "sku": _show_stock_payload(conn, refreshed),
        "reference_key": reference_key,
    }


def set_date_stock(
    conn: sqlite3.Connection,
    *,
    sku: sqlite3.Row,
    owner_id: int,
    actor_external_user_id: str,
    date_from: date,
    date_to: date,
    stock_quantity: int,
    reason: str,
    operation_id: str,
    sellable_status: str | None,
) -> dict[str, Any]:
    """Write or clear date-specific stock overrides for a date-based SKU.

    Args:
        conn: Open SQLite connection used for override writes and audit logging.
        sku: Target `date_quantity` SKU row being updated.
        owner_id: Internal owner primary key performing the update.
        actor_external_user_id: Stable external owner identifier for audit rows.
        date_from: Inclusive start date of the owner-maintained stock window.
        date_to: Inclusive end date of the owner-maintained stock window.
        stock_quantity: Desired stock value for each expanded date row.
        reason: Human-readable reason recorded with the override update.
        operation_id: Host-generated request identifier for idempotency.
        sellable_status: Optional sellable-status override for each date row.

    Returns:
        Runtime payload describing the updated date-stock window.
    """

    if sku["inventory_mode"] != DATE_INVENTORY_MODE:
        return _invalid(
            "invalid_input",
            "set date stock is only available for SKUs with inventory_mode = date_quantity.",
        )

    expire_reservations(conn)
    days = _inclusive_dates(date_from, date_to)
    for inventory_day in days:
        inventory_day_text = inventory_day.isoformat()
        key = build_set_date_stock_reference_key(
            operation_id, int(sku["id"]), inventory_day
        )
        if stock_quantity == int(sku["stock_quantity"]) and sellable_status is None:
            conn.execute(
                """
                DELETE FROM sku_date_overrides
                WHERE sku_id = ? AND inventory_date = ?
                """,
                (int(sku["id"]), inventory_day_text),
            )
        else:
            conn.execute(
                """
                INSERT INTO sku_date_overrides(
                    sku_id,
                    inventory_date,
                    stock_quantity_override,
                    sellable_status_override,
                    reason,
                    created_by_owner_id
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(sku_id, inventory_date) DO UPDATE SET
                    stock_quantity_override = excluded.stock_quantity_override,
                    sellable_status_override = excluded.sellable_status_override,
                    reason = excluded.reason,
                    created_by_owner_id = excluded.created_by_owner_id
                """,
                (
                    int(sku["id"]),
                    inventory_day_text,
                    stock_quantity,
                    sellable_status,
                    reason,
                    owner_id,
                ),
            )
        _record_audit_event_ignore_duplicates(
            conn,
            event_type="inventory.date_stock_set",
            actor_type="owner",
            actor_id=actor_external_user_id,
            entity_type="sku",
            entity_id=str(sku["sku_code"]),
            idempotency_key=key,
            payload={
                "inventory_date": inventory_day_text,
                "stock_quantity": stock_quantity,
                "sellable_status": sellable_status,
                "reason": reason,
            },
        )

    refreshed = _fetch_sku_by_code(conn, str(sku["sku_code"]))
    _sync_low_stock_alerts_for_sku(conn, refreshed)
    conn.commit()
    return {
        "status": "updated",
        "reply": f"Date stock updated for {sku['sku_code']}.",
        "sku": _show_stock_payload(conn, refreshed, date_from=date_from, date_to=date_to),
        "days_updated": len(days),
    }


def scan_low_stock_alerts(
    conn: sqlite3.Connection,
    *,
    mark_sent: bool,
    days_ahead: int = LOW_STOCK_SCAN_DAYS,
) -> list[dict[str, Any]]:
    """Detect low-stock conditions, then return pending alerts.

    Args:
        conn: Open SQLite connection used for stock reads and alert writes.
        mark_sent: Whether returned pending alerts should be marked as `sent`.
        days_ahead: Future scan window for `date_quantity` alert generation.

    Returns:
        Serialized low-stock alert rows that were pending at scan time.
    """

    expire_reservations(conn)
    skus = conn.execute(
        """
        SELECT *
        FROM skus
        ORDER BY id
        """
    ).fetchall()
    for sku in skus:
        _sync_low_stock_alerts_for_sku(conn, sku, days_ahead=days_ahead)

    pending = conn.execute(
        """
        SELECT alerts.*, skus.sku_code, skus.title
        FROM low_stock_alerts AS alerts
        JOIN skus ON skus.id = alerts.sku_id
        WHERE alerts.status = 'pending'
        ORDER BY alerts.detected_at, alerts.id
        """
    ).fetchall()
    if mark_sent and pending:
        conn.executemany(
            """
            UPDATE low_stock_alerts
            SET status = 'sent',
                sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP)
            WHERE id = ?
            """,
            [(int(row["id"]),) for row in pending],
        )
    conn.commit()
    return [
        {
            "sku_code": row["sku_code"],
            "title": row["title"],
            "inventory_mode": row["inventory_mode"],
            "inventory_date": row["inventory_date"],
            "threshold": int(row["threshold"]),
            "sellable_quantity": int(row["sellable_quantity"]),
            "status": "sent" if mark_sent else row["status"],
        }
        for row in pending
    ]


def get_customer_availability(
    conn: sqlite3.Connection,
    sku: sqlite3.Row,
    *,
    check_in_date: date | None = None,
    check_out_date: date | None = None,
) -> dict[str, Any]:
    """Return customer-facing availability status and hint for one SKU.

    Args:
        conn: Open SQLite connection used for stock and date-override reads.
        sku: SKU row being presented to a customer.
        check_in_date: Optional hotel check-in date for exact room availability.
        check_out_date: Optional hotel check-out date for exact room availability.

    Returns:
        Availability payload containing a stable status and optional user-facing
        hint string.

    Raises:
        ValueError: If only one of `check_in_date` or `check_out_date` is
            provided.
    """

    if sku["sellable_status"] != "active":
        return {"availability_status": "hidden", "availability_hint": None}

    if sku["inventory_mode"] == QUANTITY_INVENTORY_MODE:
        sellable_quantity = get_sellable_quantity(conn, sku)
        if sellable_quantity <= 0:
            return {
                "availability_status": "unavailable",
                "availability_hint": "Currently unavailable.",
            }
        if sellable_quantity <= LOW_STOCK_THRESHOLD:
            return {
                "availability_status": "only_a_few_left",
                "availability_hint": "Only a few left.",
            }
        return {
            "availability_status": "available",
            "availability_hint": "Available now.",
        }

    if (check_in_date is None) != (check_out_date is None):
        raise ValueError(
            "params.check_in_date and params.check_out_date must be provided together"
        )

    if check_in_date is None or check_out_date is None:
        return {
            "availability_status": "dates_required",
            "availability_hint": (
                "Provide check-in and check-out dates to confirm exact availability."
            ),
        }

    nightly_rows = [
        get_sellable_quantity(conn, sku, inventory_date=inventory_day)
        for inventory_day in _stay_dates(check_in_date, check_out_date)
    ]
    sellable_quantity = min(nightly_rows) if nightly_rows else 0
    if sellable_quantity <= 0:
        return {
            "availability_status": "unavailable",
            "availability_hint": "Unavailable for the requested stay dates.",
        }
    if sellable_quantity <= LOW_STOCK_THRESHOLD:
        return {
            "availability_status": "only_a_few_left",
            "availability_hint": "Only a few left for the requested stay dates.",
        }
    return {
        "availability_status": "available",
        "availability_hint": "Available for the requested stay dates.",
    }


def reserve_order_items(conn: sqlite3.Connection, *, order_id: int) -> int:
    """Write reservation movements for one pending-payment order."""

    inserted = 0
    for item in _fetch_order_inventory_rows(conn, order_id=order_id):
        inserted += _insert_order_movement(
            conn,
            action="reserve",
            order_id=order_id,
            item=item,
            reason="pending_payment",
        )
    return inserted


def release_order_reservation(conn: sqlite3.Connection, *, order_id: int, reason: str) -> int:
    """Write release movements for one order and refresh affected low-stock rows."""

    inserted = 0
    for item in _fetch_order_inventory_rows(conn, order_id=order_id):
        inserted += _insert_order_movement(
            conn,
            action="release",
            order_id=order_id,
            item=item,
            reason=reason,
        )
    return inserted


def commit_order_reservation(
    conn: sqlite3.Connection, *, order_id: int, payment_reference: str
) -> dict[str, int]:
    """Commit one order's reservation into inventory history and stock snapshots."""

    movement_count = 0
    quantity_stock_updates = 0
    for item in _fetch_order_inventory_rows(conn, order_id=order_id):
        movement_count += _insert_order_movement(
            conn,
            action="commit",
            order_id=order_id,
            item=item,
            reason="payment_captured",
            payment_reference=payment_reference,
        )
        if item["inventory_mode"] == QUANTITY_INVENTORY_MODE:
            sku = _fetch_sku_by_id(conn, int(item["sku_id"]))
            assert sku is not None
            current_stock_quantity = int(sku["stock_quantity"])
            item_quantity = int(item["quantity"])
            if current_stock_quantity < item_quantity:
                raise ValueError(
                    f"SKU {sku['sku_code']} no longer has enough on-hand stock to commit."
                )
            conn.execute(
                """
                UPDATE skus
                SET stock_quantity = stock_quantity - ?
                WHERE id = ?
                """,
                (item_quantity, int(item["sku_id"])),
            )
            quantity_stock_updates += 1
        elif item["inventory_mode"] == DATE_INVENTORY_MODE:
            for inventory_date in _movement_dates_for_item(item):
                _apply_date_override_delta(
                    conn,
                    sku_id=int(item["sku_id"]),
                    inventory_date=inventory_date,
                    delta=-int(item["quantity"]),
                    reason="system_commit",
                )
    return {
        "movement_count": movement_count,
        "quantity_stock_updates": quantity_stock_updates,
    }


def restock_refunded_order(
    conn: sqlite3.Connection, *, order_id: int, refund_reference: str
) -> dict[str, int]:
    """Restock refundable order items and record refund movements."""

    movement_count = 0
    quantity_stock_updates = 0
    for item in _fetch_order_inventory_rows(conn, order_id=order_id):
        if not bool(item["restock_on_refund"]):
            continue
        movement_count += _insert_order_movement(
            conn,
            action="refund_restock",
            order_id=order_id,
            item=item,
            reason="refund",
            refund_reference=refund_reference,
        )
        if item["inventory_mode"] == QUANTITY_INVENTORY_MODE:
            conn.execute(
                """
                UPDATE skus
                SET stock_quantity = stock_quantity + ?
                WHERE id = ?
                """,
                (int(item["quantity"]), int(item["sku_id"])),
            )
            quantity_stock_updates += 1
        elif item["inventory_mode"] == DATE_INVENTORY_MODE:
            for inventory_date in _movement_dates_for_item(item):
                _apply_date_override_delta(
                    conn,
                    sku_id=int(item["sku_id"]),
                    inventory_date=inventory_date,
                    delta=int(item["quantity"]),
                    reason="system_refund_restock",
                )
    return {
        "movement_count": movement_count,
        "quantity_stock_updates": quantity_stock_updates,
    }


def _show_inventory(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return the owner-facing inventory list."""

    rows = list_inventory_rows(conn)
    return {
        "status": "listed",
        "reply": f"Loaded {len(rows)} inventory row(s).",
        "inventory_rows": rows,
    }


def _show_stock(conn: sqlite3.Connection, *, params: dict[str, Any]) -> dict[str, Any]:
    """Return owner-facing stock details for one SKU."""

    sku_code = _normalize_text(params.get("sku_code"), "params.sku_code").upper()
    sku = _fetch_sku_by_code(conn, sku_code)
    if sku is None:
        return _invalid("not_found", f"SKU {sku_code} was not found.")

    date_from = date_to = None
    if "date_from" in params or "date_to" in params:
        date_from = _parse_date(params.get("date_from"), "params.date_from")
        date_to = _parse_date(params.get("date_to"), "params.date_to")

    return {
        "status": "found",
        "reply": f"Loaded stock view for {sku_code}.",
        "sku": _show_stock_payload(conn, sku, date_from=date_from, date_to=date_to),
    }


def _show_low_stock(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return owner-facing active low-stock rows after refreshing conditions."""

    expire_reservations(conn)
    skus = conn.execute(
        """
        SELECT *
        FROM skus
        ORDER BY id
        """
    ).fetchall()
    for sku in skus:
        _sync_low_stock_alerts_for_sku(conn, sku)
    conn.commit()

    rows = conn.execute(
        """
        SELECT alerts.*, skus.sku_code, skus.title
        FROM low_stock_alerts AS alerts
        JOIN skus ON skus.id = alerts.sku_id
        WHERE alerts.status IN ('pending', 'sent')
        ORDER BY skus.sku_code ASC, alerts.inventory_date ASC, alerts.id ASC
        """
    ).fetchall()
    return {
        "status": "listed",
        "reply": f"Loaded {len(rows)} low-stock row(s).",
        "low_stock_rows": [
            {
                "sku_code": row["sku_code"],
                "title": row["title"],
                "inventory_mode": row["inventory_mode"],
                "inventory_date": row["inventory_date"],
                "threshold": int(row["threshold"]),
                "sellable_quantity": int(row["sellable_quantity"]),
                "alert_status": row["status"],
            }
            for row in rows
        ],
    }


def handle_inventory(context: dict[str, Any]) -> dict[str, Any]:
    """Handle owner inventory intents using normalized host context.

    Args:
        context: Host-normalized payload containing `channel`, `command_code`,
            `user`, and optional `params`.

    Returns:
        JSON-serializable runtime response for the requested inventory command.
    """

    command_code = str(context.get("command_code") or "").strip().lower()
    if command_code not in INVENTORY_INTENTS:
        return _invalid("invalid_intent", f"Unsupported inventory intent: {command_code}")

    user = context.get("user") or {}
    params = context.get("params")
    channel = str(context.get("channel") or "telegram").strip() or "telegram"
    external_user_id = str(user.get("external_user_id") or "").strip()
    if not external_user_id:
        return _invalid("invalid_input", "user.external_user_id is required")

    try:
        normalized_params = _require_params_mapping(params)
    except ValueError as exc:
        return _invalid("invalid_input", str(exc))

    runtime = context.get("runtime") or {}
    db_path = str(runtime.get("db_path") or DEFAULT_DB_PATH)
    with closing(ensure_database(db_path)) as conn:
        owner = _fetch_active_owner(
            conn, channel=channel, external_user_id=external_user_id
        )
        if owner is None:
            return _invalid(
                "forbidden",
                "Only the active owner can perform this inventory action.",
            )

        try:
            if command_code == "inventory.show_inventory":
                return _show_inventory(conn)
            if command_code == "inventory.show_stock":
                return _show_stock(conn, params=normalized_params)
            if command_code == "inventory.show_low_stock":
                return _show_low_stock(conn)
            if command_code == "inventory.adjust_stock":
                sku_code = _normalize_text(
                    normalized_params.get("sku_code"), "params.sku_code"
                ).upper()
                sku = _fetch_sku_by_code(conn, sku_code)
                if sku is None:
                    return _invalid("not_found", f"SKU {sku_code} was not found.")
                delta = _coerce_int(normalized_params.get("delta"), "params.delta")
                reason = _normalize_text(normalized_params.get("reason"), "params.reason")
                operation_id = _normalize_text(
                    normalized_params.get("operation_id"), "params.operation_id"
                )
                confirm_duplicate = _coerce_bool(
                    normalized_params.get("confirm_duplicate"),
                    "params.confirm_duplicate",
                )
                return adjust_stock(
                    conn,
                    sku=sku,
                    owner_id=int(owner["id"]),
                    actor_external_user_id=external_user_id,
                    delta=delta,
                    reason=reason,
                    operation_id=operation_id,
                    confirm_duplicate=confirm_duplicate,
                )
            if command_code == "inventory.set_date_stock":
                sku_code = _normalize_text(
                    normalized_params.get("sku_code"), "params.sku_code"
                ).upper()
                sku = _fetch_sku_by_code(conn, sku_code)
                if sku is None:
                    return _invalid("not_found", f"SKU {sku_code} was not found.")
                date_from = _parse_date(
                    normalized_params.get("date_from"), "params.date_from"
                )
                date_to = _parse_date(normalized_params.get("date_to"), "params.date_to")
                stock_quantity = _coerce_non_negative_int(
                    normalized_params.get("stock_quantity"), "params.stock_quantity"
                )
                reason = _normalize_text(normalized_params.get("reason"), "params.reason")
                operation_id = _normalize_text(
                    normalized_params.get("operation_id"), "params.operation_id"
                )
                sellable_status = _optional_text(normalized_params.get("sellable_status"))
                if sellable_status is not None and sellable_status not in {"active", "unavailable"}:
                    raise ValueError(
                        "params.sellable_status must be one of: active, unavailable"
                    )
                return set_date_stock(
                    conn,
                    sku=sku,
                    owner_id=int(owner["id"]),
                    actor_external_user_id=external_user_id,
                    date_from=date_from,
                    date_to=date_to,
                    stock_quantity=stock_quantity,
                    reason=reason,
                    operation_id=operation_id,
                    sellable_status=sellable_status,
                )
        except ValueError as exc:
            return _invalid("invalid_input", str(exc))
        except sqlite3.IntegrityError as exc:
            if "inventory_movements" in str(exc):
                return _invalid("conflict", "Inventory movement reference key already exists.")
            raise

    return _invalid("invalid_intent", f"Unsupported inventory intent: {command_code}")
