# Catalog Skill 详细设计（v1）

## 1. 目标

`catalog` 负责定义“卖什么”和“怎么展示”，不负责库存保留、释放、提交或回补。

当前已落地的能力范围：

- 新增 SKU
- 更新 SKU 详情 / 价格 / 状态
- 安全切换 `inventory_mode`
- 归档 SKU
- owner 视角查看单个 SKU 和全部 SKU
- customer `catalog.show_catalog` / `catalog.show_product` 已接入 inventory availability

## 2. 输入合同

`catalog` runtime 只接受 canonical `command_code`，不做自然语言理解。

统一规则：

- `command_code` 只放 canonical 命令码
- 业务字段全部放 `params`
- 外部引用 SKU 一律使用 `sku_code`

Phase A 接受的 canonical `command_code`：

- `catalog.add_sku`
- `catalog.update_details`
- `catalog.update_inventory_mode`
- `catalog.update_price`
- `catalog.update_status`
- `catalog.archive_sku`
- `catalog.show_sku`
- `catalog.show_catalog`
- `catalog.show_product`

Phase A 的 `params` 合同：

- `catalog.add_sku`
  - 必填：`sku_code`, `title`, `price_minor`, `currency`
  - 可选：`inventory_mode`, `description`, `stock_quantity`, `sellable_status`, `media_url`, `product_url`, `restock_on_refund`
  - `inventory_mode` 默认 `quantity`
  - 允许值：`quantity`, `date_quantity`
  - `stock_quantity`
    - `quantity` 时表示现货库存
    - `date_quantity` 时表示默认每晚容量
- `catalog.update_details`
  - 必填：`sku_code`
  - 至少一个：`title`, `description`, `media_url`, `product_url`
- `catalog.update_inventory_mode`
  - 必填：`sku_code`, `inventory_mode`
  - 仅允许：`quantity`, `date_quantity`
- `catalog.update_price`
  - 必填：`sku_code`, `price_minor`, `currency`
- `catalog.update_status`
  - 必填：`sku_code`, `sellable_status`
  - 仅允许：`active`, `unavailable`
- `catalog.archive_sku`
  - 必填：`sku_code`
- `catalog.show_sku`
  - 必填：`sku_code`
- `catalog.show_catalog`
  - owner 视角无额外必填字段
- `catalog.show_product`
  - 必填：`sku_code`

固定规则：

- runtime 不猜 `inventory_mode`
- 你要在调用前与商家确认：
  - 明显是房型/日期库存 -> 用 `date_quantity`
  - 普通零售 -> 默认 `quantity`
- `inventory_mode` 只能通过独立命令 `catalog.update_inventory_mode` 修改
- `catalog.update_details` / `catalog.update_price` / `catalog.update_status` / `catalog.archive_sku` 都不允许改 mode
- `catalog.update_inventory_mode` 只在 Safe Switch 成功时允许修改
- Safe Switch 的失败条件：
  - 已有 `inventory_movements`
  - 已有 `order_items`
  - 已有 `sku_date_overrides`
- 原始 `v1-product-spec.md` 与 `v1-demo-spec.md` 保持不改；当前实现解释只记录在 execution-plan 和 schema 文档

## 3. `sku_code` 规则

- `sku_code` 是外部主标识，不暴露数据库内部 `id`
- `sku_code` 创建后不可修改
- `sku_code` 归档后不复用
- runtime 只校验和去重，不负责生成

自动生成责任固定在 Agent 侧：

- 你要先参考 `skills/catalog/reference/sku-code-generation.md`
- 你要先向用户解释生成标准和示例
- 你要先生成候选 `sku_code`
- 你要先告诉用户最终将要创建的编码
- 然后再调用 runtime

runtime 校验规则：

- 非空
- 唯一
- 仅允许大写字母、数字、`-`、`_`
- 长度不超过 30

## 4. SQLite 合同

主要写：

- `skus`
- `audit_events`

主要读：

- `skus`

写入范围：

- 创建 SKU
- 更新标题、描述、价格、币种、媒体、链接
- 更新 `sellable_status`
- 归档 SKU

不负责的写入：

- 不写 `inventory_movements`
- 不执行 reservation / release / commit / refund_restock

创建规则：

- 创建 SKU 时允许写初始 `stock_quantity`
- 创建后的库存变化全部交给 `inventory`
- `catalog` 负责定义 `inventory_mode`
- `inventory` 负责解释不同 mode 下的库存口径

价格规则：

- 当前价格存 `skus.price_minor + skus.currency`
- runtime 统一返回派生字段 `display_price`
- Phase A 只支持法币：
  - `USD`, `CNY`, `JPY`, `HKD`, `SGD`, `KRW`, `EUR`
- 精度映射：
  - 2 位：`USD`, `CNY`, `HKD`, `SGD`, `EUR`
  - 0 位：`JPY`, `KRW`

## 5. 返回与展示合同

runtime 固定返回：

- `status`
- `reply`

成功时返回：

- 单条：`sku`
- 列表：`skus`
- 变更类附带：`audit_event_type`

每个 `sku` 结构里都应包含：

- 持久化字段
- `display_price`
- `inventory_mode`
- `stock_quantity_semantics`
- customer 视角额外包含：
  - `availability_status`
  - `availability_hint`

建议状态集合：

- `created`
- `updated`
- `archived`
- `found`
- `listed`
- `forbidden`
- `not_found`
- `invalid_input`
- `invalid_intent`
- `conflict`

Agent 输出义务：

- 成功：先自然语言说明结果，再附 Markdown 表格
- 失败：自然语言解释原因，不直接输出原始 JSON

## 6. owner / customer 边界

owner 视角：

- 可查看 SKU 详情
- 可查看全部 SKU，包括 `archived / unavailable`
- owner 返回应能区分：
  - `inventory_mode = quantity` -> `stock_quantity_semantics = on_hand_quantity`
  - `inventory_mode = date_quantity` -> `stock_quantity_semantics = default_nightly_capacity`

customer 视角：

- `catalog.show_catalog` / `catalog.show_product` 已通过 inventory 统一返回 availability
- 只展示 `sellable_status = active` 的 SKU
- `quantity` SKU 返回普通 availability 状态
- `date_quantity` SKU：
  - 无日期：只展示房型与 `dates_required` 提示
  - 有 `check_in_date` / `check_out_date`：返回精确 availability
- `catalog` 不自行发明库存口径，所有 customer availability 都来自 inventory helper

## 7. 审计与防护

- owner 才可执行 SKU 变更
- SKU 变更必须写 `audit_events`
- Phase A 审计事件：
  - `catalog.sku_created`
  - `catalog.sku_updated`
  - `catalog.sku_archived`

## 8. 当前实现状态

当前 runtime 已实现：

1. owner SKU CRUD
2. owner 视角 `catalog.show_sku` / `catalog.show_catalog`
3. `catalog.update_inventory_mode` Safe Switch
4. inventory-backed customer `catalog.show_catalog` / `catalog.show_product`

当前仍待后续阶段实现：

1. 订单驱动的库存保留 / 提交 / 释放 / 回补
2. 与 `orders/payments` 的交易主链闭环
