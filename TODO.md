# Purr Suite TODO

## Completed

- [x] Set up repository structure for docs, skills, scripts, tests, and local data.
- [x] Add root guidance in `SKILL.md`.
- [x] Add working context in `Agent.md`.
- [x] Create `TODO.md` for task tracking.
- [x] Add SQLite migration scaffold and Python DB scripts.
- [x] Add local fixture-based onboarding test entry.
- [x] Add first detailed skill design doc for onboarding.
- [x] Add onboarding integration tests.
- [x] Move all Python runtime code out of `skills/`.
- [x] Merge DB runtime logic and migrations into `scripts/db/`.
- [x] Rewrite root and child `SKILL.md` files as actual skill instructions.
- [x] Sync the new structure into `Agent.md` and `README.md`.
- [x] Split skill invocation into `scripts/test_skill.ts` and `scripts/run_skill.ts`.
- [x] Add shared skill dispatch via `scripts/lib/skill_runner.ts`.
- [x] Lock v1 stock semantics: `skus.stock_quantity` means on-hand stock.
- [x] Expand catalog/inventory design docs with reservation and order-item rules.
- [x] Add `orders(status, reserved_until)` index migration for reservation scans.
- [x] Add index visibility to `scripts/dev/db_inspect.ts` via `--show-indexes`.
- [x] Add module-level and function-level usage docstrings to current Python runtime/test files.
- [x] Add `docs/v1/execution-plan/v1-development-plan.md` for the full skill build order.
- [x] Realign root and child `SKILL.md` files to the example-based prod structure, keep only prod-facing runtime facts, and remove test/dev/release-cleanup mentions.
- [x] Add `docs/v1/execution-plan/skill-package-release-cleanup.md` for prod package cleanup.
- [x] Document the unified `scripts/run_skill.ts` stdin JSON contract in root `SKILL.md` only.
- [x] Add `skills/catalog/reference/sku-code-generation.md` as the required reference for auto-generated SKU codes.
- [x] Add shared fiat money formatting in `scripts/lib/money.ts`.
- [x] Create `scripts/lib/catalog.ts`.
- [x] Register catalog in `scripts/lib/skill_runner.ts`.
- [x] Implement owner catalog intents: `catalog.add_sku`, `catalog.update_details`, `catalog.update_price`, `catalog.update_status`, `catalog.archive_sku`, `catalog.show_sku`, `catalog.show_catalog`.
- [x] Add catalog fixtures for owner CRUD and blocked customer reads.
- [x] Add integration tests for catalog owner CRUD, pricing, and initial blocked customer-read paths.
- [x] Add representative catalog fixtures and a `review-catalog` replay preset for manual DB inspection.
- [x] Add schema cleanup migration for owner/customer identity fields and `order_items.currency` backfill.
- [x] Add `skus.inventory_mode` to catalog create flow and expose mode semantics in owner catalog output.
- [x] Switch the default hospitality review dataset to mixed `date_quantity` rooms plus at least one `quantity` SKU.
- [x] Add inventory Phase A runtime with owner intents: `inventory.show_inventory`, `inventory.show_stock`, `inventory.adjust_stock`, `inventory.set_date_stock`, `inventory.show_low_stock`.
- [x] Add `sku_date_overrides` and `low_stock_alerts` schema support.
- [x] Connect customer catalog/product reads to inventory-backed availability.
- [x] Allow `inventory_mode` changes only through Safe Switch via `update inventory mode`.
- [x] Freeze explicit `field=value` reference-key rules for manual/date/automatic inventory actions.
- [x] Switch implemented skills from `message_text` to `command_code` and document the `needs_confirmation` / `operation_id` contract for inventory.
- [x] Expand `docs/v1/execution-plan/skills/seller-bi.md` with metrics over orders/payments and explicit metric semantics.
- [x] Create `scripts/lib/seller_bi.ts` and register `seller-bi` in `scripts/lib/skill_runner.ts`.
- [x] Implement owner-only seller-bi metrics: `seller_bi.sales_today` and `seller_bi.revenue_this_month`.
- [x] Add seller-bi fixtures and integration tests, including refund semantics and multi-currency revenue grouping.

## Next

### Documentation Alignment

- [ ] Keep `docs/v1/database/sqlite-design.md` aligned with future migrations and runtime behavior.
- [x] Expand `docs/v1/execution-plan/skills/orders.md` with multi-item order and reservation dependencies.
- [x] Expand `docs/v1/execution-plan/skills/payments.md` with commit/release/reconciliation hooks.
- [ ] Expand `docs/v1/execution-plan/skills/crm.md` with SKU lookup handoff to catalog.
- [x] Clarify that natural-language understanding and session orchestration belong to the OpenClaw host layer, not individual skill runtimes.

### Schema / DB Foundation

- [ ] Extend `scripts/dev/db_inspect.ts` with query-plan or migration-debug output if deeper DB diagnostics become necessary.
- [ ] Add reservation-focused indexes only when a concrete query pattern is introduced beyond `status + reserved_until`.
- [ ] Keep migration filenames monotonic and document each new index in `sqlite-design.md`.
- [ ] Add more migration regression tests when order/payment schema starts evolving beyond the current cleanup migration.

### Catalog Implementation

- [x] Complete customer intents: show catalog, show product, after inventory availability is implemented.
- [x] Restrict customer catalog output to `sellable_status = active`.
- [x] Read availability through inventory logic instead of duplicating stock rules inside catalog.
- [x] Allow `inventory_mode` changes only through Safe Switch and route exact availability through inventory instead of catalog shortcuts.
- [x] Write `audit_events` for `catalog.sku_created`, `catalog.sku_updated`, and `catalog.sku_archived`.
- [x] Add more fixtures for customer-facing catalog output after inventory is available.
- [x] Add integration tests for customer-facing catalog output once inventory is ready.

### Inventory Implementation

- [x] Create `scripts/lib/inventory.ts`.
- [x] Add schema and runtime support for `quantity` and `date_quantity` inventory modes.
- [x] Implement `expire_reservations(...)` with transaction-safe lazy expiry.
- [x] Implement `get_reserved_quantity(...)`.
- [x] Implement `get_sellable_quantity(...)`.
- [x] Implement `adjust_stock(...)` for owner-side manual adjustments.
- [x] Implement `set_date_stock(...)` for sparse date overrides on `date_quantity`.
- [x] Add low-stock detection lifecycle plus `scripts/run_low_stock_scan.ts`.
- [x] Implement `reserve_order_items(...)`.
- [x] Implement `release_order_reservation(...)`.
- [x] Implement `commit_order_reservation(...)`.
- [x] Implement `restock_refunded_order(...)`.
- [x] Attach stay-date data to `order_items` so `date_quantity` reservations can become real nightly holds.
- [x] Ensure reserve/release/commit/refund actions write `inventory_movements` with stable reference keys.
- [x] Add fixtures for reserve, expiry release, payment commit, and refund restock flows.
- [x] Add integration tests for reservation expiry and payment-driven inventory actions.
- [ ] Add stronger oversell protection and failure-recovery coverage for order/payment races.

### Orders / Payments Implementation

- [x] Register `orders` runtime in `scripts/lib/skill_runner.ts`.
- [x] Implement `orders.create_session_draft`, query, and cancel flows.
- [x] Register `payments` runtime in `scripts/lib/skill_runner.ts`.
- [x] Implement v1 mock payment commands: create link, confirm paid, refund.
- [x] Persist and enforce the idempotency anchors `payment_request_id`, `payment_reference`, and `refund_reference`.
- [ ] Add real provider adapter and webhook reconciliation flow.

### Code Hygiene

- [ ] Keep new Python files aligned with the module/function docstring standard.
- [ ] Keep transaction boundaries, idempotency paths, and inventory-consistency rules explicitly commented in new logic.

### Tooling / Integration

- [x] Add SQLite init/inspect helpers under `scripts/dev/`.
- [x] Add `scripts/dev/load_fixture.ts` to replay fixtures into a persistent SQLite file.
- [x] Add one end-to-end demo replay preset covering onboarding -> catalog -> orders -> payments -> refund -> BI.
- [ ] Add more development-only helper scripts under `scripts/dev/` when workflows become concrete.
- [ ] Add real scripts under `scripts/reports/` when report/export workflows become concrete.
- [ ] Add more fixture payloads for multi-step flows beyond the current `review-catalog` seed set.
- [ ] Add real OpenClaw integration verification path.

## Notes

- All runnable scripts should stay in Python.
- Development SQLite should stay under `data/dev/`.
- `scripts/db/` now contains shared DB logic and migrations.
- `scripts/lib/` is reserved for non-DB shared logic.
- `scripts/test_skill.ts` is the local fixture replay entrypoint.
- `scripts/run_skill.ts` is the prod entrypoint for host-normalized JSON.
- `scripts/lib/skill_runner.ts` is the shared dispatcher for both entrypoints.
- Prod-facing `SKILL.md` files should only describe `scripts/run_skill.ts --skill <name>` and must not reference `docs/` or DB helper scripts.
- Root `SKILL.md` owns the unified `stdin` JSON contract; child `SKILL.md` files should not duplicate payload structure.
- Skill registration truth comes from `scripts/lib/skill_runner.ts`; `business_config.enabled_skills` does not gate v1 runtime yet.
- `skus.stock_quantity` means on-hand stock; sellable stock must be derived from active reservations.
- `order_items` is the required multi-item order line table, not redundant structure.
- `scripts/dev/` is for development-only helpers.
- `scripts/reports/` is for report/export helpers.
- Any major repo-level decision should also be reflected in `Agent.md`.
