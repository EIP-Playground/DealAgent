# Investor Demo 拍摄脚本（中文内部彩排版）

## 1. 目的

这份脚本把当前已经跑通的：

- `crm`
- `orders`
- `payments`
- `seller-bi`
- `scripts/dev/load_fixture.ts --preset demo-replay`

压成一套可拍、可排练、可复述的逐镜头脚本。

使用原则：

- 这是**内部彩排脚本**，不是对外产品 spec
- 画面以聊天界面为主，命令行只作为 operator 侧准备工具
- 观众看到的是宿主包装后的聊天体验，不是 runtime 原始 JSON

## 2. 演员与画面

- `owner`
  - 店主 Alice
  - 画面：宿主聊天界面 / Telegram 店主视角
- `customer`
  - 客户 Anna
  - 画面：同一 Bot 的客户视角
- `旁白`
  - 内部彩排时可念，正式版可作为字幕或后期 overlay

推荐画面标签：

- `宿主控制台`
- `店主聊天界面`
- `客户聊天界面`
- `支付跳转页`

## 3. 逐镜头脚本

| `scene_id` | `actor` | `spoken_line` | `host_action` | `fixture_or_command` | `skill` | `screen` | `expected_visible_reply` | `narration_focus` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `S01` | owner | “帮我初始化 Purr Suite。” | 宿主路由到 suite setup，完成 owner pairing。 | `tests/fixtures/onboarding_first_setup.json` | `onboarding` | `宿主控制台 -> 店主聊天界面` | “Purr Suite 已初始化完成，店主账号已绑定，可以开始上架和接单。” | 搭建不是后台项目，而是对话式启用。 |
| `S02` | owner | “先上几种房型和一个附加商品。” | 宿主连续执行 SKU 创建，准备一个主推房型、一个标准房、一个不可售房型和一个 minibar add-on。 | `catalog_owner_add_room_deluxe_seaview.json` + `catalog_owner_add_room_standard_city.json` + `catalog_owner_add_room_single_seaview_unavailable.json` + `catalog_owner_add_minibar_snack_box.json` | `catalog` | `店主聊天界面` | 逐条看到“SKU 创建成功”，重点停留在 `Deluxe Seaview King` 和 `MINIBAR-SNACK-BOX`。 | 一个聊天入口同时管理商品和可售状态。 |
| `S03` | owner | “我现在能卖什么？库存怎么样？” | 宿主先做一个低库存准备，再读取库存总览。 | `inventory_owner_adjust_minibar_stock_low.json` + `inventory_owner_show_inventory.json` | `inventory` | `店主聊天界面` | “已加载 4 条库存记录”，画面里能看出房型与 minibar 共存，且 minibar 处于低库存。 | 没有切到后台，库存和商品在同一条业务链上。 |
| `S04` | customer | “我想看看 7 月 1 日到 7 月 4 日有什么房间。” | 宿主把日期补进 `catalog.show_catalog`，返回 customer 视角房型列表。 | `tests/fixtures/catalog_customer_show_room_catalog_with_dates.json` | `catalog` | `客户聊天界面` | 一条紧凑 catalog 回复，至少出现 `Deluxe Seaview King` 的价格与可订状态。 | 客户在同一 Bot 里直接得到带日期的可售结果。 |
| `S05` | customer | “海景大床房这几天可以订吗？” | 宿主先把询单记进 CRM，再读取 response context，再用宿主话术回一条报价/跟进。 | `crm_caller_log_inquiry_deluxe_room.json` + `crm_caller_get_response_context_customer_001.json` + `crm_caller_log_reply_deluxe_room.json` + `crm_caller_upsert_customer_summary_customer_001.json` | `crm` | `客户聊天界面` | “Deluxe Seaview King 这几天可订，价格是 USD 289.00/晚。如果你确认，我可以继续帮你下单。” | CRM 和销售转化在同一个聊天体验里完成。 |
| `S06` | customer | “可以，那就下单吧，顺便加一份 minibar snack box。” | 宿主把会话补齐后创建 draft order。 | `tests/fixtures/orders_customer_create_deluxe_room_and_minibar.json` | `orders` | `客户聊天界面` | “已为你创建订单草稿 PO-1001，包含海景大床房 3 晚和 1 份 minibar snack box。” | 询单自然过渡到订单，不需要人工整理聊天记录。 |
| `S07` | 旁白 | “接下来由调用方代表店铺发起支付。” | 宿主代表店铺创建支付链接，订单进入 `pending_payment`。 | `tests/fixtures/payments_caller_create_payment_link.json` | `payments` | `客户聊天界面 -> 支付跳转页` | “这是你的支付链接，完成后我会自动确认订单。” 画面可短暂切到支付页。 | 支付链接不是手工开票，而是系统追踪的一部分。 |
| `S08` | 旁白 | “模拟支付成功后，系统自动确认订单并联动库存。” | 宿主确认 mock paid，随后可补一条宿主侧自然语言回执。 | `tests/fixtures/payments_caller_confirm_mock_paid.json` | `payments` | `客户聊天界面` | “付款已确认，订单 PO-1001 已生效。你已预订 Deluxe Seaview King（2099-07-01 至 2099-07-04），并加购 1 份 minibar snack box。” | 支付成功后，订单和库存自动更新。 |
| `S09` | customer | “帮我看看我的订单。” | 宿主读取 customer 订单列表。 | `tests/fixtures/orders_customer_show_my_orders.json` | `orders` | `客户聊天界面` | “你当前有 1 笔订单：PO-1001，状态为 paid。” 画面里最好直接显示房型和日期摘要。 | 同一个入口承接售后自助，不需要店主人工回复。 |
| `S10` | owner | “今天卖了多少？这个月收入多少？” | 宿主先读退款前 BI。 | `tests/fixtures/seller_bi_owner_sales_today.json` + `tests/fixtures/seller_bi_owner_revenue_this_month.json` | `seller-bi` | `店主聊天界面` | “今天成交 1 单；本月净收入 USD 885.00。” | 所有经营指标直接建立在同一套订单/支付数据上。 |
| `S11` | owner | “把 PO-1001 退掉。” | owner 视角发起退款。 | `tests/fixtures/payments_owner_refund_mock_payment.json` | `payments` | `店主聊天界面` | “订单 PO-1001 已退款，相关状态和库存已同步更新。” | 退款不是外挂流程，而是订单模型的延伸。 |
| `S12` | owner | “那现在本月收入还剩多少？” | 宿主再读退款后 BI，作为结尾。 | `tests/fixtures/seller_bi_owner_sales_today.json` + `tests/fixtures/seller_bi_owner_revenue_this_month.json` | `seller-bi` | `店主聊天界面` | “今天成交仍然是 1 单，但本月净收入已经回到 0。” | 同一条链路同时解释销售事件和净收入。 |

## 4. 画面切换建议

- `S01-S03`
  - 节奏偏快，用来建立“聊天也能做运营”的第一印象
- `S04-S08`
  - 是主戏，需要给客户聊天界面更多停留时间
- `S09-S12`
  - 重点展示“售后自助 + 退款 + BI”这一套闭环

推荐镜头长度：

- setup / catalog / inventory：每幕 `5-10` 秒
- CRM / order / payment：每幕 `10-18` 秒
- refund / BI：每幕 `6-10` 秒

## 5. 彩排注意事项

- 不要直接把 fixture 的英文 `reply` 原样读给投资人听；正式画面应使用宿主包装后的中文话术
- `crm.show_history` 当前不建议作为投资人主画面，只作为 operator 校对 CRM 是否已落库
- `payments_caller_create_payment_link` 和 `payments_caller_confirm_mock_paid` 的 caller 语义可以由旁白解释一次，但不要在主画面里讲技术词
- 付款成功后的客户回执里，必须明确出现：
  - `order_number`
  - 房型名
  - 入住/离店日期
  - add-on 商品
- 结尾一定要同时讲清：
  - `sales_today` 仍然是 `1`
  - `revenue_this_month` 因退款变成 `0`

## 6. 与现有 demo spec 的关系

- [v1-demo-spec.md](/Users/eight/Desktop/Coding_Space/purrfect-suite/docs/v1/product-foundation/v1-demo-spec.md)
  - 保持产品故事层
- 本文档
  - 负责“今天这套实现到底怎么拍”

如果产品故事和当前实现不完全一致，以本文档和当前 fixtures 为准进行内部彩排。
