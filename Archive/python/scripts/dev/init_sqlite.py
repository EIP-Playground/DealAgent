"""Initialize the local SQLite database and show the created schema objects.

Use this development helper when you want to bootstrap a fresh local database
file and verify that migrations ran successfully.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.db.sqlite import DEFAULT_DB_PATH, ensure_database


def main() -> None:
    """Parse CLI flags, initialize SQLite, and print created tables.

    Args:
        None. Input comes from command-line flags.

    Returns:
        None. The database file is created or updated in-place, and a schema
        summary is printed to stdout.
    """
    parser = argparse.ArgumentParser(description="Initialize the local SQLite database.")
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help="Path to the SQLite database file.",
    )
    args = parser.parse_args()

    db_path = Path(args.db_path)
    conn = ensure_database(db_path)
    try:
        # Print the visible schema objects so initialization is easy to verify by eye.
        tables = [
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
        ]
    finally:
        conn.close()

    print(f"Initialized SQLite at {db_path}")
    print("Tables:")
    for table in tables:
        print(f"- {table}")


if __name__ == "__main__":
    main()
