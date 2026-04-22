"""Replay one or more JSON fixtures into a chosen SQLite database.

This development helper makes it easy to seed a persistent local database with
the same normalized payloads used by integration tests. Each fixture is routed
through the registered skill handler inferred from its filename prefix unless a
single `--skill` override is provided. Named presets may also insert small
development-only hooks between fixture replays when deterministic demo state is
needed.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.db.sqlite import DEFAULT_DB_PATH
from scripts.lib.skill_runner import available_skills, dispatch_skill

REVIEW_CATALOG_PRESET = "review-catalog"
DEMO_REPLAY_PRESET = "demo-replay"
DEMO_PAID_AT = "2099-07-02 10:15:00"
DEMO_REFUNDED_AT = "2099-07-12 09:00:00"


def _fixture_action(path: Path) -> dict[str, Any]:
    """Wrap a fixture path into a replay action record."""

    return {"type": "fixture", "path": path}


def _hook_action(name: str) -> dict[str, Any]:
    """Wrap a named development hook into a replay action record."""

    return {"type": "hook", "name": name}


REVIEW_CATALOG_ACTIONS = [
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_add_room_deluxe_seaview.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_add_room_standard_city.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_add_room_family_suite.json"),
    _fixture_action(
        ROOT / "tests" / "fixtures" / "catalog_owner_add_room_single_seaview_unavailable.json"
    ),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_add_minibar_snack_box.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "inventory_owner_set_family_suite_holiday_stock.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "inventory_owner_adjust_minibar_stock_low.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_update_room_price_peak_season.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_update_room_status_unavailable.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_archive_room_type.json"),
]
DEMO_REPLAY_ACTIONS = [
    _fixture_action(ROOT / "tests" / "fixtures" / "onboarding_first_setup.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_add_room_deluxe_seaview.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_add_room_standard_city.json"),
    _fixture_action(
        ROOT / "tests" / "fixtures" / "catalog_owner_add_room_single_seaview_unavailable.json"
    ),
    _fixture_action(ROOT / "tests" / "fixtures" / "catalog_owner_add_minibar_snack_box.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "inventory_owner_adjust_minibar_stock_low.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "inventory_owner_show_inventory.json"),
    _fixture_action(
        ROOT / "tests" / "fixtures" / "catalog_customer_show_room_catalog_with_dates.json"
    ),
    _fixture_action(ROOT / "tests" / "fixtures" / "crm_caller_log_inquiry_deluxe_room.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "crm_caller_log_reply_deluxe_room.json"),
    _fixture_action(
        ROOT / "tests" / "fixtures" / "crm_caller_upsert_customer_summary_customer_001.json"
    ),
    _fixture_action(ROOT / "tests" / "fixtures" / "crm_owner_show_history_customer_001.json"),
    _fixture_action(
        ROOT / "tests" / "fixtures" / "crm_caller_get_response_context_customer_001.json"
    ),
    _fixture_action(
        ROOT / "tests" / "fixtures" / "orders_customer_create_deluxe_room_and_minibar.json"
    ),
    _fixture_action(ROOT / "tests" / "fixtures" / "payments_caller_create_payment_link.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "payments_caller_confirm_mock_paid.json"),
    _hook_action("set_demo_paid_timestamps"),
    _fixture_action(ROOT / "tests" / "fixtures" / "inventory_owner_show_inventory.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "orders_customer_show_my_orders.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "seller_bi_owner_sales_today.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "seller_bi_owner_revenue_this_month.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "payments_owner_refund_mock_payment.json"),
    _hook_action("set_demo_refund_timestamps"),
    _fixture_action(ROOT / "tests" / "fixtures" / "seller_bi_owner_sales_today.json"),
    _fixture_action(ROOT / "tests" / "fixtures" / "seller_bi_owner_revenue_this_month.json"),
]
PRESETS = {
    REVIEW_CATALOG_PRESET: REVIEW_CATALOG_ACTIONS,
    DEMO_REPLAY_PRESET: DEMO_REPLAY_ACTIONS,
}


def _infer_skill_from_fixture(fixture: Path) -> str:
    """Infer the target skill from a fixture filename prefix.

    Args:
        fixture: Fixture path whose basename is expected to start with
            `<skill>_...`.

    Returns:
        Registered skill name inferred from the filename.

    Raises:
        ValueError: If the filename does not contain a registered skill prefix.
    """

    stem = fixture.stem
    skill_aliases = {
        skill.replace("-", "_"): skill for skill in available_skills()
    }
    for normalized_prefix, skill_name in sorted(
        skill_aliases.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        if stem == normalized_prefix or stem.startswith(normalized_prefix + "_"):
            return skill_name

    prefix = stem.split("_", 1)[0]
    if prefix in available_skills():
        return prefix
    raise ValueError(
        f"Could not infer a registered skill from fixture name: {fixture.name}"
    )


def _load_payload(fixture: Path, db_path: Path) -> dict[str, Any]:
    """Load a fixture file and override its runtime database path.

    Args:
        fixture: Path to a JSON fixture file.
        db_path: SQLite file that should receive all replayed writes.

    Returns:
        Mutable normalized payload ready for dispatch.
    """

    payload = json.loads(fixture.read_text(encoding="utf-8"))
    payload.setdefault("runtime", {})
    payload["runtime"]["db_path"] = str(db_path)

    user = payload.get("user", {})
    if user.get("external_user_id") == "agent-001":
        try:
            conn = sqlite3.connect(db_path)
            row = conn.execute("SELECT external_user_id FROM identities WHERE role = 'agent' AND is_active = 1 LIMIT 1").fetchone()
            if row:
                user["external_user_id"] = row[0]
        except sqlite3.Error:
            pass
        finally:
            conn.close()

    return payload


def _has_active_owner(db_path: Path) -> bool:
    """Return whether the target database already contains an active owner."""

    if not db_path.exists():
        return False

    try:
        conn = sqlite3.connect(db_path)
    except sqlite3.Error:
        return False

    try:
        row = conn.execute(
            """
            SELECT 1
            FROM identities
            WHERE is_active = 1 AND role = 'owner'
            LIMIT 1
            """
        ).fetchone()
    except sqlite3.Error:
        return False
    finally:
        conn.close()

    return row is not None


def _resolve_replay_actions(
    raw_fixtures: list[str], preset: str | None
) -> list[dict[str, Any]]:
    """Resolve explicit fixtures plus any named preset into ordered replay actions."""

    resolved: list[dict[str, Any]] = []
    if preset:
        resolved.extend(PRESETS[preset])
    resolved.extend(_fixture_action(Path(item)) for item in raw_fixtures)
    return resolved


def _require_demo_row(conn: sqlite3.Connection, sql: str, params: tuple[str, ...]) -> None:
    """Execute one demo timestamp update and require that it touches a row."""

    cursor = conn.execute(sql, params)
    if cursor.rowcount == 0:
        raise ValueError("Demo replay preset could not locate the expected order/payment row.")


def _set_demo_paid_timestamps(db_path: Path) -> None:
    """Normalize payment timestamps before BI reads so demo output is deterministic."""

    conn = sqlite3.connect(db_path)
    try:
        _require_demo_row(
            conn,
            """
            UPDATE orders
            SET paid_at = ?
            WHERE order_number = 'PO-1001'
            """,
            (DEMO_PAID_AT,),
        )
        _require_demo_row(
            conn,
            """
            UPDATE payments
            SET paid_at = ?
            WHERE provider_reference = 'mock-pay-po-1001-001'
            """,
            (DEMO_PAID_AT,),
        )
        conn.commit()
    finally:
        conn.close()


def _set_demo_refund_timestamps(db_path: Path) -> None:
    """Normalize refund timestamps after the refund step for deterministic BI output."""

    conn = sqlite3.connect(db_path)
    try:
        _require_demo_row(
            conn,
            """
            UPDATE orders
            SET paid_at = ?, refunded_at = ?
            WHERE order_number = 'PO-1001'
            """,
            (DEMO_PAID_AT, DEMO_REFUNDED_AT),
        )
        _require_demo_row(
            conn,
            """
            UPDATE payments
            SET paid_at = ?, refunded_at = ?
            WHERE provider_reference = 'mock-pay-po-1001-001'
            """,
            (DEMO_PAID_AT, DEMO_REFUNDED_AT),
        )
        conn.commit()
    finally:
        conn.close()


HOOKS = {
    "set_demo_paid_timestamps": _set_demo_paid_timestamps,
    "set_demo_refund_timestamps": _set_demo_refund_timestamps,
}


def main() -> int:
    """Replay one or more fixtures into a single SQLite database.

    Args:
        None. Input comes from command-line flags.

    Returns:
        Process exit code:
        - `0` when all fixtures succeed
        - `1` when any fixture fails or input is invalid
    """

    parser = argparse.ArgumentParser(
        description="Replay one or more fixtures into a chosen SQLite database."
    )
    parser.add_argument(
        "fixtures",
        nargs="*",
        help="Fixture paths to replay in order.",
    )
    parser.add_argument(
        "--preset",
        choices=sorted(PRESETS),
        help="Replay a named preset of representative fixtures.",
    )
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help="SQLite database file to write into.",
    )
    parser.add_argument(
        "--skill",
        choices=available_skills(),
        help="Force all fixtures to use the same skill instead of inferring from filename.",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Delete the target SQLite file before replaying fixtures.",
    )
    args = parser.parse_args()
    if args.preset and args.skill:
        parser.error("--preset cannot be combined with --skill override.")

    db_path = Path(args.db_path)
    if args.fresh and db_path.exists():
        db_path.unlink()

    actions = _resolve_replay_actions(args.fixtures, args.preset)
    if not actions:
        parser.error("Provide at least one fixture path or a --preset value.")

    if args.preset == REVIEW_CATALOG_PRESET and not _has_active_owner(db_path):
        actions = [_fixture_action(ROOT / "tests" / "fixtures" / "onboarding_first_setup.json")] + actions

    failures = 0
    for action in actions:
        try:
            if action["type"] == "hook":
                hook_name = str(action["name"])
                HOOKS[hook_name](db_path)
                print(f"[ok] <hook:{hook_name}>")
                continue

            fixture = Path(action["path"])
            skill = args.skill or _infer_skill_from_fixture(fixture)
            payload = _load_payload(fixture, db_path)
            result = dispatch_skill(skill, payload)
        except Exception as exc:
            failures += 1
            label = action.get("path") or f"<hook:{action.get('name')}>"
            print(f"[error] {label}: {exc}", file=sys.stderr)
            continue

        status = result.get("status", "unknown")
        reply = result.get("reply", "")
        print(f"[ok] {fixture} -> {skill}: {status}")
        if reply:
            print(f"  reply: {reply}")

    if failures:
        print(f"Replay finished with {failures} failure(s).", file=sys.stderr)
        return 1

    print(f"Replay finished successfully. DB: {db_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
