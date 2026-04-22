# Purr Suite v1 Skill 合同总览

本文档是 7 个技能的总览与索引，不再承载每个 skill 的全部实现细节。  
详细设计统一拆到 `docs/v1/execution-plan/skills/`。定义方式与结构参考 [Guide-to-Building-Skill.md](../reference/Guide-to-Building-Skill.md)。

完整开发顺序与阶段目标见：[v1-development-plan.md](v1-development-plan.md)。

目录约定：

- `skills/` 只放 Skill 包说明
- 所有 Python 代码都放在 `scripts/`
- 共享 Python 模块统一放在 `scripts/lib/`
- 数据表是共享数据层，不采用“一张表只属于一个 skill”的理解

## 1. 通用合同模板

每个 skill 的详细文档都必须覆盖以下内容：

1. skill 目录内的 `SKILL.md`
2. 触发命令/意图
3. 宿主输入合同
4. SQLite 读写合同
5. owner/customer 响应合同
6. 防护约束（鉴权、幂等、限制条件）
7. 最小测试集（happy path + edge cases）

## 2. 七个技能与详细文档

1. `onboarding`
   - 主表：`owners`、`business_config`、`audit_events`
   - 详细设计：[onboarding.md](skills/onboarding.md)
2. `catalog`
   - 主逻辑表：`skus`、`audit_events`
   - 详细设计：[catalog.md](skills/catalog.md)
3. `inventory`
   - 主逻辑表：`skus`、`orders`、`order_items`、`inventory_movements`、`audit_events`
   - 详细设计：[inventory.md](skills/inventory.md)
4. `orders`
   - 主表：`orders`、`order_items`、`audit_events`
   - 详细设计：[orders.md](skills/orders.md)
5. `payments`
   - 主表：`payments`、`webhook_events`、`audit_events`
   - 详细设计：[payments.md](skills/payments.md)
6. `crm`
   - 主表：`customers`、`conversations`、`audit_events`
   - 详细设计：[crm.md](skills/crm.md)
7. `seller-bi`
   - 主表：`orders`、`payments`
   - 详细设计：[seller-bi.md](skills/seller-bi.md)

## 3. 跨技能约束

1. 角色约束
   - 仅 owner 可执行：setup、SKU 变更、库存调整、退款、BI
   - customer 可执行：查看目录、发起购买意图、查询自己的订单
2. 状态一致性
   - 支付成功驱动订单变为 `paid`，并提交库存扣减
   - 支付失败或过期驱动库存预留释放
   - `skus.stock_quantity` 表示现货库存，不是可售库存
   - `pending_payment + reserved_until < now` 视为 expired
   - 过期释放统一写 `inventory_movements(release)`，并用 `reason=expired` 区分原因
3. 幂等性
   - webhook 通过 `(provider, event_id)` 去重
   - 库存关键写操作通过 movement reference key 去重
4. 渠道边界
   - Telegram 接入由 OpenClaw 提供
   - Purr Suite skill 消费宿主消息上下文，不自行绑定 TG token

## 4. 构建顺序

1. `onboarding`
2. `catalog`
3. `inventory`
4. `orders`
5. `payments`
6. `crm`
7. `seller-bi`
