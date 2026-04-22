# Orders Skill 详细设计（v1）

## 1. 目标

`orders` 负责订单头与订单行的结构化落库，是 `payments` 和 `inventory` 的直接上游。

v1 当前阶段的重点，不是一次性做完整交易链，而是先把以下合同冻结：

- `orders` / `order_items` 的输入与落库规则
- OpenClaw session 与 `orders` 的职责边界
- owner / customer 的查询边界
- 订单状态流转边界
- 金额与快照语义
- 后续 `payments` / `inventory` 如何消费订单

当前约束：

- `orders` runtime 不做开放式自然语言理解
- `orders` runtime 不负责 session 追问与缺失资料收集
- `orders` runtime 不负责支付确认
- `orders` runtime 不负责 webhook
- `orders` runtime 不负责直接做库存 `commit` / `release` / `refund_restock`
- `orders` runtime 需要与当前 `inventory` / `catalog` 边界对齐

## 2. OpenClaw Session 与 `orders` 的职责边界

用户表达购买意向时，第一层不是 `orders`，而是 OpenClaw presale session。

推荐链路：

1. 用户表达房型 / 预算 / 时间相关意图
2. OpenClaw 启动或续写 presale session
3. OpenClaw 在 session 中补齐缺失资料
4. OpenClaw 完成 SKU 匹配
5. OpenClaw 调用 `orders.create_session_draft`

固定原则：

- session 由 OpenClaw 持有，不落在 Purr Suite runtime 内
- `orders` 只接收宿主归一后的 `command_code + params`
- 如果 session 信息未补齐，`orders` 不负责继续追问，而是拒绝建单

session 至少应维护以下信息：

- 共享联系信息：
  - `session_id`
  - `guest_name`
  - `phone`
- item 级匹配信息：
  - `sku_code`
  - `check_in_date`
  - `check_out_date`
- 匹配辅助信息：
  - `room_type_intent`
  - `budget_per_night`
  - `guests`

其中：

- `guest_name` 必填
- `phone` 必填
- 每个准备提交给 `orders` 的 item 都必须先完成 SKU 匹配
- `budget_per_night` 非必填
- `guests` 非必填

关于 `budget_per_night`：

- 它属于 OpenClaw 的 session 匹配阶段，不属于 `orders` runtime 的选品职责
- 如果用户提供预算，宿主应优先匹配价格不高于预算的 SKU
- 如果没有满足预算的 SKU，由宿主决定是继续追问、推荐最接近项，还是直接告知无匹配
- `orders` 接收的应当是已经完成匹配后的 item 列表，而不是预算本身

关于匹配辅助信息的归属：

- `room_type_intent`、`budget_per_night`、`guests` 当前都只属于 OpenClaw session
- v1 当前不把这三个字段落到 `orders` 或 `order_items`
- 这里的 `sku_code` 是 OpenClaw 完成匹配后填入的商品编码；它只是 runtime 输入时的查找键
- 真正落库的订单事实仍是 `order_items.sku_id` 以及订单时快照字段

## 3. `command_code`

v1 建议冻结以下 canonical `command_code`：

- `orders.create_session_draft`
- `orders.show_my_orders`
- `orders.list_orders`
- `orders.show_order`
- `orders.cancel_order`

固定原则：

- 用户自然语言只到 OpenClaw 路由层
- `orders` runtime 不做开放式自然语言解析
- `orders` 对外暴露的业务标识是 `order_number`，不是数据库内部 `id`
- 对外部调用方传入的商品标识应为 item 内的 `sku_code`，不是数据库内部 `sku_id`

## 4. 宿主输入合同

统一外层结构沿用根 [SKILL.md](/Users/Zhuanz/purrfect-suite/SKILL.md) 当前的 prod 输入合同：

- `channel`
- `command_code`
- `user`
- `params`
- `runtime.db_path`

名词对照：

- `session`
  - 指 OpenClaw 在追问和匹配阶段维护的会话上下文
  - 这里会保存 `room_type_intent`、`budget_per_night`、`guests` 等匹配辅助信息
- `params`
  - 指一次 runtime 调用里传给 `orders` 的业务参数容器
  - 它属于输入 JSON，不属于数据库字段
- `params.items`
  - 指这次建单请求里要提交的订单行输入数组
  - 它属于 runtime 输入，最终会展开成一条或多条 `order_items`
- `order_items`
  - 指 SQLite 里的订单行表
  - 它承载真正落库的每个 item 快照，例如 `sku_id`、价格快照、日期字段
- `sku_code`
  - 指 catalog 对外暴露的 SKU 编码
  - OpenClaw 在 session 匹配完成后，把这个 `sku_code` 填进 `params.items[*]`
  - `orders` runtime 再用它查到内部 `sku_id`

### 4.1 `orders.create_session_draft`

最小输入建议：

```json
{
  "channel": "telegram",
  "command_code": "orders.create_session_draft",
  "user": {
    "external_user_id": "customer-001",
    "username": "guest-anna"
  },
  "params": {
    "session_id": "telegram:customer-001",
    "booking_contact": {
      "guest_name": "Anna",
      "phone": "13800138000"
    },
    "items": [
      {
        "sku_code": "DELUXE-SEAVIEW-KING",
        "quantity": 1,
        "check_in_date": "2026-03-20",
        "check_out_date": "2026-03-22"
      },
      {
        "sku_code": "MINIBAR-SNACK-BOX",
        "quantity": 1
      }
    ]
  },
  "runtime": {
    "db_path": "data/dev/purr_suite_dev.sqlite3"
  }
}
```

`params` 规则：

- 必填：
  - `session_id`
  - `booking_contact.guest_name`
  - `booking_contact.phone`
  - `items`
- 可选：
  - 无额外订单头必填字段

`params.items` 规则：

- 必须是非空数组
- 每个 item 必填：
  - `sku_code`
  - `quantity`
- 对 `date_quantity` item，额外必填：
  - `check_in_date`
  - `check_out_date`
- 对 `quantity` item：
  - 不需要日期
- 当前不接受 item 级：
  - `room_type_intent`
  - `budget_per_night`
  - `guests`

当前约束：

- v1 单订单只允许单币种
- 对于 hospitality v1，所有 `date_quantity` item 都需要带入住日期区间才能建单
- `check_out_date` 必须晚于 `check_in_date`
- OpenClaw 可以在用户只说一次日期的情况下，把同一入住窗口补到多个 `date_quantity` item；但提交给 runtime 时，每个 `date_quantity` item 都必须是完整的
- `budget_per_night`、`guests`、`room_type_intent` 属于 session 匹配信息，不属于 `orders` runtime 输入

### 4.2 `orders.show_my_orders`

```json
{
  "channel": "telegram",
  "command_code": "orders.show_my_orders",
  "user": {
    "external_user_id": "customer-001"
  },
  "params": {
    "status": "pending_payment"
  }
}
```

`params.status` 可选，用于按订单状态过滤。

### 4.3 `orders.list_orders`

```json
{
  "channel": "telegram",
  "command_code": "orders.list_orders",
  "user": {
    "external_user_id": "owner-001"
  },
  "params": {
    "status": "paid"
  }
}
```

当前只允许 owner 调用。

### 4.4 `orders.show_order`

```json
{
  "channel": "telegram",
  "command_code": "orders.show_order",
  "user": {
    "external_user_id": "customer-001"
  },
  "params": {
    "order_number": "1001"
  }
}
```

### 4.5 `orders.cancel_order`

```json
{
  "channel": "telegram",
  "command_code": "orders.cancel_order",
  "user": {
    "external_user_id": "owner-001"
  },
  "params": {
    "order_number": "1001",
    "reason": "manual_cancel"
  }
}
```

## 5. SQLite 读写合同

主要写：

- `orders`
- `order_items`
- `audit_events`

必要读：

- `skus`
- `orders`
- `order_items`
- `customers`

与 `inventory` 的协作：

- `orders` 依赖当前 `inventory` 的可售口径做建单前检查
- `orders` 当前不写 `inventory_movements`
- `draft -> pending_payment + reservation` 的正式锁库存动作，放在后续 `payments + inventory Phase B`

customer 身份处理：

- `orders` 需要稳定的 `customer_id`
- v1 可以接受以下实现方式：
  - 若 `customers(channel, external_user_id)` 已存在，则复用
  - 若不存在，则写入一条最小 customer 记录，仅保留身份映射
- customer 画像的补充与摘要仍属于 `crm`，不属于 `orders`

创建订单时的读写顺序建议：

1. 解析 `params.booking_contact` 与 `params.items`
2. 校验共享联系信息已齐全
3. 逐个 item 用 `sku_code` 查 `skus`
4. 逐个 item 校验：
   - SKU 存在
   - `sellable_status = active`
   - `quantity` 为正整数
   - 若为 `date_quantity`，日期区间完整且合法
5. 校验整单单币种约束成立
6. 基于每个 SKU 的 `inventory_mode` 做可售检查
7. 创建 `orders`
8. 创建 `order_items`
9. 回填 `subtotal_minor` / `total_minor`
10. 写 `audit_events`

说明：

- 当前阶段创建订单时，推荐先落 `draft`
- 后续由 `payments` 创建 payment link 时，把 `draft -> pending_payment`
- `pending_payment` 之后的 reservation / commit / release 由 `payments + inventory` 协同处理

## 6. `inventory_mode` 对 `orders` 的影响

### `quantity`

- 可按当前普通库存口径校验可售数量
- `quantity` SKU 在下单前读取当前 sellable quantity

### `date_quantity`

- 建单前必须提供：
  - `check_in_date`
  - `check_out_date`
- 口径应与当前 customer catalog 一致：
  - `check_in_date` 含当天
  - `check_out_date` 不占库存
- 当前 Phase A 已经支持日期覆盖和 customer availability
- 真正 nightly reservation 的自动化库存动作，要到 `payments + inventory Phase B`

固定约束：

- `date_quantity` SKU 不能在没有日期区间时建单
- `orders` 必须沿用当前 `inventory` 的酒店日期语义，不能自创另一套区间口径

## 7. 订单金额语义

保留以下字段：

- `currency`
- `subtotal_minor`
- `total_minor`

v1 当前定义：

- `subtotal_minor = SUM(order_items.line_total_minor)`
- `total_minor = subtotal_minor`

这样保留 `subtotal_minor` 不是冗余，而是为未来费用拆层预留基础。

未来扩展方向：

- `discount_minor`
- `shipping_minor`
- `tax_minor`

未来公式固定为：

- `total = subtotal - discount + shipping + tax`

## 8. `order_items` 快照语义

`order_items` 本身就是订单时快照，因此列名不再显式带 `_snapshot`。

v1 订单行固定包含：

- `sku_id`
- `sku_title`
- `unit_price_minor`
- `currency`
- `quantity`
- `line_total_minor`

固定约束：

- `quantity` SKU：`line_total_minor = unit_price_minor * quantity`
- `date_quantity` SKU：`line_total_minor = unit_price_minor * quantity * stay_nights`
- `stay_nights` 由 `check_in_date` 到 `check_out_date` 的晚数，`check_out_date` 为 end-exclusive
- `order_items.currency` 必须与 `orders.currency` 相同
- v1 单订单只允许单币种
- `sku_title`、`unit_price_minor`、`currency` 都表示订单时快照，不随 SKU 后续变更而变化
- 当前 schema 仍有 `UNIQUE(order_id, sku_id)`

与 hospitality 后续扩展的关系：

- 当前 inventory 文档已经明确，未来酒店订单日期字段挂在 `order_items`，不是 `orders`
- 因此 `orders` 在正式实现前，建议先补对应 migration，而不是把日期临时塞进 `notes`
- 如果 v1 希望一个订单里出现“相同 SKU 但不同日期区间”的多行，当前 `UNIQUE(order_id, sku_id)` 需要一起调整；否则这条唯一约束过严
- `room_type_intent`、`budget_per_night`、`guests` 不属于当前订单行快照；它们保留在 OpenClaw session，而不是通过 `order_items` 落库

## 9. 已实现 Schema 变更

为支撑当前 `orders.create_session_draft` runtime，仓库当前的单一 baseline
`0001_init.sql` 已直接包含以下 schema 变更：

- `orders`
  - `session_id`
  - `booking_contact_name`
  - `booking_contact_phone`
- `order_items`
  - `check_in_date`
  - `check_out_date`

原因：

- `guest_name` 是订单级必填资料，不能只停留在 session
- `phone` 是订单确认级信息，不能只存在宿主内存
- hospitality 日期更适合挂在 `order_items`
- `budget_per_night`、`guests`、`room_type_intent` 都属于 session 匹配信息，不进入 `orders` 或 `order_items` 的 migration
- 若后续确认需要 item 级备注，再单独评估是否给 `order_items` 增加备注字段

### 9.1 字段级设计

| 表.字段 | 类型 | 可空性 | 默认值 | 索引建议 | 说明 |
|---|---|---|---|---|---|
| `orders.session_id` | `TEXT` | 可空 | 无 | 加普通索引，建议仅索引非空值 | `create_session_draft` 当前会传入，但 schema 不强制所有订单来源都必须有 session |
| `orders.booking_contact_name` | `TEXT` | 可空 | 无 | 无单独索引 | 对 `create_session_draft` 是 runtime 必填；schema 先保持可空，兼容旧数据和未来非 session 来源 |
| `orders.booking_contact_phone` | `TEXT` | 可空 | 无 | 无单独索引 | 对 `create_session_draft` 是 runtime 必填；schema 先保持可空，兼容旧数据和未来非 session 来源 |
| `order_items.check_in_date` | `TEXT` | 可空 | 无 | 参与组合索引 | 本地日期字符串，格式固定为 `YYYY-MM-DD` |
| `order_items.check_out_date` | `TEXT` | 可空 | 无 | 参与组合索引 | 本地日期字符串，格式固定为 `YYYY-MM-DD` |

固定解释：

- `session_id` 不做唯一约束
- `session_id` 主要服务排查、重放、后续幂等边界，不直接等价于订单主键
- `booking_contact_name` / `booking_contact_phone` 先不做复杂格式校验，runtime 负责非空和基础格式检查
- `check_in_date` / `check_out_date` 必须成对出现；要么都为空，要么都非空
- 当两者都非空时，`check_out_date` 必须晚于 `check_in_date`

### 9.2 唯一约束与索引调整

当前底层 schema 的 `UNIQUE(order_id, sku_id)` 对 hospitality v1 过严。

推荐替换为两条 partial unique index：

- 未带日期的 item：
  - `UNIQUE(order_id, sku_id)`
  - 条件：`check_in_date IS NULL AND check_out_date IS NULL`
- 带日期的 item：
  - `UNIQUE(order_id, sku_id, check_in_date, check_out_date)`
  - 条件：`check_in_date IS NOT NULL AND check_out_date IS NOT NULL`

这样处理后的语义是：

- 普通 `quantity` item 在一个订单里，同一 SKU 只保留一行
- `date_quantity` item 允许同一 SKU 在一个订单里出现多行，但每个日期区间只能出现一次
- “相同 SKU、不同入住窗口”的多行可以成立

建议新增的非唯一索引：

- `orders(session_id)`，条件：`session_id IS NOT NULL`
- `order_items(order_id, check_in_date, check_out_date)`

说明：

- `orders(session_id)` 主要方便按 session 查草稿创建结果和排查问题
- `order_items(order_id, check_in_date, check_out_date)` 主要服务订单详情读取和后续日期型库存动作
- 是否额外增加 `order_items(sku_id, check_in_date, check_out_date)`，等 `payments + inventory Phase B` 的 nightly query 形状冻结后再决定

### 9.3 Schema 约束与 Runtime 校验的分工

Schema 层建议新增这条配对约束：

- `check_in_date` / `check_out_date` 必须同时为空，或同时非空

Runtime 层继续负责：

- `orders.create_session_draft` 下的 `session_id` 必填
- `booking_contact.guest_name` 必填
- `booking_contact.phone` 必填
- `date_quantity` item 必须带日期
- `quantity` item 不应携带日期
- `check_out_date > check_in_date`
- `sku_code` 必须能匹配到有效 SKU

换句话说：

- schema 负责兜住“字段是否成对存在”这类结构性约束
- runtime 负责根据 `inventory_mode` 决定哪些 item 应该带日期，以及联系信息是否齐全

### 9.4 迁移实现注意点

这次 migration 不只是“加几列”，而是已经按以下方式实现：

- `orders` 新增 3 列本身可以走增量迁移
- `order_items` 如果要去掉当前的 `UNIQUE(order_id, sku_id)`，通常需要重建表或重建约束
- 因此这组变更更适合做成一轮完整的 schema migration，而不是只追加两个 `ADD COLUMN`
- 现有会直接插入 `orders` / `order_items` 的测试和 fixture，后续也要跟着一起更新

## 10. 订单状态流转

v1 保留以下订单状态：

- `draft`
- `pending_payment`
- `paid`
- `cancelled`
- `refunded`
- `fulfilled`

推荐状态流转边界：

1. `none -> draft`
   - 触发方：`orders`
   - 场景：session 信息补齐后创建草稿订单
2. `draft -> pending_payment`
   - 触发方：`payments + inventory`
   - 场景：生成 payment link 并成功建立 reservation
3. `pending_payment -> paid`
   - 触发方：`payments`
   - 场景：支付成功确认
4. `draft -> cancelled`
   - 触发方：`orders`
   - 场景：未进入支付前人工取消
5. `pending_payment -> cancelled`
   - 触发方：`orders` 或 `payments + inventory`
   - 场景：人工取消、超时、支付失败
6. `paid -> refunded`
   - 触发方：`payments`
   - 场景：退款成功
7. `paid -> fulfilled`
   - 触发方：后续 fulfillment 路径
   - 场景：已履约完成

当前禁止的跳转：

- `draft -> paid`
- `draft -> fulfilled`
- `cancelled -> pending_payment`
- `refunded -> paid`
- `refunded -> fulfilled`

## 11. owner / customer 权限边界

customer 可执行：

- `orders.create_session_draft`
- `orders.show_my_orders`
- `orders.show_order`，但仅限自己的订单
- `orders.cancel_order`，但仅限自己的 `draft` / `pending_payment` 订单

owner 可执行：

- `orders.list_orders`
- `orders.show_order`，可查看任意订单
- `orders.cancel_order`，可取消任意 `draft` / `pending_payment` 订单

固定约束：

- customer 绝不能读取其他 customer 的订单
- owner 视角可以看到全量订单
- order ownership 依赖 `customers(channel, external_user_id)` 的身份映射

## 12. 响应合同

runtime 固定返回：

- `status`
- `reply`

成功返回建议：

- 单条结果：`order`
- 列表结果：`orders`
- 变更类结果可附带：`audit_event_type`

建议状态集合：

- `created`
- `listed`
- `found`
- `cancelled`
- `forbidden`
- `not_found`
- `invalid_input`
- `invalid_state`
- `conflict`

单条 `order` 建议至少包含：

- `order_number`
- `status`
- `currency`
- `subtotal_minor`
- `total_minor`
- `reserved_until`
- `paid_at`
- `cancelled_at`
- `refunded_at`
- `fulfilled_at`
- `notes`
- `items`

## 13. 审计与幂等

v1 建议至少写以下审计事件：

- `orders.order_draft_created`
- `orders.order_cancelled`
- `orders.order_status_changed`

幂等说明：

- `orders.create_session_draft` 最终应考虑 request-level idempotency
- 现有 schema 已有 `audit_events.idempotency_key`
- 正式实现 runtime 时，应优先考虑让同一次 session 草稿创建具备稳定幂等边界

## 14. 最小测试集

happy path：

- customer 以完整 session 成功创建 draft order
- owner 查询全部订单成功
- customer 查询自己的订单成功
- `subtotal_minor == SUM(order_items.line_total_minor)`
- `order_items.currency == orders.currency`

session / hospitality 边界：

- 缺 `guest_name` 时拒绝建单
- 缺 `phone` 时拒绝建单
- `date_quantity` SKU 缺日期区间时拒绝建单
- `check_out_date <= check_in_date` 时拒绝建单
- 带 `budget_per_night` 时不由 `orders` 重新选 SKU
- mixed order 中，`quantity` item 可以不带日期
- mixed order 中，`date_quantity` item 必须逐行带日期

edge cases：

- `sku_code` 不存在
- SKU 不是 `active`
- customer 查询他人订单被拒绝
- owner/customer 取消已 `paid` 订单被拒绝
- 非法状态跳转被拒绝

## 15. 当前实现状态

当前已实现：

- `orders.create_session_draft`
- `orders.show_my_orders`
- `orders.list_orders`
- `orders.show_order`
- `orders.cancel_order`
- `scripts/lib/orders.ts`
- `tests/integration/test_orders.test.ts`
- `skills/orders/SKILL.md`

当前仍未实现：

- payment link 创建
- `draft -> pending_payment` 时的 reservation 写入
- 支付成功后的 `commit`
- 退款后的 `refund_restock`
- request-level idempotency
