# Archived Python Runtime

This directory preserves the pre-TypeScript Python runtime and Python
integration tests as a soft-delete archive.

Status:

- These files are no longer the active runtime or test entrypoints.
- The active implementation lives under `scripts/**/*.ts` and
  `tests/integration/*.test.ts`.
- The active executable entrypoints are generated into `dist/**/*.js` by
  running `npm run build`.

Archive layout:

- `Archive/python/scripts/`: legacy Python runtime, DB helpers, and CLI entrypoints.
- `Archive/python/tests/integration/`: legacy Python integration tests.

Intent:

- Keep migration history easy to inspect.
- Preserve old behavior references during future parity checks.
- Avoid hard-deleting the Python implementation while the TypeScript rewrite
  stabilizes.
