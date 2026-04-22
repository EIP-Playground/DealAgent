# 2026-03-14 更新批次说明：Catalog `inventory_mode`、Inventory Phase A、`command_code`

## 1. 这批更新覆盖了什么

这份说明对应最近这一批新提交，主要覆盖 4 个主题：

| Commit | 主题 | 一句话说明 |
| --- | --- | --- |
| `5b88649` | Catalog `inventory_mode` | SKU 定义层支持 `quantity` / `date_quantity`，并把 mixed hospitality 数据集切到默认审查流。 |
| `884cceb` | Inventory Phase A | 真正落地 inventory runtime、日期库存覆盖、low-stock 生命周期和扫描脚本。 |
| `5b24eec` | `command_code` 切换 | 已实现 skill 全量从 `message_text` 切到 `command_code`，并补了 `inventory.show_low_stock` 与确认流测试。 |
| `3734d47` | Skill 文档表格化 | 根 `SKILL.md` 和已实现子 skill 改成按子技能分表列命令与关键 `params`。 |

如果你只想快速理解当前代码库的新事实，优先看这 4 个主题，不用先从所有历史 PR 开始。

## 2. 你需要先知道的最终状态

### 2.1 Catalog 不再只是“普通商品”

- `catalog` 现在定义 SKU 的 `inventory_mode`
- 当前允许两种：
  - `quantity`
  - `date_quantity`
- `quantity`
  - `skus.stock_quantity` 表示现货库存
- `date_quantity`
  - `skus.stock_quantity` 表示默认每晚容量
  - 精确日期库存由 `sku_date_overrides` 覆盖

同时：

- `inventory_mode` 允许修改
- 但只能通过 `catalog.update_inventory_mode`
- 并且必须通过 Safe Switch：
  - 该 SKU 不能已有 `inventory_movements`
  - 不能已有 `order_items`
  - 不能已有 `sku_date_overrides`

### 2.2 Inventory Phase A 已经是真实现，不只是设计稿

现在已注册并可运行的 inventory 命令有：

| `command_code` | 作用 |
| --- | --- |
| `inventory.show_inventory` | owner 看库存总览 |
| `inventory.show_stock` | owner 看单个 SKU 库存 |
| `inventory.adjust_stock` | owner 手工加减库存或调整默认 nightly capacity |
| `inventory.set_date_stock` | owner 批量设置日期库存覆盖 |
| `inventory.show_low_stock` | owner 查看当前 low-stock 结果 |

另外还有一个独立脚本：

- `node dist/scripts/run_low_stock_scan.js`

它的职责和 `inventory.show_low_stock` 不一样：

- `inventory.show_low_stock`
  - 先刷新当前 low-stock 状态
  - 再返回当前结果
  - **不**把 alert 标记成 `sent`
- `run_low_stock_scan`
  - 面向宿主/cron
  - 输出待提醒结果
  - 同时把 `pending -> sent`

### 2.3 运行时输入协议已经切换

已实现 skill 现在统一使用：

- `command_code`
- `params`

不再用：

- `message_text`

也就是说，宿主现在给 runtime 的结构应当是：

| 字段 | 用途 |
| --- | --- |
| `channel` | 渠道标识 |
| `command_code` | 规范化命令码 |
| `user` | 调用用户身份 |
| `params` | 业务参数容器 |
| `runtime` | 运行时参数，如 `db_path` |

### 2.4 Skill 文档已经按命令表收口

根 `SKILL.md` 现在：

- 明确说明 `params` 是所有 skill 的业务参数容器
- 按子技能分别列出已实现命令表

已实现子技能也都有自己的命令表：

- `skills/onboarding/SKILL.md`
- `skills/catalog/SKILL.md`
- `skills/inventory/SKILL.md`

这意味着队员现在可以直接从 skill 文档读出：

- 这个 skill 支持哪些 `command_code`
- 每个命令至少需要哪些关键 `params`

## 3. 这批改动里最值得注意的几个设计点

### 3.1 `needs_confirmation` 现在是正式协议

`inventory.adjust_stock` 在 60 秒窗口内遇到相同 owner、相同 SKU、相同 `delta + reason` 的重复手工调整时，不会直接再写一条 movement，而是返回：

- `status = "needs_confirmation"`

现在这不是隐含行为，而是正式文档化的协议：

- Agent 必须先和商家确认
- 商家确认后：
  - 重新调用 `inventory.adjust_stock`
  - 保持业务内容不变
  - 使用**新的** `operation_id`
  - 带 `confirm_duplicate = true`
- 商家不确认：
  - 不再调用 runtime
- 商家改口：
  - 视为新的调整请求

### 3.2 `operation_id` 由 Agent/宿主生成

这一批把 `operation_id` 的责任也写死了：

- runtime 不生成
- Agent/宿主生成
- 同一次请求重试复用同一个 ID
- 真正的新操作必须换新 ID

推荐格式是可读 slug + 递增编号，例如：

- `inventory-adjust-stock-minibar-snack-box-001`
- `inventory-set-date-stock-family-suite-4p-001`

### 3.3 原始产品文档没改

这批实现没有去改：

- `docs/v1/product-foundation/v1-product-spec.md`
- `docs/v1/product-foundation/v1-demo-spec.md`

如果当前实现和原始 spec/demo 有解释差异，只体现在：

- `Agent.md`
- `docs/v1/execution-plan/`
- `docs/v1/database/sqlite-design.md`

这条规则现在是明确约束。

## 4. Review 时建议重点看什么

如果你是来做 code review 或快速接手，建议优先看这几块：

### 4.1 先看运行时入口和契约

- `scripts/lib/catalog.ts`
- `scripts/lib/inventory.ts`
- `scripts/lib/onboarding.ts`
- `scripts/lib/skill_runner.ts`

重点确认：

- 是否都已经改成读 `command_code`
- `catalog.update_inventory_mode` 的 Safe Switch 是否符合预期
- `inventory.show_low_stock` 是否只读、不发送

### 4.2 再看 schema 和库存模型

- `scripts/db/migrations/0004_skus_inventory_mode.sql`
- `scripts/db/migrations/0005_inventory_date_overrides_and_alerts.sql`
- `docs/v1/database/sqlite-design.md`

重点确认：

- `inventory_mode` 的语义是否清楚
- `sku_date_overrides` 是否足够表达日期库存
- `low_stock_alerts` 生命周期是否合理

### 4.3 最后看 fixtures 和集成测试

- `tests/integration/test_catalog.test.ts`
- `tests/integration/test_inventory.test.ts`
- `tests/integration/test_onboarding.test.ts`
- `tests/integration/test_skill_entrypoints.test.ts`

重点确认：

- `command_code` 已全量替代旧字段
- 60 秒重复调整确认流是否覆盖完整
- `inventory.show_low_stock` 是否覆盖“刷新但不标 sent”

## 5. 队员快速验证命令

### 5.1 先跑集成测试

```bash
npx vitest run \
  tests/integration/test_catalog.test.ts \
  tests/integration/test_inventory.test.ts \
  tests/integration/test_onboarding.test.ts \
  tests/integration/test_skill_entrypoints.test.ts \
  tests/integration/test_schema_migrations.test.ts
```

### 5.2 重建默认审查库

```bash
node dist/scripts/dev/load_fixture.js --preset review-catalog --fresh --db-path data/dev/purr_suite_dev.sqlite3
```

### 5.3 查看 low-stock

```bash
printf '%s\n' '{
  "channel": "telegram",
  "command_code": "inventory.show_low_stock",
  "user": {
    "external_user_id": "owner-001"
  },
  "runtime": {
    "db_path": "data/dev/purr_suite_dev.sqlite3"
  }
}' | node dist/scripts/run_skill.js --skill inventory
```

### 5.4 查看审计链

```bash
node dist/scripts/dev/db_inspect.js --db-path data/dev/purr_suite_dev.sqlite3 --show-audit-events --limit 20
```

## 6. 一句话总结

这批更新把 Purr Suite 从“只有 catalog + onboarding 的基础框架”推进到了：

- SKU 已经能区分普通库存和日期库存
- inventory Phase A 已能真实运行
- low-stock 有 runtime 查看入口和独立扫描入口
- 运行时协议统一成 `command_code + params`
- skill 文档已经能直接给宿主/Agent 当命令参考
