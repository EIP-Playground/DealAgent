"""Integration coverage for the first executable seller-bi runtime slice."""

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
CATALOG_ADD_MINIBAR_FIXTURE = (
    ROOT / "tests" / "fixtures" / "catalog_owner_add_minibar_snack_box.json"
)
ORDERS_CREATE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "orders_customer_create_deluxe_room_and_minibar.json"
)
SELLER_BI_SALES_FIXTURE = (
    ROOT / "tests" / "fixtures" / "seller_bi_owner_sales_today.json"
)
SELLER_BI_REVENUE_FIXTURE = (
    ROOT / "tests" / "fixtures" / "seller_bi_owner_revenue_this_month.json"
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


def seed_usd_catalog(db_path: Path) -> None:
    """Seed the default USD hospitality sample used by seller-bi tests."""

    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)
    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_MINIBAR_FIXTURE), db_path)


def create_paid_order(
    db_path: Path,
    *,
    order_payload: dict,
    payment_request_id: str,
) -> tuple[str, str]:
    """Create one order, create a payment link, confirm it paid, and return ids."""

    created = run_prod_entry("orders", order_payload, db_path)
    order_number = created["order"]["order_number"]
    payment_created = run_prod_entry(
        "payments",
        {
            "channel": "telegram",
            "command_code": "payments.create_payment_link",
            "params": {
                "order_number": order_number,
                "payment_request_id": payment_request_id,
            },
            "user": {
                "external_user_id": "owner-001",
                "username": "alice",
            },
        },
        db_path,
    )
    payment_reference = payment_created["payment"]["payment_reference"]
    run_prod_entry(
        "payments",
        {
            "channel": "telegram",
            "command_code": "payments.confirm_mock_paid",
            "params": {"payment_reference": payment_reference},
            "user": {
                "external_user_id": "owner-001",
                "username": "alice",
            },
        },
        db_path,
    )
    return order_number, payment_reference


def refund_paid_order(db_path: Path, *, order_number: str, refund_reference: str) -> dict:
    """Refund one paid order through the payments runtime."""

    return run_prod_entry(
        "payments",
        {
            "channel": "telegram",
            "command_code": "payments.refund_mock_payment",
            "params": {
                "order_number": order_number,
                "refund_reference": refund_reference,
            },
            "user": {
                "external_user_id": "owner-001",
                "username": "alice",
            },
        },
        db_path,
    )


def set_payment_times(
    db_path: Path,
    *,
    order_number: str,
    payment_reference: str,
    paid_at: str,
    refunded_at: str | None = None,
) -> None:
    """Rewrite paid/refund timestamps so anchored metric tests stay deterministic."""

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            UPDATE orders
            SET paid_at = ?, refunded_at = COALESCE(?, refunded_at)
            WHERE order_number = ?
            """,
            (paid_at, refunded_at, order_number),
        )
        conn.execute(
            """
            UPDATE payments
            SET paid_at = ?, refunded_at = COALESCE(?, refunded_at)
            WHERE provider_reference = ?
            """,
            (paid_at, refunded_at, payment_reference),
        )
        conn.commit()
    finally:
        conn.close()


class SellerBIRuntimeTest(unittest.TestCase):
    def test_owner_can_read_zero_metrics_and_legacy_aliases_still_work(self) -> None:
        """Return empty metrics on a fresh DB and accept legacy hyphenated commands."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "seller-bi.sqlite3"
            setup_owner(db_path)

            sales = run_prod_entry(
                "seller-bi",
                {
                    "channel": "telegram",
                    "command_code": "seller-bi.sales_today",
                    "params": {"anchor_date": "2099-07-02"},
                    "user": {
                        "external_user_id": "owner-001",
                        "username": "alice",
                    },
                },
                db_path,
            )
            revenue = run_test_entry("seller-bi", SELLER_BI_REVENUE_FIXTURE, db_path)

            self.assertEqual(sales["status"], "computed")
            self.assertEqual(sales["metric_code"], "seller_bi.sales_today")
            self.assertEqual(sales["sales_count"], 0)
            self.assertEqual(revenue["status"], "computed")
            self.assertEqual(revenue["currency_count"], 0)
            self.assertFalse(revenue["multi_currency"])
            self.assertEqual(revenue["revenue_rows"], [])

    def test_sales_today_counts_paid_orders_even_if_the_order_is_later_refunded(self) -> None:
        """Keep the daily sales count anchored to paid events, not current paid status."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "seller-bi.sqlite3"
            setup_owner(db_path)
            seed_usd_catalog(db_path)

            order_number, payment_reference = create_paid_order(
                db_path,
                order_payload=_load_fixture(ORDERS_CREATE_FIXTURE),
                payment_request_id="seller-bi-po-1001-001",
            )
            refund_paid_order(
                db_path,
                order_number=order_number,
                refund_reference="seller-bi-refund-po-1001-001",
            )
            set_payment_times(
                db_path,
                order_number=order_number,
                payment_reference=payment_reference,
                paid_at="2099-07-02 10:15:00",
                refunded_at="2099-07-03 09:00:00",
            )

            sales = run_test_entry("seller-bi", SELLER_BI_SALES_FIXTURE, db_path)
            revenue = run_test_entry("seller-bi", SELLER_BI_REVENUE_FIXTURE, db_path)

            self.assertEqual(sales["status"], "computed")
            self.assertEqual(sales["sales_count"], 1)
            self.assertEqual(sales["window_start"], "2099-07-02 00:00:00")
            self.assertEqual(sales["window_end_exclusive"], "2099-07-03 00:00:00")

            self.assertEqual(revenue["status"], "computed")
            self.assertEqual(revenue["currency_count"], 0)
            self.assertEqual(revenue["revenue_rows"], [])

    def test_revenue_this_month_groups_net_paid_revenue_by_currency(self) -> None:
        """Group monthly net paid revenue by currency instead of summing across FX."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "seller-bi.sqlite3"
            setup_owner(db_path)
            seed_usd_catalog(db_path)

            usd_order_number, usd_payment_reference = create_paid_order(
                db_path,
                order_payload=_load_fixture(ORDERS_CREATE_FIXTURE),
                payment_request_id="seller-bi-po-1001-001",
            )
            set_payment_times(
                db_path,
                order_number=usd_order_number,
                payment_reference=usd_payment_reference,
                paid_at="2099-07-02 10:15:00",
            )

            run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.add_sku",
                    "params": {
                        "sku_code": "WELCOME-BENTO-JPY",
                        "title": "Welcome Bento",
                        "price_minor": 3500,
                        "currency": "JPY",
                        "stock_quantity": 30,
                    },
                    "user": {
                        "external_user_id": "owner-001",
                        "username": "alice",
                    },
                },
                db_path,
            )
            jpy_order_number, jpy_payment_reference = create_paid_order(
                db_path,
                order_payload={
                    "channel": "telegram",
                    "command_code": "orders.create_session_draft",
                    "params": {
                        "session_id": "telegram:customer-002:retail-001",
                        "booking_contact": {
                            "guest_name": "Ben",
                            "phone": "13900139000",
                        },
                        "items": [
                            {
                                "sku_code": "WELCOME-BENTO-JPY",
                                "quantity": 2,
                            }
                        ],
                    },
                    "user": {
                        "external_user_id": "customer-002",
                        "username": "guest-ben",
                    },
                },
                payment_request_id="seller-bi-po-1002-001",
            )
            set_payment_times(
                db_path,
                order_number=jpy_order_number,
                payment_reference=jpy_payment_reference,
                paid_at="2099-07-10 19:30:00",
            )

            revenue = run_test_entry("seller-bi", SELLER_BI_REVENUE_FIXTURE, db_path)

            self.assertEqual(revenue["status"], "computed")
            self.assertEqual(revenue["month"], "2099-07")
            self.assertEqual(revenue["currency_count"], 2)
            self.assertTrue(revenue["multi_currency"])
            self.assertEqual(
                revenue["revenue_rows"],
                [
                    {
                        "currency": "JPY",
                        "amount_minor": 7000,
                        "display_amount": "JPY 7000",
                    },
                    {
                        "currency": "USD",
                        "amount_minor": 88500,
                        "display_amount": "USD 885.00",
                    },
                ],
            )

    def test_customer_cannot_query_seller_bi_metrics(self) -> None:
        """Restrict seller-bi metrics to the active owner identity."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "seller-bi.sqlite3"
            setup_owner(db_path)

            forbidden = run_prod_entry(
                "seller-bi",
                {
                    "channel": "telegram",
                    "command_code": "seller_bi.sales_today",
                    "params": {"anchor_date": "2099-07-02"},
                    "user": {
                        "external_user_id": "customer-001",
                        "username": "guest-anna",
                    },
                },
                db_path,
            )

            self.assertEqual(forbidden["status"], "forbidden")


if __name__ == "__main__":
    unittest.main()
