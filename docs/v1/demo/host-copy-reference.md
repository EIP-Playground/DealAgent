# Host Copy Reference（中文内部彩排版）

## 1. 这份文档是干什么的

这份文档给宿主层使用，用来把 skill runtime 的结构化 JSON 包装成更像产品的聊天体验。

它**不是**：

- runtime 代码
- `skills/*/reference/` 下的单 skill 附属知识
- 要在每次调用时整份塞进 LLM 上下文的超长 prompt

它是：

- 宿主 reply 的参考文档
- demo 阶段的话术模板库
- 后续如果要做 host rendering spec 的前置素材

## 2. 如何避免占用太多 LLM 上下文

推荐分两层使用：

### 2.1 Always-on copy kernel

这部分可以常驻在宿主 prompt 里，长度应控制在很短的范围内。

推荐 kernel：

1. 优先像“会做事的店铺助手”，不要像 API 返回解释器。
2. 先给结果，再给必要细节，不先解释系统内部过程。
3. 每次回复只保留用户当前最关心的下一步。
4. 金额、日期、订单号、商品名必须具体，不用模糊词。
5. 如果是购买或售后场景，默认带上状态结论。
6. 如果同一条消息里既有结果也有下一步，下一步只给一个。
7. 不要复述 `command_code`、skill 名或 JSON 字段名。
8. 对投资人可见画面，语气要简洁、稳、像真实产品，不要工程味太重。

### 2.2 Scenario templates

详细模板不要常驻上下文。

使用方式：

- 只在命中特定场景时检索对应模板
- 或者 operator 在彩排时人工参考

## 3. 场景模板

## 3.1 Catalog 展示

适用输入：

- `catalog.show_catalog`
- `catalog.show_product`

必须出现的信息：

- 至少 1 个主推商品/房型名称
- 价格
- 是否可订 / 是否需要日期

推荐模板：

> 这几天可选的房型我帮你整理好了。  
> `Deluxe Seaview King` 为 `USD 289.00/晚`，当前可以预订；如果你想，我可以继续帮你下单。

更短版本：

> 这几天 `Deluxe Seaview King` 可订，价格 `USD 289.00/晚`。要不要我继续帮你下单？

避免事项：

- 不要把整个 catalog 都铺成长表
- 不要把 `inventory_mode`、`sellable_status` 这些内部词直接给客户
- 不要只说“Loaded 3 SKU(s)”

## 3.2 CRM 跟进回复

适用输入：

- `crm.get_response_context` + 宿主准备给客户的跟进消息

必须出现的信息：

- 客户当前问的是哪一个主 SKU
- 现在是否可订/可买
- 价格或下一步

推荐模板：

> 你刚才问的 `Deluxe Seaview King` 这几天可以预订，价格是 `USD 289.00/晚`。如果你确认，我现在就可以继续帮你下单。

更短版本：

> `Deluxe Seaview King` 这几天可订，`USD 289.00/晚`。你确认的话我继续帮你下单。

避免事项：

- 不要暴露“CRM context”这种内部概念
- 不要把历史 `message_text` 原样复读给客户
- 不要把 `current_sku_snapshot` 说成“历史记录”

## 3.3 支付成功后的订单摘要

适用输入：

- `payments.confirm_mock_paid`

必须出现的信息：

- `order_number`
- 状态
- 订了什么
- 房型日期或普通商品数量

推荐模板：

> 付款已确认，订单 `PO-1001` 已生效。  
> 你已预订 `Deluxe Seaview King`（`2099-07-01` 入住，`2099-07-04` 离店），并加购 `1` 份 `Minibar Snack Box`。

更短版本：

> 付款成功，订单 `PO-1001` 已确认：`Deluxe Seaview King` `3` 晚 + `1` 份 `Minibar Snack Box`。

避免事项：

- 不要只回 `payment_reference`
- 不要只说“paid”
- 不要漏掉房型日期

## 3.4 Refund 回执

适用输入：

- `payments.refund_mock_payment`

必须出现的信息：

- `order_number`
- 退款已完成
- 状态已同步

推荐模板：

> 订单 `PO-1001` 已完成退款，相关订单状态和库存都已经同步更新。

更短版本：

> `PO-1001` 已退款完成，状态已同步。

避免事项：

- 不要把退款说成“已发起”如果 runtime 已经是 `refunded`
- 不要展开过多内部库存细节
- 不要只给 `refund_reference`

## 3.5 BI 回答

适用输入：

- `seller_bi.sales_today`
- `seller_bi.revenue_this_month`

必须出现的信息：

- 时间锚点
- 结果值
- 币种

推荐模板：

> 以 `2099-07-02` 为锚点，今天成交 `1` 单。  
> 以 `2099-07` 为锚点，本月净收入是 `USD 885.00`。

退款后推荐模板：

> 今天成交仍然是 `1` 单；但本月净收入已经回到 `0`。

更短版本：

> 今天 `1` 单，本月净收入 `USD 885.00`。  
> 退款后：成交仍是 `1`，净收入回到 `0`。

避免事项：

- 不要把 `sales_today` 和 `revenue_this_month` 混成一个数字
- 不要省略币种
- 不要把“成交事件”误讲成“当前净 paid 订单数”

## 4. 宿主包装时的字段取舍

推荐优先级：

1. 直接面向用户的结果字段
   - `status`
   - `reply`
   - `order`
   - `payment`
   - `revenue_rows`
2. 用户看得懂的业务细节
   - `order_number`
   - `items`
   - `check_in_date`
   - `check_out_date`
   - `display_amount`
3. 不直接暴露给用户的字段
   - `command_code`
   - `audit_event_type`
   - `payment_reference`
   - `idempotent_replay`

## 5. 对 demo operator 的使用建议

- 彩排时先按 [investor-demo-shot-script.md](/Users/eight/Desktop/Coding_Space/purrfect-suite/docs/v1/demo/investor-demo-shot-script.md) 逐幕走
- 每一幕要对外展示的聊天内容，优先从本文档取模板
- 如果模板和当下画面不完全贴合，允许微调措辞，但不要改动：
  - 商品名
  - 价格
  - 日期
  - 订单号
  - BI 数字

## 6. 当前边界

这份文档先只服务：

- 中文内部彩排
- 投资人 demo 录制准备

它不替代：

- 正式的 host rendering spec
- 多语言 copy system
- runtime 返回结构本身
