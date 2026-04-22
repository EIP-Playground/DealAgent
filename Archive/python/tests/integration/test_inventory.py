"""Integration coverage for Inventory Phase A runtime and helper contracts."""

from __future__ import annotations

import copy
import json
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEST_ENTRY = ROOT / "scripts" / "test_skill.py"
PROD_ENTRY = ROOT / "scripts" / "run_skill.py"
SCAN_ENTRY = ROOT / "scripts" / "run_low_stock_scan.py"
ONBOARD_FIXTURE = ROOT / "tests" / "fixtures" / "onboarding_first_setup.json"
CATALOG_ADD_FAMILY_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_room_family_suite.json"
)
CATALOG_ADD_MINIBAR_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_minibar_snack_box.json"
)
INVENTORY_SHOW_FIXTURE = (
    ROOT / "tests" / "fixtures" / "inventory_owner_show_inventory.json"
)
INVENTORY_SHOW_MINIBAR_FIXTURE = (
    ROOT / "tests" / "fixtures" / "inventory_owner_show_stock_minibar.json"
)
INVENTORY_SHOW_FAMILY_DATES_FIXTURE = (
    ROOT / "tests" / "fixtures" / "inventory_owner_show_stock_family_suite_dates.json"
)
INVENTORY_SHOW_LOW_STOCK_FIXTURE = (
    ROOT / "tests" / "fixtures" / "inventory_owner_show_low_stock.json"
)
INVENTORY_ADJUST_MINIBAR_FIXTURE = (
    ROOT / "tests" / "fixtures" / "inventory_owner_adjust_minibar_stock_low.json"
)
INVENTORY_SET_FAMILY_DATES_FIXTURE = (
    ROOT / "tests" / "fixtures" / "inventory_owner_set_family_suite_holiday_stock.json"
)


def _load_fixture(path: Path) -> dict:
    """Load a JSON fixture into a mutable dictionary."""

    return json.loads(path.read_text(encoding="utf-8"))


def run_test_entry(skill: str, fixture: Path, db_path: Path) -> dict:
    """Replay one fixture through `scripts/test_skill.py`."""

    result = subprocess.run(
        [
            "python3",
            str(TEST_ENTRY),
            "--skill",
            skill,
            "--fixture",
            str(fixture),
            "--db-path",
            str(db_path),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def run_prod_entry(skill: str, payload: dict, db_path: Path) -> dict:
    """Run the stdin prod entrypoint with an overridden SQLite path."""

    normalized = copy.deepcopy(payload)
    normalized.setdefault("runtime", {})
    normalized["runtime"]["db_path"] = str(db_path)
    result = subprocess.run(
        ["python3", str(PROD_ENTRY), "--skill", skill],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        input=json.dumps(normalized),
    )
    return json.loads(result.stdout)


def setup_owner(db_path: Path) -> dict:
    """Initialize the temporary DB with the default owner."""

    return run_prod_entry("onboarding", _load_fixture(ONBOARD_FIXTURE), db_path)


def seed_inventory_sample(db_path: Path) -> None:
    """Seed one room SKU and one quantity SKU for inventory tests."""

    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_FAMILY_FIXTURE), db_path)
    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)


class InventoryPhaseATest(unittest.TestCase):
    def test_owner_can_show_inventory_and_show_stock_for_both_modes(self) -> None:
        """Verify owner inventory reads for both quantity and date_quantity SKUs."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "inventory.sqlite3"
            setup_owner(db_path)
            seed_inventory_sample(db_path)
            run_prod_entry("inventory", _load_fixture(INVENTORY_SET_FAMILY_DATES_FIXTURE), db_path)
            run_prod_entry("inventory", _load_fixture(INVENTORY_ADJUST_MINIBAR_FIXTURE), db_path)

            listed = run_test_entry("inventory", INVENTORY_SHOW_FIXTURE, db_path)
            minibar = run_test_entry("inventory", INVENTORY_SHOW_MINIBAR_FIXTURE, db_path)
            family = run_test_entry("inventory", INVENTORY_SHOW_FAMILY_DATES_FIXTURE, db_path)

            self.assertEqual(listed["status"], "listed")
            self.assertEqual(minibar["status"], "found")
            self.assertEqual(family["status"], "found")

            rows = {row["sku_code"]: row for row in listed["inventory_rows"]}
            self.assertEqual(rows["MINIBAR-SNACK-BOX"]["inventory_mode"], "quantity")
            self.assertEqual(rows["MINIBAR-SNACK-BOX"]["sellable_quantity"], 2)
            self.assertTrue(rows["MINIBAR-SNACK-BOX"]["low_stock"])
            self.assertEqual(rows["FAMILY-SUITE-4P"]["inventory_mode"], "date_quantity")
            self.assertEqual(
                rows["FAMILY-SUITE-4P"]["stock_quantity_semantics"],
                "default_nightly_capacity",
            )

            self.assertEqual(minibar["sku"]["sellable_quantity"], 2)
            self.assertEqual(len(family["sku"]["date_inventory"]), 3)
            self.assertEqual(family["sku"]["requested_window_sellable_quantity"], 2)

    def test_adjust_stock_is_idempotent_and_duplicate_safe(self) -> None:
        """Cover idempotent replay, duplicate detection, and confirmed repeat adjustment."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "inventory.sqlite3"
            setup_owner(db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)

            base_payload = {
                "channel": "telegram",
                "command_code": "inventory.adjust_stock",
                "params": {
                    "sku_code": "MINIBAR-SNACK-BOX",
                    "delta": 2,
                    "reason": "manual_recount",
                    "operation_id": "recount-001",
                },
                "user": {"external_user_id": "owner-001"},
            }
            first = run_prod_entry("inventory", base_payload, db_path)
            replay = run_prod_entry("inventory", base_payload, db_path)
            needs_confirmation = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.adjust_stock",
                    "params": {
                        "sku_code": "MINIBAR-SNACK-BOX",
                        "delta": 2,
                        "reason": "manual_recount",
                        "operation_id": "recount-002",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            confirmed = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.adjust_stock",
                    "params": {
                        "sku_code": "MINIBAR-SNACK-BOX",
                        "delta": 2,
                        "reason": "manual_recount",
                        "operation_id": "recount-003",
                        "confirm_duplicate": True,
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )

            self.assertEqual(first["status"], "adjusted")
            self.assertEqual(replay["status"], "adjusted")
            self.assertTrue(replay["idempotent_replay"])
            self.assertEqual(needs_confirmation["status"], "needs_confirmation")
            self.assertEqual(needs_confirmation["duplicate_check"]["window_seconds"], 60)
            self.assertEqual(confirmed["status"], "adjusted")
            self.assertEqual(confirmed["sku"]["stock_quantity"], 28)

    def test_adjust_stock_after_duplicate_window_no_longer_needs_confirmation(self) -> None:
        """Allow the same adjustment again once it falls outside the 60-second window."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "inventory.sqlite3"
            setup_owner(db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)

            first = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.adjust_stock",
                    "params": {
                        "sku_code": "MINIBAR-SNACK-BOX",
                        "delta": -1,
                        "reason": "manual_recount",
                        "operation_id": "inventory-adjust-stock-minibar-snack-box-001",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            self.assertEqual(first["status"], "adjusted")

            conn = sqlite3.connect(db_path)
            try:
                sku_id = conn.execute(
                    "SELECT id FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'"
                ).fetchone()[0]
                conn.execute(
                    """
                    UPDATE inventory_movements
                    SET created_at = datetime('now', '-61 seconds')
                    WHERE reference_key = ?
                    """,
                    (
                        f"manual_adjust:operation_id=inventory-adjust-stock-minibar-snack-box-001:sku_id={sku_id}",
                    ),
                )
                conn.commit()
            finally:
                conn.close()

            second = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.adjust_stock",
                    "params": {
                        "sku_code": "MINIBAR-SNACK-BOX",
                        "delta": -1,
                        "reason": "manual_recount",
                        "operation_id": "inventory-adjust-stock-minibar-snack-box-002",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            self.assertEqual(second["status"], "adjusted")
            self.assertNotIn("duplicate_check", second)

    def test_low_stock_scan_marks_alerts_sent_and_resolution_happens_after_restock(self) -> None:
        """Scan low-stock alerts through pending, sent, and resolved lifecycle states."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "inventory.sqlite3"
            setup_owner(db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)
            run_prod_entry("inventory", _load_fixture(INVENTORY_ADJUST_MINIBAR_FIXTURE), db_path)

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                pending_before = conn.execute(
                    "SELECT status FROM low_stock_alerts"
                ).fetchall()
            finally:
                conn.close()
            self.assertEqual([row["status"] for row in pending_before], ["pending"])

            result = subprocess.run(
                [
                    "python3",
                    str(SCAN_ENTRY),
                    "--db-path",
                    str(db_path),
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            payload = json.loads(result.stdout)
            self.assertEqual(payload["status"], "scanned")
            self.assertEqual(len(payload["alerts"]), 1)
            self.assertEqual(payload["alerts"][0]["sku_code"], "MINIBAR-SNACK-BOX")

            run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.adjust_stock",
                    "params": {
                        "sku_code": "MINIBAR-SNACK-BOX",
                        "delta": 3,
                        "reason": "restock_delivery",
                        "operation_id": "restock-001",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                statuses = [
                    row["status"]
                    for row in conn.execute(
                        "SELECT status FROM low_stock_alerts ORDER BY id"
                    ).fetchall()
                ]
            finally:
                conn.close()
            self.assertEqual(statuses, ["resolved"])

    def test_show_low_stock_refreshes_but_does_not_mark_alerts_sent(self) -> None:
        """Refresh low-stock state for owner reads without consuming pending alerts."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "inventory.sqlite3"
            setup_owner(db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)
            run_prod_entry("inventory", _load_fixture(INVENTORY_ADJUST_MINIBAR_FIXTURE), db_path)

            shown = run_test_entry("inventory", INVENTORY_SHOW_LOW_STOCK_FIXTURE, db_path)
            self.assertEqual(shown["status"], "listed")
            self.assertEqual(len(shown["low_stock_rows"]), 1)
            self.assertEqual(shown["low_stock_rows"][0]["sku_code"], "MINIBAR-SNACK-BOX")
            self.assertEqual(shown["low_stock_rows"][0]["alert_status"], "pending")

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                statuses = [
                    row["status"]
                    for row in conn.execute(
                        "SELECT status FROM low_stock_alerts ORDER BY id"
                    ).fetchall()
                ]
            finally:
                conn.close()
            self.assertEqual(statuses, ["pending"])

    def test_reference_key_builders_include_mode_specific_fields(self) -> None:
        """Ensure manual and future automatic reference keys encode mode-specific identity."""

        from scripts.lib.inventory import (
            build_manual_adjust_reference_key,
            build_order_reference_key,
            build_set_date_stock_reference_key,
        )

        self.assertEqual(
            build_manual_adjust_reference_key("op-1", 7),
            "manual_adjust:operation_id=op-1:sku_id=7",
        )
        self.assertEqual(
            build_set_date_stock_reference_key(
                "op-2", 8, date.fromisoformat("2099-07-01")
            ),
            "set_date_stock:operation_id=op-2:sku_id=8:inventory_date=2099-07-01",
        )
        self.assertEqual(
            build_order_reference_key(
                "reserve",
                order_id=11,
                order_item_id=22,
                sku_id=33,
            ),
            "reserve:order_id=11:order_item_id=22:sku_id=33",
        )
        self.assertEqual(
            build_order_reference_key(
                "commit",
                order_id=11,
                order_item_id=22,
                sku_id=33,
                payment_reference="pay-001",
                inventory_date=date.fromisoformat("2099-07-01"),
            ),
            "commit:payment_reference=pay-001:order_id=11:order_item_id=22:sku_id=33:inventory_date=2099-07-01",
        )

    def test_non_owner_inventory_read_is_forbidden(self) -> None:
        """Reject inventory reads from users who are not the active owner."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "inventory.sqlite3"
            setup_owner(db_path)
            seed_inventory_sample(db_path)

            forbidden = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.show_inventory",
                    "params": {},
                    "user": {"external_user_id": "customer-001"},
                },
                db_path,
            )
            self.assertEqual(forbidden["status"], "forbidden")


if __name__ == "__main__":
    unittest.main()
