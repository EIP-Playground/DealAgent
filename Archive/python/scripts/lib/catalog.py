"""Catalog skill runtime for owner-side SKU management in v1.

This module implements catalog Phase A: owner CRUD for SKUs, safe inventory-mode
switching, owner catalog reads, and customer-facing catalog output backed by
inventory availability helpers.
"""

from __future__ import annotations

import re
import sqlite3
from contextlib import closing
from datetime import date
from pathlib import Path
from typing import Any

from scripts.db.sqlite import DEFAULT_DB_PATH, ensure_database, record_audit_event
from scripts.lib.inventory import get_customer_availability
from scripts.lib.money import format_minor_amount, validate_supported_currency


CATALOG_INTENTS = {
    "catalog.add_sku",
    "catalog.update_details",
    "catalog.update_inventory_mode",
    "catalog.update_price",
    "catalog.update_status",
    "catalog.archive_sku",
    "catalog.show_sku",
    "catalog.show_catalog",
    "catalog.show_product",
}
OWNER_ONLY_INTENTS = {
    "catalog.add_sku",
    "catalog.update_details",
    "catalog.update_inventory_mode",
    "catalog.update_price",
    "catalog.update_status",
    "catalog.archive_sku",
    "catalog.show_sku",
}
SKU_CODE_PATTERN = re.compile(r"^[A-Z0-9_-]{1,30}$")
ACTIVE_STATUS_VALUES = {"active", "unavailable"}
INVENTORY_MODE_VALUES = {"quantity", "date_quantity"}
OUTPUT_SKU_FIELDS = (
    "sku_code",
    "title",
    "description",
    "price_minor",
    "currency",
    "inventory_mode",
    "stock_quantity",
    "sellable_status",
    "media_url",
    "product_url",
    "restock_on_refund",
    "archived_at",
    "created_at",
    "updated_at",
)


def _invalid(status: str, reply: str) -> dict[str, Any]:
    """Build a stable JSON error payload for catalog runtime responses."""

    return {"status": status, "reply": reply}


def _normalize_text(value: object, field_name: str) -> str:
    """Normalize a required text field and reject blank values."""

    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def _optional_text(value: object) -> str | None:
    """Normalize an optional text field into stripped text or `None`."""

    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _require_params_mapping(params: object) -> dict[str, Any]:
    """Validate the shared `params` container introduced for catalog runtime."""

    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    return dict(params)


def _coerce_non_negative_int(value: object, field_name: str) -> int:
    """Coerce a JSON value into a non-negative integer field."""

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

    if number < 0:
        raise ValueError(f"{field_name} must be non-negative")
    return number


def _coerce_refund_flag(value: object) -> int:
    """Normalize the SKU refund-restock flag into SQLite-friendly `0` or `1`."""

    if value is None:
        return 1
    if value in (True, 1, "1", "true", "True"):
        return 1
    if value in (False, 0, "0", "false", "False"):
        return 0
    raise ValueError(
        "params.restock_on_refund must be a boolean or one of 0/1/true/false"
    )


def _validate_sku_code(value: object) -> str:
    """Validate the external SKU identifier used by all catalog operations."""

    sku_code = _normalize_text(value, "params.sku_code").upper()
    if not SKU_CODE_PATTERN.match(sku_code):
        raise ValueError(
            "params.sku_code must use only uppercase letters, digits, '-' or '_' and be <= 30 chars"
        )
    return sku_code


def _validate_status(value: object, *, allow_archived: bool = False) -> str:
    """Validate SKU sellable status transitions for catalog writes."""

    status = _normalize_text(value, "params.sellable_status").lower()
    allowed = ACTIVE_STATUS_VALUES | ({"archived"} if allow_archived else set())
    if status not in allowed:
        allowed_text = ", ".join(sorted(allowed))
        raise ValueError(f"params.sellable_status must be one of: {allowed_text}")
    return status


def _validate_inventory_mode(value: object | None) -> str:
    """Validate the SKU inventory mode, defaulting omitted values to quantity."""

    if value is None:
        return "quantity"
    inventory_mode = _normalize_text(value, "params.inventory_mode").lower()
    if inventory_mode not in INVENTORY_MODE_VALUES:
        allowed_text = ", ".join(sorted(INVENTORY_MODE_VALUES))
        raise ValueError(f"params.inventory_mode must be one of: {allowed_text}")
    return inventory_mode


def _stock_quantity_semantics(inventory_mode: str) -> str:
    """Describe how owner-facing stock_quantity should be interpreted."""

    if inventory_mode == "date_quantity":
        return "default_nightly_capacity"
    return "on_hand_quantity"


def _reject_inventory_mode_change(params: dict[str, Any]) -> None:
    """Reject attempts to mutate immutable inventory mode after creation."""

    if "inventory_mode" in params:
        raise ValueError(
            "params.inventory_mode can only be set during add sku and cannot be changed later"
        )


def _parse_optional_customer_dates(params: dict[str, Any]) -> tuple[date | None, date | None]:
    """Parse optional customer-facing hotel stay dates from params."""

    check_in = _optional_text(params.get("check_in_date"))
    check_out = _optional_text(params.get("check_out_date"))
    if bool(check_in) != bool(check_out):
        raise ValueError(
            "params.check_in_date and params.check_out_date must be provided together"
        )
    if not check_in or not check_out:
        return None, None
    try:
        return date.fromisoformat(check_in), date.fromisoformat(check_out)
    except ValueError as exc:
        raise ValueError(
            "params.check_in_date and params.check_out_date must be ISO dates like YYYY-MM-DD"
        ) from exc


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


def _fetch_sku(conn: sqlite3.Connection, sku_code: str) -> sqlite3.Row | None:
    """Return a SKU row by `sku_code`, or `None` if no record exists."""

    return conn.execute(
        "SELECT * FROM skus WHERE sku_code = ? LIMIT 1",
        (sku_code,),
    ).fetchone()


def _serialize_sku(row: sqlite3.Row) -> dict[str, Any]:
    """Convert a SKU row into the structured payload returned by runtime."""

    payload = {field: row[field] for field in OUTPUT_SKU_FIELDS}
    payload["display_price"] = format_minor_amount(row["price_minor"], row["currency"])
    payload["stock_quantity_semantics"] = _stock_quantity_semantics(
        row["inventory_mode"]
    )
    return payload


def _record_catalog_audit(
    conn: sqlite3.Connection,
    *,
    event_type: str,
    actor_external_user_id: str,
    sku_code: str,
    payload: dict[str, Any],
) -> None:
    """Persist catalog-specific audit rows using the shared audit helper."""

    record_audit_event(
        conn,
        event_type=event_type,
        actor_type="owner",
        actor_id=actor_external_user_id,
        entity_type="sku",
        entity_id=sku_code,
        payload=payload,
    )


def _inventory_mode_switch_blockers(
    conn: sqlite3.Connection, *, sku_id: int
) -> list[str]:
    """Return concrete reasons why a SKU can no longer safely switch mode."""

    blockers: list[str] = []
    movement_count = conn.execute(
        "SELECT COUNT(*) FROM inventory_movements WHERE sku_id = ?",
        (sku_id,),
    ).fetchone()[0]
    if movement_count:
        blockers.append("inventory_movements")

    order_item_count = conn.execute(
        "SELECT COUNT(*) FROM order_items WHERE sku_id = ?",
        (sku_id,),
    ).fetchone()[0]
    if order_item_count:
        blockers.append("order_items")

    override_count = conn.execute(
        "SELECT COUNT(*) FROM sku_date_overrides WHERE sku_id = ?",
        (sku_id,),
    ).fetchone()[0]
    if override_count:
        blockers.append("sku_date_overrides")

    return blockers


def _serialize_customer_sku(
    conn: sqlite3.Connection,
    sku: sqlite3.Row,
    *,
    check_in_date: date | None = None,
    check_out_date: date | None = None,
) -> dict[str, Any]:
    """Serialize a customer-facing product row with availability metadata."""

    payload = {
        "sku_code": sku["sku_code"],
        "title": sku["title"],
        "description": sku["description"],
        "price_minor": sku["price_minor"],
        "currency": sku["currency"],
        "display_price": format_minor_amount(sku["price_minor"], sku["currency"]),
        "inventory_mode": sku["inventory_mode"],
        "media_url": sku["media_url"],
        "product_url": sku["product_url"],
    }
    payload.update(
        get_customer_availability(
            conn,
            sku,
            check_in_date=check_in_date,
            check_out_date=check_out_date,
        )
    )
    if check_in_date and check_out_date:
        payload["check_in_date"] = check_in_date.isoformat()
        payload["check_out_date"] = check_out_date.isoformat()
    return payload


def _add_sku(
    conn: sqlite3.Connection,
    *,
    params: dict[str, Any],
    owner_id: int,
    actor_external_user_id: str,
) -> dict[str, Any]:
    """Create a new SKU row and emit the corresponding audit event."""

    sku_code = _validate_sku_code(params.get("sku_code"))
    title = _normalize_text(params.get("title"), "params.title")
    price_minor = _coerce_non_negative_int(params.get("price_minor"), "params.price_minor")
    currency = validate_supported_currency(params.get("currency"))
    inventory_mode = _validate_inventory_mode(params.get("inventory_mode"))
    sellable_status = _validate_status(params.get("sellable_status", "active"))
    stock_quantity = _coerce_non_negative_int(
        params.get("stock_quantity", 0), "params.stock_quantity"
    )
    restock_on_refund = _coerce_refund_flag(params.get("restock_on_refund"))
    description = _optional_text(params.get("description"))
    media_url = _optional_text(params.get("media_url"))
    product_url = _optional_text(params.get("product_url"))

    existing = _fetch_sku(conn, sku_code)
    if existing is not None:
        return _invalid("conflict", f"SKU {sku_code} already exists.")

    cursor = conn.execute(
        """
        INSERT INTO skus(
            sku_code,
            title,
            description,
            price_minor,
            currency,
            inventory_mode,
            stock_quantity,
            sellable_status,
            media_url,
            product_url,
            restock_on_refund,
            created_by_owner_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sku_code,
            title,
            description,
            price_minor,
            currency,
            inventory_mode,
            stock_quantity,
            sellable_status,
            media_url,
            product_url,
            restock_on_refund,
            owner_id,
        ),
    )
    created = conn.execute(
        "SELECT * FROM skus WHERE id = ? LIMIT 1",
        (cursor.lastrowid,),
    ).fetchone()
    _record_catalog_audit(
        conn,
        event_type="catalog.sku_created",
        actor_external_user_id=actor_external_user_id,
        sku_code=sku_code,
        payload={
            "title": title,
            "currency": currency,
            "inventory_mode": inventory_mode,
            "price_minor": price_minor,
            "stock_quantity": stock_quantity,
            "sellable_status": sellable_status,
        },
    )
    conn.commit()
    return {
        "status": "created",
        "reply": f"SKU {sku_code} created successfully.",
        "audit_event_type": "catalog.sku_created",
        "sku": _serialize_sku(created),
    }


def _update_details(
    conn: sqlite3.Connection,
    *,
    params: dict[str, Any],
    actor_external_user_id: str,
) -> dict[str, Any]:
    """Update title/description/link metadata for a single SKU."""

    _reject_inventory_mode_change(params)
    sku_code = _validate_sku_code(params.get("sku_code"))
    sku = _fetch_sku(conn, sku_code)
    if sku is None:
        return _invalid("not_found", f"SKU {sku_code} was not found.")

    changes: dict[str, Any] = {}
    for field in ("title", "description", "media_url", "product_url"):
        if field in params:
            if field == "title":
                changes[field] = _normalize_text(params.get(field), f"params.{field}")
            else:
                changes[field] = _optional_text(params.get(field))

    if not changes:
        return _invalid(
            "invalid_input",
            "update details requires at least one of title, description, media_url, or product_url.",
        )

    assignments = ", ".join(f"{field} = ?" for field in changes)
    conn.execute(
        f"UPDATE skus SET {assignments} WHERE sku_code = ?",
        (*changes.values(), sku_code),
    )
    updated = _fetch_sku(conn, sku_code)
    _record_catalog_audit(
        conn,
        event_type="catalog.sku_updated",
        actor_external_user_id=actor_external_user_id,
        sku_code=sku_code,
        payload={"changed_fields": sorted(changes), "change_type": "details"},
    )
    conn.commit()
    return {
        "status": "updated",
        "reply": f"SKU {sku_code} details updated successfully.",
        "audit_event_type": "catalog.sku_updated",
        "sku": _serialize_sku(updated),
    }


def _update_inventory_mode(
    conn: sqlite3.Connection,
    *,
    params: dict[str, Any],
    actor_external_user_id: str,
) -> dict[str, Any]:
    """Safely switch a SKU between quantity and date_quantity modes."""

    sku_code = _validate_sku_code(params.get("sku_code"))
    inventory_mode = _validate_inventory_mode(params.get("inventory_mode"))
    sku = _fetch_sku(conn, sku_code)
    if sku is None:
        return _invalid("not_found", f"SKU {sku_code} was not found.")
    if sku["inventory_mode"] == inventory_mode:
        return {
            "status": "updated",
            "reply": f"SKU {sku_code} already uses inventory_mode={inventory_mode}.",
            "audit_event_type": "catalog.sku_updated",
            "sku": _serialize_sku(sku),
        }

    blockers = _inventory_mode_switch_blockers(conn, sku_id=int(sku["id"]))
    if blockers:
        return _invalid(
            "conflict",
            (
                f"SKU {sku_code} can no longer switch inventory_mode because it already has "
                + ", ".join(blockers)
                + "."
            ),
        )

    conn.execute(
        "UPDATE skus SET inventory_mode = ? WHERE sku_code = ?",
        (inventory_mode, sku_code),
    )
    updated = _fetch_sku(conn, sku_code)
    _record_catalog_audit(
        conn,
        event_type="catalog.sku_updated",
        actor_external_user_id=actor_external_user_id,
        sku_code=sku_code,
        payload={
            "changed_fields": ["inventory_mode"],
            "change_type": "inventory_mode",
            "inventory_mode": inventory_mode,
        },
    )
    conn.commit()
    return {
        "status": "updated",
        "reply": f"SKU {sku_code} inventory mode updated to {inventory_mode}.",
        "audit_event_type": "catalog.sku_updated",
        "sku": _serialize_sku(updated),
    }


def _update_price(
    conn: sqlite3.Connection,
    *,
    params: dict[str, Any],
    actor_external_user_id: str,
) -> dict[str, Any]:
    """Update the stored money fields for a SKU."""

    _reject_inventory_mode_change(params)
    sku_code = _validate_sku_code(params.get("sku_code"))
    sku = _fetch_sku(conn, sku_code)
    if sku is None:
        return _invalid("not_found", f"SKU {sku_code} was not found.")

    price_minor = _coerce_non_negative_int(params.get("price_minor"), "params.price_minor")
    currency = validate_supported_currency(params.get("currency"))
    conn.execute(
        """
        UPDATE skus
        SET price_minor = ?, currency = ?
        WHERE sku_code = ?
        """,
        (price_minor, currency, sku_code),
    )
    updated = _fetch_sku(conn, sku_code)
    _record_catalog_audit(
        conn,
        event_type="catalog.sku_updated",
        actor_external_user_id=actor_external_user_id,
        sku_code=sku_code,
        payload={
            "changed_fields": ["currency", "price_minor"],
            "change_type": "price",
            "price_minor": price_minor,
            "currency": currency,
        },
    )
    conn.commit()
    return {
        "status": "updated",
        "reply": f"SKU {sku_code} price updated successfully.",
        "audit_event_type": "catalog.sku_updated",
        "sku": _serialize_sku(updated),
    }


def _update_status(
    conn: sqlite3.Connection,
    *,
    params: dict[str, Any],
    actor_external_user_id: str,
) -> dict[str, Any]:
    """Update a SKU between the active and unavailable sellable states."""

    _reject_inventory_mode_change(params)
    sku_code = _validate_sku_code(params.get("sku_code"))
    sku = _fetch_sku(conn, sku_code)
    if sku is None:
        return _invalid("not_found", f"SKU {sku_code} was not found.")

    sellable_status = _validate_status(params.get("sellable_status"))
    archived_at = None if sellable_status in ACTIVE_STATUS_VALUES else sku["archived_at"]
    conn.execute(
        """
        UPDATE skus
        SET sellable_status = ?, archived_at = ?
        WHERE sku_code = ?
        """,
        (sellable_status, archived_at, sku_code),
    )
    updated = _fetch_sku(conn, sku_code)
    _record_catalog_audit(
        conn,
        event_type="catalog.sku_updated",
        actor_external_user_id=actor_external_user_id,
        sku_code=sku_code,
        payload={
            "changed_fields": ["sellable_status"],
            "change_type": "status",
            "sellable_status": sellable_status,
        },
    )
    conn.commit()
    return {
        "status": "updated",
        "reply": f"SKU {sku_code} status updated to {sellable_status}.",
        "audit_event_type": "catalog.sku_updated",
        "sku": _serialize_sku(updated),
    }


def _archive_sku(
    conn: sqlite3.Connection,
    *,
    params: dict[str, Any],
    actor_external_user_id: str,
) -> dict[str, Any]:
    """Soft-archive a SKU without deleting its row or releasing its code."""

    _reject_inventory_mode_change(params)
    sku_code = _validate_sku_code(params.get("sku_code"))
    sku = _fetch_sku(conn, sku_code)
    if sku is None:
        return _invalid("not_found", f"SKU {sku_code} was not found.")

    if sku["sellable_status"] != "archived":
        conn.execute(
            """
            UPDATE skus
            SET sellable_status = 'archived',
                archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)
            WHERE sku_code = ?
            """,
            (sku_code,),
        )
        _record_catalog_audit(
            conn,
            event_type="catalog.sku_archived",
            actor_external_user_id=actor_external_user_id,
            sku_code=sku_code,
            payload={"change_type": "archive"},
        )
        conn.commit()

    archived = _fetch_sku(conn, sku_code)
    return {
        "status": "archived",
        "reply": f"SKU {sku_code} archived successfully.",
        "audit_event_type": "catalog.sku_archived",
        "sku": _serialize_sku(archived),
    }


def _show_sku(conn: sqlite3.Connection, *, params: dict[str, Any]) -> dict[str, Any]:
    """Return a single SKU for owner-side inspection."""

    sku_code = _validate_sku_code(params.get("sku_code"))
    sku = _fetch_sku(conn, sku_code)
    if sku is None:
        return _invalid("not_found", f"SKU {sku_code} was not found.")
    return {
        "status": "found",
        "reply": f"SKU {sku_code} loaded successfully.",
        "sku": _serialize_sku(sku),
    }


def _show_catalog(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return the owner-side SKU catalog, including archived rows."""

    rows = conn.execute(
        """
        SELECT *
        FROM skus
        ORDER BY created_at DESC, sku_code ASC
        """
    ).fetchall()
    return {
        "status": "listed",
        "reply": f"Loaded {len(rows)} SKU(s).",
        "skus": [_serialize_sku(row) for row in rows],
    }


def _show_customer_catalog(
    conn: sqlite3.Connection, *, params: dict[str, Any]
) -> dict[str, Any]:
    """Return customer-facing catalog rows with inventory-backed availability."""

    check_in_date, check_out_date = _parse_optional_customer_dates(params)
    rows = conn.execute(
        """
        SELECT *
        FROM skus
        WHERE sellable_status = 'active'
        ORDER BY created_at DESC, sku_code ASC
        """
    ).fetchall()
    return {
        "status": "listed",
        "reply": f"Loaded {len(rows)} customer-visible SKU(s).",
        "skus": [
            _serialize_customer_sku(
                conn,
                row,
                check_in_date=check_in_date,
                check_out_date=check_out_date,
            )
            for row in rows
        ],
    }


def _show_customer_product(
    conn: sqlite3.Connection, *, params: dict[str, Any]
) -> dict[str, Any]:
    """Return one customer-facing product payload with availability."""

    sku_code = _validate_sku_code(params.get("sku_code"))
    sku = _fetch_sku(conn, sku_code)
    if sku is None or sku["sellable_status"] != "active":
        return _invalid("not_found", f"SKU {sku_code} is not available.")

    check_in_date, check_out_date = _parse_optional_customer_dates(params)
    return {
        "status": "found",
        "reply": f"Loaded customer product view for {sku_code}.",
        "sku": _serialize_customer_sku(
            conn,
            sku,
            check_in_date=check_in_date,
            check_out_date=check_out_date,
        ),
    }


def handle_catalog(context: dict[str, Any]) -> dict[str, Any]:
    """Handle owner-side catalog intents using normalized host context.

    Args:
        context: Host-normalized payload containing `channel`, `command_code`,
            `user`, and catalog-specific `params`.

    Returns:
        JSON-serializable result describing the catalog action outcome.
    """

    command_code = str(context.get("command_code") or "").strip().lower()
    if command_code not in CATALOG_INTENTS:
        return _invalid("invalid_intent", f"Unsupported catalog intent: {command_code}")

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
            conn,
            channel=channel,
            external_user_id=external_user_id,
        )

        if owner is None and command_code in OWNER_ONLY_INTENTS:
            return _invalid(
                "forbidden",
                "Only the active owner can perform this catalog action.",
            )

        try:
            if command_code == "catalog.add_sku":
                return _add_sku(
                    conn,
                    params=normalized_params,
                    owner_id=int(owner["id"]),
                    actor_external_user_id=external_user_id,
                )
            if command_code == "catalog.update_details":
                return _update_details(
                    conn,
                    params=normalized_params,
                    actor_external_user_id=external_user_id,
                )
            if command_code == "catalog.update_inventory_mode":
                return _update_inventory_mode(
                    conn,
                    params=normalized_params,
                    actor_external_user_id=external_user_id,
                )
            if command_code == "catalog.update_price":
                return _update_price(
                    conn,
                    params=normalized_params,
                    actor_external_user_id=external_user_id,
                )
            if command_code == "catalog.update_status":
                return _update_status(
                    conn,
                    params=normalized_params,
                    actor_external_user_id=external_user_id,
                )
            if command_code == "catalog.archive_sku":
                return _archive_sku(
                    conn,
                    params=normalized_params,
                    actor_external_user_id=external_user_id,
                )
            if command_code == "catalog.show_sku":
                return _show_sku(conn, params=normalized_params)
            if command_code == "catalog.show_catalog":
                if owner is None:
                    return _show_customer_catalog(conn, params=normalized_params)
                return _show_catalog(conn)
            if command_code == "catalog.show_product":
                if owner is None:
                    return _show_customer_product(conn, params=normalized_params)
                return _show_sku(conn, params=normalized_params)
        except ValueError as exc:
            return _invalid("invalid_input", str(exc))
        except sqlite3.IntegrityError as exc:
            if "sku_code" in str(exc).lower():
                return _invalid("conflict", "SKU code already exists.")
            raise

    return _invalid("invalid_intent", f"Unsupported catalog intent: {command_code}")
