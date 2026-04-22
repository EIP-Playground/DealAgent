-- Single baseline schema for Purr Suite v1.
-- Development migrations are intentionally squashed into this file.

CREATE TABLE IF NOT EXISTS business_config (
    config_key TEXT PRIMARY KEY,
    config_value_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL DEFAULT 'telegram',
    external_user_id TEXT NOT NULL,
    username TEXT,
    role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner', 'agent')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    paired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel, external_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_single_active
ON identities(is_active)
WHERE is_active = 1 AND role = 'owner';

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL DEFAULT 'telegram',
    external_user_id TEXT NOT NULL,
    username TEXT,
    summary_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel, external_user_id)
);

CREATE TABLE IF NOT EXISTS skus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    price_minor INTEGER NOT NULL CHECK(price_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    sellable_status TEXT NOT NULL DEFAULT 'active'
        CHECK(sellable_status IN ('active', 'archived', 'unavailable')),
    media_url TEXT,
    product_url TEXT,
    restock_on_refund INTEGER NOT NULL DEFAULT 1 CHECK(restock_on_refund IN (0, 1)),
    created_by_owner_id INTEGER,
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    inventory_mode TEXT NOT NULL DEFAULT 'quantity'
        CHECK(inventory_mode IN ('quantity', 'date_quantity')),
    FOREIGN KEY(created_by_owner_id) REFERENCES identities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    customer_id INTEGER,
    source_channel TEXT NOT NULL DEFAULT 'telegram',
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'pending_payment', 'paid', 'cancelled', 'refunded', 'fulfilled')),
    currency TEXT NOT NULL DEFAULT 'USD',
    subtotal_minor INTEGER NOT NULL DEFAULT 0,
    total_minor INTEGER NOT NULL DEFAULT 0,
    reserved_until TEXT,
    paid_at TEXT,
    cancelled_at TEXT,
    refunded_at TEXT,
    fulfilled_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT,
    booking_contact_name TEXT,
    booking_contact_phone TEXT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    sku_id INTEGER NOT NULL,
    sku_title TEXT NOT NULL,
    unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    line_total_minor INTEGER NOT NULL CHECK(line_total_minor >= 0),
    check_in_date TEXT,
    check_out_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(
        (check_in_date IS NULL AND check_out_date IS NULL)
        OR (check_in_date IS NOT NULL AND check_out_date IS NOT NULL)
    ),
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(sku_id) REFERENCES skus(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_unique_without_dates
ON order_items(order_id, sku_id)
WHERE check_in_date IS NULL AND check_out_date IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_unique_with_dates
ON order_items(order_id, sku_id, check_in_date, check_out_date)
WHERE check_in_date IS NOT NULL AND check_out_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_order_dates
ON order_items(order_id, check_in_date, check_out_date);

CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    signature TEXT,
    processing_status TEXT NOT NULL DEFAULT 'received'
        CHECK(processing_status IN ('received', 'processed', 'failed')),
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT,
    error_message TEXT,
    UNIQUE(provider, event_id)
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_reference TEXT NOT NULL,
    payment_link_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'pending_confirmation', 'paid', 'failed', 'cancelled', 'refunded')),
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    webhook_event_id INTEGER,
    paid_at TEXT,
    refunded_at TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, provider_reference),
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(webhook_event_id) REFERENCES webhook_events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_id INTEGER NOT NULL,
    order_id INTEGER,
    movement_type TEXT NOT NULL
        CHECK(movement_type IN ('reserve', 'commit', 'release', 'manual_adjust', 'refund_restock')),
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reference_key TEXT,
    created_by_owner_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sku_id) REFERENCES skus(id) ON DELETE CASCADE,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by_owner_id) REFERENCES identities(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movement_reference
ON inventory_movements(movement_type, sku_id, reference_key)
WHERE reference_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sku_date_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_id INTEGER NOT NULL,
    inventory_date TEXT NOT NULL,
    stock_quantity_override INTEGER NOT NULL CHECK(stock_quantity_override >= 0),
    sellable_status_override TEXT CHECK(sellable_status_override IN ('active', 'unavailable')),
    reason TEXT NOT NULL,
    created_by_owner_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sku_id, inventory_date),
    FOREIGN KEY(sku_id) REFERENCES skus(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by_owner_id) REFERENCES identities(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sku_date_overrides_date
ON sku_date_overrides(inventory_date, sku_id);

CREATE TABLE IF NOT EXISTS low_stock_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_id INTEGER NOT NULL,
    inventory_date TEXT,
    inventory_mode TEXT NOT NULL CHECK(inventory_mode IN ('quantity', 'date_quantity')),
    threshold INTEGER NOT NULL CHECK(threshold >= 0),
    sellable_quantity INTEGER NOT NULL CHECK(sellable_quantity >= 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'resolved')),
    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT,
    resolved_at TEXT,
    FOREIGN KEY(sku_id) REFERENCES skus(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_low_stock_alerts_sku_date_status
ON low_stock_alerts(sku_id, inventory_date, status);

CREATE INDEX IF NOT EXISTS idx_low_stock_alerts_status_detected
ON low_stock_alerts(status, detected_at);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    channel_message_id TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    message_text TEXT NOT NULL,
    intent TEXT,
    sku_id INTEGER,
    order_id INTEGER,
    summary TEXT,
    source_kind TEXT NOT NULL DEFAULT 'manual'
        CHECK(source_kind IN ('manual', 'openclaw_inbound', 'openclaw_delivery_mirror')),
    source_event_key TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(sku_id) REFERENCES skus(id) ON DELETE SET NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS crm_sync_cursors (
    session_relpath TEXT PRIMARY KEY,
    last_processed_line INTEGER NOT NULL DEFAULT 0,
    bootstrapped_at TEXT,
    peer_channel TEXT,
    peer_external_user_id TEXT,
    peer_username TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL
        CHECK(actor_type IN ('system', 'owner', 'customer', 'payment_provider', 'caller')),
    actor_id TEXT,
    entity_type TEXT,
    entity_id TEXT,
    idempotency_key TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_idempotency_key
ON audit_events(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_status_created_at
ON orders(customer_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_session_id
ON orders(session_id)
WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_status_reserved_until
ON orders(status, reserved_until);

CREATE INDEX IF NOT EXISTS idx_payments_order_status_created_at
ON payments(order_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_conversations_customer_created_at
ON conversations(customer_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_source_event_key
ON conversations(source_event_key)
WHERE source_event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_entity_created_at
ON audit_events(entity_type, entity_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_business_config_updated_at
AFTER UPDATE ON business_config
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE business_config
    SET updated_at = CURRENT_TIMESTAMP
    WHERE config_key = OLD.config_key;
END;

CREATE TRIGGER IF NOT EXISTS trg_identities_updated_at
AFTER UPDATE ON identities
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE identities
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_updated_at
AFTER UPDATE ON customers
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE customers
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_crm_sync_cursors_updated_at
AFTER UPDATE ON crm_sync_cursors
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE crm_sync_cursors
    SET updated_at = CURRENT_TIMESTAMP
    WHERE session_relpath = OLD.session_relpath;
END;

CREATE TRIGGER IF NOT EXISTS trg_skus_updated_at
AFTER UPDATE ON skus
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE skus
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sku_date_overrides_updated_at
AFTER UPDATE ON sku_date_overrides
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE sku_date_overrides
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_updated_at
AFTER UPDATE ON orders
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE orders
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_payments_updated_at
AFTER UPDATE ON payments
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE payments
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.id;
END;
