# Purr Suite SQLite 设计与数据字典（v1）

本文档对应当前已落地的单一 baseline：

- [0001_init.sql](../../../scripts/db/migrations/0001_init.sql)

说明：

- 开发期增量 migration 已压平进 `0001_init.sql`
- 当前 schema 中不再有 `owners` 表；owner 身份现在存放在 `identities` 表中，`role = 'owner'`

用于说明：

1. 每张表负责什么
2. 字段含义与约束
3. 关键状态如何变化
4. 当前实现与文档如何保持一致

## 1. 总览

当前核心表：

- `business_config`
- `identities`
- `customers`
- `skus`
- `orders`
- `order_items`
- `payments`
- `inventory_movements`
- `sku_date_overrides`
- `low_stock_alerts`
- `conversations`
- `crm_sync_cursors`
- `audit_events`
- `webhook_events`
- `schema_migrations`

统一约定：

- 时间字段使用 `TEXT` + `CURRENT_TIMESTAMP`
- 所有开发期 SQLite 默认落在 `data/dev/`
- 查看数据库统一用 `node dist/scripts/dev/db_inspect.js`

## 2. 表说明

## `business_config`

用途：保存业务初始化配置和默认运行参数。

| 字段 | 含义 |
|---|---|
| `config_key` | 配置键，主键 |
| `config_value_json` | JSON 值 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

当前默认键：

- `channel_binding = "telegram_via_openclaw"`
- `database_mode = "local_sqlite"`
- `enabled_skills = [...]`
- `payment_provider = "mock"`

说明：

- `payment_provider` 表示当前业务激活的支付后端标识，v1 固定为 `mock`
- 不在这里存储 API secret

## `identities`

用途：统一记录店铺身份。当前包含 `owner` 与 `agent` 两种角色，其中 v1 只允许 1 个激活 owner。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `channel` | 渠道，当前默认 `telegram` |
| `external_user_id` | 渠道侧用户唯一标识 |
| `username` | 用户名 |
| `role` | 身份角色：`owner` / `agent` |
| `is_active` | 是否激活 |
| `paired_at` | 配对时间 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

关键约束：

- `(channel, external_user_id)` 唯一
- 只允许 1 个激活 owner
- 身份判断只依赖 `channel + external_user_id`；`username` 作为可选展示辅助字段保留

例子：

- Agent 把初始化自然语言归一成 `onboarding.setup_suite` 后：写入 1 条 owner
- 同一 owner 再次 setup：不新增行，刷新 `paired_at`

## `customers`

用途：记录客户身份与轻量画像。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `channel` | 渠道 |
| `external_user_id` | 渠道用户标识 |
| `username` | 用户名 |
| `summary_json` | 客户摘要 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

关键约束：

- `(channel, external_user_id)` 唯一
- 身份判断只依赖 `channel + external_user_id`；`username` 作为可选展示辅助字段保留

说明：

- `orders` 和 `crm` 当前共用同一套 customer fetch-or-create 逻辑
- `summary_json` 是调用方提供并由 `crm` 替换持久化的轻量画像，不在 runtime 内自动生成

## `skus`

用途：商品目录与现货库存快照。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `sku_code` | SKU 编码，唯一 |
| `title` | 商品名 |
| `description` | 描述 |
| `price_minor` | 价格最小货币单位整数 |
| `currency` | 币种 |
| `inventory_mode` | 库存模式：`quantity` / `date_quantity` |
| `stock_quantity` | `quantity` 时为现货库存；`date_quantity` 时为默认每晚容量 |
| `sellable_status` | `active/archived/unavailable` |
| `media_url` | 媒体链接 |
| `product_url` | 商品链接 |
| `restock_on_refund` | 退款是否回补库存（默认 1） |
| `created_by_owner_id` | 创建 owner |
| `archived_at` | 归档时间 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

说明：

- `inventory_mode = quantity`
  - `stock_quantity` 表示现货库存，不是可售库存
  - v1 当前固定采用库存语义 A：
    - `skus.stock_quantity` 是当前 on-hand 库存快照
    - `commit` 会扣减 `skus.stock_quantity`
    - `refund_restock` 在允许回补时会回加 `skus.stock_quantity`
  - 可售库存统一按 `stock_quantity - 当前有效 reservation` 推导
- `inventory_mode = date_quantity`
  - `stock_quantity` 表示默认每晚容量
  - 具体日期库存由 `sku_date_overrides` 稀疏覆盖解释
- `inventory_mode` 默认值是 `quantity`
- `catalog` 负责定义 `inventory_mode`
- `inventory_mode` 可通过 `catalog.update_inventory_mode` 修改
- mode 切换必须通过 Safe Switch：
  - 没有 `inventory_movements`
  - 没有 `order_items`
  - 没有 `sku_date_overrides`
- `inventory` 负责解释不同 mode 下的库存口径与后续动作
- `catalog` 可读取库存结果做 availability 展示，但不直接变更库存数量
- `price_minor` 必须结合 `currency` 一起解释，不能单独展示
- `catalog` Phase A 当前接受的法币：
  - `USD`, `CNY`, `JPY`, `HKD`, `SGD`, `KRW`, `EUR`
- 价格展示按 runtime 精度映射还原：
  - `USD/CNY/HKD/SGD/EUR` -> 2 位小数
  - `JPY/KRW` -> 0 位小数
- `display_price` 是 runtime 派生字段，不落库
- `restock_on_refund` 表示退款成功后是否允许把现货库存加回到 `stock_quantity`，默认值为 `1`

## `sku_date_overrides`

用途：为 `date_quantity` SKU 提供按日期覆盖的 nightly capacity / 可售状态。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `sku_id` | 关联 SKU |
| `inventory_date` | 覆盖日期 |
| `stock_quantity_override` | 该日容量覆盖 |
| `sellable_status_override` | 该日状态覆盖 |
| `reason` | 覆盖原因 |
| `created_by_owner_id` | 操作 owner |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

关键约束：

- `(sku_id, inventory_date)` 唯一

说明：

- 若某天没有 override，则回退到 `skus.stock_quantity`
- 若某天有 override，则使用该天覆盖值
- owner 的日期库存输入是区间式，runtime 会逐日展开写入
- 如果某天设置值与 SKU 默认值和默认状态完全一致，则删除该日 override，保持表稀疏
- 当 `date_quantity` 订单支付或退款时，runtime 会更新对应日期的 override，以保持“当前剩余容量”一致

## `orders`

用途：订单主表，承载订单生命周期。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `order_number` | 业务订单号，唯一 |
| `customer_id` | 客户关联 |
| `source_channel` | 来源渠道 |
| `status` | `draft/pending_payment/paid/cancelled/refunded/fulfilled` |
| `currency` | 币种 |
| `subtotal_minor` | 商品行小计 |
| `total_minor` | 当前订单总计 |
| `reserved_until` | 库存预留过期时间 |
| `paid_at` | 支付成功时间 |
| `cancelled_at` | 取消时间 |
| `refunded_at` | 退款时间 |
| `fulfilled_at` | 履约完成时间 |
| `notes` | 备注 |
| `session_id` | 宿主 presale session 标识 |
| `booking_contact_name` | 订单联系人姓名 |
| `booking_contact_phone` | 订单联系人手机号 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

说明：

- `status` 统一复用订单状态，不新增单独的 cancelled 布尔字段
- 当 `status = pending_payment` 且 `reserved_until < now` 时，视为 reservation expired
- v1 过期后订单状态直接转为 `cancelled`
- v1 当前 `subtotal_minor = SUM(order_items.line_total_minor)`
- v1 当前 `total_minor = subtotal_minor`
- 保留 `subtotal_minor` 是为了未来支持 `discount/shipping/tax` 拆层，而不是冗余字段
- `session_id`、`booking_contact_name`、`booking_contact_phone` 当前已落库
- 这 3 个字段属于订单头级事实，不属于 `order_items`
- schema 侧保持可空，兼容旧数据与未来非 session 来源订单
- runtime 侧对 `orders.create_session_draft` 强制要求 `session_id`、`guest_name`、`phone`

## `order_items`

用途：订单明细，保存下单时的 SKU 快照，并作为库存动作的按行依据。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `order_id` | 所属订单 |
| `sku_id` | 商品 id |
| `sku_title` | 商品名快照 |
| `unit_price_minor` | 下单时的单价最小货币单位整数快照 |
| `currency` | 下单时币种快照 |
| `quantity` | 数量 |
| `line_total_minor` | 行总价 |
| `check_in_date` | 入住日期，checkout-exclusive 订单行适用 |
| `check_out_date` | 离店日期，checkout-exclusive 订单行适用 |
| `created_at` | 创建时间 |

关键约束：

- `check_in_date` / `check_out_date` 要么同时为空，要么同时非空

说明：

- v1 保留多 item 订单结构，`orders` 是订单头，`order_items` 是订单行
- reservation / commit / refund_restock 都按 `order_items` 的 SKU 与数量执行
- `order_items` 本身就表示订单时快照，因此列名不再重复写 `_snapshot`
- `sku_title`、`unit_price_minor`、`currency` 用于保留历史订单快照，避免 SKU 后续改名改价影响历史数据
- `order_items.currency` 必须与 `orders.currency` 相同
- `quantity` SKU：`line_total_minor = unit_price_minor * quantity`
- `date_quantity` SKU：`line_total_minor = unit_price_minor * quantity * stay_nights`
- `stay_nights` 由 `check_in_date` 到 `check_out_date` 的晚数，`check_out_date` 为 end-exclusive
- `check_in_date` / `check_out_date` 当前已落库，类型为 `TEXT`，格式固定为 `YYYY-MM-DD`
- 这两个字段属于订单行级事实，挂在 `order_items`，不挂在 `orders`
- runtime 继续负责：
  - `date_quantity` item 必须带日期
  - `quantity` item 不应带日期
  - `check_out_date > check_in_date`
- `room_type_intent`、`budget_per_night`、`guests` 都保留在 OpenClaw session，不进入 `order_items`
- 当前已用 partial unique index 替代原来的 `UNIQUE(order_id, sku_id)`：
  - 无日期 item：`UNIQUE(order_id, sku_id)`，条件为 `check_in_date IS NULL AND check_out_date IS NULL`
  - 有日期 item：`UNIQUE(order_id, sku_id, check_in_date, check_out_date)`，条件为 `check_in_date IS NOT NULL AND check_out_date IS NOT NULL`
- 这样允许“同一订单、同一 SKU、不同入住窗口”的多行共存

## `payments`

用途：支付单与支付状态。一个订单允许多个支付尝试，因此不对 `order_id` 做唯一限制。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `order_id` | 关联订单 |
| `provider` | 支付提供方，如 `mock` |
| `provider_reference` | 渠道支付单号，按 provider 唯一 |
| `payment_link_url` | 支付链接 |
| `status` | `pending/pending_confirmation/paid/failed/cancelled/refunded` |
| `amount_minor` | 支付金额 |
| `currency` | 币种 |
| `webhook_event_id` | 最后关联 webhook 事件 |
| `paid_at` | 支付成功时间 |
| `refunded_at` | 退款时间 |
| `metadata_json` | 扩展字段 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

关键约束：

- `(provider, provider_reference)` 唯一

## `inventory_movements`

用途：库存流水，记录每次库存变化。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `sku_id` | 关联 SKU |
| `order_id` | 关联订单 |
| `movement_type` | `reserve/commit/release/manual_adjust/refund_restock` |
| `delta` | 库存变化量 |
| `reason` | 变化原因 |
| `reference_key` | 幂等键 |
| `created_by_owner_id` | 操作 owner |
| `created_at` | 创建时间 |

关键约束：

- `(movement_type, sku_id, reference_key)` 在 `reference_key` 非空时唯一

说明：

- v1 使用的主要动作是 `reserve`、`release`、`commit`、`refund_restock`、`manual_adjust`
- reservation 过期不是单独的 movement type，而是 `release + reason=expired`
- Phase A 已实现的 movement 写入是 `manual_adjust`
- `inventory.set_date_stock` 当前不写 `inventory_movements`，而是写 `sku_date_overrides` + `audit_events`
- `reference_key` 统一采用显式 `field=value` 风格
- 当前已实现：
  - `manual_adjust:operation_id=<...>:sku_id=<...>`
- 已冻结的未来自动化 key 规则：
  - `quantity`
    - `reserve:order_id=<...>:order_item_id=<...>:sku_id=<...>`
    - `commit:payment_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>`
    - `release:order_id=<...>:order_item_id=<...>:sku_id=<...>:reason=<...>`
    - `refund_restock:refund_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>`
  - `date_quantity`
    - 一晚一条 movement
    - `reserve:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`
    - `commit:payment_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`
    - `release:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD:reason=<...>`
    - `refund_restock:refund_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`

## `low_stock_alerts`

用途：记录 low-stock 提醒生命周期，不用 `audit_events` 代替状态机。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `sku_id` | 关联 SKU |
| `inventory_date` | 具体日期；`quantity` 可空 |
| `inventory_mode` | `quantity` / `date_quantity` |
| `threshold` | 触发阈值 |
| `sellable_quantity` | 检测时可售量 |
| `status` | `pending/sent/resolved` |
| `detected_at` | 首次检测时间 |
| `sent_at` | 标记发送时间 |
| `resolved_at` | 恢复时间 |

说明：

- `quantity`
  - 直接按当前 `sellable_quantity` 触发
- `date_quantity`
  - 针对未来 30 天内的具体日期触发
- v1 默认阈值固定为 `2`
- 只有“恢复后再次跌破”才允许生成新的提醒

## `conversations`

用途：客户会话日志（询单/回复）。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `customer_id` | 关联客户 |
| `channel_message_id` | 渠道消息 id |
| `direction` | `inbound/outbound` |
| `message_text` | 消息正文 |
| `intent` | 意图 |
| `sku_id` | 关联 SKU |
| `order_id` | 关联订单 |
| `summary` | 摘要 |
| `source_kind` | 来源：`manual/openclaw_inbound/openclaw_delivery_mirror` |
| `source_event_key` | 自动同步去重键 |
| `created_at` | 创建时间 |

说明：

- Telegram 私聊的正常 CRM 基线由后台 `sync_crm_from_openclaw` 自动写入；`crm.log_inquiry` / `crm.log_reply` 只作为人工补录和调试入口
- 一条 conversation 当前只支持 1 个结构化主 SKU，使用 `sku_id` 表示
- `order_id` 只记录显式传入的关联订单，不把 `orders.session_id` 扩到 CRM
- `source_event_key` 非空时唯一，用于防止重复导入同一条 OpenClaw session 事件
- 当前可回复商品摘要不会固化在 `conversations`
  - 历史真相由 `message_text`、`summary` 和 `sku_id` 承担
  - `crm.get_response_context` 读取时再基于最新 catalog 生成 `current_sku_snapshot`
  - `current_sku_snapshot` 只表示 live catalog read，不是历史 transcript

## `crm_sync_cursors`

用途：保存每个 OpenClaw session 文件的同步游标和当前已解析出的私聊 peer。

| 字段 | 含义 |
|---|---|
| `session_relpath` | 相对 `~/.openclaw` 的 session 文件路径，主键 |
| `last_processed_line` | 已处理到的最后一行 |
| `bootstrapped_at` | 首次 bootstrap 时间 |
| `peer_channel` | 当前解析出的 peer 渠道 |
| `peer_external_user_id` | 当前解析出的 peer 外部 ID |
| `peer_username` | 当前解析出的 peer 用户名 |
| `updated_at` | 更新时间 |

说明：

- v1 自动同步只扫描 `~/.openclaw/agents/*/sessions/*.jsonl`
- `bootstrap` 不导入历史消息，只更新 cursor 和 peer context
- `incremental` 只处理新行；delivery-mirror 出站消息依赖这里保存的 peer context 做归属
- session 文件若被清空或缩短，runtime 会把该文件重新 bootstrap 到当前 EOF

## `audit_events`

用途：通用审计日志，记录关键业务动作。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `event_type` | 事件类型 |
| `actor_type` | `system/owner/customer/payment_provider/caller` |
| `actor_id` | 操作主体 id；`caller` 时固定为 `channel:external_user_id` |
| `entity_type` | 实体类型 |
| `entity_id` | 实体 id |
| `idempotency_key` | 幂等键 |
| `payload_json` | 上下文 JSON |
| `created_at` | 创建时间 |

关键约束：

- `idempotency_key` 非空时唯一

说明：

- `system` 只表示自动/运行时动作，例如库存过期释放、low-stock 扫描和 OpenClaw CRM session 同步，不表示“调用方代店铺执行”
- `caller` 表示调用方（代表店铺）触发并执行的动作；v1 当前在鉴权上仍复用 active owner identity
- `caller` 事件会在 `payload_json.actor_identity` 里补充：
  - `channel`
  - `external_user_id`
  - `auth_identity_model = caller_identity`
- `payload_json.actor_identity` 只用于补充当前鉴权真相，不替代 `actor_type`
- CRM auto-sync 会新增：
  - `crm.inquiry_synced`
  - `crm.reply_synced`
  - 固定 `actor_id = openclaw:session-sync`

## `webhook_events`

用途：记录支付 webhook 接收与处理状态。

| 字段 | 含义 |
|---|---|
| `id` | 主键 |
| `provider` | 支付提供方 |
| `event_id` | 事件 id |
| `event_type` | 事件类型 |
| `signature` | 签名 |
| `processing_status` | `received/processed/failed` |
| `payload_json` | 原始 payload |
| `received_at` | 接收时间 |
| `processed_at` | 处理完成时间 |
| `error_message` | 失败原因 |

关键约束：

- `(provider, event_id)` 唯一

## `schema_migrations`

用途：记录已执行的迁移版本。

| 字段 | 含义 |
|---|---|
| `version` | 迁移版本号 |
| `applied_at` | 执行时间 |

## 3. 关键索引与触发器

当前已实现：

- `orders(customer_id, status, created_at)`
- `orders(status, reserved_until)`
- `orders(session_id)`，条件：`session_id IS NOT NULL`
- `order_items(order_id, check_in_date, check_out_date)`
- `order_items` 的 partial unique index：
  - `UNIQUE(order_id, sku_id)`，条件：`check_in_date IS NULL AND check_out_date IS NULL`
  - `UNIQUE(order_id, sku_id, check_in_date, check_out_date)`，条件：`check_in_date IS NOT NULL AND check_out_date IS NOT NULL`
- `payments(order_id, status, created_at)`
- `conversations(customer_id, created_at)`
- `conversations(source_event_key)`，条件：`source_event_key IS NOT NULL`
- `audit_events(entity_type, entity_id, created_at)`
- `sku_date_overrides(sku_id, inventory_date)` 唯一约束
- `low_stock_alerts(sku_id, status, inventory_date)` 索引
- `identities/customers/crm_sync_cursors/skus/orders/payments/business_config/sku_date_overrides` 的 `updated_at` 触发器

推荐理解：

- `orders(customer_id, status, created_at)` 主要服务订单查询
- `orders(status, reserved_until)` 主要服务待支付 reservation 与过期扫描
- `orders(session_id)` 主要服务 session 定位、排查与后续幂等边界
- `order_items(order_id, check_in_date, check_out_date)` 主要服务订单详情读取和日期型订单行扫描
- 是否追加 `order_items(sku_id, check_in_date, check_out_date)`，等 nightly reservation 查询形状冻结后再决定

## 4. 库存与 reservation 语义

v1 统一使用以下口径：

- `quantity`
  - `skus.stock_quantity` 表示现货库存
- `date_quantity`
  - `skus.stock_quantity` 表示默认每晚容量
  - 具体日期库存通过 `sku_date_overrides` 覆盖
- 可售库存不单独存表
- 当前有效 reservation 通过订单与明细推导

补充说明：

- v1 保持库存语义 A，不采用“每次仅靠历史 movement 反推当前库存”的语义 B
- `quantity` 下已 `paid` / `fulfilled` 订单的库存影响已经反映在当前 `skus.stock_quantity` 中
- `date_quantity` 不直接改写 `skus.stock_quantity`；已 `paid` / `fulfilled` 的未来房晚继续通过 `orders + order_items` 占用 nightly capacity
- 查询可售库存时：
  - `quantity` 额外扣减的只应是当前仍有效的 reservation
  - `date_quantity` 需要同时扣减当前有效 reservation 和已 `paid` / `fulfilled` 的房晚占用
- 订单头 `orders` 本身不包含 SKU 粒度信息；真正的商品维度来自 `order_items`
- 所以 `show inventory` 或 SKU 级 availability 计算必须结合 `orders + order_items`

当前有效 reservation 的判定：

- `orders.status = pending_payment`
- `orders.reserved_until > now`
- `quantity` 模式数量来自对应 `order_items`
- `date_quantity` 需要按 `order_items.check_in_date/check_out_date` 逐晚展开 reservation
- 当前 schema 已具备日期字段；nightly `reserve/commit/release/refund_restock` 已由 `payments + inventory` runtime 落地

过期 reservation 的判定：

- `orders.status = pending_payment`
- `orders.reserved_until < now`

过期释放后的处理：

- `orders.status -> cancelled`
- `orders.cancelled_at -> now`
- `inventory_movements` 写 `release`
- `reason = expired`

## 5. 常见状态流转

1. onboarding
   - Agent 先把初始化自然语言归一成 `onboarding.setup_suite`
   - 写 `schema_migrations`
   - 写 `identities`
   - 写 `business_config`
   - 写 `audit_events`

2. 下单支付
   - 建 `orders(pending_payment)` + `order_items`
   - 建 `payments(pending)` 并生成链接
   - 写 `inventory_movements(reserve)`
   - `reserve` 只表示锁定库存，不改 `skus.stock_quantity`
   - 支付成功后：`payments -> paid`，`orders -> paid`
   - `quantity` SKU 写 `inventory_movements(commit)` 并扣减 `skus.stock_quantity`
   - `date_quantity` SKU 写逐晚 `inventory_movements(commit)`，但不改 `skus.stock_quantity`

2.1 owner 日期库存维护
   - `date_quantity` SKU 通过 `inventory.set_date_stock` 维护日期覆盖
   - 写 `sku_date_overrides`
   - 写 `audit_events`
   - 同步 `low_stock_alerts`

3. reservation 过期释放
   - 扫描 `pending_payment + reserved_until < now` 的订单
   - `orders -> cancelled`
   - 写 `inventory_movements(release)`，`reason = expired`

4. 退款
   - `payments -> refunded`
   - `orders -> refunded`
   - 如允许回补库存：写 `inventory_movements(refund_restock)`，并回加 `skus.stock_quantity`

5. low-stock
   - 检测到 `sellable_quantity <= threshold`
   - 创建或刷新 `low_stock_alerts(pending)`
   - `node dist/scripts/run_low_stock_scan.js` 输出提醒并标记为 `sent`
   - 恢复后标记为 `resolved`

## 6. 查看与排查

初始化数据库：

```bash
node dist/scripts/dev/init_sqlite.js
```

查看数据库：

```bash
node dist/scripts/dev/db_inspect.js
```

查看数据库并列出索引：

```bash
node dist/scripts/dev/db_inspect.js --show-indexes
```

重点联查：

- owner/权限问题：`identities` + `business_config` + `audit_events`
- 支付重复处理：`webhook_events` + `payments`
- 库存不一致：`skus.stock_quantity` + `orders` + `order_items` + `inventory_movements`
