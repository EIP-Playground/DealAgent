"""Inspect an existing local SQLite database and optionally list schema indexes.

This development helper prints table row counts, current business config
values, and optionally the non-system indexes created by the current migration
set. It intentionally avoids running migrations so inspection stays read-only.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.db.sqlite import DEFAULT_DB_PATH


def _list_indexes(conn) -> list[tuple[str, str | None]]:
    """Return visible, non-system indexes for the connected SQLite database.

    Args:
        conn: Open SQLite connection used for schema inspection.

    Returns:
        List of `(index_name, table_name)` tuples ordered by table then name.
    """
    return [
        (row["name"], row["tbl_name"])
        for row in conn.execute(
            """
            SELECT name, tbl_name
            FROM sqlite_master
            WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
            ORDER BY tbl_name, name
            """
        ).fetchall()
    ]


def main() -> None:
    """Parse CLI flags and print a compact database summary.

    Args:
        None. Input comes from command-line flags.

    Returns:
        None. Results are printed to stdout for manual inspection.
    """
    parser = argparse.ArgumentParser(description="Inspect the local SQLite database.")
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help="Path to the SQLite database file.",
    )
    parser.add_argument(
        "--show-indexes",
        action="store_true",
        help="Print non-system indexes after the table summary.",
    )
    parser.add_argument(
        "--show-audit-events",
        action="store_true",
        help="Print the most recent audit_events rows after the summary.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Maximum rows to print for optional detailed sections.",
    )
    args = parser.parse_args()

    db_path = Path(args.db_path)
    if not db_path.exists():
        raise SystemExit(f"Database does not exist: {db_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        tables = [
            row[0]
            for row in conn.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
                """
            )
        ]
        print(f"DB: {db_path}")
        for table in tables:
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(f"{table}: {count}")

        rows = conn.execute(
            "SELECT config_key, config_value_json FROM business_config ORDER BY config_key"
        ).fetchall()
        if rows:
            print("business_config:")
            for row in rows:
                payload = json.loads(row["config_value_json"])
                print(f"- {row['config_key']}: {payload}")

        if args.show_indexes:
            indexes = _list_indexes(conn)
            if indexes:
                print("indexes:")
                for index_name, table_name in indexes:
                    print(f"- {table_name}: {index_name}")

        if args.show_audit_events:
            rows = conn.execute(
                """
                SELECT id, event_type, actor_type, actor_id, entity_type, entity_id, created_at
                FROM audit_events
                ORDER BY id DESC
                LIMIT ?
                """,
                (args.limit,),
            ).fetchall()
            print("audit_events:")
            for row in rows:
                print(
                    "- "
                    f"id={row['id']} "
                    f"event_type={row['event_type']} "
                    f"actor_type={row['actor_type']} "
                    f"actor_id={row['actor_id']} "
                    f"entity_type={row['entity_type']} "
                    f"entity_id={row['entity_id']} "
                    f"created_at={row['created_at']}"
                )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
