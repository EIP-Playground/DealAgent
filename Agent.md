# Purr Suite Agent Context

## Project Snapshot

- Project: `purrfect-suite`
- Goal: build Purr Suite as a chat-first commerce/operations solution that can be called by a host agent.
- v1 scope: Telegram channel, shared bot, single owner, local SQLite, modular skills.
- Current implementation focus: onboarding, catalog, inventory, orders, payments mock loop, seller-bi runtime, SQLite schema evolution, and stable host entry contracts.

## Repository Conventions

- `docs/`: product, execution, database, and reference documentation.
- `skills/`: pure Skill packages only. Keep `SKILL.md` and optional references/assets here, but no Python code.
- `scripts/`: the only place for Python code.
- `scripts/db/`: shared DB logic and migrations.
- `scripts/lib/`: non-DB shared Python modules used by entrypoint scripts.
- `scripts/dev/`: development-only helper scripts such as SQLite init/inspect utilities and fixture replay helpers.
- `scripts/reports/`: report and export scripts.
- `tests/`: fixtures, unit tests, integration tests.
- `data/dev/`: local development SQLite files.

## Current Decisions

- Telegram integration is hosted by OpenClaw, not configured inside Purr Suite onboarding.
- Agent should route setup natural language into the canonical onboarding command code `onboarding.setup_suite`.
- The product spec may show conversational setup text, but the execution boundary is: OpenClaw translates that natural language into normalized JSON with a canonical `command_code`, then calls Purr Suite runtime.
- This natural-language understanding rule is not onboarding-specific: intent recognition, session tracking, slot-filling, SKU matching, and follow-up dialogue are shared OpenClaw host responsibilities across all skills.
- Therefore, do not move open-ended natural-language parsing into `onboarding` or any other single skill runtime; skill runtimes should stay machine-oriented and consume normalized JSON only.
- Development testing uses `scripts/test_skill.ts` with fixture JSON.
- Prod invocation uses `scripts/run_skill.ts` with host-normalized JSON from `stdin`.
- `scripts/run_skill.ts` and `scripts/test_skill.ts` should use the same entrypoint contract: success returns the raw handler JSON, while predictable failures return a minimal stdout JSON error envelope plus a non-zero exit code.
- SQLite should be created inside the project directory, defaulting to `data/dev/purr_suite_dev.sqlite3`.
- After a skill's integration tests pass, replay representative fixtures into `data/dev/purr_suite_dev.sqlite3` for manual review before closing the task.
- The preferred review seed path is `node dist/scripts/dev/load_fixture.js --preset review-catalog --fresh --db-path data/dev/purr_suite_dev.sqlite3`.
- `scripts/dev/load_fixture.ts --preset review-catalog` should auto-bootstrap onboarding if the review DB does not yet contain an active owner, then seed the default mixed hospitality catalog review dataset.
- `scripts/dev/load_fixture.ts --preset demo-replay --fresh --db-path data/dev/purr_suite_demo.sqlite3` should replay the end-to-end demo path and normalize demo timestamps before seller-bi reads.
- The default `review-catalog` preset should seed a mixed hospitality dataset: room-type SKUs use `inventory_mode = date_quantity`, while at least one hospitality add-on SKU stays `quantity`.
- The default `review-catalog` preset should also create at least one date override row and at least one low-stock condition so inventory review has something real to inspect.
- `business_config.payment_provider` stays named `payment_provider`, and v1 defaults it to `mock`.
- Root `SKILL.md` input contract now includes `params` as the shared business-parameter container for skill-specific data.
- Root `SKILL.md` should document `command_code` as the unified runtime command field, with onboarding using `onboarding.setup_suite` rather than the old slash command.
- `command_code` is the host-normalized machine command derived from user or owner natural language; it represents the caller's intent, but it is not the raw utterance itself.
- Data tables are shared across skills; skill boundaries split processing logic, not table ownership.
- `skus.stock_quantity` is v1 on-hand stock, not sellable stock.
- v1 keeps inventory semantic A: `skus.stock_quantity` is the current on-hand snapshot, `commit` / `refund_restock` update that snapshot, and available inventory is derived by subtracting only active reservations.
- `skus.price_minor` must be interpreted together with `currency`; user-facing money display should come from a shared formatter rather than ad-hoc string math.
- Active reservation means `orders.status = pending_payment` and `orders.reserved_until > now`; quantities come from `order_items`.
- Expired reservation means `orders.status = pending_payment` and `orders.reserved_until < now`.
- Expired reservations should be released via `inventory_movements.release` with `reason=expired`, and the order should move to `cancelled`.
- `order_items` is required for multi-item orders and for SKU-level reservation/commit/refund actions.
- `owners` and `customers` identity fields should stay narrowed to `external_user_id + username`; do not add `display_name` or `nickname` back.
- `orders.subtotal_minor` should represent the sum of item lines, while v1 keeps `total_minor == subtotal_minor`.
- `order_items` should store `sku_title`, `unit_price_minor`, and `currency` as order-time snapshots; do not use `sku_title_snapshot`.
- Root `SKILL.md` is the top-level prod skill router and should follow the `SKILL-main-example` structure.
- Child `skills/<name>/SKILL.md` files should follow the `SKILL-sub-example` structure.
- `SKILL.md` files are prod-facing only: do not reference `docs/`, do not mention local test/development scripts, do not mention release-cleanup steps, and do not expose DB helper scripts as skill invocation commands.
- `SKILL.md` prose should refer to "你" or "调用方", not assume the caller is OpenClaw.
- Root `SKILL.md` should list each child skill's prod invocation command as `node dist/scripts/run_skill.js --skill <name>`.
- The unified `stdin` JSON contract for `scripts/run_skill.ts` should be documented in root `SKILL.md` only.
- Every child `skills/<name>/SKILL.md` should describe role, routing triggers, the single prod invocation command, current runtime status, and failure handling.
- Child `SKILL.md` files should not repeat or redefine the JSON payload contract.
- If a skill needs extra prod-facing explanation, place it under `skills/<name>/reference/` instead of `docs/`.
- Skill runtime availability is currently controlled only by `scripts/lib/skill_runner.ts` `HANDLERS`.
- `business_config.enabled_skills` is currently defaulted by onboarding but does not participate in v1 runtime gating.
- Catalog Phase A now includes inventory-backed customer `catalog.show_catalog` / `catalog.show_product`.
- `catalog` owns SKU-level `inventory_mode` definition.
- `inventory_mode` currently allows `quantity` and `date_quantity`.
- `inventory_mode` defaults to `quantity`.
- `inventory_mode` may change only through catalog command `catalog.update_inventory_mode`, and only when Safe Switch passes with no `inventory_movements`, `order_items`, or `sku_date_overrides` for that SKU.
- `quantity` means `skus.stock_quantity` is on-hand quantity.
- `date_quantity` means `skus.stock_quantity` is default nightly capacity; exact per-date availability is interpreted by inventory through sparse date overrides.
- Do not modify `docs/v1/product-foundation/v1-product-spec.md` or `docs/v1/product-foundation/v1-demo-spec.md` when current implementation details diverge; record those differences in execution-plan and schema docs instead.
- Inventory Phase A is implemented in `scripts/lib/inventory.ts` and currently exposes `inventory.show_inventory`, `inventory.show_stock`, `inventory.adjust_stock`, `inventory.set_date_stock`, and `inventory.show_low_stock`.
- `sku_date_overrides` is the sparse date-capacity table for `date_quantity`, and `low_stock_alerts` tracks low-stock lifecycle outside `audit_events`.
- Inventory order-driven actions are now implemented for the mock payment loop: `reserve_order_items(...)`, `release_order_reservation(...)`, `commit_order_reservation(...)`, and `restock_refunded_order(...)`.
- `date_quantity` now uses nightly availability math: default/override capacity minus active pending reservations minus paid or fulfilled future stays.
- Orders runtime is now implemented for draft creation, list/detail reads, and cancellation.
- Payments runtime is now implemented for the v1 mock loop: `payments.create_payment_link`, `payments.confirm_mock_paid`, and `payments.refund_mock_payment`.
- Seller BI runtime is now implemented for owner-only v1 metrics: `seller_bi.sales_today` and `seller_bi.revenue_this_month`.
- Seller BI relative-time metrics require an explicit host-provided `params.anchor_date`.
- `seller_bi.sales_today` counts orders whose `paid_at` falls inside the anchored day window, even if those orders are later refunded.
- `seller_bi.revenue_this_month` groups net paid revenue by `currency` and excludes payments whose current status is `refunded`.
- Manual stock adjustment uses `manual_adjust:operation_id=<...>:sku_id=<...>` and keeps the 60-second duplicate-confirmation flow.
- If runtime returns `needs_confirmation`, the agent must ask the owner first; only an explicit confirmation should trigger a second call with a new `operation_id` and `confirm_duplicate=true`.
- If the owner declines a `needs_confirmation` follow-up, do not call runtime again; keep the first adjustment result as the final state.
- If the owner changes `delta` or `reason` after `needs_confirmation`, treat it as a new request with a new `operation_id` and without `confirm_duplicate=true`.
- `operation_id` must be generated by the host/agent, not runtime, using readable `kebab-case` plus a sequence that increments within the same `action + sku` family.
- Recommended `operation_id` examples:
  - `inventory-adjust-stock-minibar-snack-box-001`
  - `inventory-adjust-stock-minibar-snack-box-002`
  - `inventory-set-date-stock-family-suite-4p-001`
- Automatic inventory `reference_key` values should use explicit `field=value` segments; `quantity` keys do not carry dates, while `date_quantity` keys expand to nightly keys with `inventory_date`.
- `inventory.show_low_stock` is an owner-only runtime read that refreshes current low-stock state before returning results, but it does not mark alerts as `sent`; that side effect belongs only to `scripts/run_low_stock_scan.ts`.
- Customer inventory-backed availability rules are:
  - `quantity`: return normal availability status.
  - `date_quantity` without dates: return room visibility plus a “provide dates” hint.
  - `date_quantity` with dates: return exact availability for the requested stay window.
- If catalog needs an auto-generated `sku_code`, you must follow `skills/catalog/reference/sku-code-generation.md` before invoking runtime.
- Catalog auto-generation responsibility sits with you; runtime validates and persists `sku_code` but does not generate it.
- Successful skill responses should be relayed to the user in natural language; catalog create/update/archive/show responses should normally include a Markdown table built from the structured JSON.
- Every Python file should have a module-level docstring that explains what the file is for and when to use it.
- Important functions should have docstrings that explain purpose, expected inputs, and returned values so another engineer can use them without reverse-engineering the implementation.
- Dispatcher flow, transaction boundaries, inventory consistency logic, input protocol handling, and idempotency paths should have brief explanatory comments where code is not self-evident.

## Current Deliverables

- SQLite schema migration scaffold under `scripts/db/migrations/`.
- Development DB helper scripts under `scripts/dev/`.
- Manual review flow should use `scripts/dev/load_fixture.ts` to seed `data/dev/purr_suite_dev.sqlite3` and `scripts/dev/db_inspect.ts --show-audit-events` to inspect the resulting rows.
- Fixture replay helper under `scripts/dev/load_fixture.ts`.
- Shared non-DB Python modules under `scripts/lib/`.
- Shared fiat money formatting helper under `scripts/lib/money.ts`.
- Shared skill dispatcher under `scripts/lib/skill_runner.ts`.
- Catalog runtime under `scripts/lib/catalog.ts`.
- Seller BI runtime under `scripts/lib/seller_bi.ts`.
- Test entrypoint under `scripts/test_skill.ts`.
- Prod entrypoint under `scripts/run_skill.ts`.
- Detailed onboarding design doc under `docs/v1/execution-plan/skills/onboarding.md`.
- Detailed catalog and inventory design docs under `docs/v1/execution-plan/skills/`.
- Detailed seller-bi design doc under `docs/v1/execution-plan/skills/seller-bi.md`.
- Release cleanup checklist under `docs/v1/execution-plan/skill-package-release-cleanup.md`.
- Task tracking in `TODO.md`.

## Next Work

1. Keep SQLite design, migrations, and future catalog/inventory logic aligned.
2. Expand `crm` and freeze the OpenClaw session / inquiry handoff contract.
3. Add real OpenClaw integration validation.
4. Add real payment provider webhook handling after mock-loop + host integration are stable.
