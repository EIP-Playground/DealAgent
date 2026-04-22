"""Shared customer identity helpers reused by multiple Purr Suite skills."""

from __future__ import annotations

import json
import sqlite3
from typing import Any


def fetch_customer_by_identity(
    conn: sqlite3.Connection, *, channel: str, external_user_id: str
) -> sqlite3.Row | None:
    """Return one customer row by `(channel, external_user_id)`."""

    return conn.execute(
        """
        SELECT *
        FROM customers
        WHERE channel = ? AND external_user_id = ?
        LIMIT 1
        """,
        (channel, external_user_id),
    ).fetchone()


def fetch_customer_by_id(
    conn: sqlite3.Connection, *, customer_id: int
) -> sqlite3.Row | None:
    """Return one customer row by primary key."""

    return conn.execute(
        "SELECT * FROM customers WHERE id = ? LIMIT 1",
        (customer_id,),
    ).fetchone()


def upsert_customer_identity(
    conn: sqlite3.Connection,
    *,
    channel: str,
    external_user_id: str,
    username: str | None,
) -> sqlite3.Row:
    """Return an existing customer row or create a minimal identity mapping."""

    customer = fetch_customer_by_identity(
        conn,
        channel=channel,
        external_user_id=external_user_id,
    )
    if customer is not None:
        if username and customer["username"] != username:
            conn.execute(
                "UPDATE customers SET username = ? WHERE id = ?",
                (username, int(customer["id"])),
            )
            customer = fetch_customer_by_id(conn, customer_id=int(customer["id"]))
        assert customer is not None
        return customer

    cursor = conn.execute(
        """
        INSERT INTO customers(channel, external_user_id, username)
        VALUES (?, ?, ?)
        """,
        (channel, external_user_id, username),
    )
    customer = fetch_customer_by_id(conn, customer_id=int(cursor.lastrowid))
    assert customer is not None
    return customer


def update_customer_summary(
    conn: sqlite3.Connection,
    *,
    customer_id: int,
    summary_json: dict[str, Any],
) -> sqlite3.Row:
    """Replace one customer's persisted summary JSON object."""

    conn.execute(
        "UPDATE customers SET summary_json = ? WHERE id = ?",
        (
            json.dumps(summary_json, ensure_ascii=False, sort_keys=True),
            customer_id,
        ),
    )
    customer = fetch_customer_by_id(conn, customer_id=customer_id)
    assert customer is not None
    return customer


def decode_customer_summary_json(raw_value: object) -> dict[str, Any] | None:
    """Decode stored customer summary JSON into a dictionary when available."""

    if raw_value is None:
        return None
    try:
        decoded = json.loads(str(raw_value))
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None
