# Seller BI Skill 详细设计（v1）

## 1. 目标

`seller-bi` 负责基于已经稳定落库的订单与支付结果，返回 owner 视角的最小经营指标。

v1 第一版只冻结 2 个指标：

- `sales_today`
- `revenue_this_month`

当前定位：

- 直接补齐 demo spec 最后一段
- 只做 owner 侧只读指标
- 不做自然语言理解
- 不做报表导出、图表、排行或复杂分析

## 2. 技能边界

`seller-bi` 负责：

- 返回基于 `orders` / `payments` 的最小经营指标
- 固定指标口径
- 固定多币种展示规则

`seller-bi` 不负责：

- 自然语言解析
- 订单创建
- 支付确认
- 库存修改
- CRM 对话记录
- 实时报表导出

固定前提：

- OpenClaw / 宿主负责把自然语言归一成 canonical `command_code + params`
- `seller-bi` runtime 只消费规范化 JSON
- 指标结果以 SQLite 中已经提交的业务事实为准

## 3. `command_code`

v1 第一版冻结以下 canonical `command_code`：

- `seller_bi.sales_today`
- `seller_bi.revenue_this_month`

兼容说明：

- runtime 会兼容旧写法别名：
  - `seller-bi.sales_today`
  - `seller-bi.revenue_this_month`
- 但文档和宿主推荐只使用 canonical `seller_bi.*`

## 4. 宿主输入合同

统一外层结构沿用根 [SKILL.md](/Users/Zhuanz/purrfect-suite/SKILL.md) 当前的 prod 输入合同：

- `channel`
- `command_code`
- `user`
- `params`
- `runtime.db_path`

### 4.1 为什么 v1 要显式传 `anchor_date`

`today` / `this month` 都是相对时间。

为了避免：

- 宿主时区和 runtime 时区不一致
- 回放 fixture 时结果不稳定
- demo 录制时“今天”含义漂移

v1 runtime 固定要求宿主传显式的 `params.anchor_date`。

规则：

- 格式：`YYYY-MM-DD`
- 表示宿主已经解释好的业务锚点日期
- runtime 再据此推导当天窗口或当月窗口

### 4.2 `seller_bi.sales_today`

最小输入建议：

```json
{
  "channel": "telegram",
  "command_code": "seller_bi.sales_today",
  "user": {
    "external_user_id": "owner-001"
  },
  "params": {
    "anchor_date": "2026-03-15"
  }
}
```

规则：

- 必填：
  - `anchor_date`
- 只允许 owner 调用

### 4.3 `seller_bi.revenue_this_month`

最小输入建议：

```json
{
  "channel": "telegram",
  "command_code": "seller_bi.revenue_this_month",
  "user": {
    "external_user_id": "owner-001"
  },
  "params": {
    "anchor_date": "2026-03-15"
  }
}
```

规则：

- 必填：
  - `anchor_date`
- runtime 根据 `anchor_date` 所在月份计算月窗口
- 只允许 owner 调用

## 5. 指标口径冻结

这部分是 v1 最重要的合同。

### 5.1 `sales_today`

定义：

- 统计 `orders.paid_at` 落在 `anchor_date` 当天窗口内的订单数

窗口：

- `window_start = anchor_date 00:00:00`
- `window_end_exclusive = anchor_date + 1 day 00:00:00`

口径说明：

- 这是“当天发生过多少笔成交”的计数
- 只要订单在当天进入过 paid，就计入
- 后续如果该订单又变成 `refunded`，仍然保留这笔成交计数

原因：

- `sales_today` 在 v1 表示 gross sales event count
- 它回答的是“今天发生了几笔销售”，不是“今天最终净剩几笔 paid 订单”

### 5.2 `revenue_this_month`

定义：

- 统计 `payments.paid_at` 落在 `anchor_date` 所在月份内、且当前 `payments.status = paid` 的支付金额合计

窗口：

- `window_start = month first day 00:00:00`
- `window_end_exclusive = next month first day 00:00:00`

口径说明：

- 这是 v1 的 net paid revenue
- 已退款 payment 不计入当月收入
- v1 当前只做全额退款；未来如果引入部分退款，需要重新冻结净收入口径

原因：

- demo 中 BI 查询发生在退款动作之后
- 如果月收入仍把已退款金额算进去，会和当前业务状态不一致

## 6. 多币种展示规则

`revenue_this_month` 不允许把不同币种直接相加。

固定规则：

- 按 `currency` 分组聚合
- runtime 返回 `revenue_rows`
- 每行都包含：
  - `currency`
  - `amount_minor`
  - `display_amount`
- `display_amount` 使用共享 money formatter 生成

返回解释：

- 0 个币种：
  - 返回空数组
- 1 个币种：
  - 仍返回数组，只是长度为 1
- 多个币种：
  - 返回多行，不额外折算成统一货币

原因：

- v1 没有 FX 汇率层
- 直接相加会制造错误的经营数据

## 7. 数据来源

### 7.1 `sales_today`

主要读：

- `orders`

主要字段：

- `orders.order_number`
- `orders.status`
- `orders.paid_at`

说明：

- 统计以 `orders.paid_at` 为准
- 不以当前订单状态是否仍是 `paid` 为准

### 7.2 `revenue_this_month`

主要读：

- `payments`

主要字段：

- `payments.status`
- `payments.amount_minor`
- `payments.currency`
- `payments.paid_at`

说明：

- 聚合以 `payments` 为准
- 已退款 payment 通过 `status != paid` 被排除

## 8. 返回合同

固定返回：

- `status`
- `reply`
- `metric_code`
- `anchor_date`

### 8.1 `seller_bi.sales_today`

成功时返回：

- `window_start`
- `window_end_exclusive`
- `sales_count`

### 8.2 `seller_bi.revenue_this_month`

成功时返回：

- `month`
- `window_start`
- `window_end_exclusive`
- `currency_count`
- `multi_currency`
- `revenue_rows`

`revenue_rows[*]` 结构：

- `currency`
- `amount_minor`
- `display_amount`

建议状态集合：

- `computed`
- `forbidden`
- `invalid_input`
- `invalid_intent`

## 9. owner / customer 边界

- owner 可以查询全部指标
- customer 不允许访问任何 seller-bi 指标
- runtime 不根据自然语言猜角色，只根据 owner 身份映射判断

## 10. 当前实现状态

v1 当前应实现：

- owner `seller_bi.sales_today`
- owner `seller_bi.revenue_this_month`
- 多币种按 `currency` 分组展示
- fixtures / integration tests

暂不实现：

- top SKU
- AOV
- repeat buyers
- 自然语言开放问答
- 图表与导出
