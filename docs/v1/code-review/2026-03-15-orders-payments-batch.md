# 2026-03-15 更新批次说明：Host Contract、Orders Draft Runtime、Payments Mock Loop

## 1. 这批更新覆盖了什么

这份说明对应上一份 review 文档之后、到当前 `payments` mock 闭环落地为止的这一批核心提交。

| Commit | 主题 | 一句话说明 |
| --- | --- | --- |
| `2c5d4da` | Host contract / 库存口径说明 | 把“自然语言属于宿主、runtime 只吃 `command_code + params`”和库存语义 A 写进关键文档。 |
| `0a9b8b2` | Orders draft runtime | 真正落地 `orders.create_session_draft`、订单查询、取消订单、订单行日期字段和对应测试。 |
| `c502511` | Payments 设计冻结 | 把 mock payment 的 3 个命令、逐晚 reservation 规则和幂等锚点写成可实现合同。 |
| `a6bf92f` | Payments mock runtime | 真正落地 payment link、confirm paid、refund，以及和 `inventory` 的订单驱动联动。 |

如果你只想快速理解当前代码库新增了什么，优先看这 4 个主题，不用先从全部历史提交开始。

### 1.1 `b7bb945` 为什么没有单独列成一个主题 commit

这一批里还有一个重要的 merge commit：

- `b7bb945` `Merge remote-tracking branch 'origin/main'`

它不适合和上面 4 个 commit 放在同一层，原因是：

- 它本质上不是单一功能主题
- 它的主要作用是把当时远端主线和本地文档调整合并成一个一致基线
- 后续的 `orders` 和 `payments` 都是建立在这个 merge 后的统一主线上继续实现的

因此更准确的理解方式是：

- `b7bb945` 是 **baseline / integration checkpoint**
- 不是“第五个独立功能主题”

review 时可以把它当成“后续主链开发的起跑线”，而不是当成和 `orders` / `payments` 并列的一块新功能。

### 1.2 `b7bb945` 里最值得注意的冲突点

这个 merge commit 最有 review 价值的地方，不是把所有 diff 重新看一遍，而是看它解决冲突后，哪些共享文档语义被正式定住了。

这次显式冲突文件有 4 个：

- `Agent.md`
- `docs/v1/database/sqlite-design.md`
- `docs/v1/execution-plan/skills/inventory.md`
- `docs/v1/execution-plan/skills/onboarding.md`

这 4 个文件的重要性在于：

- `Agent.md`
  - 定住了宿主和 runtime 的边界
  - 也就是“自然语言属于 OpenClaw，Purr Suite 只吃规范化 JSON”
- `sqlite-design.md`
  - 定住了库存语义 A 和共享数据模型
  - 是后续 `orders` / `payments` 能安全往下写的数据库基线
- `inventory.md`
  - 定住了 `quantity` / `date_quantity` 的解释方式
  - 是后来 nightly reservation 和 payment-driven inventory action 的设计前提
- `onboarding.md`
  - 定住了 setup 的 product narrative 和 runtime contract 如何共存

所以如果 reviewer 想理解“为什么后面的 `orders` 和 `payments` 会按现在这种方式写”，`b7bb945` 的意义就在这里：

- 它先把共享边界整合干净
- 然后后面的功能 commit 才能在同一套口径上落地

## 2. 你需要先知道的最终状态

### 2.1 自然语言仍然存在，但不在 skill runtime 里

当前仓库已经把“产品叙事”和“执行边界”分开了：

- product spec / demo spec 里仍然可以保留自然语言 setup 和自然语言购买意图
- 但 runtime 层不再直接解析这些自然语言
- OpenClaw 宿主负责：
  - 意图识别
  - session / 补资料
  - SKU 匹配
  - 把输入翻译成 `command_code + params`
- Purr Suite skill runtime 只负责执行规范化 JSON

这条规则现在不是 onboarding 特例，而是对所有 skill 通用：

- `onboarding`
- `orders`
- `payments`
- 未来的 `crm`
- 未来的 `seller-bi`

也就是说，这一批之后，仓库的正式执行边界更清楚了：

- 自然语言和多轮对话属于宿主
- skill runtime 属于机器命令执行层

### 2.2 Orders 已经是可运行的 draft 层，不再只是设计稿

这一批之后，`orders` 已经实现并注册到 runtime。

当前可执行命令：

| `command_code` | 作用 |
| --- | --- |
| `orders.create_session_draft` | 用宿主已补齐的 session 输出创建 draft order |
| `orders.show_my_orders` | customer 看自己的订单列表 |
| `orders.list_orders` | owner 看全部订单 |
| `orders.show_order` | owner / customer 看单个订单 |
| `orders.cancel_order` | 取消 `draft` / `pending_payment` 订单 |

同时，这一批把订单层几个关键事实真正落库了：

- `orders.session_id`
- `orders.booking_contact_name`
- `orders.booking_contact_phone`
- `order_items.check_in_date`
- `order_items.check_out_date`

也就是说：

- session 来源已经可追踪
- 联系人信息不再只存在于宿主 session
- `date_quantity` 的房型行已经有真正的入住/离店日期

### 2.3 Payments 现在是可运行的 mock 闭环

`payments` 已经不再是“定义了但没注册”的 skill，而是正式接进了 `scripts/lib/skill_runner.ts`。

当前可执行命令：

| `command_code` | 作用 |
| --- | --- |
| `payments.create_payment_link` | 为 `draft` 订单创建 mock payment link，并推进到 `pending_payment` |
| `payments.confirm_mock_paid` | 把一笔 mock payment 确认成 `paid` |
| `payments.refund_mock_payment` | 对已支付订单发起 mock refund |

当前已经跑通的状态流转：

1. `draft -> pending_payment`
   - 创建 `payments(pending)`
   - 写 `orders.reserved_until`
   - 写 `inventory_movements(reserve)`
2. `pending_payment -> paid`
   - `payments -> paid`
   - `orders -> paid`
   - 写 `inventory_movements(commit)`
3. `paid -> refunded`
   - `payments -> refunded`
   - `orders -> refunded`
   - 按 SKU 策略写 `refund_restock`

这意味着 v1 当前已经具备了本地 mock 的完整交易主链：

- 建 draft
- 建 payment link
- 支付成功
- 订单状态更新
- 库存联动
- 退款联动

### 2.4 `date_quantity` 不再只是“静态日期库存”

这是这批里最容易忽略、但其实最关键的新事实。

现在 `date_quantity` 的库存已经不是只有：

- `skus.stock_quantity`
- `sku_date_overrides`

而是变成了真正的“日期容量 + 订单占用”模型。

当前口径是：

- `sku_date_overrides`
  - 负责“某天本来有多少容量 / 可不可卖”
  - 是日期级基线覆盖表
- `orders + order_items`
  - 负责“哪些日期已经被订单占用”
- `inventory_movements`
  - 负责 reservation / commit / release / refund_restock 的审计与幂等流水

最终某一晚的可售量，现在按下面的逻辑计算：

- 默认 nightly capacity 或 date override
- 减去有效 `pending_payment` reservation
- 再减去已 `paid` / `fulfilled` 的未来房晚占用

这一步现在已经不是文档约定，而是真正在 `scripts/lib/inventory.ts` 里落地了。

## 3. 这批改动里最值得注意的几个设计点

### 3.1 `sku_date_overrides` 不是 reservation 表

这张表现在的职责很明确：

- 它只描述 date-based SKU 的日期级容量和状态覆盖
- 它不记录订单占用
- 它不替代 `orders` / `order_items`
- 它也不替代 `inventory_movements`

如果 reviewer 看到 `sku_date_overrides`，需要用下面这句话来理解它：

- 它是 `date_quantity` 的“每日基线库存配置”
- 不是“每日已售/已占库存事实”

### 3.2 这批真正引入了 3 个支付幂等锚点

这不是文档层面的名词，而是已经进了 runtime 的设计：

- `payment_request_id`
  - 建 payment link 请求锚点
- `payment_reference`
  - 具体 payment 实例锚点
- `refund_reference`
  - 退款动作锚点

当前 v1 做法是：

- `payment_reference` 落在 `payments.provider_reference`
- `payment_request_id` / `refund_reference` 先放在 `payments.metadata_json`

这个做法的意义是：

- 先把幂等逻辑跑通
- 不急着为 mock provider 再开一轮 schema 变更

review 时可以重点判断：

- 这种 v1 做法是否足够清楚
- 未来换真实 provider 时，是否需要把其中部分字段提升成专用列

### 3.3 `orders.cancel_order` 现在已经不是纯状态修改

这一批后，取消订单需要分情况看：

- 取消 `draft`
  - 主要是订单状态变化
- 取消 `pending_payment`
  - 除了状态变化，还必须写 `inventory_movements(release)`

也就是说，`orders.cancel_order` 现在已经和 reservation 逻辑发生了正式耦合，这是 review 时需要确认的点。

### 3.4 `date_quantity` 的 commit 不再等于“改 stock_quantity”

这一批把 `quantity` 和 `date_quantity` 的 commit 语义真正分开了：

- `quantity`
  - `commit` 后直接改 `skus.stock_quantity`
- `date_quantity`
  - `commit` 只写 nightly movement
  - 不改 `skus.stock_quantity`
  - 未来房晚继续通过订单状态占用 nightly capacity

如果 reviewer 用“现货库存模型”去看 hotel stay 模型，会很容易误判这里有 bug。

## 4. Review 时建议重点看什么

如果你是来做 code review 或快速接手，建议优先看这几块。

### 4.1 先看宿主边界和协议收口

- `Agent.md`
- `docs/v1/execution-plan/skills/onboarding.md`
- `SKILL.md`

重点确认：

- 自然语言是否已经明确归到 OpenClaw 宿主层
- runtime 是否统一只吃 `command_code + params`
- 这条规则是否已经从 onboarding 外推到所有 skill

### 4.2 再看 orders 的 schema 和 runtime

- `scripts/db/migrations/0006_orders_session_and_stay_dates.sql`
- `scripts/lib/orders.ts`
- `docs/v1/execution-plan/skills/orders.md`
- `tests/integration/test_orders.test.ts`

重点确认：

- `orders` / `order_items` 的新增字段是否和 hospitality 语义匹配
- `date_quantity` item 的日期校验是否合理
- owner / customer 读写边界是否正确
- 取消订单时的状态流转是否合理

### 4.3 然后看 payments 和 inventory 的耦合实现

- `scripts/lib/payments.ts`
- `scripts/lib/inventory.ts`
- `docs/v1/execution-plan/skills/payments.md`
- `docs/v1/database/sqlite-design.md`
- `tests/integration/test_payments.test.ts`

重点确认：

- `create_payment_link` 是否真的只允许 `draft`
- `confirm_mock_paid` 是否真的只允许 `pending_payment`
- `refund_mock_payment` 是否真的只允许 `paid`
- `payment_request_id` / `payment_reference` / `refund_reference` 的幂等处理是否稳定
- `date_quantity` 的 nightly reservation / paid stay 占用是否符合预期

### 4.4 最后看 `sku_date_overrides` 与日期库存的解释是否一致

- `scripts/lib/inventory.ts`
- `docs/v1/database/sqlite-design.md`
- `docs/v1/execution-plan/skills/inventory.md`

重点确认：

- `sku_date_overrides` 是否只是基线覆盖
- `get_sellable_quantity(...)` 对 `date_quantity` 是否真的采用“基线 - 占用”而不是“直接改 stock_quantity”
- owner `show_stock` 和 customer availability 是否共用同一套计算

## 5. 队员快速验证命令

### 5.1 先跑这批最相关的集成测试

```bash
npx vitest run \
  tests/integration/test_orders.test.ts \
  tests/integration/test_payments.test.ts \
  tests/integration/test_inventory.test.ts \
  tests/integration/test_schema_migrations.test.ts \
  tests/integration/test_skill_entrypoints.test.ts
```

### 5.2 重建一份专门用于 orders/payments review 的本地库

```bash
node dist/scripts/dev/load_fixture.js \
  --preset review-catalog \
  --fresh \
  --db-path data/dev/purr_suite_orders_payments_review.sqlite3
```

### 5.3 回放 draft order

```bash
node dist/scripts/test_skill.js \
  --skill orders \
  --fixture tests/fixtures/orders_customer_create_deluxe_room_and_minibar.json \
  --db-path data/dev/purr_suite_orders_payments_review.sqlite3
```

### 5.4 回放 payment link / paid / refund

```bash
node dist/scripts/test_skill.js \
  --skill payments \
  --fixture tests/fixtures/payments_caller_create_payment_link.json \
  --db-path data/dev/purr_suite_orders_payments_review.sqlite3
```

```bash
node dist/scripts/test_skill.js \
  --skill payments \
  --fixture tests/fixtures/payments_caller_confirm_mock_paid.json \
  --db-path data/dev/purr_suite_orders_payments_review.sqlite3
```

```bash
node dist/scripts/test_skill.js \
  --skill payments \
  --fixture tests/fixtures/payments_owner_refund_mock_payment.json \
  --db-path data/dev/purr_suite_orders_payments_review.sqlite3
```

### 5.5 查看索引、审计和库状态

```bash
node dist/scripts/dev/db_inspect.js \
  --db-path data/dev/purr_suite_orders_payments_review.sqlite3 \
  --show-indexes \
  --show-audit-events \
  --limit 30
```

## 6. 一句话总结

这批更新把 Purr Suite 从“catalog / inventory / orders draft 已就位”推进到了：

- 宿主边界更清楚：自然语言属于 OpenClaw，不属于 skill runtime
- orders 已经是正式可运行的 draft 层
- payments mock 闭环已经可运行
- `date_quantity` 已经具备真实 nightly reservation / paid stay 占用逻辑
- 交易主链现在能从 draft 一直走到 refund，并保持库存状态一致
