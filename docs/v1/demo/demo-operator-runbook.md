# Demo Operator Runbook（中文内部彩排草稿）

## 1. 目的

这份 runbook 给负责彩排或录制 demo 的同事使用。

目标是让另一个工程师在**不翻代码**的情况下，也能完成：

1. reset demo 数据库
2. 对照脚本确认当前状态
3. 从 owner setup 一直走到 refund + seller-bi

## 2. 演示目标

本轮不是做实时工程 debug，而是稳定复现这条投资人故事：

- 一个 Bot
- 两个角色（owner/customer）
- 一条从 inquiry 到支付、退款和 BI 的闭环

本轮假设：

- demo 语言为中文内部彩排
- 画面以聊天界面为主
- 支付页面只做短暂过渡
- runtime 内部 JSON 不直接展示给投资人

## 3. 预备条件

### 3.1 使用的数据库

固定使用：

```bash
data/dev/purr_suite_demo.sqlite3
```

### 3.2 推荐 reset 命令

每次正式彩排前，先执行：

```bash
node dist/scripts/dev/load_fixture.js --preset demo-replay --fresh \
  --db-path data/dev/purr_suite_demo.sqlite3
```

这条命令的作用：

- 重建 demo DB
- 校验所有 fixtures 仍然可跑
- 顺手核对 seller-bi 关键数字没有漂

### 3.3 演员准备

- owner：`owner-001 / alice`
- customer：`customer-001 / guest-anna`

画面准备：

- 店主聊天界面
- 客户聊天界面
- 可选的宿主控制台
- 可选的支付跳转页

## 4. 彩排前检查

每次开始前确认：

1. `demo-replay` 已经成功跑完
2. 你手上的拍摄脚本版本是：
   - [investor-demo-shot-script.md](/Users/eight/Desktop/Coding_Space/purrfect-suite/docs/v1/demo/investor-demo-shot-script.md)
3. 宿主回复话术参考版本是：
   - [host-copy-reference.md](/Users/eight/Desktop/Coding_Space/purrfect-suite/docs/v1/demo/host-copy-reference.md)
4. 当前 payment fixtures 是：
   - `payments_caller_create_payment_link`
   - `payments_caller_confirm_mock_paid`
   - `payments_owner_refund_mock_payment`

## 5. 录制顺序

## 5.1 开场：owner setup

目标状态：

- 观众理解这是一个对话式启用流程

operator 提示：

- 画面可从宿主控制台切入，再切到店主聊天界面
- setup 这幕只需要简洁，不要停太久

必须看到：

- “Purr Suite initialized” 对应的宿主自然语言包装
- owner pairing 成功的明确结果

## 5.2 店主准备商品与库存

目标状态：

- 至少有一个主推房型
- 至少有一个 add-on
- 至少能看见库存总览

operator 提示：

- 主推展示 `Deluxe Seaview King`
- add-on 展示 `Minibar Snack Box`
- 不可售房型不需要长时间停留，只要证明不是所有商品都在售

必须看到：

- SKU 创建成功反馈
- 库存总览里能区分房型和 add-on

## 5.3 客户询房 + CRM 跟进

目标状态：

- 观众看到客户问房
- 观众看到系统用业务上下文回复，而不是纯 FAQ

operator 提示：

- 主镜头放在客户聊天界面
- CRM 历史和 response-context 不一定要作为主画面展示，但 operator 需知道后台对应的是这些步骤

必须看到：

- 客户问日期型房型
- 系统给出可订 + 价格 + 下一步

## 5.4 下单与支付

目标状态：

- draft order 创建
- 支付链接发出
- paid 确认后订单摘要清楚

operator 提示：

- 付款链接这一步只需要短暂切到支付页，不要让画面脱离聊天太久
- 付款成功后的回复里必须把订单内容说完整

必须看到：

- `PO-1001`
- `Deluxe Seaview King`
- `2099-07-01 -> 2099-07-04`
- `Minibar Snack Box`

## 5.5 订单自助查询

目标状态：

- 观众理解客户可以在同一 Bot 里自己查订单

必须看到：

- customer 侧 “我的订单”
- 当前订单状态为 `paid`

## 5.6 退款与 BI 收尾

目标状态：

- owner 发起退款
- 退款后 BI 数字变化成立

operator 提示：

- BI 需要拍两次：
  - refund 前
  - refund 后

必须看到：

- refund 前：`sales_today = 1`
- refund 前：`revenue_this_month = USD 885.00`
- refund 后：`sales_today = 1`
- refund 后：`revenue_this_month = 0`

## 6. 推荐 operator 工作流

### 6.1 正式录制前

先跑一次 reset：

```bash
node dist/scripts/dev/load_fixture.js --preset demo-replay --fresh \
  --db-path data/dev/purr_suite_demo.sqlite3
```

如果这一步失败，**不要进入录制**。

### 6.2 录制时

- 按 [investor-demo-shot-script.md](/Users/eight/Desktop/Coding_Space/purrfect-suite/docs/v1/demo/investor-demo-shot-script.md) 的 `scene_id` 顺序走
- 用户可见回复按 [host-copy-reference.md](/Users/eight/Desktop/Coding_Space/purrfect-suite/docs/v1/demo/host-copy-reference.md) 取模板
- 每一幕结束时，operator 只检查“关键信号是否出现”，不在现场做工程解释

### 6.3 录制失败后的恢复

如果中途状态乱了，直接重新执行：

```bash
node dist/scripts/dev/load_fixture.js --preset demo-replay --fresh \
  --db-path data/dev/purr_suite_demo.sqlite3
```

不要尝试手动修 demo DB。

## 7. 常见失败与恢复办法

### 7.1 看到的是 runtime 英文 reply，不像产品聊天

原因：

- 宿主没有做自然语言包装

处理：

- 回到 [host-copy-reference.md](/Users/eight/Desktop/Coding_Space/purrfect-suite/docs/v1/demo/host-copy-reference.md)
- 使用对应场景模板重新包装

### 7.2 payment 前后状态讲不清

原因：

- 付款成功后的订单摘要不完整

处理：

- 重新检查是否至少说出了：
  - `order_number`
  - 房型名
  - 日期
  - add-on 商品

### 7.3 BI 数字和预期不一致

原因：

- demo DB 没有 fresh reset
- refund 前后镜头顺序错了

处理：

- 重新执行 `demo-replay --fresh`
- 先拍退款前 BI，再拍退款，再拍退款后 BI

### 7.4 把 caller/owner 角色讲反了

原因：

- 把 create/confirm 说成 owner 手动操作

处理：

- 对外只讲“系统代表店铺完成支付流转”
- 不在主画面里解释 `caller` 术语
- refund 再强调是 owner 的管理动作

## 8. 最终通过标准

这次 demo operator run 的通过标准是：

1. 不翻代码也能按脚本完成彩排
2. 观众能看懂：
   - 一个 Bot
   - 两个角色
   - 一条完整闭环
3. 付款成功和退款后的 BI 结果都能对上
4. operator 遇到失败时知道唯一恢复动作就是重新 `demo-replay --fresh`
