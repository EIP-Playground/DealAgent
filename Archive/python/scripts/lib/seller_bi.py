"""Seller BI runtime for owner-facing metrics over orders and payments.

This module implements the first executable Seller BI slice for Purr Suite v1.
It exposes two owner-only read commands, both anchored by an explicit host
provided date so demo playback and integration tests stay deterministic.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import date, timedelta
from typing import Any

from scripts.db.sqlite import DEFAULT_DB_PATH, ensure_database
from scripts.lib.money import format_minor_amount


COMMAND_ALIASES = {
    "seller-bi.sales_today": "seller_bi.sales_today",
    "seller-bi.revenue_this_month": "seller_bi.revenue_this_month",
}
SELLER_BI_COMMANDS = {
    "seller_bi.sales_today",
    "seller_bi.revenue_this_month",
}
SALES_COUNTABLE_ORDER_STATUSES = ("paid", "refunded", "fulfilled")


def _invalid(status: str, reply: str) -> dict[str, Any]:
    """Return a stable seller-bi runtime error payload."""

    return {"status": status, "reply": reply}


def _normalize_text(value: object, field_name: str) -> str:
    """Normalize one required text field and reject blank values."""

    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def _require_params_mapping(params: object) -> dict[str, Any]:
    """Validate the shared `params` envelope for seller-bi runtime."""

    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    return dict(params)


def _canonical_command_code(value: object) -> str:
    """Normalize runtime command codes and fold supported legacy aliases."""

    normalized = str(value or "").strip().lower()
    return COMMAND_ALIASES.get(normalized, normalized)


def _parse_anchor_date(params: dict[str, Any]) -> date:
    """Parse the host-provided anchor date used for relative metric windows."""

    raw = _normalize_text(params.get("anchor_date"), "params.anchor_date")
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError("params.anchor_date must be an ISO date like YYYY-MM-DD") from exc


def _day_window(anchor_date: date) -> tuple[str, str]:
    """Return the day window as SQLite-compatible timestamp bounds."""

    start = anchor_date.isoformat() + " 00:00:00"
    end = (anchor_date + timedelta(days=1)).isoformat() + " 00:00:00"
    return start, end


def _month_window(anchor_date: date) -> tuple[str, str]:
    """Return the month window as SQLite-compatible timestamp bounds."""

    month_start = anchor_date.replace(day=1)
    if month_start.month == 12:
        next_month_start = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month_start = month_start.replace(month=month_start.month + 1)
    return (
        month_start.isoformat() + " 00:00:00",
        next_month_start.isoformat() + " 00:00:00",
    )


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


def _sales_today(conn: sqlite3.Connection, *, anchor_date: date) -> dict[str, Any]:
    """Count orders that first reached paid state during the anchored day."""

    window_start, window_end_exclusive = _day_window(anchor_date)
    row = conn.execute(
        """
        SELECT COUNT(*) AS sales_count
        FROM orders
        WHERE status IN (?, ?, ?)
          AND paid_at IS NOT NULL
          AND paid_at >= ?
          AND paid_at < ?
        """,
        (
            SALES_COUNTABLE_ORDER_STATUSES[0],
            SALES_COUNTABLE_ORDER_STATUSES[1],
            SALES_COUNTABLE_ORDER_STATUSES[2],
            window_start,
            window_end_exclusive,
        ),
    ).fetchone()
    sales_count = int(row["sales_count"]) if row is not None else 0
    return {
        "status": "computed",
        "reply": f"Sales count for {anchor_date.isoformat()} is {sales_count}.",
        "metric_code": "seller_bi.sales_today",
        "anchor_date": anchor_date.isoformat(),
        "window_start": window_start,
        "window_end_exclusive": window_end_exclusive,
        "sales_count": sales_count,
    }


def _revenue_this_month(conn: sqlite3.Connection, *, anchor_date: date) -> dict[str, Any]:
    """Return net paid revenue for the anchored month, grouped by currency."""

    window_start, window_end_exclusive = _month_window(anchor_date)
    month = anchor_date.strftime("%Y-%m")
    rows = conn.execute(
        """
        SELECT currency, SUM(amount_minor) AS amount_minor
        FROM payments
        WHERE status = 'paid'
          AND paid_at IS NOT NULL
          AND paid_at >= ?
          AND paid_at < ?
        GROUP BY currency
        ORDER BY currency ASC
        """,
        (window_start, window_end_exclusive),
    ).fetchall()
    revenue_rows = [
        {
            "currency": str(row["currency"]),
            "amount_minor": int(row["amount_minor"]),
            "display_amount": format_minor_amount(
                int(row["amount_minor"]),
                str(row["currency"]),
            ),
        }
        for row in rows
    ]
    currency_count = len(revenue_rows)
    if currency_count == 0:
        reply = f"No net paid revenue found for {month}."
    elif currency_count == 1:
        reply = f"Revenue for {month} is {revenue_rows[0]['display_amount']}."
    else:
        reply = f"Revenue for {month} spans {currency_count} currencies."
    return {
        "status": "computed",
        "reply": reply,
        "metric_code": "seller_bi.revenue_this_month",
        "anchor_date": anchor_date.isoformat(),
        "month": month,
        "window_start": window_start,
        "window_end_exclusive": window_end_exclusive,
        "currency_count": currency_count,
        "multi_currency": currency_count > 1,
        "revenue_rows": revenue_rows,
    }


def handle_seller_bi(context: dict[str, Any]) -> dict[str, Any]:
    """Handle normalized seller-bi runtime commands."""

    command_code = _canonical_command_code(context.get("command_code"))
    if command_code not in SELLER_BI_COMMANDS:
        return _invalid("invalid_intent", f"Unsupported seller-bi intent: {command_code}")

    user = context.get("user") or {}
    params = context.get("params")
    channel = str(context.get("channel") or "telegram").strip() or "telegram"
    external_user_id = str(user.get("external_user_id") or "").strip()
    if not external_user_id:
        return _invalid("invalid_input", "user.external_user_id is required")

    try:
        normalized_params = _require_params_mapping(params)
        anchor_date = _parse_anchor_date(normalized_params)
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
                "Only the active owner can query seller-bi metrics.",
            )

        if command_code == "seller_bi.sales_today":
            return _sales_today(conn, anchor_date=anchor_date)
        if command_code == "seller_bi.revenue_this_month":
            return _revenue_this_month(conn, anchor_date=anchor_date)

    return _invalid("invalid_intent", f"Unsupported seller-bi intent: {command_code}")
