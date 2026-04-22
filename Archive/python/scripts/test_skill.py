"""Local fixture replay entrypoint for Purr Suite skills.

Use this script during development and tests when the input payload already
exists as a JSON fixture file. Success responses mirror the handler JSON,
while predictable entrypoint failures use the same stdout error envelope as the
prod entrypoint.
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
    """Parse CLI input, load a fixture, and dispatch a skill.

    Args:
        None. Input comes from command-line flags.

    Returns:
        Process exit code:
        - `0` when the fixture is loaded and the skill completes successfully
        - `1` when CLI input, fixture JSON, or dispatch fails
    """
    parser = argparse.ArgumentParser(
        description="Replay a local fixture through a Purr Suite skill.",
        add_help=False,
        exit_on_error=False,
    )
    parser.add_argument("--skill")
    parser.add_argument("--fixture", help="Path to a JSON fixture file.")
    parser.add_argument(
        "--db-path",
        help="Override runtime.db_path in the fixture.",
    )

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
    if not args.fixture:
        return _emit_error("invalid_cli", "--fixture is required")

    try:
        payload = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
        payload.setdefault("runtime", {})
        # Tests can safely redirect SQLite into a temp path without changing fixtures.
        if args.db_path:
            payload["runtime"]["db_path"] = args.db_path
        result = dispatch_skill(args.skill, payload)
    except json.JSONDecodeError as exc:
        return _emit_error("invalid_json", f"Invalid fixture JSON: {exc}")
    except Exception as exc:
        return _emit_error("runtime_error", str(exc))

    _emit_json(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
