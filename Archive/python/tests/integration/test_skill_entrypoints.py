"""Failure-contract coverage for prod and local skill entrypoints."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUN_ENTRY = ROOT / "scripts" / "run_skill.py"
TEST_ENTRY = ROOT / "scripts" / "test_skill.py"
ONBOARD_FIXTURE = ROOT / "tests" / "fixtures" / "onboarding_first_setup.json"


def _run(command: list[str], *, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    """Execute an entrypoint and capture stdout/stderr without raising."""

    return subprocess.run(
        command,
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        input=input_text,
    )


class SkillEntrypointErrorContractTest(unittest.TestCase):
    def assert_error_envelope(
        self,
        result: subprocess.CompletedProcess[str],
        *,
        error_type: str,
    ) -> dict:
        """Assert a stable error JSON envelope and return the parsed payload."""

        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(result.stdout.strip())
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["error_type"], error_type)
        self.assertIn("reply", payload)
        return payload

    def test_run_skill_requires_skill_flag(self) -> None:
        """Return a stable invalid-cli envelope when --skill is omitted."""

        result = _run(["python3", str(RUN_ENTRY)], input_text="{}")
        payload = self.assert_error_envelope(result, error_type="invalid_cli")
        self.assertIn("--skill is required", payload["reply"])

    def test_run_skill_rejects_unsupported_skill(self) -> None:
        """Return a stable invalid-cli envelope for unsupported prod skills."""

        result = _run(
            ["python3", str(RUN_ENTRY), "--skill", "missing-skill"],
            input_text="{}",
        )
        payload = self.assert_error_envelope(result, error_type="invalid_cli")
        self.assertIn("Unsupported skill", payload["reply"])

    def test_run_skill_rejects_missing_stdin(self) -> None:
        """Reject empty stdin payloads with the documented missing-stdin envelope."""

        result = _run(["python3", str(RUN_ENTRY), "--skill", "onboarding"], input_text="")
        payload = self.assert_error_envelope(result, error_type="missing_stdin")
        self.assertIn("stdin JSON payload is required", payload["reply"])

    def test_run_skill_rejects_invalid_json(self) -> None:
        """Reject malformed stdin JSON with the documented invalid-json envelope."""

        result = _run(["python3", str(RUN_ENTRY), "--skill", "onboarding"], input_text="{")
        payload = self.assert_error_envelope(result, error_type="invalid_json")
        self.assertIn("Invalid JSON payload", payload["reply"])

    def test_run_skill_returns_runtime_error_for_handler_failure(self) -> None:
        """Surface handler failures through the stable runtime-error envelope."""

        payload = {
            "channel": "telegram",
            "command_code": "onboarding.setup_suite",
            "user": {},
        }
        result = _run(
            ["python3", str(RUN_ENTRY), "--skill", "onboarding"],
            input_text=json.dumps(payload),
        )
        payload = self.assert_error_envelope(result, error_type="runtime_error")
        self.assertIn("user.external_user_id is required", payload["reply"])

    def test_test_skill_rejects_unsupported_skill(self) -> None:
        """Return a stable invalid-cli envelope for unsupported local test skills."""

        result = _run(
            [
                "python3",
                str(TEST_ENTRY),
                "--skill",
                "missing-skill",
                "--fixture",
                str(ONBOARD_FIXTURE),
            ]
        )
        payload = self.assert_error_envelope(result, error_type="invalid_cli")
        self.assertIn("Unsupported skill", payload["reply"])

    def test_test_skill_rejects_invalid_fixture_json(self) -> None:
        """Reject malformed fixture JSON with the documented invalid-json envelope."""

        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "broken.json"
            fixture.write_text("{", encoding="utf-8")

            result = _run(
                [
                    "python3",
                    str(TEST_ENTRY),
                    "--skill",
                    "onboarding",
                    "--fixture",
                    str(fixture),
                ]
            )

        payload = self.assert_error_envelope(result, error_type="invalid_json")
        self.assertIn("Invalid fixture JSON", payload["reply"])

    def test_test_skill_returns_runtime_error_for_handler_failure(self) -> None:
        """Surface local fixture handler failures through the runtime-error envelope."""

        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "runtime-error.json"
            fixture.write_text(
                json.dumps(
                    {
                        "channel": "telegram",
                        "command_code": "onboarding.setup_suite",
                        "user": {},
                    }
                ),
                encoding="utf-8",
            )

            result = _run(
                [
                    "python3",
                    str(TEST_ENTRY),
                    "--skill",
                    "onboarding",
                    "--fixture",
                    str(fixture),
                ]
            )

        payload = self.assert_error_envelope(result, error_type="runtime_error")
        self.assertIn("user.external_user_id is required", payload["reply"])


if __name__ == "__main__":
    unittest.main()
