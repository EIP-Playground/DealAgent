# DealAgent

DealAgent 是一个 chat-first 的库存与客服解决方案。项目当前以库存管理和客户服务为切入点，围绕商品、询单、下单、支付、订单、退款和基础经营数据，逐步扩展成一套轻量级的商家运营工作台。

它的核心判断是：对小商家来说，聊天本身就应该是业务入口。与其把客服、库存、订单和支付拆在多个工具里，不如让一个具备角色权限和业务状态的智能助手统一承接。

## 愿景

我们的第一目标，是把 DealAgent 做成 **PurrfectClaw 上的库存 + 客服一体化解决方案**：

- 对商家，降低库存维护、客户回复、订单跟进和售后处理的切换成本。
- 对客户，在同一个对话入口里完成咨询、下单、支付和订单查询。
- 对系统，把客服行为自然沉淀为可执行的业务动作，而不是停留在消息回复层。

在这个基础上，DealAgent 会从单点的 inventory / customer support 工具，进一步拓展为覆盖前台销售与后台运营的 agentic commerce suite。

## 项目关系

这里有三层需要区分清楚：

- **PurrfectClaw**：OpenClaw 的启动台，也是面向具体业务方案的产品入口。
- **OpenClaw**：skills 的宿主，负责承载和编排不同业务 skill。
- **DealAgent**：运行在这套框架上的一个具体方案，当前聚焦库存、客服、订单和支付闭环。

换句话说，DealAgent 不是孤立产品，而是 PurrfectClaw 启动台上的一个业务场景实现；它背后的能力宿主是 OpenClaw。

## v1 定位

- **平台范围**：框架层未来可以连接多个平台，但 **v1 只做 Telegram**。
- **主入口**：一个共享的 Telegram Bot，同时服务商家与客户。
- **核心能力**：SKU 管理、库存管理、客户询单、支付链接、支付确认、订单生命周期、退款处理、Seller BI。
- **数据层**：按业务独立存储在本地 SQLite 中，便于快速落地与后续演进。
- **交互方式**：以自然语言命令驱动，不依赖传统后台表单作为唯一操作面。
- **架构方向**：采用模块化 skill/framework 设计，便于后续按业务场景启停和扩展。

## 文档关系

本仓库当前有三份基础材料，它们的关系如下：

- [产品文档](docs/v1/product-foundation/v1-product-spec.docx)：项目主规范，定义产品边界、核心流程、模块接口、数据模型和测试思路。
- [Demo 文档](docs/v1/product-foundation/v1-demo-spec.docx)：服务于产品文档，用于对外演示和讲故事，把产品能力收敛成一条清晰可展示的 demo flow。
- [框架图](PurrSuiteFramework-v1.jpg)：初步确认的项目框架，用来说明平台入口、skills 宿主、业务模块与数据层之间的关系。

## 当前产品轮廓

结合产品文档和框架图，DealAgent v1 实现的skills包括：

- **Onboarding**：完成渠道接入、数据库初始化、owner pairing 和初始配置。
- **Catalog**：管理商品信息、价格和可售状态。
- **Inventory**：管理库存保留、扣减、释放和低库存提醒。
- **CRM**：承接外部询单、客户画像和对话摘要。
- **Payments**：生成支付链接、查询支付状态、处理 webhook 与退款。
- **Orders**：管理从购物意图到订单完成的整个生命周期。
- **Seller BI**：在同一数据层上提供自然语言经营指标查询。

这意味着 DealAgent 的解决方案不只是一个“会回复消息的客服机器人”，而是一个运行在 OpenClaw（skills 宿主）上的业务操作层，负责把咨询、成交与履约状态串起来。

## Demo 展示计划

根据 demo 文档，第一版对外展示应聚焦一条完整闭环：

1. 商家通过对话完成初始化。
2. 商家添加 SKU 并查看可售库存。
3. 客户在同一个 Bot 中咨询商品并发起购买。
4. 系统创建订单、生成支付链接并保留库存。
5. 支付成功后自动确认订单并更新库存。（支付部分暂时mock，客户点击付款确认）
6. 客户查询订单，商家发起退款，系统返回经营指标。

这条链路的意义在于证明：DealAgent 把客服入口变成了业务入口，把碎片化消息流变成了可追踪、可执行、可分析的运营流。

## 项目框架

![DealAgent Framework](PurrSuiteFramework-v1.jpg)

从这张图可以看出，当前方案已经有明确的几层关系：

- **平台接入层**：OpenClaw 理论上可以对接多个平台，当前 v1 先落在 Telegram Bot。
- **角色层**：商家与客户共用同一个 TG Bot，但通过身份与权限区分能力边界。
- **能力层（skills）**：以 Onboarding、Catalog、Payments、Orders、Inventory、CRM、Seller-BI 等模块组织业务能力。
- **数据层**：以 SQLite 作为统一状态来源，承接商品、库存、订单、支付和客户数据。

## 仓库结构

```text
.
├── Agent.md
├── SKILL.md
├── TODO.md
├── Archive/
│   └── python/
├── data/
│   └── dev/
├── docs/
│   └── v1/
│       ├── database/
│       ├── execution-plan/
│       ├── product-foundation/
│       └── reference/
├── scripts/
│   ├── db/
│   │   ├── migrations/
│   │   └── sqlite.ts
│   ├── dev/
│   │   ├── init_sqlite
│   │   ├── db_inspect
│   │   ├── load_fixture
│   │   └── README.md
│   ├── lib/
│   │   ├── onboarding.ts
│   │   └── skill_runner.ts
│   ├── run_skill
│   ├── test_skill
│   └── reports/
├── skills/
│   ├── onboarding/
│   ├── catalog/
│   ├── inventory/
│   ├── orders/
│   ├── payments/
│   ├── crm/
│   └── seller-bi/
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── unit/
└── PurrSuiteFramework-v1.jpg
```

## 下一步计划

- 打造成模块化项目：存储层、agent层（含skills）、channel层
- 支持多平台（whatsapp、instagram等）
- 支持skills灵活插拔
- 支持多种数据库方案
- 集成pieverse支付系统，支持多个provider
- 准备简单后端服务（含存储层/服务层API）
- 考虑套用 UCP
