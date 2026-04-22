# Inventory Skill 详细设计（v1）

## 1. 目标

`inventory` 负责库存口径、库存一致性、日期库存维护和 low-stock 生命周期。

当前实现边界：

- **不修改** `docs/v1/product-foundation/v1-product-spec.md`
- **不修改** `docs/v1/product-foundation/v1-demo-spec.md`
- 如果当前实现对原始 spec/demo 有解释差异，只记录在 execution-plan、schema 和 `Agent.md`

当前已实现的范围：

- 共享库存服务
- owner inventory runtime
- customer catalog availability 联调
- low-stock 主动提醒
- `orders/payments` 驱动的 `reserve`
- `commit`
- `release`
- `refund_restock`

宿主侧默认调度：

- `onboarding.setup_suite` 成功且数据库存在后，宿主或 Agent 必须按 `skills/onboarding/cron/low-stock-scan.md` 通过 Gateway cron tool 检查并安装受管 OpenClaw cron 任务，让 `node <skill_package_root>/dist/scripts/run_low_stock_scan.js` 按 5 分钟周期运行

## 2. inventory_mode 与日期库存

v1 当前支持两种库存模式：

- `quantity`
- `date_quantity`

语义固定为：

- `quantity`
  - `skus.stock_quantity` 表示现货库存
- `date_quantity`
  - `skus.stock_quantity` 表示默认每晚容量
  - 具体日期库存通过 `sku_date_overrides` 稀疏覆盖

补充口径：

- `quantity` SKU 继续采用库存语义 A：
  - `skus.stock_quantity` 是当前 on-hand 库存快照
  - `reserve` 只锁定库存，不直接改 `skus.stock_quantity`
  - `commit` 才把已支付订单真正扣到 `skus.stock_quantity`
  - `refund_restock` 在允许回补时把库存加回 `skus.stock_quantity`
- 因此 `quantity` 下已 `paid` / `fulfilled` 的影响已经体现在当前 `stock_quantity` 中
- `quantity` SKU 的可售库存继续按 `stock_quantity - 当前有效 reservation` 推导
- `date_quantity` SKU 不直接改写 `skus.stock_quantity`
- `date_quantity` 的某晚可售量按“默认/覆盖容量 - 当前有效 `pending_payment` 预留 - 已 `paid` / `fulfilled` 的房晚占用”计算
- 任何 SKU 粒度的 reservation 或 `show inventory` 计算都不能只查 `orders`，必须结合 `orders + order_items`
- `inventory_movements` 负责库存动作历史、审计与幂等，不替代 `order_items`

这次不做：

- 完整每日库存主表
- 把日期编码进 `sku_code`
- 把系统写死成酒店专用产品

## 3. 当前已落地数据结构

### `skus.inventory_mode`

- 允许值：`quantity`, `date_quantity`
- 默认值：`quantity`
- 由 `catalog` 在 `catalog.add_sku` 时定义
- 可通过独立命令 `catalog.update_inventory_mode` 修改
- 修改必须通过 Safe Switch：
  - 该 SKU 没有 `inventory_movements`
  - 没有 `order_items`
  - 没有 `sku_date_overrides`

### `sku_date_overrides`

用途：为 `date_quantity` SKU 提供日期级库存覆盖。

关键字段：

- `sku_id`
- `inventory_date`
- `stock_quantity_override`
- `sellable_status_override`
- `reason`
- `created_by_owner_id`

关键约束：

- `(sku_id, inventory_date)` 唯一

语义：

- 若某天没有 override，则回退到 `skus.stock_quantity`
- 若某天有 override，则使用该天覆盖值
- owner 使用日期区间输入时，runtime 内部逐日展开写入
- `date_quantity` 订单支付或退款时会更新对应日期的 override，以保持“当前剩余容量”一致

### `low_stock_alerts`

用途：跟踪 low-stock 提醒生命周期，不复用 `audit_events`。

关键字段：

- `sku_id`
- `inventory_date` 可空
- `inventory_mode`
- `threshold`
- `sellable_quantity`
- `status`
- `detected_at`
- `sent_at`
- `resolved_at`

状态：

- `pending`
- `sent`
- `resolved`

## 4. Inventory Phase A runtime

当前 runtime 已注册到 `scripts/lib/skill_runner.ts`。

已实现 canonical `command_code`：

- `inventory.show_inventory`
- `inventory.show_stock`
- `inventory.adjust_stock`
- `inventory.set_date_stock`
- `inventory.show_low_stock`

### `inventory.show_inventory`

- owner-only
- 返回每个 SKU 的库存视图

至少包含：

- `sku_code`
- `title`
- `inventory_mode`
- `stock_quantity`
- `stock_quantity_semantics`
- `sellable_status`
- `reserved_quantity`
- `sellable_quantity`
- `low_stock`
- `low_stock_threshold`

### `inventory.show_stock`

- owner-only
- 必填：`params.sku_code`

对 `quantity`：

- 返回当前普通库存视图

对 `date_quantity`：

- 可选：`params.date_from`, `params.date_to`
- 无日期时：
  - 返回默认 nightly capacity
  - 返回提示：传日期区间可看精确日期库存
- 有日期时：
  - 返回逐日库存视图
  - 返回该区间的聚合最小可售量

### `inventory.adjust_stock`

- owner-only
- 必填：
  - `params.sku_code`
  - `params.delta`
  - `params.reason`
  - `params.operation_id`
- 可选：
  - `params.confirm_duplicate`

行为：

- `quantity`：调整现货库存
- `date_quantity`：调整默认 nightly capacity
- 写 `inventory_movements(manual_adjust)`
- 写 `audit_events`
- 同步 low-stock 状态

### `inventory.set_date_stock`

- owner-only
- 仅适用于 `date_quantity`
- 必填：
  - `params.sku_code`
  - `params.date_from`
  - `params.date_to`
  - `params.stock_quantity`
  - `params.reason`
  - `params.operation_id`
- 可选：
  - `params.sellable_status`

行为：

- runtime 逐日展开日期区间
- 对每一天 upsert `sku_date_overrides`
- 若某天设置值与默认 `stock_quantity` / `sellable_status` 完全一致：
  - 删除该日 override，保持表稀疏
- 写日期库存审计事件
- 同步 low-stock 状态

### `inventory.show_low_stock`

- owner-only
- 无必填参数

行为：

- 进入后先重新扫描当前 low-stock 状态
- 再返回当前低库存结果
- 返回内容同时覆盖：
  - `quantity` SKU 的当前低库存项
  - `date_quantity` SKU 在未来 30 天窗口内的低库存日期项
- `date_quantity` 的低库存只在计算出的可售量低于阈值且不是默认 nightly capacity 时触发
- 这个命令只做 owner 查看
- 不把 `low_stock_alerts.status` 从 `pending` 改成 `sent`

## 5. customer availability 口径

customer catalog 已接入 inventory。

### `quantity`

- 直接返回 availability 状态
- 当前状态词：
  - `available`
  - `only_a_few_left`
  - `unavailable`

### `date_quantity`

- 若带 `check_in_date` + `check_out_date`：
  - 返回精确 availability
  - 口径取入住区间内每日可售量的最小值
- 若不带日期：
  - 仍可展示房型
  - 但只返回 `dates_required`
  - 不得伪造无日期下的精确库存

说明：

- owner 的 `inventory.show_stock` 日期区间采用 **inclusive** `date_from/date_to`
- customer 的入住日期采用酒店常见语义：
  - `check_in_date` 含当天
  - `check_out_date` 不占库存

## 6. reference_key 与幂等

总原则：

- 不用动作内容做 key
- 用业务动作实例做 key
- 统一采用显式 `field=value` 风格
- `delta` 不进入自动化 key

### 已实现的手工动作 key

- `manual_adjust`
  - `manual_adjust:operation_id=<...>:sku_id=<...>`
- `set_date_stock`
  - `set_date_stock:operation_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`

### `manual_adjust` 的二次确认流

若满足以下条件：

- 同一 owner
- 同一 SKU
- 相同 `delta`
- 相同 `reason`
- 60 秒内再次提交

则默认返回 `needs_confirmation`。

固定处理规则：

- 如果 runtime 返回 `needs_confirmation`：
  - 这不是最终失败
  - 这表示系统检测到 60 秒内已经有一笔内容完全相同的手工库存调整
  - Agent 必须先向商家确认，不能直接静默重试
- 如果商家明确确认：
  - 重新调用 `inventory.adjust_stock`
  - 保持 `sku_code` / `delta` / `reason` 不变
  - 使用**新的** `operation_id`
  - 设置 `confirm_duplicate = true`
- 如果商家明确不确认：
  - 不再调用 runtime
  - 当前库存保持第一次结果不变
- 如果商家改口并修改了 `delta` 或 `reason`：
  - 视为新的库存调整请求
  - 使用新的 `operation_id`
  - 不带 `confirm_duplicate = true`

### `operation_id` 生成规范

- `operation_id` 必须由 Agent/宿主生成，runtime 不负责生成
- `operation_id` 表示“一次手工库存操作请求的实例 ID”
- 同一次请求重试时，必须复用同一个 `operation_id`
- 真正的新操作，即使内容一模一样，也必须使用新的 `operation_id`

推荐格式：

- 使用可读 `kebab-case` slug + 递增编号
- 编号范围按 `action + sku` 递增
- 示例：
  - `inventory-adjust-stock-minibar-snack-box-001`
  - `inventory-adjust-stock-minibar-snack-box-002`
  - `inventory-set-date-stock-family-suite-4p-001`
  - `inventory-set-date-stock-family-suite-4p-002`

若需要把日期区间显式带进去，`inventory.set_date_stock` 可写成：

- `inventory-set-date-stock-family-suite-4p-2099-07-01-to-2099-07-03-001`

### 已冻结的未来自动化 key 规则

#### `quantity`

- `reserve:order_id=<...>:order_item_id=<...>:sku_id=<...>`
- `commit:payment_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>`
- `release:order_id=<...>:order_item_id=<...>:sku_id=<...>:reason=<...>`
- `refund_restock:refund_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>`

#### `date_quantity`

- 一晚一条 movement
- `reserve:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`
- `commit:payment_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`
- `release:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD:reason=<...>`
- `refund_restock:refund_reference=<...>:order_id=<...>:order_item_id=<...>:sku_id=<...>:inventory_date=YYYY-MM-DD`

说明：

- `order_item_id` 是库存动作实例锚点
- 它不等于 `sku_id`
- 未来酒店订单日期字段挂在 `order_items`，不是 `orders`

## 7. low-stock 主动提醒

默认阈值固定为：

- `2`

规则：

- `quantity`
  - 当前 `sellable_quantity <= 2` 时触发提醒
- `date_quantity`
  - 扫描未来 30 天
  - 某天 `sellable_quantity <= 2` 时触发该日提醒

重发策略：

- 只有**恢复后再次跌破**才允许生成新提醒

独立扫描脚本：

- `scripts/run_low_stock_scan.ts`

行为：

- 定时运行
- 输出应推给 Agent 的提醒 JSON
- 不直接发消息
- 把 `pending` 提醒标记为 `sent`

## 8. 当前 Phase B 范围

当前已经落地：

- `reserve_order_items(...)`
- `release_order_reservation(...)`
- `commit_order_reservation(...)`
- `restock_refunded_order(...)`
- `date_quantity` 的真实 nightly reservation / commit / release / refund_restock

当前仍需继续补：

- 更细的 oversell 保护与异常恢复策略
- 自动化库存动作的更多回归测试
- 真实 provider / webhook 接入后的支付侧联调
