# Demo Flow Spec: Purr Suite v1 Investor Demo

## Summary

Design the demo as a short async video that shows one complete commerce loop through a single Telegram bot: owner setup, customer inquiry, purchase, payment confirmation, stock update, order lookup, refund, and simple BI. The goal is to show that Purr Suite turns a chat channel into an operating system for a small business, not just a support bot.

The demo should stay product-level. Mention webhook-driven payment confirmation and modular skills only when they explain why the flow is reliable and extensible.

## Demo Flow

### 1. Opening setup scene

- Start with the owner inside the agent entering:

```text
setup the purr suite
1. channel - telegram bot(token:xxxx)
2. database - local sqlite
```

- Show the agent confirming: Telegram connected, SQLite initialized, owner pairing ready.

- Cut to the owner pairing the Telegram bot and receiving admin access.

- Narration focus: Setup is conversational, not a dashboard project.

### 2. Owner prepares the business

- Owner adds two or three SKUs through chat: one featured item, one low-stock item, one archived or unavailable item.

- Show the bot confirming SKU creation and available stock.

- Owner asks: show inventory or what can customers buy today?

- Narration focus: The same agent handles catalog and operations; no context switching.

### 3. Customer inquiry and assisted selling

- Switch to a customer using the same Telegram bot.

- Customer asks: show me room options

- Bot returns a compact catalog with prices and availability.

- Customer follows with: i'd like to order the double room with seaview and optionally: do you have seaview single room?

- Bot answers the inquiry from SKU data, creates a draft order, and proposes checkout.

- Narration focus: CRM and commerce are merged; inquiry handling naturally becomes conversion.

### 4. Payment link and order creation

- Bot sends a payment link in chat.

- Briefly show that the system marks the order as `pending_payment` and reserves stock.

- If needed, overlay one sentence: payment links are provider-backed and tracked by the suite.

- Narration focus: The seller does not manually create invoices or reconcile chats.

### 5. Payment success and operational update

- Simulate payment completion.

- Show the customer receiving: payment received and order confirmed.

- Show the owner view updating: paid order appears, stock count drops, inventory movement recorded.

- Keep the internal explanation brief: payment success is confirmed asynchronously, then inventory and order state update automatically.

- Narration focus: This is the operational core of the product.

### 6. Customer self-service after purchase

- Customer asks: what's my orders

- Bot returns the customer's order list and current status.

- Narration focus: The same channel handles post-purchase support without seller intervention.

### 7. Refund extension

- Owner asks: refund order #1001

- Bot confirms refund initiated, updates order/payment state, and shows resulting stock behavior.

- Narration focus: Extensions like refunds are built on the same order/payment model, not bolted on.

### 8. Seller BI close

- Owner asks: how many sales today? then what's the revenue this month?

- Bot returns concise metrics sourced from the same operational data.

- End on a simple message: one Telegram bot, one setup flow, one operating layer for sales and service.

- Narration focus: Purr Suite becomes the seller's front office and back office in one agent.

## Scene Notes

- Use exactly two actors: owner and customer.

- Use a single product category with intuitive SKUs so viewers understand the flow immediately.

- Keep all screens inside chat except for a brief payment-link completion moment.

- Favor visible state changes: catalog shown, payment link sent, order confirmed, stock reduced, refund applied, BI answer returned.

- Avoid architecture diagrams in the main cut; use one overlay line at most for webhook-based payment confirmation.

## Success Criteria

- Viewer understands that setup is conversational and fast.

- Viewer sees one bot serving both admin and customer roles safely.

- Viewer sees payment success trigger downstream business updates automatically.

- Viewer sees the suite cover both CRM-like interactions and ERP-like operations.

- Viewer leaves with a clear mental model: chat is the interface, modular skills are the engine, and the data layer keeps the business consistent.

## Assumptions

- Audience is investors/partners, so the flow prioritizes product leverage over implementation detail.

- Format is async video, so the sequence should be linear, visually obvious, and low-branching.

- Depth stays product-level; internal modules are only referenced when needed to explain reliability or extensibility.
