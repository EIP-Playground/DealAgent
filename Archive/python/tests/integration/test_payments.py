"""Integration coverage for the first executable mock payments runtime slice."""

from __future__ import annotations

import copy
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import date
from pathlib import Path

from scripts.lib.inventory import get_sellable_quantity


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
ORDERS_OWNER_CANCEL_FIXTURE = (
    ROOT / "tests" / "fixtures" / "orders_owner_cancel_order.json"
)
PAYMENTS_CALLER_CREATE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "payments_caller_create_payment_link.json"
)
PAYMENTS_CALLER_CONFIRM_FIXTURE = (
    ROOT / "tests" / "fixtures" / "payments_caller_confirm_mock_paid.json"
)
PAYMENTS_REFUND_FIXTURE = (
    ROOT / "tests" / "fixtures" / "payments_owner_refund_mock_payment.json"
)


def _load_fixture(path: Path) -> dict:
    """Load one JSON fixture into a mutable dictionary."""

    return json.loads(path.read_text(encoding="utf-8"))


def _inject_agent_id(db_path: Path, payload: dict) -> None:
    user = payload.get("user", {})
    if user.get("external_user_id") == "agent-001":
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute("SELECT external_user_id FROM identities WHERE role = 'agent' AND is_active = 1 LIMIT 1").fetchone()
            if row:
                user["external_user_id"] = row[0]
        except sqlite3.Error:
            pass
        finally:
            conn.close()

def _get_agent_id(db_path: Path) -> str:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT external_user_id FROM identities WHERE role = 'agent' AND is_active = 1 LIMIT 1").fetchone()
        return row[0] if row else "agent-001"
    finally:
        conn.close()

def run_test_entry(skill: str, fixture: Path, db_path: Path) -> dict:
    """Replay one fixture through `scripts/test_skill.py`."""

    payload = _load_fixture(fixture)
    _inject_agent_id(db_path, payload)

    with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False) as f:
        json.dump(payload, f)
        tmp_path = f.name

    try:
        result = subprocess.run(
            [
                "python3",
                str(TEST_ENTRY),
                "--skill",
                skill,
                "--fixture",
                tmp_path,
                "--db-path",
                str(db_path),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)
    finally:
        os.remove(tmp_path)


def run_prod_entry(skill: str, payload: dict, db_path: Path) -> dict:
    """Run the stdin prod entrypoint and decode the JSON result."""

    normalized = copy.deepcopy(payload)
    normalized.setdefault("runtime", {})
    normalized["runtime"]["db_path"] = str(db_path)
    _inject_agent_id(db_path, normalized)
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
    """Seed one room SKU and one quantity SKU, then create a draft order."""

    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)
    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)
    run_prod_entry("orders", _load_fixture(ORDERS_CREATE_FIXTURE), db_path)


class PaymentsRuntimeTest(unittest.TestCase):
    def test_pending_payment_cancel_releases_reservations(self) -> None:
        """Release quantity and nightly holds when an owner cancels pending payment."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "payments.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)
            run_test_entry("payments", PAYMENTS_CALLER_CREATE_FIXTURE, db_path)

            cancelled = run_test_entry("orders", ORDERS_OWNER_CANCEL_FIXTURE, db_path)

            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(cancelled["order"]["status"], "cancelled")

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                movement_counts = {
                    row["movement_type"]: int(row["movement_count"])
                    for row in conn.execute(
                        """
                        SELECT movement_type, COUNT(*) AS movement_count
                        FROM inventory_movements
                        GROUP BY movement_type
                        ORDER BY movement_type
                        """
                    ).fetchall()
                }
                deluxe = conn.execute(
                    "SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'"
                ).fetchone()
                minibar = conn.execute(
                    "SELECT * FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'"
                ).fetchone()
                deluxe_sellable = get_sellable_quantity(
                    conn,
                    deluxe,
                    inventory_date=date.fromisoformat("2099-07-02"),
                )
                minibar_sellable = get_sellable_quantity(conn, minibar)
            finally:
                conn.close()

            self.assertEqual(movement_counts["reserve"], 4)
            self.assertEqual(movement_counts["release"], 4)
            self.assertEqual(deluxe_sellable, 6)
            self.assertEqual(minibar_sellable, 24)

    def test_caller_can_create_link_confirm_paid_and_owner_can_refund(self) -> None:
        """Run the full v1 mock loop with caller-triggered pay steps and owner refund."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "payments.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)

            created = run_test_entry("payments", PAYMENTS_CALLER_CREATE_FIXTURE, db_path)
            confirmed = run_test_entry("payments", PAYMENTS_CALLER_CONFIRM_FIXTURE, db_path)

            self.assertEqual(created["status"], "created")
            self.assertEqual(
                created["payment"]["payment_reference"], "mock-pay-po-1001-001"
            )
            self.assertEqual(created["payment"]["status"], "pending")
            self.assertEqual(created["order"]["status"], "pending_payment")
            self.assertEqual(created["inventory_actions"]["reserve_movement_count"], 4)

            self.assertEqual(confirmed["status"], "paid")
            self.assertEqual(confirmed["payment"]["status"], "paid")
            self.assertEqual(confirmed["order"]["status"], "paid")
            self.assertEqual(confirmed["inventory_actions"]["movement_count"], 4)
            self.assertEqual(confirmed["inventory_actions"]["quantity_stock_updates"], 1)

            stock_after_commit = run_prod_entry(
                "inventory",
                {
                    "channel": "telegram",
                    "command_code": "inventory.show_stock",
                    "params": {
                        "sku_code": "DELUXE-SEAVIEW-KING",
                        "date_from": "2099-07-01",
                        "date_to": "2099-07-03",
                    },
                    "user": {"external_user_id": "owner-001", "username": "alice"},
                },
                db_path,
            )

            self.assertEqual(
                [row["sellable_quantity"] for row in stock_after_commit["sku"]["date_inventory"]],
                [5, 5, 5],
            )
            self.assertEqual(
                stock_after_commit["sku"]["requested_window_sellable_quantity"], 5
            )

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                deluxe = conn.execute(
                    "SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'"
                ).fetchone()
                deluxe_sellable_after_commit = get_sellable_quantity(
                    conn,
                    deluxe,
                    inventory_date=date.fromisoformat("2099-07-02"),
                )
                override_rows = conn.execute(
                    """
                    SELECT inventory_date, stock_quantity_override, sellable_status_override, reason
                    FROM sku_date_overrides
                    WHERE sku_id = (SELECT id FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING')
                    ORDER BY inventory_date ASC
                    """
                ).fetchall()
            finally:
                conn.close()

            self.assertEqual(deluxe_sellable_after_commit, 5)
            self.assertEqual(len(override_rows), 3)
            for row in override_rows:
                self.assertEqual(int(row["stock_quantity_override"]), 5)
                self.assertIsNone(row["sellable_status_override"])
                self.assertEqual(row["reason"], "system_commit")

            refunded = run_test_entry("payments", PAYMENTS_REFUND_FIXTURE, db_path)

            self.assertEqual(refunded["status"], "refunded")
            self.assertEqual(refunded["payment"]["status"], "refunded")
            self.assertEqual(refunded["payment"]["refund_reference"], "refund-po-1001-001")
            self.assertEqual(refunded["order"]["status"], "refunded")
            self.assertEqual(refunded["inventory_actions"]["movement_count"], 3)
            self.assertEqual(refunded["inventory_actions"]["quantity_stock_updates"], 0)

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                deluxe = conn.execute(
                    "SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'"
                ).fetchone()
                minibar = conn.execute(
                    "SELECT * FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'"
                ).fetchone()
                order = conn.execute(
                    """
                    SELECT status, reserved_until, paid_at, refunded_at
                    FROM orders
                    WHERE order_number = 'PO-1001'
                    """
                ).fetchone()
                payment = conn.execute(
                    """
                    SELECT status, provider_reference, paid_at, refunded_at
                    FROM payments
                    WHERE order_id = (SELECT id FROM orders WHERE order_number = 'PO-1001')
                    ORDER BY id DESC
                    LIMIT 1
                    """
                ).fetchone()
                movement_counts = {
                    row["movement_type"]: int(row["movement_count"])
                    for row in conn.execute(
                        """
                        SELECT movement_type, COUNT(*) AS movement_count
                        FROM inventory_movements
                        GROUP BY movement_type
                        ORDER BY movement_type
                        """
                    ).fetchall()
                }
                deluxe_sellable_after_refund = get_sellable_quantity(
                    conn,
                    deluxe,
                    inventory_date=date.fromisoformat("2099-07-02"),
                )
                minibar_sellable_after_refund = get_sellable_quantity(conn, minibar)
                override_count = conn.execute(
                    """
                    SELECT COUNT(*) AS row_count
                    FROM sku_date_overrides
                    WHERE sku_id = (SELECT id FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING')
                    """
                ).fetchone()
                payment_audit_rows = conn.execute(
                    """
                    SELECT event_type, actor_type, actor_id, payload_json
                    FROM audit_events
                    WHERE event_type IN (
                        'payments.payment_link_created',
                        'payments.payment_paid',
                        'payments.payment_refunded',
                        'orders.order_status_changed'
                    )
                    ORDER BY id ASC
                    """
                ).fetchall()
            finally:
                conn.close()

            self.assertEqual(order["status"], "refunded")
            self.assertIsNone(order["reserved_until"])
            self.assertIsNotNone(order["paid_at"])
            self.assertIsNotNone(order["refunded_at"])
            self.assertEqual(payment["status"], "refunded")
            self.assertIsNotNone(payment["paid_at"])
            self.assertIsNotNone(payment["refunded_at"])
            self.assertEqual(movement_counts["reserve"], 4)
            self.assertEqual(movement_counts["commit"], 4)
            self.assertEqual(movement_counts["refund_restock"], 3)
            self.assertEqual(int(minibar["stock_quantity"]), 23)
            self.assertEqual(minibar_sellable_after_refund, 23)
            self.assertEqual(deluxe_sellable_after_refund, 6)
            self.assertEqual(int(override_count["row_count"]), 0)
            agent_id = _get_agent_id(db_path)
            self.assertEqual(
                [
                    (row["event_type"], row["actor_type"], row["actor_id"])
                    for row in payment_audit_rows
                ],
                [
                    (
                        "payments.payment_link_created",
                        "caller",
                        f"telegram:{agent_id}",
                    ),
                    (
                        "orders.order_status_changed",
                        "caller",
                        f"telegram:{agent_id}",
                    ),
                    ("payments.payment_paid", "caller", f"telegram:{agent_id}"),
                    (
                        "orders.order_status_changed",
                        "caller",
                        f"telegram:{agent_id}",
                    ),
                    ("payments.payment_refunded", "owner", "owner-001"),
                    ("orders.order_status_changed", "owner", "owner-001"),
                ],
            )
            for audit_row in payment_audit_rows[:4]:
                self.assertEqual(
                    json.loads(audit_row["payload_json"])["actor_identity"],
                    {
                        "channel": "telegram",
                        "external_user_id": agent_id,
                        "auth_identity_model": "caller_identity",
                    },
                )
            for audit_row in payment_audit_rows[4:]:
                self.assertNotIn(
                    "actor_identity",
                    json.loads(audit_row["payload_json"]),
                )

    def test_payment_commands_are_idempotent_by_their_frozen_anchors(self) -> None:
        """Replay the same create/pay/refund anchors without duplicating side effects."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "payments.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)

            first_create = run_test_entry("payments", PAYMENTS_CALLER_CREATE_FIXTURE, db_path)
            replay_create = run_test_entry("payments", PAYMENTS_CALLER_CREATE_FIXTURE, db_path)
            first_confirm = run_test_entry("payments", PAYMENTS_CALLER_CONFIRM_FIXTURE, db_path)
            replay_confirm = run_test_entry("payments", PAYMENTS_CALLER_CONFIRM_FIXTURE, db_path)
            first_refund = run_test_entry("payments", PAYMENTS_REFUND_FIXTURE, db_path)
            replay_refund = run_test_entry("payments", PAYMENTS_REFUND_FIXTURE, db_path)

            self.assertEqual(first_create["status"], "created")
            self.assertEqual(replay_create["status"], "created")
            self.assertTrue(replay_create["idempotent_replay"])
            self.assertEqual(
                first_create["payment"]["payment_reference"],
                replay_create["payment"]["payment_reference"],
            )

            self.assertEqual(first_confirm["status"], "paid")
            self.assertEqual(replay_confirm["status"], "paid")
            self.assertTrue(replay_confirm["idempotent_replay"])

            self.assertEqual(first_refund["status"], "refunded")
            self.assertEqual(replay_refund["status"], "refunded")
            self.assertTrue(replay_refund["idempotent_replay"])

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                movement_counts = {
                    row["movement_type"]: int(row["movement_count"])
                    for row in conn.execute(
                        """
                        SELECT movement_type, COUNT(*) AS movement_count
                        FROM inventory_movements
                        GROUP BY movement_type
                        ORDER BY movement_type
                        """
                    ).fetchall()
                }
                payment_count = conn.execute(
                    "SELECT COUNT(*) FROM payments"
                ).fetchone()[0]
            finally:
                conn.close()

            self.assertEqual(payment_count, 1)
            self.assertEqual(movement_counts["reserve"], 4)
            self.assertEqual(movement_counts["commit"], 4)
            self.assertEqual(movement_counts["refund_restock"], 3)

    def test_expired_pending_payment_is_cancelled_and_released_before_confirm(self) -> None:
        """Expire a pending payment hold and reject later paid confirmation."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "payments.sqlite3"
            setup_owner(db_path)
            seed_orders_sample(db_path)
            run_test_entry("payments", PAYMENTS_CALLER_CREATE_FIXTURE, db_path)

            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    """
                    UPDATE orders
                    SET reserved_until = datetime('now', '-5 minutes')
                    WHERE order_number = 'PO-1001'
                    """
                )
                conn.commit()
            finally:
                conn.close()

            expired_confirm = run_test_entry("payments", PAYMENTS_CALLER_CONFIRM_FIXTURE, db_path)

            self.assertEqual(expired_confirm["status"], "invalid_state")
            self.assertIn("order=cancelled", expired_confirm["reply"])

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                order = conn.execute(
                    """
                    SELECT status, reserved_until, cancelled_at
                    FROM orders
                    WHERE order_number = 'PO-1001'
                    """
                ).fetchone()
                movement_counts = {
                    row["movement_type"]: int(row["movement_count"])
                    for row in conn.execute(
                        """
                        SELECT movement_type, COUNT(*) AS movement_count
                        FROM inventory_movements
                        GROUP BY movement_type
                        ORDER BY movement_type
                        """
                    ).fetchall()
                }
                deluxe = conn.execute(
                    "SELECT * FROM skus WHERE sku_code = 'DELUXE-SEAVIEW-KING'"
                ).fetchone()
                minibar = conn.execute(
                    "SELECT * FROM skus WHERE sku_code = 'MINIBAR-SNACK-BOX'"
                ).fetchone()
                deluxe_sellable = get_sellable_quantity(
                    conn,
                    deluxe,
                    inventory_date=date.fromisoformat("2099-07-02"),
                )
                minibar_sellable = get_sellable_quantity(conn, minibar)
            finally:
                conn.close()

            self.assertEqual(order["status"], "cancelled")
            self.assertIsNone(order["reserved_until"])
            self.assertIsNotNone(order["cancelled_at"])
            self.assertEqual(movement_counts["reserve"], 4)
            self.assertEqual(movement_counts["release"], 4)
            self.assertEqual(deluxe_sellable, 6)
            self.assertEqual(minibar_sellable, 24)


if __name__ == "__main__":
    unittest.main()
