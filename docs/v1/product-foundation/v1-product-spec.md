# Purr Suite v1 Product Spec

## Summary

Purr Suite v1 is an agentic, chat-first business suite for small sellers that combines lightweight CRM and ERP workflows inside a single assistant. The first release is commerce-first: SKU management, customer inquiry handling, payment-link generation, payment success processing, stock updates, customer follow-up, order management, refunds, and simple seller BI.

The primary operating surface is a single Telegram bot shared by the business owner and customers. Access is role-gated: the paired owner gets admin capabilities, while customers get catalog, purchase, and order self-service. Business data is stored in a per-business local SQLite database. Payments are provider-agnostic through a payment adapter layer; hosted payment links and webhook-driven payment confirmation are the reference v1 flow.

## Key Changes / Product Shape

### 1. Core user journeys

- Owner onboarding via agent command:

```text
setup the purr suite
channel - telegram bot(token:xxxx)
database - local sqlite
```

- Setup skill provisions: Telegram channel config, owner pairing flow, local SQLite/JSON file schema, default skills, starter catalog structure, and payment provider placeholders.

- Owner can manage the suite from the same Telegram bot using owner-only intents such as: add sku, update stock, create payment link, list orders, refund order, sales today.

- Customer can use the same bot for: show me catalog, i'd like to buy this, what's my orders, where is my payment link.

### 2. Modular framework

- onboarding skill: Parses setup requests, validates required inputs, initializes SQLite, registers owner identity, and enables modules.

- catalog skill: SKU CRUD, pricing, stock visibility, catalog rendering, and product lookup.

- crm skill: External inquiry intake, customer profile lookup/creation, conversation summaries, and response drafting/sending.

- payments skill: Payment-link generation, payment status lookup, refund initiation, and webhook reconciliation.

- orders skill: Cart-to-order conversion, order lifecycle tracking, fulfillment status, and customer order history.

- inventory skill: Stock reservation, decrement on successful payment, adjustment logs, and low-stock signals.

- seller-bi skill: Natural-language metrics over orders/payments, starting with daily sales count and monthly revenue.

- All skills interact through stable service contracts so modules can be enabled/disabled per business without rewriting the agent surface.

### 3. Functional requirements by user story

- SKU management: Create/edit/archive SKU, title, description, price, currency, stock quantity, status, and optional media/link fields.

- Respond with external inquiry: When a customer asks about an item, the agent identifies SKU(s), answers from catalog data, and logs the inquiry under the customer record.

- Send payment links: Agent creates a draft order, reserves stock for a short TTL, generates a hosted payment link through the configured payment adapter, and sends it back in chat.

- Handle payment success: Payment provider webhook is the source of truth for paid state. On webhook success, the system marks payment paid, confirms order, decrements stock, records an inventory movement, and sends a confirmation reply to the customer.

- Stock management: Reservation on payment-link creation; committed decrement only on payment success; automatic release on expiration/cancel/failure.

- Respond user: Customer receives acknowledgment for inquiry, payment-link delivery, payment success, refund outcome, and order-status updates.

- Order management: Order states at minimum: draft, `pending_payment`, paid, cancelled, refunded, fulfilled. Customer can query own orders; owner can query all orders.

- Refund extension: Owner-triggered refund routed through payment adapter; on success, order/payment state changes to refunded and stock-restock policy is configurable per SKU/order type.

- Seller BI extension: Natural-language analytics backed by SQL templates/metrics service for: how many sales today? what's the revenue this month?

### 4. Public interfaces / contracts

- Setup command contract: Natural-language setup must extract at least channel, channel credentials, and database.

- Channel interface: `pairOwner()`, `sendMessage()`, `identifyUser()`, `listUserOrders()`, `sendCatalog()`.

- Payment adapter interface: `createPaymentLink(order)`, `getPaymentStatus(reference)`, `handleWebhook(payload, signature)`, `refund(payment, amount?)`.

- Inventory service interface: `reserveStock(orderDraft)`, `commitReservation(orderId)`, `releaseReservation(orderId)`, `adjustStock(skuId, delta, reason)`.

- BI service interface: `salesCount(range)`, `revenue(range)`, later extensible to AOV, repeat buyers, and top SKUs.

### 5. Data model

- owners: paired admin identities and permissions.

- customers: messaging identity, profile fields, and summary metadata.

- skus: catalog records and sellability status.

- inventory_movements: reserve, commit, release, manual adjust, refund restock.

- orders: order header, customer link, totals, and status.

- order_items: SKU snapshot, quantity, unit price.

- payments: provider, link reference, status, paid amount, refund status.

- conversations: inquiry log and response metadata.

- audit_events: setup, admin actions, payment webhook events, stock changes.

### 6. Behavior and edge cases

- Same Telegram bot is shared by owner and customers, but admin actions require paired-owner identity and role checks.

- Customers can only see their own orders based on Telegram identity mapping.

- Payment webhook must be idempotent; duplicate success events must not double-decrement stock or duplicate confirmations.

- Expired or failed payments release reserved stock automatically.

- Out-of-stock SKUs remain visible only if the business enables backorder/preorder mode; default is hidden from checkout.

- Refunds do not auto-restock unless the order is marked unfulfilled or the SKU is restockable.

- If webhook delivery fails, the system keeps the payment in `pending_confirmation` and retries reconciliation through adapter polling/manual recheck.

## Test Plan

- Owner onboarding: Run setup with Telegram token and local SQLite; verify schema is created, owner pairing succeeds, and admin commands become available.

- Owner management: From the paired owner account, create/update SKU, inspect orders, request BI metrics, and confirm DB rows change accordingly.

- Customer catalog flow: From a non-owner Telegram account, ask show me catalog; verify visible SKUs are returned from SQLite.

- Customer purchase flow: Ask to buy a SKU; verify draft order, stock reservation, and payment link are created.

- Payment success flow: Send provider webhook for the payment; verify payment becomes paid, order becomes paid/confirmed, inventory movement is committed, and customer receives confirmation.

- Order history flow: Customer asks what's my orders; verify only that customer's orders are returned.

- Refund flow: Owner triggers refund; verify payment/order state updates and stock handling follows policy.

- BI flow: Seed paid orders and verify answers for how many sales today? and what's the revenue this month? match the database.

- Idempotency and recovery: Replay the same webhook twice, simulate webhook delay, and verify no double-processing.

## Assumptions

- The spec is product-generic.

- v1 is commerce-first, not a full accounting/procurement ERP.

- Local SQLite is the business data store for tenant-level operational data.

- Payment links are provider-agnostic; hosted checkout plus webhook confirmation is the default v1 pattern.

- Telegram is the only required v1 channel.

- One shared bot is used for both owner and customers, with role-based access after owner pairing.
