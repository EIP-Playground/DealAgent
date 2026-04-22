"""Prod skill entrypoint that reads host-normalized JSON from stdin.

OpenClaw or another host process should call this script with a skill name and
pipe a normalized context payload into stdin. Success responses mirror the
handler JSON, while predictable entrypoint failures use a stable error envelope
on stdout so hosts do not need separate stderr parsing logic.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.skill_runner import available_skills, dispatch_skill


def _emit_json(payload: dict[str, object]) -> None:
    """Serialize a JSON payload to stdout using the shared CLI format."""

    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _emit_error(error_type: str, reply: str) -> int:
    """Emit the stable entrypoint error envelope and return a failing exit code."""

    _emit_json(
        {
            "status": "error",
            "error_type": error_type,
            "reply": reply,
        }
    )
    return 1


def main() -> int:
    """Parse CLI input, dispatch a skill, and return a process exit code.

    Args:
        None. Input comes from command-line flags and stdin JSON.

    Returns:
        Process exit code:
        - `0` when the skill runs successfully
        - `1` when CLI input, stdin JSON, or dispatch fails
    """
    parser = argparse.ArgumentParser(
        description="Run a Purr Suite skill with host-normalized JSON from stdin.",
        add_help=False,
        exit_on_error=False,
    )
    parser.add_argument("--skill")

    try:
        args, unknown = parser.parse_known_args()
    except argparse.ArgumentError as exc:
        return _emit_error("invalid_cli", str(exc))

    if unknown:
        return _emit_error("invalid_cli", f"Unknown CLI arguments: {' '.join(unknown)}")
    if not args.skill:
        return _emit_error("invalid_cli", "--skill is required")
    if args.skill not in available_skills():
        return _emit_error("invalid_cli", f"Unsupported skill: {args.skill}")

    raw_payload = sys.stdin.read().strip()
    if not raw_payload:
        return _emit_error("missing_stdin", "stdin JSON payload is required")

    try:
        # Keep the CLI thin: parsing happens here, behavior stays in shared handlers.
        payload = json.loads(raw_payload)
        result = dispatch_skill(args.skill, payload)
    except json.JSONDecodeError as exc:
        return _emit_error("invalid_json", f"Invalid JSON payload: {exc}")
    except Exception as exc:
        return _emit_error("runtime_error", str(exc))

    _emit_json(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
