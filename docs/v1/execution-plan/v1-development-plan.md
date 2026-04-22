# Purr Suite v1 完整开发计划

## 1. 背景与目标

本文档用于锁定 v1 后续 skill 的推荐开发顺序、并行边界、阶段完成标准，以及每一阶段应同步补齐的文档与测试。

当前原则：

- 采用“模块边界优先”，不是“最短 demo 闭环优先”
- 不按人员分工写，只写技能开发顺序与阶段目标
- 以已经完成的交易主链为基础，继续向 demo 完整度与宿主集成推进
- 自然语言理解、session 补资料和跨 skill 对话编排属于 OpenClaw 共享宿主层，不属于单个 skill runtime

## 2. 当前已完成基础

当前已具备的前置条件：

- `onboarding`
- `scripts/run_skill.ts`
- `scripts/test_skill.ts`
- `scripts/lib/skill_runner.ts`
- SQLite 基础迁移
- `catalog` / `inventory` / `orders` / `payments` 详细设计
- `orders(status, reserved_until)` 索引
- `inventory` Phase A runtime
- `orders` draft runtime
- `payments` mock runtime
- `inventory` Phase B 的订单驱动动作
- `seller-bi` runtime
- mixed hospitality review dataset

这些能力已足够支撑后续 skill 进入实现阶段。

补充说明：

- Agent 路由层负责把所有自然语言输入归一成 canonical `command_code + params`
- `onboarding` runtime 只消费 canonical `onboarding.setup_suite`，不做开放式自然语言理解
- session 补资料、SKU 匹配、自然语言追问是宿主可复用能力，不应写死在 `onboarding`、`orders` 或其他单个 skill 里

## 3. 依赖关系总览

核心依赖关系如下：

- `catalog` 定义商品元数据与展示输出
- `inventory` 定义库存计算与库存一致性
- `orders` 依赖 `catalog` 的 SKU 结构和 `inventory` 的库存口径
- `payments` 依赖 `orders` 的状态流转，并驱动 `inventory` 的 commit / release / refund
- `crm` 依赖 `catalog` 的 SKU lookup，但不阻塞交易主链
- `seller-bi` 依赖 `orders + payments` 的稳定结果

因此不推荐简单按产品展示顺序开发，而要按“谁给后续模块提供稳定合同”来推进。

## 4. 推荐开发顺序

### Phase 0：已完成基础

- `onboarding`
- skill 调度入口
- SQLite 基础 schema
- `catalog` / `inventory` 边界定义

这一阶段已完成，不再作为待开发项。

### Phase 1：`catalog` + `inventory` Phase A

`catalog` 已完成：

- owner SKU CRUD
- `inventory_mode` 定义：`quantity` / `date_quantity`
- `sellable_status`
- owner 视角 `catalog.show_sku` / `catalog.show_catalog`
- inventory-backed customer `catalog.show_catalog` / `catalog.show_product`
- Safe Switch `catalog.update_inventory_mode`

`inventory` Phase A 已完成：

- `expire_reservations(...)`
- `get_reserved_quantity(...)`
- `get_sellable_quantity(...)`
- `adjust_stock(...)`
- `set_date_stock(...)`
- owner `inventory.show_inventory` / `inventory.show_stock`
- low-stock 生命周期与扫描脚本
- owner `inventory.show_low_stock`

这一阶段的关键原则：

- `catalog` 负责商品定义与展示
- `inventory` 负责库存计算与一致性
- `catalog` 可读取 availability，但不自行实现库存口径
- `catalog` 负责定义 SKU 的 `inventory_mode`
- `inventory` 负责解释不同 mode 的库存口径与后续动作
- 原始 `v1-product-spec.md` / `v1-demo-spec.md` 不改；当前实现对 hotel 日期库存的解释只写入 execution-plan / schema 文档

### Phase 2：`orders`

`orders` 放在 `inventory` Phase A 之后。

要做：

- 多 item 订单创建
- `orders` / `order_items` 写入
- owner/customer 查询
- 基础状态流转
- 订单 fixtures / integration tests

原因：

- 依赖 `catalog` 的 SKU 结构稳定
- 依赖 `inventory` 的库存口径稳定
- 是后续 `payments` 的直接上游
- `order_items` 的快照字段和币种语义需要先被冻结

### Phase 3：`payments` + `inventory` Phase B

`payments` 与 `inventory` Phase B 应联动推进。

`payments` 做：

- mock payment link
- payment status
- webhook / callback handling
- refund initiation

`inventory` Phase B 做：

- `reserve_order_items(...)`
- `release_order_reservation(...)`
- `commit_order_reservation(...)`
- `restock_refunded_order(...)`

这两者必须一起推进，因为：

- payment success 才触发 `commit`
- payment timeout / failure 才触发 `release`
- refund 才触发 `refund_restock`

当前这两阶段已完成的实际结果：

- `orders.create_session_draft`
- `orders.show_my_orders`
- `orders.list_orders`
- `orders.show_order`
- `orders.cancel_order`
- `payments.create_payment_link`
- `payments.confirm_mock_paid`
- `payments.refund_mock_payment`
- `reserve_order_items(...)`
- `release_order_reservation(...)`
- `commit_order_reservation(...)`
- `restock_refunded_order(...)`
- `date_quantity` 的 nightly reservation / paid stay 占用计算

### Phase 4：`seller-bi`

`seller-bi` 已完成，当前实际结果：

- `seller_bi.sales_today`
- `seller_bi.revenue_this_month`
- owner 侧最小 BI runtime 与 fixtures / integration tests
- 用显式 `anchor_date` 锚定相对时间窗口
- `revenue_this_month` 按 `currency` 分组展示，不做跨币种求和

当前意义：

- 已补齐 demo spec 的最后一段核心指标
- 指标完全建立在已经稳定的 `orders + payments` 结果之上
- 当前下一阶段已转入并完成 `crm` Phase 1，后续重点应进入真实支付 / 调用方集成

### Phase 5：`crm`

`crm` 已完成 Phase 1，当前实际结果：

- `crm.log_inquiry`
- `crm.log_reply`
- `crm.show_history`
- `crm.get_response_context`
- `crm.upsert_customer_summary`
- 共享 customer upsert helper 抽离，`orders` / `crm` 复用
- `primary_sku_ref + current_sku_snapshot` 两层 response context 语义冻结

当前意义：

- `crm` 依赖 `catalog`，但不阻塞交易主链
- owner / 调用方内部已可读取 inquiry history 与回复辅助上下文
- 自动摘要生成、多 SKU 结构化支持与 session 级 CRM 切分仍延期

### Phase 6：真实支付 / 宿主集成

在 mock payment 和最小 demo 补齐后，再进入：

要做：

- 真实 payment adapter
- webhook / reconciliation
- `pending_confirmation`
- 更完整的 OpenClaw 集成验证路径

原因：

- 这部分跨 skill、跨宿主、跨 provider，返工成本明显更高
- 放在 mock 主链稳定之后更稳

## 5. 每阶段目标与完成标准

### Phase 1 完成标准

- owner 能新增 / 更新 / 归档 SKU
- owner 能查看单个 SKU 和全部 SKU
- owner SKU 结果中能看到 `inventory_mode`
- `inventory` 能返回 sellable quantity
- customer catalog 能在 inventory 接入后读取统一 availability
- `catalog` 与 `inventory` 的 availability 口径一致
- `date_quantity` 可通过默认 nightly capacity + 日期覆盖表达
- low-stock 能生成待发送提醒并通过扫描脚本输出

### Phase 2 完成标准

- 能创建多 item 订单
- `subtotal_minor == SUM(order_items.line_total_minor)`
- `order_items` 快照正确
- `order_items.currency == orders.currency`
- owner/customer 查询范围正确

### Phase 3 完成标准

- payment link 能生成
- 支付成功能驱动 order paid + inventory commit
- 超时 / 失败能释放 reservation
- 退款能按策略回补库存

### Phase 4 完成标准

- 基础销量与收入指标能从订单 / 支付数据正确读出
- 至少覆盖 demo 所需的 `sales today` 和 `revenue this month`

### Phase 5 完成标准

- 能记录询单
- 能更新 customer
- 能查看 inquiry-related history
- 能基于主 SKU 查询返回当前 catalog enrich 信息

### Phase 6 完成标准

- 真实 provider 回调能驱动支付状态变化
- `pending_confirmation` 和 webhook 幂等可验证
- OpenClaw 与 Purr Suite 的 prod 集成路径可回放

## 6. 可并行开发说明

可以并行：

- `seller-bi` 与 `crm` 设计可以并行
- 宿主侧 OpenClaw session / routing 设计可与 `seller-bi` runtime 并行

谨慎并行：

- `crm` 可以在宿主 session 边界冻结后启动
- 真实 payment 接入可以在 `seller-bi` 后启动设计，但不建议直接并行实现

不建议并行：

- `crm` 与 OpenClaw session 设计在边界未冻结前同时起步
- 真实 payment adapter 与 `crm` 同时从零实现

## 7. 阶段交接规则

进入下一阶段前，应满足：

- 对应 skill 详细设计已展开
- fixture 已补
- 最小集成测试已补
- 若共享语义变更，`sqlite-design.md` / `Agent.md` / `TODO.md` 已同步

固定交接点：

- Gate 1：`catalog` / `inventory` availability 口径冻结
- Gate 2：`orders` 状态与 `order_items` 快照规则冻结
- Gate 3：`payments` 对 `orders` / `inventory` 的驱动关系冻结
- Gate 4：`seller-bi` 指标来源冻结
- Gate 5：OpenClaw 宿主层的自然语言 / session / routing 边界冻结

## 8. 文档与测试同步要求

每一阶段实现时都应同步检查：

- `docs/v1/database/sqlite-design.md`
- 对应 `docs/v1/execution-plan/skills/*.md`
- `Agent.md`
- `TODO.md`

测试上至少补：

- fixture
- 最小 integration test
- 共享口径变化的回归验证
