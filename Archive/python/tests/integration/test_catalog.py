"""Integration coverage for catalog Phase A and shared money formatting."""

from __future__ import annotations

import copy
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEST_ENTRY = ROOT / "scripts" / "test_skill.py"
PROD_ENTRY = ROOT / "scripts" / "run_skill.py"
ONBOARD_FIXTURE = ROOT / "tests" / "fixtures" / "onboarding_first_setup.json"
CATALOG_ADD_DELUXE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_room_deluxe_seaview.json"
)
CATALOG_ADD_STANDARD_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_room_standard_city.json"
)
CATALOG_ADD_FAMILY_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_room_family_suite.json"
)
CATALOG_ADD_SINGLE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_room_single_seaview_unavailable.json"
)
CATALOG_ADD_MINIBAR_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_minibar_snack_box.json"
)
CATALOG_UPDATE_PRICE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_update_room_price_peak_season.json"
)
CATALOG_UPDATE_STATUS_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_update_room_status_unavailable.json"
)
CATALOG_ARCHIVE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_archive_room_type.json"
)
CATALOG_SHOW_SKU_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_show_room.json"
)
CATALOG_CUSTOMER_SHOW_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_customer_show_room_catalog.json"
)
CATALOG_CUSTOMER_SHOW_WITH_DATES_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_customer_show_room_catalog_with_dates.json"
)


def _load_fixture(path: Path) -> dict:
    """Load a JSON fixture into a mutable Python dictionary."""

    return json.loads(path.read_text(encoding="utf-8"))


def run_test_entry(skill: str, fixture: Path, db_path: Path) -> dict:
    """Run the local fixture replay entrypoint and decode the JSON response."""

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
    """Run the prod stdin entrypoint with a payload and decode the result."""

    normalized = copy.deepcopy(payload)
    normalized.setdefault("runtime", {})
    normalized["runtime"]["db_path"] = str(db_path)

    result = subprocess.run(
        [
            "python3",
            str(PROD_ENTRY),
            "--skill",
            skill,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        input=json.dumps(normalized),
    )
    return json.loads(result.stdout)


def setup_owner(db_path: Path) -> dict:
    """Initialize the temp database with the default owner via onboarding."""

    return run_prod_entry("onboarding", _load_fixture(ONBOARD_FIXTURE), db_path)


class CatalogPhaseATest(unittest.TestCase):
    def test_owner_can_create_and_show_sku(self) -> None:
        """Verify owner create/show flows expose persisted SKU fields and money display."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "catalog.sqlite3"
            setup_owner(db_path)

            created = run_test_entry("catalog", CATALOG_ADD_DELUXE_FIXTURE, db_path)
            self.assertEqual(created["status"], "created")
            self.assertEqual(created["sku"]["display_price"], "USD 289.00")
            self.assertEqual(created["sku"]["sku_code"], "DELUXE-SEAVIEW-KING")
            self.assertEqual(created["sku"]["inventory_mode"], "date_quantity")
            self.assertEqual(
                created["sku"]["stock_quantity_semantics"], "default_nightly_capacity"
            )

            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_FAMILY_FIXTURE), db_path)
            shown = run_test_entry("catalog", CATALOG_SHOW_SKU_FIXTURE, db_path)
            self.assertEqual(shown["status"], "found")
            self.assertEqual(shown["sku"]["title"], "Family Suite 4P")
            self.assertEqual(shown["sku"]["display_price"], "USD 359.00")
            self.assertEqual(shown["sku"]["inventory_mode"], "date_quantity")
            self.assertEqual(
                shown["sku"]["stock_quantity_semantics"], "default_nightly_capacity"
            )

    def test_inventory_mode_defaults_validates_and_can_switch_safely(self) -> None:
        """Cover default mode selection, validation, and Safe Switch success paths."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "catalog.sqlite3"
            setup_owner(db_path)

            default_mode = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.add_sku",
                    "params": {
                        "sku_code": "WELCOME-COOKIE-TIN",
                        "title": "Welcome Cookie Tin",
                        "price_minor": 2500,
                        "currency": "USD",
                        "stock_quantity": 12,
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            explicit_date = run_prod_entry(
                "catalog",
                _load_fixture(CATALOG_ADD_DELUXE_FIXTURE),
                db_path,
            )
            invalid_mode = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.add_sku",
                    "params": {
                        "sku_code": "BAD-MODE-SKU",
                        "title": "Bad Mode SKU",
                        "price_minor": 1000,
                        "currency": "USD",
                        "inventory_mode": "calendar_quantity",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            switch_mode = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.update_inventory_mode",
                    "params": {
                        "sku_code": "DELUXE-SEAVIEW-KING",
                        "inventory_mode": "quantity",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )

            self.assertEqual(default_mode["status"], "created")
            self.assertEqual(default_mode["sku"]["inventory_mode"], "quantity")
            self.assertEqual(
                default_mode["sku"]["stock_quantity_semantics"], "on_hand_quantity"
            )
            self.assertEqual(explicit_date["status"], "created")
            self.assertEqual(explicit_date["sku"]["inventory_mode"], "date_quantity")
            self.assertEqual(switch_mode["status"], "updated")
            self.assertEqual(switch_mode["sku"]["inventory_mode"], "quantity")
            self.assertEqual(
                switch_mode["sku"]["stock_quantity_semantics"], "on_hand_quantity"
            )
            self.assertEqual(invalid_mode["status"], "invalid_input")

    def test_money_helper_formats_supported_fiat_currencies(self) -> None:
        """Confirm the shared money helper formats supported fiat currencies consistently."""

        from scripts.lib.money import format_minor_amount

        self.assertEqual(format_minor_amount(1999, "USD"), "USD 19.99")
        self.assertEqual(format_minor_amount(8850, "CNY"), "CNY 88.50")
        self.assertEqual(format_minor_amount(1200, "JPY"), "JPY 1200")
        self.assertEqual(format_minor_amount(15000, "KRW"), "KRW 15000")

    def test_create_rejects_duplicate_sku_code_invalid_code_and_currency(self) -> None:
        """Reject duplicate SKU codes and invalid catalog creation inputs."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "catalog.sqlite3"
            setup_owner(db_path)

            first = run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)
            duplicate = run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)

            self.assertEqual(first["status"], "created")
            self.assertEqual(duplicate["status"], "conflict")

            invalid_sku = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.add_sku",
                    "params": {
                        "sku_code": "bad code",
                        "title": "Broken SKU",
                        "price_minor": 1000,
                        "currency": "USD",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            self.assertEqual(invalid_sku["status"], "invalid_input")

            invalid_currency = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.add_sku",
                    "params": {
                        "sku_code": "VALID-SKU-2",
                        "title": "Unsupported Currency SKU",
                        "price_minor": 1000,
                        "currency": "USDT",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            self.assertEqual(invalid_currency["status"], "invalid_input")

    def test_owner_can_update_details_price_status_and_archive(self) -> None:
        """Exercise the owner update and archive mutations for one SKU lifecycle."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "catalog.sqlite3"
            setup_owner(db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_STANDARD_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)

            details = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.update_details",
                    "params": {
                        "sku_code": "DELUXE-SEAVIEW-KING",
                        "title": "Deluxe Seaview King Room",
                        "description": "Updated description",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            price = run_test_entry("catalog", CATALOG_UPDATE_PRICE_FIXTURE, db_path)
            status = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.update_status",
                    "params": {
                        "sku_code": "STANDARD-CITY-QUEEN",
                        "sellable_status": "unavailable",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            archived = run_test_entry("catalog", CATALOG_ARCHIVE_FIXTURE, db_path)
            archived_again = run_test_entry("catalog", CATALOG_ARCHIVE_FIXTURE, db_path)

            self.assertEqual(details["status"], "updated")
            self.assertEqual(price["status"], "updated")
            self.assertEqual(price["sku"]["display_price"], "USD 329.00")
            self.assertEqual(status["status"], "updated")
            self.assertEqual(status["sku"]["sku_code"], "STANDARD-CITY-QUEEN")
            self.assertEqual(status["sku"]["sellable_status"], "unavailable")
            self.assertEqual(archived["status"], "archived")
            self.assertEqual(archived["sku"]["sellable_status"], "archived")
            self.assertIsNotNone(archived["sku"]["archived_at"])
            self.assertEqual(archived_again["status"], "archived")
            self.assertEqual(price["sku"]["inventory_mode"], "date_quantity")

            conn = sqlite3.connect(db_path)
            try:
                events = [
                    row[0]
                    for row in conn.execute(
                        """
                        SELECT event_type
                        FROM audit_events
                        WHERE event_type LIKE 'catalog.%'
                        ORDER BY created_at, id
                        """
                    ).fetchall()
                ]
            finally:
                conn.close()

            self.assertIn("catalog.sku_created", events)
            self.assertIn("catalog.sku_updated", events)
            self.assertIn("catalog.sku_archived", events)

    def test_owner_show_catalog_lists_all_skus(self) -> None:
        """Ensure owner catalog listing includes multiple SKUs and archived rows."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "catalog.sqlite3"
            setup_owner(db_path)

            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_STANDARD_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_FAMILY_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_SINGLE_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)
            run_test_entry("catalog", CATALOG_UPDATE_PRICE_FIXTURE, db_path)
            run_test_entry("catalog", CATALOG_UPDATE_STATUS_FIXTURE, db_path)
            run_test_entry("catalog", CATALOG_ARCHIVE_FIXTURE, db_path)

            listed = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.show_catalog",
                    "params": {},
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )

            self.assertEqual(listed["status"], "listed")
            self.assertEqual(len(listed["skus"]), 5)
            statuses = {sku["sku_code"]: sku["sellable_status"] for sku in listed["skus"]}
            self.assertEqual(statuses["DELUXE-SEAVIEW-KING"], "archived")
            self.assertEqual(statuses["STANDARD-CITY-QUEEN"], "unavailable")
            self.assertEqual(statuses["SINGLE-SEAVIEW"], "unavailable")
            self.assertEqual(statuses["FAMILY-SUITE-4P"], "active")
            self.assertEqual(statuses["MINIBAR-SNACK-BOX"], "active")

            prices = {sku["sku_code"]: sku["display_price"] for sku in listed["skus"]}
            self.assertEqual(prices["DELUXE-SEAVIEW-KING"], "USD 329.00")
            self.assertEqual(prices["STANDARD-CITY-QUEEN"], "USD 189.00")
            self.assertEqual(prices["SINGLE-SEAVIEW"], "USD 209.00")
            self.assertEqual(prices["FAMILY-SUITE-4P"], "USD 359.00")
            self.assertEqual(prices["MINIBAR-SNACK-BOX"], "USD 18.00")

            inventory_modes = {sku["sku_code"]: sku["inventory_mode"] for sku in listed["skus"]}
            self.assertEqual(inventory_modes["DELUXE-SEAVIEW-KING"], "date_quantity")
            self.assertEqual(inventory_modes["STANDARD-CITY-QUEEN"], "date_quantity")
            self.assertEqual(inventory_modes["FAMILY-SUITE-4P"], "date_quantity")
            self.assertEqual(inventory_modes["SINGLE-SEAVIEW"], "date_quantity")
            self.assertEqual(inventory_modes["MINIBAR-SNACK-BOX"], "quantity")

            semantics = {
                sku["sku_code"]: sku["stock_quantity_semantics"] for sku in listed["skus"]
            }
            self.assertEqual(
                semantics["DELUXE-SEAVIEW-KING"], "default_nightly_capacity"
            )
            self.assertEqual(semantics["MINIBAR-SNACK-BOX"], "on_hand_quantity")

    def test_inventory_mode_switch_conflicts_after_real_usage(self) -> None:
        """Block inventory mode changes once the SKU has inventory or date-stock history."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "catalog.sqlite3"
            setup_owner(db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_FAMILY_FIXTURE), db_path)

            movement_conflict = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.adjust_stock",
                    "params": {
                        "sku_code": "MINIBAR-SNACK-BOX",
                        "delta": -2,
                        "reason": "restock_count",
                        "operation_id": "minibar-adjust-001",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            movement_mode_change = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.update_inventory_mode",
                    "params": {
                        "sku_code": "MINIBAR-SNACK-BOX",
                        "inventory_mode": "date_quantity",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )

            override_conflict = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.set_date_stock",
                    "params": {
                        "sku_code": "FAMILY-SUITE-4P",
                        "date_from": "2099-07-01",
                        "date_to": "2099-07-02",
                        "stock_quantity": 2,
                        "reason": "holiday_hold",
                        "operation_id": "family-hold-001",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )
            override_mode_change = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.update_inventory_mode",
                    "params": {
                        "sku_code": "FAMILY-SUITE-4P",
                        "inventory_mode": "quantity",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )

            conn = sqlite3.connect(db_path)
            try:
                customer_cursor = conn.execute(
                    """
                    INSERT INTO customers(channel, external_user_id, username)
                    VALUES ('telegram', 'customer-001', 'guest-anna')
                    """
                )
                customer_id = customer_cursor.lastrowid
                order_cursor = conn.execute(
                    """
                    INSERT INTO orders(
                        order_number,
                        customer_id,
                        source_channel,
                        status,
                        currency,
                        subtotal_minor,
                        total_minor
                    ) VALUES ('PO-2001', ?, 'telegram', 'draft', 'USD', 1800, 1800)
                    """,
                    (customer_id,),
                )
                order_id = order_cursor.lastrowid
                family_sku_id = conn.execute(
                    "SELECT id FROM skus WHERE sku_code = 'FAMILY-SUITE-4P'"
                ).fetchone()[0]
                conn.execute(
                    """
                    INSERT INTO order_items(
                        order_id,
                        sku_id,
                        sku_title,
                        unit_price_minor,
                        currency,
                        quantity,
                        line_total_minor
                    ) VALUES (?, ?, 'Family Suite 4P', 35900, 'USD', 1, 35900)
                    """,
                    (order_id, family_sku_id),
                )
                conn.commit()
            finally:
                conn.close()

            order_item_mode_change = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.update_inventory_mode",
                    "params": {
                        "sku_code": "FAMILY-SUITE-4P",
                        "inventory_mode": "quantity",
                    },
                    "user": {"external_user_id": "owner-001"},
                },
                db_path,
            )

            self.assertEqual(movement_conflict["status"], "adjusted")
            self.assertEqual(movement_mode_change["status"], "conflict")
            self.assertEqual(override_conflict["status"], "updated")
            self.assertEqual(override_mode_change["status"], "conflict")
            self.assertEqual(order_item_mode_change["status"], "conflict")

    def test_non_owner_write_is_forbidden_and_customer_reads_inventory_backed_catalog(self) -> None:
        """Protect owner-only writes while allowing customer inventory-backed catalog reads."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "catalog.sqlite3"
            setup_owner(db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_FAMILY_FIXTURE), db_path)
            run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)
            run_prod_entry(
                "inventory",
                _load_fixture(
                    ROOT / "tests" / "fixtures" / "inventory_owner_set_family_suite_holiday_stock.json"
                ),
                db_path,
            )
            run_prod_entry(
                "inventory",
                _load_fixture(
                    ROOT / "tests" / "fixtures" / "inventory_owner_adjust_minibar_stock_low.json"
                ),
                db_path,
            )

            forbidden = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.add_sku",
                    "params": {
                        "sku_code": "CUSTOMER-FAIL",
                        "title": "Forbidden write",
                        "price_minor": 1000,
                        "currency": "USD",
                    },
                    "user": {"external_user_id": "customer-001"},
                },
                db_path,
            )
            show_catalog = run_test_entry("catalog", CATALOG_CUSTOMER_SHOW_FIXTURE, db_path)
            show_catalog_with_dates = run_test_entry(
                "catalog", CATALOG_CUSTOMER_SHOW_WITH_DATES_FIXTURE, db_path
            )
            show_product = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.show_product",
                    "params": {"sku_code": "FAMILY-SUITE-4P"},
                    "user": {"external_user_id": "customer-001"},
                },
                db_path,
            )
            show_product_with_dates = run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.show_product",
                    "params": {
                        "sku_code": "FAMILY-SUITE-4P",
                        "check_in_date": "2099-07-01",
                        "check_out_date": "2099-07-04",
                    },
                    "user": {"external_user_id": "customer-001"},
                },
                db_path,
            )

            self.assertEqual(forbidden["status"], "forbidden")
            self.assertEqual(show_catalog["status"], "listed")
            self.assertEqual(show_catalog_with_dates["status"], "listed")
            self.assertEqual(show_product["status"], "found")
            self.assertEqual(show_product_with_dates["status"], "found")

            no_date_status = {
                sku["sku_code"]: sku["availability_status"] for sku in show_catalog["skus"]
            }
            self.assertEqual(no_date_status["FAMILY-SUITE-4P"], "dates_required")
            self.assertEqual(no_date_status["MINIBAR-SNACK-BOX"], "only_a_few_left")

            dated_status = {
                sku["sku_code"]: sku["availability_status"]
                for sku in show_catalog_with_dates["skus"]
            }
            self.assertEqual(dated_status["FAMILY-SUITE-4P"], "only_a_few_left")
            self.assertEqual(dated_status["MINIBAR-SNACK-BOX"], "only_a_few_left")
            self.assertEqual(show_product["sku"]["availability_status"], "dates_required")
            self.assertEqual(
                show_product_with_dates["sku"]["availability_status"], "only_a_few_left"
            )


if __name__ == "__main__":
    unittest.main()
