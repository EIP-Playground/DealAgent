"""Integration coverage for the first executable CRM runtime slice."""

from __future__ import annotations

import copy
import json
import os
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
CRM_LOG_INQUIRY_FIXTURE = (
    ROOT / "tests" / "fixtures" / "crm_caller_log_inquiry_deluxe_room.json"
)
CRM_LOG_REPLY_FIXTURE = (
    ROOT / "tests" / "fixtures" / "crm_caller_log_reply_deluxe_room.json"
)
CRM_SHOW_HISTORY_FIXTURE = (
    ROOT / "tests" / "fixtures" / "crm_owner_show_history_customer_001.json"
)
CRM_GET_RESPONSE_CONTEXT_FIXTURE = (
    ROOT / "tests" / "fixtures" / "crm_caller_get_response_context_customer_001.json"
)
CRM_UPSERT_SUMMARY_FIXTURE = (
    ROOT / "tests" / "fixtures" / "crm_caller_upsert_customer_summary_customer_001.json"
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


def seed_catalog(db_path: Path) -> None:
    """Seed one date-based SKU used across CRM tests."""

    run_prod_entry("catalog", _load_fixture(CATALOG_ADD_DELUXE_FIXTURE), db_path)


class CrmRuntimeTest(unittest.TestCase):
    def test_log_inquiry_reply_and_show_history_persist_customer_and_audit(self) -> None:
        """Create inbound/outbound CRM rows, reuse the customer, and read history."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "crm.sqlite3"
            setup_owner(db_path)
            seed_catalog(db_path)

            inquiry = run_test_entry("crm", CRM_LOG_INQUIRY_FIXTURE, db_path)
            reply = run_test_entry("crm", CRM_LOG_REPLY_FIXTURE, db_path)
            history = run_test_entry("crm", CRM_SHOW_HISTORY_FIXTURE, db_path)

            self.assertEqual(inquiry["status"], "logged")
            self.assertEqual(inquiry["conversation"]["direction"], "inbound")
            self.assertEqual(reply["status"], "logged")
            self.assertEqual(reply["conversation"]["direction"], "outbound")
            self.assertEqual(history["status"], "listed")
            self.assertTrue(history["customer_exists"])
            self.assertEqual(history["conversation_count"], 2)
            self.assertEqual(history["conversations"][0]["direction"], "inbound")
            self.assertEqual(history["conversations"][1]["direction"], "outbound")
            self.assertEqual(
                history["conversations"][0]["primary_sku_ref"]["sku_code"],
                "DELUXE-SEAVIEW-KING",
            )
            self.assertEqual(
                history["conversations"][0]["primary_sku_ref"]["reference_source"],
                "conversation_history",
            )

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                customer_count = conn.execute(
                    """
                    SELECT COUNT(*) AS row_count
                    FROM customers
                    WHERE channel = 'telegram' AND external_user_id = 'customer-001'
                    """
                ).fetchone()["row_count"]
                conversation_rows = conn.execute(
                    """
                    SELECT direction, message_text, summary
                    FROM conversations
                    ORDER BY id ASC
                    """
                ).fetchall()
                audit_rows = conn.execute(
                    """
                    SELECT event_type, actor_type, actor_id, payload_json
                    FROM audit_events
                    WHERE event_type LIKE 'crm.%'
                    ORDER BY id ASC
                    """
                ).fetchall()
            finally:
                conn.close()

            self.assertEqual(int(customer_count), 1)
            self.assertEqual(len(conversation_rows), 2)
            self.assertEqual(conversation_rows[0]["direction"], "inbound")
            self.assertEqual(conversation_rows[1]["direction"], "outbound")
            agent_id = _get_agent_id(db_path)
            self.assertEqual(
                [row["event_type"] for row in audit_rows],
                ["crm.inquiry_logged", "crm.reply_logged"],
            )
            self.assertEqual(
                [row["actor_type"] for row in audit_rows],
                ["caller", "caller"],
            )
            self.assertEqual(
                [row["actor_id"] for row in audit_rows],
                [f"telegram:{agent_id}", f"telegram:{agent_id}"],
            )
            self.assertEqual(
                json.loads(audit_rows[0]["payload_json"])["actor_identity"],
                {
                    "channel": "telegram",
                    "external_user_id": agent_id,
                    "auth_identity_model": "caller_identity",
                },
            )

    def test_upsert_summary_and_response_context_use_current_sku_snapshot(self) -> None:
        """Return summary, recent history, and date-aware availability in context."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "crm.sqlite3"
            setup_owner(db_path)
            seed_catalog(db_path)
            run_test_entry("crm", CRM_LOG_INQUIRY_FIXTURE, db_path)

            first_summary = run_test_entry("crm", CRM_UPSERT_SUMMARY_FIXTURE, db_path)
            replacement_summary = run_prod_entry(
                "crm",
                {
                    "channel": "telegram",
                    "command_code": "crm.upsert_customer_summary",
                    "params": {
                        "customer": {
                            "external_user_id": "customer-001",
                            "username": "guest-anna",
                        },
                        "summary_json": {
                            "preferred_language": "en",
                            "priority": "vip",
                        },
                    },
                    "user": {
                        "external_user_id": "agent-001",
                        "username": "alice",
                    },
                },
                db_path,
            )
            context = run_test_entry("crm", CRM_GET_RESPONSE_CONTEXT_FIXTURE, db_path)
            forbidden = run_prod_entry(
                "crm",
                {
                    "channel": "telegram",
                    "command_code": "crm.get_response_context",
                    "params": {
                        "customer": {
                            "external_user_id": "customer-001",
                        },
                        "check_in_date": "2099-07-01",
                        "check_out_date": "2099-07-04",
                    },
                    "user": {
                        "external_user_id": "customer-001",
                        "username": "guest-anna",
                    },
                },
                db_path,
            )

            self.assertEqual(first_summary["status"], "updated")
            self.assertEqual(replacement_summary["status"], "updated")
            self.assertEqual(context["status"], "found")
            self.assertTrue(context["customer_exists"])
            self.assertEqual(context["customer"]["channel"], "telegram")
            self.assertEqual(
                context["customer_summary_json"],
                {"preferred_language": "en", "priority": "vip"},
            )
            self.assertEqual(context["context_window_size"], 1)
            self.assertEqual(len(context["recent_conversations"]), 1)
            self.assertEqual(
                context["primary_sku_ref"]["sku_code"],
                "DELUXE-SEAVIEW-KING",
            )
            self.assertEqual(
                context["primary_sku_ref"]["reference_source"],
                "conversation_history",
            )
            self.assertEqual(
                context["current_sku_snapshot"]["snapshot_source"],
                "catalog_live_read",
            )
            self.assertFalse(context["current_sku_snapshot"]["is_historical_truth"])
            self.assertEqual(
                context["current_sku_snapshot"]["sku"]["sku_code"],
                "DELUXE-SEAVIEW-KING",
            )
            self.assertEqual(
                context["current_sku_snapshot"]["sku"]["availability_status"],
                "available",
            )
            self.assertEqual(
                context["current_sku_snapshot"]["sku"]["check_in_date"],
                "2099-07-01",
            )
            self.assertEqual(
                context["current_sku_snapshot"]["sku"]["check_out_date"],
                "2099-07-04",
            )
            self.assertEqual(forbidden["status"], "forbidden")

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                summary_audit = conn.execute(
                    """
                    SELECT actor_type, actor_id, payload_json
                    FROM audit_events
                    WHERE event_type = 'crm.customer_summary_upserted'
                    ORDER BY id DESC
                    LIMIT 1
                    """
                ).fetchone()
            finally:
                conn.close()

            assert summary_audit is not None
            agent_id = _get_agent_id(db_path)
            self.assertEqual(summary_audit["actor_type"], "caller")
            self.assertEqual(summary_audit["actor_id"], f"telegram:{agent_id}")
            self.assertEqual(
                json.loads(summary_audit["payload_json"])["actor_identity"],
                {
                    "channel": "telegram",
                    "external_user_id": agent_id,
                    "auth_identity_model": "caller_identity",
                },
            )

    def test_show_history_empty_and_customer_reads_are_forbidden(self) -> None:
        """Keep empty reads stable while blocking customer-facing CRM history access."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "crm.sqlite3"
            setup_owner(db_path)

            empty = run_prod_entry(
                "crm",
                {
                    "channel": "telegram",
                    "command_code": "crm.show_history",
                    "params": {
                        "customer": {
                            "external_user_id": "customer-404",
                        }
                    },
                    "user": {
                        "external_user_id": "owner-001",
                        "username": "alice",
                    },
                },
                db_path,
            )
            forbidden = run_prod_entry(
                "crm",
                {
                    "channel": "telegram",
                    "command_code": "crm.show_history",
                    "params": {
                        "customer": {
                            "external_user_id": "customer-404",
                        }
                    },
                    "user": {
                        "external_user_id": "customer-404",
                        "username": "guest-missing",
                    },
                },
                db_path,
            )

            self.assertEqual(empty["status"], "listed")
            self.assertFalse(empty["customer_exists"])
            self.assertEqual(empty["conversation_count"], 0)
            self.assertEqual(empty["conversations"], [])
            self.assertEqual(forbidden["status"], "forbidden")

    def test_context_separates_historical_sku_ref_from_current_catalog_snapshot(self) -> None:
        """Keep the historical SKU reference stable while catalog data can evolve."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "crm.sqlite3"
            setup_owner(db_path)
            seed_catalog(db_path)
            inquiry_payload = _load_fixture(CRM_LOG_INQUIRY_FIXTURE)
            run_prod_entry("crm", inquiry_payload, db_path)

            before = run_test_entry("crm", CRM_GET_RESPONSE_CONTEXT_FIXTURE, db_path)
            run_prod_entry(
                "catalog",
                {
                    "channel": "telegram",
                    "command_code": "catalog.update_details",
                    "params": {
                        "sku_code": "DELUXE-SEAVIEW-KING",
                        "title": "Deluxe Seaview King Renovated",
                    },
                    "user": {
                        "external_user_id": "owner-001",
                        "username": "alice",
                    },
                },
                db_path,
            )
            after = run_test_entry("crm", CRM_GET_RESPONSE_CONTEXT_FIXTURE, db_path)

            self.assertEqual(
                before["primary_sku_ref"]["source_conversation_id"],
                after["primary_sku_ref"]["source_conversation_id"],
            )
            self.assertEqual(
                before["current_sku_snapshot"]["snapshot_source"],
                "catalog_live_read",
            )
            self.assertEqual(
                before["current_sku_snapshot"]["sku"]["title"],
                "Deluxe Seaview King",
            )
            self.assertEqual(
                after["current_sku_snapshot"]["sku"]["title"],
                "Deluxe Seaview King Renovated",
            )
            self.assertEqual(
                after["recent_conversations"][0]["message_text"],
                inquiry_payload["params"]["message_text"],
            )
            self.assertEqual(
                after["recent_conversations"][0]["summary"],
                inquiry_payload["params"]["summary"],
            )


if __name__ == "__main__":
    unittest.main()
