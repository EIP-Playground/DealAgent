# scripts/dev

Development-only TypeScript source entrypoints live here. Runtime commands use
the compiled Node entrypoints under `dist/scripts/dev/`.

Current SQLite policy:

- Schema migrations are squashed into the single baseline `scripts/db/migrations/0001_init.sql`.
- Existing local development databases are disposable; after baseline changes, delete and recreate them instead of expecting in-place upgrade compatibility.
- Repository/development mode keeps SQLite under `data/dev/`, but an installed OpenClaw skill externalizes mutable state to `../../data/<skill-package-name>/` relative to the installed skill package.

Current helpers:

- `init_sqlite`: initialize a local SQLite file and print visible tables
- `db_inspect`: inspect row counts, business config, optional indexes, and audit events
- `load_fixture`: replay one or more fixtures into a chosen SQLite file
- `sync_crm_from_openclaw`: scan `~/.openclaw/agents/*/sessions/*.jsonl` and import Telegram private-chat CRM records
- `load_fixture --preset review-catalog`: seed the shared review DB with onboarding plus a mixed hospitality catalog dataset
- `load_fixture --preset demo-replay`: replay the investor-demo chain from onboarding through refund and seller-bi checks

Runtime scheduling policy:

- `onboarding.setup_suite` no longer touches OpenClaw cron directly
- After installed setup creates the database, follow `skills/onboarding/cron/crm-sync.md` and `skills/onboarding/cron/low-stock-scan.md` to verify or install the two managed OpenClaw cron jobs via the Gateway cron tool (`cron.list` / `cron.add` / `cron.update` / `cron.remove`)
- In installed mode, the cron commands point at the externalized DB path under `~/.openclaw/data/<skill-package-name>/`

Recommended manual review flow after tests pass:

```bash
npx vitest run tests/integration/test_catalog.test.ts tests/integration/test_onboarding.test.ts
npx vitest run tests/integration/test_inventory.test.ts tests/integration/test_skill_entrypoints.test.ts tests/integration/test_schema_migrations.test.ts

node dist/scripts/dev/load_fixture.js --preset review-catalog --fresh \
  --db-path data/dev/purr_suite_dev.sqlite3

node dist/scripts/dev/load_fixture.js --preset demo-replay --fresh \
  --db-path data/dev/purr_suite_demo.sqlite3

node dist/scripts/dev/db_inspect.js --db-path data/dev/purr_suite_dev.sqlite3 \
  --show-audit-events --limit 50

node dist/scripts/sync_crm_from_openclaw.js --mode bootstrap \
  --db-path data/dev/purr_suite_dev.sqlite3

node dist/scripts/sync_crm_from_openclaw.js --mode incremental \
  --db-path data/dev/purr_suite_dev.sqlite3

node dist/scripts/run_low_stock_scan.js --db-path data/dev/purr_suite_dev.sqlite3
```

`load_fixture` defaults to `data/dev/purr_suite_dev.sqlite3`, so the commands
above seed the shared review database used for manual inspection.

The `review-catalog` preset auto-replays `tests/fixtures/onboarding_first_setup.json`
when the target database does not yet contain an active owner, then seeds the
default review database with mixed hospitality fixtures:

- room-type SKUs using `inventory_mode = date_quantity`
- at least one hospitality add-on SKU using `inventory_mode = quantity`
- at least one date override row for a room SKU
- at least one low-stock condition that `node dist/scripts/run_low_stock_scan.js` can emit

The `demo-replay` preset replays a fixed end-to-end path:

- owner setup
- owner catalog + low-stock prep
- customer catalog view
- crm inquiry log + reply log + customer summary upsert
- crm history + response-context reads
- customer draft order
- caller-triggered payment link + paid confirmation
- owner/customer post-payment reads
- owner refund
- seller-bi reads before and after refund

It also inserts development-only timestamp normalization hooks so `seller_bi`
queries anchored to `2099-07-*` return deterministic demo output.
