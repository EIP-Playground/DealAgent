# 2026-03-16 更新批次说明：Seller BI Runtime、指标口径冻结、Demo Replay Preset

## 1. 这批更新覆盖了什么

这份说明对应 `seller-bi` runtime 和 demo replay 工具落地的这一批改动。

这一批最终合并成 1 个主提交：

| Commit | 主题 | 一句话说明 |
| --- | --- | --- |
| `80d515d` | Seller BI + Demo Replay | 真正落地 owner-only BI runtime，冻结 `sales_today` / `revenue_this_month` 口径，并补一条可重复回放的 demo preset。 |

如果你只想快速理解这一批的新事实，建议按下面 3 个主题读，不用从所有 diff 逐行开始：

1. `seller-bi` 已经从占位 skill 变成正式 runtime
2. `sales_today` / `revenue_this_month` / 多币种展示规则已经冻结
3. `scripts/dev/load_fixture.ts` 现在有一条真正可跑的 `demo-replay` preset

## 2. 你需要先知道的最终状态

### 2.1 `seller-bi` 现在已经是正式可执行 skill

当前 `scripts/lib/skill_runner.ts` 已注册：

- `seller-bi`

当前可执行命令：

| `command_code` | 作用 |
| --- | --- |
| `seller_bi.sales_today` | 返回锚点日期当天的成交订单数 |
| `seller_bi.revenue_this_month` | 返回锚点日期所在月份的净收入，按币种分组展示 |

兼容说明：

- runtime 兼容旧别名：
  - `seller-bi.sales_today`
  - `seller-bi.revenue_this_month`
- 但正式推荐宿主统一发：
  - `seller_bi.sales_today`
  - `seller_bi.revenue_this_month`

同时：

- 只允许 owner 调用
- customer 调用会返回 `forbidden`
- runtime 仍然不做自然语言理解

### 2.2 这批真正把 2 个 BI 指标的口径写死了

当前 v1 只冻结 2 个指标：

- `sales_today`
- `revenue_this_month`

它们现在不是“随便写个 SQL 统计一下”，而是有明确合同。

#### `sales_today`

当前定义：

- 统计 `orders.paid_at` 落在 `anchor_date` 当天窗口内的订单数

这意味着：

- 它回答的是“当天发生过多少笔成交”
- 不要求该订单今天查询时仍然保持 `paid`
- 如果订单后来退款，`sales_today` 仍保留这笔成交计数

也就是说，v1 现在把它固定成：

- **gross sales event count**

不是：

- “当前净剩多少 paid 订单”

#### `revenue_this_month`

当前定义：

- 统计 `payments.paid_at` 落在 `anchor_date` 所在月份内
- 并且当前 `payments.status = paid`
- 的支付金额合计

这意味着：

- 它表示 v1 的 **net paid revenue**
- 已退款 payment 不计入结果
- 退款前后同一个月查询，结果会变化

### 2.3 多币种展示现在是正式规则，不再靠调用方猜

`revenue_this_month` 不允许把不同币种直接相加。

当前固定规则：

- 按 `currency` 分组聚合
- runtime 返回 `revenue_rows`
- 每行包含：
  - `currency`
  - `amount_minor`
  - `display_amount`

也就是说，如果 reviewer 在返回里没有看到单一总额，而是看到：

- `USD 885.00`
- `JPY 7000`

这不是“少做了一步”，而是当前有意为之。

原因很简单：

- v1 没有 FX 汇率层
- 直接相加会制造错误经营数据

### 2.4 `anchor_date` 现在是 seller-bi 的关键输入，不是可有可无

这批把相对时间的解释边界也定住了。

当前规则：

- 宿主必须传显式 `params.anchor_date`
- 格式固定 `YYYY-MM-DD`
- runtime 再根据它推导：
  - 当天窗口
  - 当月窗口

这样做的意义是：

- 避免宿主和 runtime 时区不一致
- 避免 fixture 回放结果不稳定
- 避免 demo 录制时“today / this month”漂移

### 2.5 `demo-replay` 现在已经是一条真正可跑的回放链

`scripts/dev/load_fixture.ts` 当前新增：

- `--preset demo-replay`

它会按固定顺序回放：

1. owner setup
2. owner catalog 准备
3. owner low-stock 准备
4. customer catalog 查看
5. customer draft order
6. payment link
7. paid confirmation
8. inventory / order post-payment read
9. seller-bi 查询
10. refund
11. refund 后 seller-bi 再查一次

这条 preset 的作用不是“替代测试”，而是：

- 给 demo 录制一个稳定起点
- 给 reviewer 一个能快速重建状态的本地回放路径
- 给手工验收一个固定脚本入口

## 3. 这批改动里最值得注意的几个设计点

### 3.1 `sales_today` 和 `revenue_this_month` 的退款语义是故意分开的

这是这批最容易在 review 里被误判成 bug 的地方。

当前语义是：

- `sales_today`
  - 看成交事件
  - 退款后仍保留计数
- `revenue_this_month`
  - 看当前净收入
  - 退款后会扣除

如果 reviewer 看到：

- 退款后 `sales_today` 仍然是 `1`
- 但 `revenue_this_month` 变成 `0`

这不是逻辑冲突，而是刻意区分：

- **销量事件**
- **净收入**

### 3.2 `demo-replay` 不只是“按顺序跑 fixtures”

这批给 `load_fixture` 增加了一个新的能力：

- preset 不只可以包含 fixture
- 也可以包含中间 hook

当前 `demo-replay` 用了 2 个 development-only hook：

- `set_demo_paid_timestamps`
- `set_demo_refund_timestamps`

作用是：

- 把 `paid_at` / `refunded_at` 改成 demo 约定日期
- 让 seller-bi 查询对 `2099-07-*` 的锚点稳定可复现

也就是说，这条 preset 现在已经不是纯“fixture 拼接器”，而是：

- fixture replay + deterministic demo normalization

### 3.3 fixture 到 skill 的推断规则现在更通用了

为了让：

- `tests/fixtures/seller_bi_owner_sales_today.json`
- `tests/fixtures/seller_bi_owner_revenue_this_month.json`

这种文件名也能被 `load_fixture` 正常识别，
这批顺手扩展了 fixture -> skill 的推断逻辑。

现在：

- `seller_bi_*`
  - 能正确映射到 skill `seller-bi`

这点虽然小，但如果 reviewer 不注意，容易把它看成和 preset 无关的杂项改动。

实际上它是为了让：

- 新增 BI fixtures
- `demo-replay` preset

能够真正一起工作。

## 4. Review 时建议重点看什么

如果你是来做 code review 或快速接手，建议优先看这几块。

### 4.1 先看 seller-bi runtime 本身

- `scripts/lib/seller_bi.ts`
- `scripts/lib/skill_runner.ts`
- `skills/seller-bi/SKILL.md`
- `SKILL.md`

重点确认：

- `seller-bi` 是否已经正式注册
- owner 权限判断是否正确
- `anchor_date` 校验是否足够清楚
- 旧 `seller-bi.*` 命令别名是否只做兼容，不会污染正式合同

### 4.2 再看指标口径文档是否和实现一致

- `docs/v1/execution-plan/skills/seller-bi.md`
- `Agent.md`
- `TODO.md`
- `docs/v1/execution-plan/v1-development-plan.md`

重点确认：

- `sales_today` 是否明确是 gross sales event count
- `revenue_this_month` 是否明确是 net paid revenue
- 多币种是否明确按 `currency` 分组而不是总和
- `anchor_date` 是否已经是正式必填合同

### 4.3 然后看 demo replay preset 的实现边界

- `scripts/dev/load_fixture.ts`
- `scripts/dev/README.md`

重点确认：

- preset 顺序是否符合 demo 叙事
- hook 是否只做 development-only 时间归一化
- `review-catalog` 旧 preset 是否没有被破坏

### 4.4 最后看 seller-bi 的测试覆盖是否足够防回归

- `tests/integration/test_seller_bi.test.ts`
- `tests/fixtures/seller_bi_owner_sales_today.json`
- `tests/fixtures/seller_bi_owner_revenue_this_month.json`

重点确认：

- 空数据时是否返回稳定结果
- owner / customer 权限边界是否覆盖
- 退款后 `sales_today` 与 `revenue_this_month` 的分叉语义是否覆盖
- 多币种分组是否覆盖

## 5. 队员快速验证命令

### 5.1 先跑 seller-bi 最相关测试

```bash
npx vitest run tests/integration/test_seller_bi.test.ts -v
```

### 5.2 再跑当前全量集成测试

```bash
npx vitest run tests/integration
```

### 5.3 直接重建 demo replay 数据库

```bash
node dist/scripts/dev/load_fixture.js --preset demo-replay --fresh \
  --db-path data/dev/purr_suite_demo.sqlite3
```

预期关键结果：

- payment confirm 后：
  - `seller_bi.sales_today` -> `1`
  - `seller_bi.revenue_this_month` -> `USD 885.00`
- refund 后：
  - `seller_bi.sales_today` -> 仍然 `1`
  - `seller_bi.revenue_this_month` -> `0`

### 5.4 如果只想单独重放 BI 查询

```bash
node dist/scripts/test_skill.js \
  --skill seller-bi \
  --fixture tests/fixtures/seller_bi_owner_sales_today.json \
  --db-path data/dev/purr_suite_demo.sqlite3
```

```bash
node dist/scripts/test_skill.js \
  --skill seller-bi \
  --fixture tests/fixtures/seller_bi_owner_revenue_this_month.json \
  --db-path data/dev/purr_suite_demo.sqlite3
```

## 6. 一句话总结

这批更新把 Purr Suite 从“交易主链已跑通但 demo 还缺结尾”推进到了：

- `seller-bi` 已正式可执行
- 关键 BI 指标口径已经冻结
- demo 现在有一条稳定可回放的 preset
