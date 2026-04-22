"""Integration coverage for the first executable Orders runtime slice."""

from __future__ import annotations

import copy
import json
import sqlite3
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEST_ENTRY = ROOT / "scripts" / "test_skill.py"
PROD_ENTRY = ROOT / "scripts" / "run_skill.py"
ONBOARD_FIXTURE = ROOT / "tests" / "fixtures" / "onboarding_first_setup.json"
CATALOG_ADD_DELUXE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_room_deluxe_seaview.json"
)
CATALOG_ADD_MINIBAR_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_minibar_snack_box.json"
)
ORDERS_CREATE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "orders_customer_create_deluxe_room_and_minibar.json"
)
ORDERS_SHOW_MY_FIXTURE = (
    ROOT / "tests" / "fixtures" / "orders_customer_show_my_orders.json"
)
ORDERS_OWNER_LIST_FIXTURE = (
    ROOT / "tests" / "fixtures" / "orders_owner_list_orders.json"
)
ORDERS_SHOW_ORDER_FIXTURE = (
    ROOT / "tests" / "fixtures" / "orders_customer_show_order.json"
)
ORDERS_OWNER_CANCEL_FIXTURE = (
    ROOT / "tests" / "fixtures" / "orders_owner_cancel_order.json"
)


def _load_fixture(path: Path) -> dict:
    """Load one JSON fixture into a mutable dictionary."""

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
    """Run the stdin prod entrypoint and decode the JSON result."""

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
    """Initialize the temporary database with the default owner."""

    return run_prod_entry("onboarding", _load_fixture(ONBOARD_FIXTURE), db_path)


def seed_orders_sample(db_path: Path) -> None:
    """Seed one room SKU and one quantity SKU for orders tests."""

    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)
    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)


class OrdersRuntimeTest(unittest.TestCase):
    def test_customer_can_create_draft_and_query_it(self) -> None:
        """Verify draft creation plus customer/owner reads with persisted snapshots."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "orders.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)

            created = run_test_entry("orders", ORDERS_CREATE_FIXTURE, db_path)
            shown = run_test_entry("orders", ORDERS_SHOW_ORDER_FIXTURE, db_path)
            my_orders = run_test_entry("orders", ORDERS_SHOW_MY_FIXTURE, db_path)
            listed = run_test_entry("orders", ORDERS_OWNER_LIST_FIXTURE, db_path)

            self.assertEqual(created["status"], "created")
            self.assertEqual(created["order"]["order_number"], "PO-1001")
            self.assertEqual(created["order"]["status"], "draft")
            self.assertEqual(created["order"]["currency"], "USD")
            self.assertEqual(created["order"]["subtotal_minor"], 88500)
            self.assertEqual(created["order"]["total_minor"], 88500)
            self.assertEqual(created["order"]["session_id"], "telegram:customer-001:stay-001")
            self.assertEqual(created["order"]["booking_contact"]["guest_name"], "Anna")
            self.assertEqual(created["order"]["booking_contact"]["phone"], "13800138000")
            self.assertEqual(len(created["order"]["items"]), 2)
            self.assertEqual(created["order"]["items"][0]["sku_code"], "DELUXE-SEAVIEW-KING")
            self.assertEqual(created["order"]["items"][0]["check_in_date"], "2099-07-01")
            self.assertNotIn("check_in_date", created["order"]["items"][1])

            self.assertEqual(shown["status"], "found")
            self.assertEqual(shown["order"]["order_number"], "PO-1001")
            self.assertEqual(my_orders["status"], "listed")
            self.assertEqual(len(my_orders["orders"]), 1)
            self.assertEqual(listed["status"], "listed")
            self.assertEqual(len(listed["orders"]), 1)
            self.assertEqual(
                listed["orders"][0]["customer"]["external_user_id"], "customer-001"
            )

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                order = conn.execute(
                    """
                    SELECT session_id, booking_contact_name, booking_contact_phone
                    FROM orders
                    WHERE order_number = 'PO-1001'
                    """
                ).fetchone()
                rows = conn.execute(
                    """
                    SELECT check_in_date, check_out_date, currency
                    FROM order_items
                    ORDER BY id
                    """
                ).fetchall()
            finally:
                conn.close()

            self.assertEqual(order["session_id"], "telegram:customer-001:stay-001")
            self.assertEqual(order["booking_contact_name"], "Anna")
            self.assertEqual(order["booking_contact_phone"], "13800138000")
            self.assertEqual(rows[0]["check_in_date"], "2099-07-01")
            self.assertEqual(rows[0]["check_out_date"], "2099-07-04")
            self.assertIsNone(rows[1]["check_in_date"])
            self.assertEqual(rows[1]["currency"], "USD")

    def test_create_generates_session_id_when_missing(self) -> None:
        """Generate a draft session_id when the caller omits it."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "orders.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)

            payload = _load_fixture(ORDERS_CREATE_FIXTURE)
            payload["params"].pop("session_id")

            created = run_prod_entry("orders", payload, db_path)

            self.assertEqual(created["status"], "created")
            generated = created["order"]["session_id"]
            self.assertRegex(
                generated,
                r"^telegram:customer-001:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            )
            self.assertEqual(
                str(uuid.UUID(generated.rsplit(":", 1)[-1])),
                generated.rsplit(":", 1)[-1],
            )

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                row = conn.execute(
                    """
                    SELECT session_id
                    FROM orders
                    WHERE order_number = 'PO-1001'
                    """
                ).fetchone()
            finally:
                conn.close()

            self.assertEqual(row["session_id"], generated)

    def test_owner_can_cancel_draft_and_status_persists(self) -> None:
        """Allow owner-side cancellation for draft orders and persist the new status."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "orders.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)
            run_test_entry("orders", ORDERS_CREATE_FIXTURE, db_path)

            cancelled = run_test_entry("orders", ORDERS_OWNER_CANCEL_FIXTURE, db_path)
            shown = run_test_entry("orders", ORDERS_SHOW_ORDER_FIXTURE, db_path)

            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(cancelled["order"]["status"], "cancelled")
            self.assertEqual(shown["order"]["status"], "cancelled")

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                row = conn.execute(
                    """
                    SELECT status, cancelled_at, reserved_until
                    FROM orders
                    WHERE order_number = 'PO-1001'
                    """
                ).fetchone()
            finally:
                conn.close()

            self.assertEqual(row["status"], "cancelled")
            self.assertIsNotNone(row["cancelled_at"])
            self.assertIsNone(row["reserved_until"])

    def test_customer_cannot_view_other_customer_order(self) -> None:
        """Restrict customer reads to their own orders while keeping owner access."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "orders.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)
            run_test_entry("orders", ORDERS_CREATE_FIXTURE, db_path)

            forbidden = run_prod_entry(
                "orders",
                {
                    "channel": "telegram",
                    "command_code": "orders.show_order",
                    "params": {"order_number": "PO-1001"},
                    "user": {
                        "external_user_id": "customer-002",
                        "username": "guest-ben",
                    },
                },
                db_path,
            )
            owner_view = run_prod_entry(
                "orders",
                {
                    "channel": "telegram",
                    "command_code": "orders.show_order",
                    "params": {"order_number": "PO-1001"},
                    "user": {
                        "external_user_id": "owner-001",
                        "username": "alice",
                    },
                },
                db_path,
            )

            self.assertEqual(forbidden["status"], "forbidden")
            self.assertEqual(owner_view["status"], "found")

    def test_create_rejects_invalid_dates_and_session_only_fields(self) -> None:
        """Reject malformed date payloads and session-only helper fields."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "orders.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)

            missing_dates = _load_fixture(ORDERS_CREATE_FIXTURE)
            missing_dates["params"]["items"][0].pop("check_in_date")
            missing_dates["params"]["items"][0].pop("check_out_date")

            quantity_with_dates = _load_fixture(ORDERS_CREATE_FIXTURE)
            quantity_with_dates["params"]["items"][1]["check_in_date"] = "2099-07-01"
            quantity_with_dates["params"]["items"][1]["check_out_date"] = "2099-07-04"

            top_level_budget = _load_fixture(ORDERS_CREATE_FIXTURE)
            top_level_budget["params"]["budget_per_night"] = 30000

            missing_dates_result = run_prod_entry("orders", missing_dates, db_path)
            quantity_dates_result = run_prod_entry("orders", quantity_with_dates, db_path)
            budget_result = run_prod_entry("orders", top_level_budget, db_path)

            self.assertEqual(missing_dates_result["status"], "invalid_input")
            self.assertIn("check_in_date/check_out_date", missing_dates_result["reply"])
            self.assertEqual(quantity_dates_result["status"], "invalid_input")
            self.assertIn("must not include dates", quantity_dates_result["reply"])
            self.assertEqual(budget_result["status"], "invalid_input")
            self.assertIn("budget_per_night", budget_result["reply"])

    def test_create_rejects_insufficient_availability_and_owner_customer_flow(self) -> None:
        """Reject overbooked room requests and owner misuse of customer draft flow."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "orders.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)

            insufficient = _load_fixture(ORDERS_CREATE_FIXTURE)
            insufficient["params"]["items"][0]["quantity"] = 7

            owner_attempt = _load_fixture(ORDERS_CREATE_FIXTURE)
            owner_attempt["user"]["external_user_id"] = "owner-001"
            owner_attempt["user"]["username"] = "alice"

            insufficient_result = run_prod_entry("orders", insufficient, db_path)
            owner_result = run_prod_entry("orders", owner_attempt, db_path)

            self.assertEqual(insufficient_result["status"], "conflict")
            self.assertIn("only has 6 available", insufficient_result["reply"])
            self.assertEqual(owner_result["status"], "forbidden")

    def test_existing_customer_is_reused_and_username_updates_on_draft_creation(self) -> None:
        """Reuse the same customer row when orders create a draft for an existing identity."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "orders.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)

            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    """
                    INSERT INTO customers(channel, external_user_id, username)
                    VALUES ('telegram', 'customer-001', 'old-guest-name')
                    """
                )
                conn.commit()
            finally:
                conn.close()

            created = run_test_entry("orders", ORDERS_CREATE_FIXTURE, db_path)

            self.assertEqual(created["status"], "created")

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                customer_rows = conn.execute(
                    """
                    SELECT COUNT(*) AS row_count, MIN(username) AS username
                    FROM customers
                    WHERE channel = 'telegram' AND external_user_id = 'customer-001'
                    """
                ).fetchone()
            finally:
                conn.close()

            self.assertEqual(int(customer_rows["row_count"]), 1)
            self.assertEqual(customer_rows["username"], "guest-anna")


if __name__ == "__main__":
    unittest.main()
