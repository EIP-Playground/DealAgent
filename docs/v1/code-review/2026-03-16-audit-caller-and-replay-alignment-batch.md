# 2026-03-16 更新批次说明：Payments 合同澄清、CRM Phase 1、Demo Replay 对齐、Caller Audit

## 1. 这一天我改了什么

这份说明对应今天在 `david/dev` 上完成的 6 个提交。

| 时间 | Commit | 主题 | 一句话说明 |
| --- | --- | --- | --- |
| 11:27 | `710ded4` | Payments docs | 把 `payments` 从“表面 owner-only”改成“customer 可触发、调用方代表店铺执行”的文档模型。 |
| 13:09 | `9958dee` | CRM runtime | 真正落地 CRM Phase 1 runtime、共享 customer helper、fixtures 和集成测试。 |
| 13:09 | `3e748c2` | CRM docs | 把根 `SKILL.md`、`skills/crm/SKILL.md` 和执行计划文档同步到 CRM Phase 1 真相。 |
| 13:19 | `5d9aff1` | Demo replay + CRM | 把 CRM inquiry / reply / summary / history / response-context 插进 `demo-replay`。 |
| 13:35 | `dd30264` | Caller audit | 引入 `audit_events.actor_type = caller`，把 CRM 写操作和 payments create/confirm 从 `owner` 审计里分离出来。 |
| 13:36 | `8b02d97` | Replay alignment | 把 payments fixtures 和 `demo-replay` preset 命名/语义对齐到 caller-triggered payment flow。 |

如果你只想快速理解今天的最终状态，先看下面 4 个结论：

1. `payments` 现在已经明确成“customer 可触发、调用方代店铺执行”
2. `crm` 已经从占位文档变成正式可执行的 Phase 1 runtime
3. `demo-replay` 现在覆盖 CRM + orders + payments + refund + seller-bi 整条链
4. 审计层现在能区分 `caller` 和 `owner`，不会再把代店铺执行动作混进 owner 管理动作

## 2. 你需要先知道的最终状态

### 2.1 `payments` 的角色语义已经从文档层冻结

今天一开始先改的是 payments 合同。

当前结论不是：

- customer 直接拿自身身份调 payments runtime

而是：

- customer 的“去支付 / 给我支付链接 / 我已付好了”可以路由到 `payments`
- 但 runtime 的真正执行方是 **调用方（代表店铺）**
- v1 当前实现里，这个受信身份暂时复用 active owner identity 通过鉴权

这件事已经同步到：

- 根 `SKILL.md`
- `skills/payments/SKILL.md`
- `docs/v1/execution-plan/skills/payments.md`

同时付款成功后的默认 UX 也已经冻结：

- 直接用 `payments.confirm_mock_paid` 返回的 `order` 给用户一个简短订单摘要
- 不强制额外再打一枪 `orders.show_my_orders`
- 用户要更详细时才进入 `orders.show_order` 或 `orders.show_my_orders`

### 2.2 CRM Phase 1 现在已经是真正可执行 skill

今天中段完成了 CRM Phase 1 落地。

当前已经可执行的 CRM 命令是：

- `crm.log_inquiry`
- `crm.log_reply`
- `crm.show_history`
- `crm.get_response_context`
- `crm.upsert_customer_summary`

同时还做了两件对后续很重要的基础工作：

1. 把 orders 里的 customer fetch/create 逻辑抽成了共享 helper
2. 把 `response_context` 的 SKU 语义拆成两层：
   - `primary_sku_ref`
   - `current_sku_snapshot`

这意味着现在 CRM 已经能稳定承接：

- inquiry logging
- customer upsert
- conversation history
- response context

但仍然明确**没有做**：

- 自动摘要生成
- 多 SKU 结构化关系

### 2.3 customer 锚点和 response context 的语义也在今天冻结了

CRM 这批我顺手把两个容易模糊的点收紧了。

#### customer 锚点

当前不是只靠：

- `params.customer.external_user_id`

而是：

- 外层 `channel`
- `params.customer.external_user_id`

共同确定目标 customer。

v1 没有新增：

- `params.customer.channel`

因为顶层 JSON 合同已经有 `channel`，在 `params.customer` 里再塞一份只会制造冲突。

#### response context

当前 `crm.get_response_context` 明确分两层商品信息：

- `primary_sku_ref`
  - 历史引用
  - 对应历史 conversation 主 SKU
- `current_sku_snapshot`
  - 当前 live catalog read
  - 只用于现在怎么回复客户

也就是说：

- 历史真相由 `message_text`、`summary`、`primary_sku_ref` 承担
- 当前可回复信息由 `current_sku_snapshot` 承担

这不是“历史快照系统”，而是“回复辅助上下文系统”。

### 2.4 `demo-replay` 现在已经是完整交易 + CRM 的回放链

今天还把 CRM 真正插进了 `scripts/dev/load_fixture.ts --preset demo-replay`。

当前这条 preset 会回放：

1. onboarding
2. catalog / inventory 预备
3. customer catalog view
4. CRM inquiry / reply / summary / history / response-context
5. draft order
6. payment link
7. paid confirmation
8. post-payment reads
9. refund
10. seller-bi refund 前后读取

后来又继续对齐了一次，把 payments fixtures 命名改成：

- `payments_caller_create_payment_link.json`
- `payments_caller_confirm_mock_paid.json`
- `payments_owner_refund_mock_payment.json`

这样 replay 本身也能把角色边界直接表达在文件名里，不再让 create/confirm 看起来像 owner 手动操作。

### 2.5 审计层现在已经正式支持 `caller`

今天最后一批是把前面文档里“调用方（代表店铺）”的语义真正推进到数据库和 runtime。

当前 `audit_events.actor_type` 合法值已经变成：

- `system`
- `owner`
- `customer`
- `payment_provider`
- `caller`

这里最关键的边界是：

- `system`
  - 只表示自动 / 运行时动作
  - 例如 low-stock 扫描、reservation expiry
- `owner`
  - 明确的店主管理动作
  - 当前典型例子：`payments.refund_mock_payment`
- `caller`
  - 调用方（代表店铺）触发并执行的动作
  - 当前典型例子：CRM 写命令、payments create/confirm

`caller` 的身份落库规则也已经冻结：

- `actor_type = caller`
- `actor_id = "<channel>:<external_user_id>"`

例如：

- `telegram:owner-001`

同时 `payload_json.actor_identity` 会补充：

- `channel`
- `external_user_id`
- `auth_identity_model = active_owner_identity_reuse`

所以现在 reviewer 可以稳定区分三件事：

1. 自动系统动作
2. 代店铺执行动作
3. 明确 owner 管理动作

## 3. 这一天里最值得注意的设计点

### 3.1 payments 没有改 runtime 鉴权模型，但把合同讲清了

今天并没有把 payments 的鉴权从 active owner identity 改成真正的新 principal。

做的是：

- 先把合同写清楚
- 让别的 Agent 不再因为 `owner` / `customer` 语义冲突而犹豫
- 再把审计层和 fixture 层对齐到“调用方代店铺执行”的真相

这是一种先统一**产品语义**和**审计语义**，再考虑未来是否引入独立 service principal 的推进方式。

### 3.2 CRM 和 orders 的 customer upsert 现在不再分叉

CRM runtime 落地时，我没有在 `scripts/lib/crm.ts` 里再写一套 customer fetch/create。

而是把 orders 里原本已经存在的逻辑抽出来做共享 helper，供：

- `orders`
- `crm`

一起用。

这样后面如果要继续加：

- username 更新
- summary 持久化
- 更多 customer 级字段

不会出现两套 customer identity 处理慢慢漂移的问题。

### 3.3 `system` 没有被拿来偷代替 `caller`

当时有一个岔路：

- 要不要把“调用方代店铺执行”直接记成 `system`

最后没有这么做，因为仓库里 `system` 已经有稳定含义：

- 自动动作
- 非人工触发
- 例如 inventory 的低库存扫描和过期释放

如果把 caller 混成 system，后面：

- audit 查询
- reviewer 理解
- 运维排查

都会把“自动任务”和“上游受信调用”混到一起。

### 3.4 这一天的改动是分层推进的，不是一次性堆在一起

今天的顺序其实很重要：

1. 先把 payments 文档边界澄清
2. 再做 CRM runtime + docs
3. 再把 CRM 接到 demo replay
4. 最后做 caller audit 和 replay 命名对齐

这种顺序保证了：

- 每一步都和上一步的合同一致
- replay / fixtures / docs / runtime 不会长期处于互相打架的状态

## 4. Review 时建议重点看什么

### 4.1 先看今天的 6 个提交顺序

如果你是接手这条分支，建议先按提交顺序读：

1. `710ded4`
2. `9958dee`
3. `3e748c2`
4. `5d9aff1`
5. `dd30264`
6. `8b02d97`

因为今天的改动本身就是按“先合同、再实现、再回放、再审计”的顺序推进的，倒着读会比较割裂。

### 4.2 再看 4 个核心模块

#### payments 合同

优先看：

- `SKILL.md`
- `skills/payments/SKILL.md`
- `docs/v1/execution-plan/skills/payments.md`

重点确认：

- caller / owner 的语义边界是否清楚
- post-payment 默认回复是否已经冻结

#### CRM runtime

优先看：

- `scripts/lib/crm.ts`
- `scripts/lib/customer_store.ts`
- `scripts/lib/orders.ts`
- `skills/crm/SKILL.md`
- `docs/v1/execution-plan/skills/crm.md`

重点确认：

- 5 个命令是否都可执行
- customer 锚点是否统一
- `response_context` 的两层 SKU 语义是否清楚

#### audit 对齐

优先看：

- `scripts/db/migrations/0007_audit_events_caller_actor_type.sql`
- `scripts/db/sqlite.ts`
- `scripts/lib/crm.ts`
- `scripts/lib/payments.ts`

重点确认：

- `caller` 是否真正打通到 schema + runtime
- `refund` 是否继续保持 `owner`
- `actor_id` 和 `payload_json.actor_identity` 是否一致

#### replay / fixtures

优先看：

- `scripts/dev/load_fixture.ts`
- `scripts/dev/README.md`
- `tests/fixtures/payments_caller_create_payment_link.json`
- `tests/fixtures/payments_caller_confirm_mock_paid.json`
- `tests/fixtures/payments_owner_refund_mock_payment.json`

重点确认：

- `demo-replay` 是否已经包含 CRM
- create/confirm/refund 的 fixture 角色命名是否反映当前合同真相

## 5. 这一天我实际做了哪些验证

### 5.1 CRM 落地时跑过的回归

当 CRM runtime 和文档落地后，我跑过：

```bash
npx vitest run tests.integration.test_crm tests.integration.test_orders
```

结果：

- `Ran 10 tests`
- `OK`

### 5.2 Caller audit 落地后跑过的回归

在 caller audit 和 payments / CRM 审计断言补完后，我跑过：

```bash
npx vitest run \
  tests.integration.test_schema_migrations \
  tests.integration.test_crm \
  tests.integration.test_payments \
  tests.integration.test_seller_bi
```

结果：

- `Ran 13 tests`
- `OK`

覆盖的关键点包括：

- 旧 audit row 迁移后保留
- `actor_type = caller` 可插入
- CRM 写操作改成 caller
- payments create/confirm 改成 caller
- payments refund 继续保持 owner
- seller-bi 在这轮 schema 变更后仍然正常

### 5.3 demo replay 的实际重放

我还多次实际回放了 demo 链。

最终对齐后的重放命令是：

```bash
node dist/scripts/dev/load_fixture.js --preset demo-replay --fresh \
  --db-path data/dev/purr_suite_demo.sqlite3
```

当前这条回放已经验证成功，并且关键结果保持稳定：

- payment confirm 后：
  - `seller_bi.sales_today = 1`
  - `seller_bi.revenue_this_month = USD 885.00`
- refund 后：
  - `seller_bi.sales_today = 1`
  - `seller_bi.revenue_this_month = 0`

## 6. 一句话总结

今天这一天，我实际上完成的是一整条从合同到实现再到回放和审计的收口：

- 先把 `payments` 的“调用方代店铺执行”语义说清楚
- 再把 `crm` 做成真正可执行的 Phase 1 runtime
- 再把 CRM 接进 `demo-replay`
- 最后把 `caller` 正式打进 audit、fixtures 和 replay

所以今天的结果不是单点功能，而是把：

- payments
- crm
- demo replay
- audit

这 4 个层面在同一天内对齐到了同一套业务真相。
