# Payments Skill 详细设计（v1）

## 1. 目标

`payments` 负责把已经存在的 `draft order` 推进成可支付、已支付、已退款的交易状态。

v1 当前已经实现最小 mock 闭环，不直接接真实第三方 provider。重点是冻结：

- mock payment 的 3 个最小命令
- `draft -> pending_payment -> paid -> refunded` 的状态流转边界
- `payments` / `orders` / `inventory_movements` 的写入顺序
- `quantity` 与 `date_quantity` 的 reservation / commit / refund_restock 规则
- `payment_request_id`、`payment_reference`、`refund_reference` 这 3 个幂等锚点

## 2. 技能边界

`payments` 负责：

- 为 `draft` 订单生成 mock payment link
- 让订单进入 `pending_payment`
- 写 reservation
- 确认 mock 支付成功并写 `commit`
- 发起 mock refund，并在允许时写 `refund_restock`
- 维护 `payments` 表、相关订单状态和支付审计

`payments` 不负责：

- 自然语言追问
- session 补资料
- 商品匹配
- 创建 `draft order`
- owner 手工库存调整
- 真实 webhook 对接

固定前提：

- v1 的 `payment_provider` 固定为 `mock`
- `payments` 的直接上游是 `orders.create_session_draft`
- `payments` 依赖 `inventory` 已冻结的 reference key 规则和库存语义 A

## 3. `command_code`

v1 mock payment 先冻结以下 3 个命令：

- `payments.create_payment_link`
- `payments.confirm_mock_paid`
- `payments.refund_mock_payment`

这 3 个命令分别对应：

1. 创建 mock 支付单与支付链接，并建立 reservation
2. 把指定 payment 标记为已支付，并提交库存扣减
3. 把已支付订单标记为退款，并按 SKU 政策决定是否回补库存

## 4. 幂等锚点

这 3 个锚点是 v1 mock payment 的核心约束，必须写清楚。

### 4.1 `payment_request_id`

用途：

- 由调用方生成
- 表示“一次创建 payment link 请求”的唯一实例
- 用来防止重复创建 link、重复把订单推进到 `pending_payment`、重复写 reservation

建议理解：

- 同一个 `payment_request_id` 重放
  - 应返回第一次创建的 payment link
  - 不得再次写 reservation
  - 不得再次新建 payment 记录
- 真正的新建 link 请求
  - 必须使用新的 `payment_request_id`

它解决的问题是：

- 用户点了两次“去支付”
- agent 重试了同一次 create link 请求
- 上游超时后重新发送了同一个请求

### 4.2 `payment_reference`

用途：

- 由 `payments.create_payment_link` 成功后生成并落到 `payments.provider_reference`
- 表示“一笔具体 payment 实例”的稳定外部引用
- 用来锚定后续的 `confirm_mock_paid`

建议理解：

- `payment_request_id` 是“建链接请求”的锚点
- `payment_reference` 是“已创建 payment 实例”的锚点
- 两者不是同一个层次

同一个 `payment_reference` 重放确认支付时：

- 应直接返回已支付结果
- 不得重复写 `inventory_movements(commit)`
- 不得重复把 `orders/payments` 状态再改一遍

### 4.3 `refund_reference`

用途：

- 由调用方生成
- 表示“一次退款请求”的唯一实例
- 用来防止重复退款、重复写 `refund_restock`

同一个 `refund_reference` 重放时：

- 应直接返回第一次退款结果
- 不得再次回补库存
- 不得再次生成新的退款状态变更

### 4.4 为什么这 3 个锚点要分开

因为它们锚定的是 3 种不同动作：

- `payment_request_id`
  - 创建支付链接
- `payment_reference`
  - 确认某笔 payment 已支付
- `refund_reference`
  - 发起某次退款

如果混成一个字段，会把：

- “建链接的请求重试”
- “支付成功确认重放”
- “退款动作重放”

这 3 类问题混在一起，后面会很难定位和去重。

## 5. 调用方输入合同

统一外层结构沿用根 [SKILL.md](/Users/Zhuanz/purrfect-suite/SKILL.md) 当前的 prod 输入合同：

- `channel`
- `command_code`
- `user`
- `params`
- `runtime.db_path`

说明：

- customer 的“去支付 / 给我支付链接 / 我已付好了”属于 payments 意图，但不是 customer 直接持自身身份调用 runtime
- 这些支付意图由调用方触发，再以店铺受信身份调用 `payments` runtime
- `user.external_user_id` 表示 runtime 调用者身份；正常 Agent 代店铺执行时应传 Agent-id，owner 直接执行时传 owner-id
- `params.customer_external_user_id` 表示“本次正在帮哪个 customer 操作”
- runtime 会再从数据库里反查订单归属 customer：`orders.customer_id -> customers.external_user_id`
- 因此 payments 里会明确区分三层身份：
  - 调用者：`user.external_user_id`
  - 请求 customer：`params.customer_external_user_id`
  - 订单 customer：`orderRow.order_customer_external_user_id`
- 对应 audit 会记作 `actor_type = caller`，`actor_id = channel:external_user_id`

### 5.1 `payments.create_payment_link`

最小输入建议：

```json
{
  "channel": "telegram",
  "command_code": "payments.create_payment_link",
  "user": {
    "external_user_id": "agent-001"
  },
  "params": {
    "order_number": "PO-1001",
    "payment_request_id": "payments-create-link-po-1001-001",
    "customer_external_user_id": "customer-001"
  }
}
```

规则：

- 必填：
  - `order_number`
  - `payment_request_id`
- Agent 调用时，`customer_external_user_id` 必填
- owner 调用时，`customer_external_user_id` 可省略
- 只要传了 `customer_external_user_id`，它就必须和订单归属 customer 完全一致
- runtime 会从数据库里把该订单的 `order_customer_external_user_id` 查出来，再和请求里的 `customer_external_user_id` 比对
- 当前不要求调用方传 `reserved_until`
- reservation TTL 由 `payments` runtime 统一设置短时有效期，再写入 `orders.reserved_until`
- 这条命令通常由 customer 的 checkout / 去支付意图触发，但真正调用 runtime 的是调用方代表店铺执行的受信身份

### 5.2 `payments.confirm_mock_paid`

最小输入建议：

```json
{
  "channel": "telegram",
  "command_code": "payments.confirm_mock_paid",
  "user": {
    "external_user_id": "agent-001"
  },
  "params": {
    "payment_reference": "mock-pay-po-1001-001",
    "customer_external_user_id": "customer-001"
  }
}
```

规则：

- 必填：
  - `payment_reference`
- Agent 调用时，`customer_external_user_id` 必填
- owner 调用时，`customer_external_user_id` 可省略
- 只要传了 `customer_external_user_id`，它就必须和目标 payment 关联订单的归属 customer 完全一致
- runtime 会先通过 `payment_reference -> payment.order_id` 找到订单，再反查 `order_customer_external_user_id`
- 这是 mock 支付成功确认命令，不是 webhook 原始 payload
- v1 先把它当成“调用方确认这笔 mock payment 成功”的规范化命令，不是 customer 直接调用的 runtime 命令
- 实现已经返回序列化后的 `order`；post-payment 的默认用户摘要应直接基于这个 `order` 构造
- 只有当用户明确要求更多详情时，才继续进入 `orders.show_order` 或 `orders.show_my_orders`

### 5.3 `payments.refund_mock_payment`

最小输入建议：

```json
{
  "channel": "telegram",
  "command_code": "payments.refund_mock_payment",
  "user": {
    "external_user_id": "owner-001"
  },
  "params": {
    "order_number": "PO-1001",
    "refund_reference": "refund-po-1001-001"
  }
}
```

规则：

- 必填：
  - `order_number`
  - `refund_reference`
- v1 当前不要求部分退款金额
- v1 先按全额退款设计

## 6. SQLite 读写合同

主要写：

- `payments`
- `orders`
- `inventory_movements`
- `audit_events`

必要读：

- `orders`
- `order_items`
- `payments`
- `skus`
- `business_config`

### 6.1 `payments.create_payment_link`

读写顺序建议：

1. 读 `orders`，确认：
   - 订单存在
   - `status = draft`
2. 读 `order_items`
3. 读 `skus`
4. 校验 `business_config.payment_provider = mock`
5. 检查 `payment_request_id` 是否已处理
6. 创建或复用一条 `payments(pending)`
7. `orders.status -> pending_payment`
8. 写 `orders.reserved_until`
9. 写 `inventory_movements(reserve)`
10. 写 `audit_events`

审计要求：

- `payments.payment_link_created` 写 `actor_type = caller`
- 这一步联动产生的 `orders.order_status_changed` 也写 `actor_type = caller`
- `actor_id` 固定为 `channel:external_user_id`
- `payload_json.actor_identity` 补充当前 v1 复用 active owner identity 的鉴权真相
- `payments.payment_link_created.payload_json` 额外写：
  - `requested_customer_external_user_id`
  - `order_customer_external_user_id`
  - `acting_for_customer`

结果：

- 返回 `payment_reference`
- 返回 mock `payment_link_url`
- 返回新的 `reserved_until`

### 6.2 `payments.confirm_mock_paid`

读写顺序建议：

1. 用 `payment_reference` 查 `payments`
2. 读关联 `orders`
3. 确认订单当前可从 `pending_payment` 进入 `paid`
4. `payments.status -> paid`
5. `orders.status -> paid`
6. 清空或失效 `reserved_until`
7. 写 `inventory_movements(commit)`
8. 对 `quantity` SKU，扣减 `skus.stock_quantity`
9. 写 `audit_events`

审计要求：

- `payments.payment_paid` 写 `actor_type = caller`
- 这一步联动产生的 `orders.order_status_changed` 也写 `actor_type = caller`
- `actor_id` 固定为 `channel:external_user_id`
- `payload_json.actor_identity` 补充当前 v1 复用 active owner identity 的鉴权真相
- `payments.payment_paid.payload_json` 额外写：
  - `requested_customer_external_user_id`
  - `order_customer_external_user_id`
  - `acting_for_customer`

### 6.3 `payments.refund_mock_payment`

读写顺序建议：

1. 查 `orders`
2. 查关联 `payments`
3. 确认当前状态允许退款
4. `payments.status -> refunded`
5. `orders.status -> refunded`
6. 对允许回补的 SKU 写 `inventory_movements(refund_restock)`
7. 对 `quantity` SKU，在允许回补时加回 `skus.stock_quantity`
8. 写 `audit_events`

审计要求：

- `payments.payment_refunded` 保持 `actor_type = owner`
- 这一步联动产生的 `orders.order_status_changed` 也保持 `actor_type = owner`

## 7. `inventory_mode` 对 payments 的影响

### `quantity`

`create_payment_link`：

- 对每个 item 写一条 `reserve`
- `reserve` 只代表锁定，不修改 `skus.stock_quantity`

`confirm_mock_paid`：

- 对每个 item 写一条 `commit`
- 再把 `skus.stock_quantity` 按数量扣减

`refund_mock_payment`：

- 如果 `restock_on_refund = true`
  - 写一条 `refund_restock`
  - 把 `skus.stock_quantity` 加回
- 如果 `restock_on_refund = false`
  - 不回补库存

### `date_quantity`

这里要特别说明“nightly reservation”。

对于房型类 `date_quantity` item：

- reservation 不是对整段住宿一次性写一条 movement
- 而是对住宿覆盖到的每一晚，各写一条 movement

例子：

- `check_in_date = 2099-07-01`
- `check_out_date = 2099-07-03`

真正会占用的 nightly dates 是：

- `2099-07-01`
- `2099-07-02`

不包含：

- `2099-07-03`

所以：

- `create_payment_link`
  - 每晚一条 `reserve`
- `confirm_mock_paid`
  - 每晚一条 `commit`
- `refund_mock_payment`
  - 若允许回补，每晚一条 `refund_restock`

固定约束：

- `date_quantity` 的 payment 流程必须逐晚写 movement
- reference key 必须带 `inventory_date=YYYY-MM-DD`
- `check_out_date` 始终是 end-exclusive

## 8. reference_key 与幂等

`payments` 必须沿用 `inventory` 已冻结的 reference key 规则。

### 8.1 `create_payment_link`

reservation movement：

- `quantity`
  - `reserve:order_id=<...>:order_item_id=<...>:sku_id=<...>`
- `date_quantity`
  - `reserve:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`

说明：

- 这一步的动作幂等主要由：
  - `payment_request_id`
  - `inventory_movements.reference_key`
  共同保证

### 8.2 `confirm_mock_paid`

commit movement：

- `quantity`
  - `commit:payment_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>`
- `date_quantity`
  - `commit:payment_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`

说明：

- 同一个 `payment_reference` 只能完成一次支付确认
- 同一个 `payment_reference` 重放时，应直接返回已支付结果

### 8.3 `refund_mock_payment`

refund movement：

- `quantity`
  - `refund_restock:refund_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>`
- `date_quantity`
  - `refund_restock:refund_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`

说明：

- 同一个 `refund_reference` 只能完成一次退款回补动作
- 如果某个 SKU 不允许回补，就不写对应的 `refund_restock`

## 9. 状态流转

v1 mock payment 先冻结以下状态流转：

1. `draft -> pending_payment`
   - 触发方：`payments.create_payment_link`
   - 副作用：
     - `payments.status = pending`
     - `orders.reserved_until` 写短 TTL
     - 写 `reserve`

2. `pending_payment -> paid`
   - 触发方：`payments.confirm_mock_paid`
   - 副作用：
     - `payments.status = paid`
     - `orders.status = paid`
     - 写 `commit`
     - 对 `quantity` SKU 扣减 `skus.stock_quantity`

3. `paid -> refunded`
   - 触发方：`payments.refund_mock_payment`
   - 副作用：
     - `payments.status = refunded`
     - `orders.status = refunded`
     - 按策略写 `refund_restock`

4. `pending_payment -> cancelled`
   - 触发方：inventory 过期扫描或显式取消
   - 副作用：
     - 写 `release`
     - `reason = expired` 或其他取消原因

## 10. 最小测试集

happy path：

- `draft` 订单成功生成 payment link
- `create_payment_link` 后订单变为 `pending_payment`
- `create_payment_link` 后写入 `payments(pending)`
- `quantity` item 成功写 `reserve`
- `date_quantity` item 成功逐晚写 `reserve`
- `confirm_mock_paid` 后 `payments/orders` 都变为 `paid`
- `confirm_mock_paid` 后写 `commit`
- `refund_mock_payment` 后 `payments/orders` 都变为 `refunded`

幂等：

- 相同 `payment_request_id` 重放时：
  - 返回同一条 payment link
  - 不重复写 `reserve`
- 相同 `payment_reference` 重放确认支付时：
  - 返回 `idempotent_replay = true`
  - 不重复写 `commit`
- 相同 `refund_reference` 重放退款时：
  - 返回 `idempotent_replay = true`
  - 不重复写 `refund_restock`

edge cases：

- 非 `draft` 订单拒绝创建 payment link
- 非 `pending_payment` 订单拒绝确认已支付
- 非 `paid` 订单拒绝退款
- `payment_provider != mock` 时拒绝执行 mock payment 命令
- `date_quantity` item 缺日期时拒绝进入 payment 链
- `reserved_until` 过期后再 confirm paid 应拒绝或要求重新建 link
