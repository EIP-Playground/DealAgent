"""Integration coverage for the onboarding skill entrypoints."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.db.sqlite import record_audit_event as persist_audit_event
from scripts.lib.onboarding import handle_onboarding


ROOT = Path(__file__).resolve().parents[2]
TEST_ENTRY = ROOT / "scripts" / "test_skill.py"
PROD_ENTRY = ROOT / "scripts" / "run_skill.py"
FIRST_FIXTURE = ROOT / "tests" / "fixtures" / "onboarding_first_setup.json"
SECOND_FIXTURE = ROOT / "tests" / "fixtures" / "onboarding_second_user.json"


def run_test_entry(fixture: Path, db_path: Path) -> dict:
    """Run the local fixture-based entrypoint and decode its JSON response.

    Args:
        fixture: Path to the normalized JSON fixture file.
        db_path: Temporary SQLite file path injected into the runtime payload.

    Returns:
        Parsed JSON response emitted by `scripts/test_skill.py`.
    """
    result = subprocess.run(
        [
            "python3",
            str(TEST_ENTRY),
            "--skill",
            "onboarding",
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


def run_prod_entry(fixture: Path, db_path: Path) -> dict:
    """Run the prod-style stdin entrypoint and decode its JSON response.

    Args:
        fixture: Path to the normalized JSON fixture file used as stdin payload.
        db_path: Temporary SQLite file path injected into the payload.

    Returns:
        Parsed JSON response emitted by `scripts/run_skill.py`.
    """
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    payload.setdefault("runtime", {})
    payload["runtime"]["db_path"] = str(db_path)

    result = subprocess.run(
        [
            "python3",
            str(PROD_ENTRY),
            "--skill",
            "onboarding",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        input=json.dumps(payload),
    )
    return json.loads(result.stdout)


class OnboardingEntryTest(unittest.TestCase):
    def _context(
        self,
        db_path: Path,
        *,
        external_user_id: str = "owner-001",
        username: str = "alice",
    ) -> dict:
        """Build a normalized onboarding context for direct handler tests."""

        return {
            "channel": "telegram",
            "command_code": "onboarding.setup_suite",
            "runtime": {"db_path": str(db_path)},
            "user": {
                "external_user_id": external_user_id,
                "username": username,
            },
        }

    def test_test_entry_first_setup_creates_database_and_records(self) -> None:
        """Verify the fixture entrypoint performs first-time setup and persists core rows."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "purr_suite_test.sqlite3"

            result = run_test_entry(FIRST_FIXTURE, db_path)

            self.assertEqual(result["status"], "initialized")
            self.assertTrue(db_path.exists())

            conn = sqlite3.connect(db_path)
            try:
                owner_count = conn.execute("SELECT COUNT(*) FROM identities WHERE role = 'owner'").fetchone()[0]
                config_count = conn.execute("SELECT COUNT(*) FROM business_config").fetchone()[0]
                audit_count = conn.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
            finally:
                conn.close()

            self.assertEqual(owner_count, 1)
            self.assertGreaterEqual(config_count, 4)
            self.assertGreaterEqual(audit_count, 2)

    def test_run_entry_first_setup_reads_stdin_payload(self) -> None:
        """Confirm the prod-style stdin entrypoint initializes onboarding from JSON input."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "purr_suite_test.sqlite3"

            result = run_prod_entry(FIRST_FIXTURE, db_path)

            self.assertEqual(result["status"], "initialized")
            self.assertTrue(db_path.exists())

    def test_same_owner_setup_is_idempotent_via_run_entry(self) -> None:
        """Return idempotent when the already-paired owner repeats setup."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "purr_suite_test.sqlite3"

            first = run_prod_entry(FIRST_FIXTURE, db_path)
            second = run_prod_entry(FIRST_FIXTURE, db_path)

            self.assertEqual(first["status"], "initialized")
            self.assertEqual(second["status"], "idempotent")

            conn = sqlite3.connect(db_path)
            try:
                owner_count = conn.execute("SELECT COUNT(*) FROM identities WHERE role = 'owner'").fetchone()[0]
            finally:
                conn.close()

            self.assertEqual(owner_count, 1)

    def test_second_owner_is_rejected_via_run_entry(self) -> None:
        """Reject setup attempts from a second owner once one owner is already paired."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "purr_suite_test.sqlite3"

            run_prod_entry(FIRST_FIXTURE, db_path)
            rejected = run_prod_entry(SECOND_FIXTURE, db_path)

            self.assertEqual(rejected["status"], "rejected")

            conn = sqlite3.connect(db_path)
            try:
                owner_count = conn.execute("SELECT COUNT(*) FROM identities WHERE role = 'owner'").fetchone()[0]
            finally:
                conn.close()

            self.assertEqual(owner_count, 1)

    def test_legacy_slash_command_is_ignored(self) -> None:
        """Ignore the legacy slash command now that onboarding uses command codes."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "purr_suite_test.sqlite3"
            payload = {
                "channel": "telegram",
                "command_code": "/setup_purrfect_suite",
                "user": {"external_user_id": "owner-001", "username": "alice"},
                "runtime": {"db_path": str(db_path)},
            }

            result = subprocess.run(
                [
                    "python3",
                    str(PROD_ENTRY),
                    "--skill",
                    "onboarding",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
                input=json.dumps(payload),
            )
            response = json.loads(result.stdout)

            self.assertEqual(response["status"], "ignored")
            self.assertFalse(db_path.exists())

    def test_first_setup_rolls_back_if_owner_paired_audit_fails(self) -> None:
        """Roll back first-time setup if the owner-paired audit write fails."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "purr_suite_test.sqlite3"

            def failing_audit(conn, **kwargs):
                if kwargs["event_type"] == "onboarding.owner_paired":
                    raise RuntimeError("forced audit failure")
                return persist_audit_event(conn, **kwargs)

            with patch("scripts.lib.onboarding.record_audit_event", side_effect=failing_audit):
                with self.assertRaisesRegex(RuntimeError, "forced audit failure"):
                    handle_onboarding(self._context(db_path))

            conn = sqlite3.connect(db_path)
            try:
                owner_count = conn.execute("SELECT COUNT(*) FROM identities WHERE role = 'owner'").fetchone()[0]
                config_count = conn.execute("SELECT COUNT(*) FROM business_config").fetchone()[0]
                audit_count = conn.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
            finally:
                conn.close()

            self.assertEqual(owner_count, 0)
            self.assertEqual(config_count, 0)
            self.assertEqual(audit_count, 0)

    def test_idempotent_setup_rolls_back_if_audit_fails(self) -> None:
        """Roll back idempotent setup refreshes when their audit write fails."""

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "purr_suite_test.sqlite3"
            initialized = handle_onboarding(self._context(db_path, username="alice"))
            self.assertEqual(initialized["status"], "initialized")

            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    "DELETE FROM business_config WHERE config_key = 'payment_provider'"
                )
                conn.commit()
            finally:
                conn.close()

            def failing_audit(conn, **kwargs):
                if kwargs["event_type"] == "onboarding.setup_idempotent":
                    raise RuntimeError("forced idempotent audit failure")
                return persist_audit_event(conn, **kwargs)

            with patch("scripts.lib.onboarding.record_audit_event", side_effect=failing_audit):
                with self.assertRaisesRegex(RuntimeError, "forced idempotent audit failure"):
                    handle_onboarding(self._context(db_path, username="alice-updated"))

            conn = sqlite3.connect(db_path)
            try:
                owner = conn.execute("SELECT username FROM identities WHERE id = 1").fetchone()
                payment_provider = conn.execute(
                    "SELECT COUNT(*) FROM business_config WHERE config_key = 'payment_provider'"
                ).fetchone()[0]
                audit_count = conn.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
            finally:
                conn.close()

            self.assertEqual(owner[0], "alice")
            self.assertEqual(payment_provider, 0)
            self.assertEqual(audit_count, 2)


if __name__ == "__main__":
    unittest.main()
