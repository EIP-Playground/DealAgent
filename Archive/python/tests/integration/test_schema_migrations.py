"""Regression coverage for the squashed single-baseline SQLite schema."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.db.sqlite import apply_migrations


class SchemaMigrationTest(unittest.TestCase):
    def test_single_baseline_creates_current_schema(self) -> None:
        """Create the full v1 schema from the single baseline migration."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "migration.sqlite3"
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")

            try:
                apply_migrations(conn)

                table_names = {
                    row["name"]
                    for row in conn.execute(
                        """
                        SELECT name
                        FROM sqlite_master
                        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                        """
                    ).fetchall()
                }
                self.assertEqual(
                    table_names,
                    {
                        "audit_events",
                        "business_config",
                        "conversations",
                        "customers",
                        "identities",
                        "inventory_movements",
                        "low_stock_alerts",
                        "order_items",
                        "orders",
                        "payments",
                        "schema_migrations",
                        "sku_date_overrides",
                        "skus",
                        "webhook_events",
                    },
                )

                identity_columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(identities)")
                }
                order_columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(orders)")
                }
                order_item_columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(order_items)")
                }
                sku_columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(skus)")
                }
                alert_columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(low_stock_alerts)")
                }

                self.assertIn("role", identity_columns)
                self.assertIn("session_id", order_columns)
                self.assertIn("booking_contact_name", order_columns)
                self.assertIn("booking_contact_phone", order_columns)
                self.assertIn("sku_title", order_item_columns)
                self.assertIn("currency", order_item_columns)
                self.assertIn("check_in_date", order_item_columns)
                self.assertIn("check_out_date", order_item_columns)
                self.assertIn("inventory_mode", sku_columns)
                self.assertIn("inventory_mode", alert_columns)
                self.assertIn("status", alert_columns)

                index_names = {
                    row["name"]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'index'"
                    ).fetchall()
                }
                self.assertIn("idx_identities_single_active", index_names)
                self.assertIn("idx_orders_session_id", index_names)
                self.assertIn("idx_orders_status_reserved_until", index_names)
                self.assertIn("idx_order_items_unique_without_dates", index_names)
                self.assertIn("idx_order_items_unique_with_dates", index_names)
                self.assertIn("idx_low_stock_alerts_sku_date_status", index_names)

                trigger_names = {
                    row["name"]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'trigger'"
                    ).fetchall()
                }
                self.assertIn("trg_identities_updated_at", trigger_names)
                self.assertIn("trg_sku_date_overrides_updated_at", trigger_names)
                self.assertIn("trg_orders_updated_at", trigger_names)

                migrated_versions = conn.execute(
                    "SELECT version FROM schema_migrations ORDER BY version"
                ).fetchall()
                self.assertEqual([row["version"] for row in migrated_versions], ["0001_init.sql"])
            finally:
                conn.close()

    def test_apply_migrations_is_idempotent_for_squashed_baseline(self) -> None:
        """Re-running migrations should preserve data and avoid duplicate versions."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "migration.sqlite3"
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")

            try:
                apply_migrations(conn)
                conn.execute(
                    """
                    INSERT INTO business_config(config_key, config_value_json)
                    VALUES ('enabled_skills', '["onboarding","catalog"]')
                    """
                )
                conn.commit()

                apply_migrations(conn)

                versions = conn.execute(
                    "SELECT version FROM schema_migrations ORDER BY version"
                ).fetchall()
                self.assertEqual([row["version"] for row in versions], ["0001_init.sql"])

                saved = conn.execute(
                    """
                    SELECT config_value_json
                    FROM business_config
                    WHERE config_key = 'enabled_skills'
                    """
                ).fetchone()
                self.assertIsNotNone(saved)
                self.assertEqual(saved["config_value_json"], '["onboarding","catalog"]')
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
