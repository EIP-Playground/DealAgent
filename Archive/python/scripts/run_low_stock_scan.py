"""Run the low-stock alert scan and emit a stable JSON payload.

This script is a lightweight host/cron entrypoint. It inspects the current
SQLite database, detects low-stock conditions, marks newly pending alerts as
sent, and prints the alert list as stdout JSON.
"""

from __future__ import annotations

import argparse
import json
import sys
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.db.sqlite import DEFAULT_DB_PATH, ensure_database
from scripts.lib.inventory import LOW_STOCK_SCAN_DAYS, scan_low_stock_alerts


def main() -> int:
    """Scan low-stock alerts in the chosen database and print JSON results.

    Args:
        None. Input comes from command-line flags.

    Returns:
        Process exit code `0` after printing the scan result to stdout.
    """
    parser = argparse.ArgumentParser(description="Scan low-stock alerts and emit JSON.")
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help="SQLite database file to scan.",
    )
    parser.add_argument(
        "--days-ahead",
        type=int,
        default=LOW_STOCK_SCAN_DAYS,
        help="How many future days to scan for date_quantity alerts.",
    )
    args = parser.parse_args()

    with closing(ensure_database(args.db_path)) as conn:
        alerts = scan_low_stock_alerts(
            conn,
            mark_sent=True,
            days_ahead=args.days_ahead,
        )

    payload = {
        "status": "scanned",
        "reply": f"Detected {len(alerts)} low-stock alert(s).",
        "alerts": alerts,
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
