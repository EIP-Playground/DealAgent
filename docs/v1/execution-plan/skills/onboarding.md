# Onboarding Skill 详细设计（v1）

## 1. 目标

`onboarding` 是 Purr Suite v1 的第一个落地 skill。它负责接收 canonical 初始化命令 `onboarding.setup_suite`，完成 owner pairing、本地 SQLite 初始化、默认业务配置写入，以及相关审计事件记录。

这里不负责 Telegram 接入本身。Telegram 渠道已经由 OpenClaw 宿主承载，Purr Suite 只消费宿主提供的消息上下文。

实现约定：

- `skills/onboarding/SKILL.md` 只描述技能用途和用法
- 统一调度逻辑放在 `scripts/lib/skill_runner.ts`
- Python 运行逻辑放在 `scripts/lib/onboarding.ts`
- SQLite 共享逻辑放在 `scripts/db/sqlite.ts`

## 2. 触发入口

- Agent 路由：用户说“初始化店铺 / setup the suite / 开始配置店铺”等自然语言时，由你先识别成 onboarding 意图
- runtime canonical command code：`onboarding.setup_suite`
- 触发条件：宿主将 canonical command code、用户身份和运行时配置一起转交给 `onboarding`
- 宿主正式触发方式：`node dist/scripts/run_skill.js --skill onboarding < context.json`
- 本地开发触发方式：`node dist/scripts/test_skill.js --skill onboarding --fixture <json>`

固定原则：

- 自然语言理解属于 Agent 路由职责
- runtime 只接收归一化后的 canonical `command_code`，不做开放式自然语言理解
- 这种自然语言理解与对话编排能力属于 OpenClaw 共享宿主层，不属于 `onboarding` 独有能力

spec 与 runtime 的职责拆分：

- product spec / demo spec 里可以继续使用面对人的自然语言 setup 表达
- OpenClaw 负责把这类自然语言翻译成规范化 JSON
- Purr Suite onboarding runtime 的执行边界，是消费带 canonical `command_code` 的规范化 JSON，而不是直接解析自然语言或 Telegram 原始 update
- `command_code` 可以理解为“自然语言意图被宿主归一后的机器命令码”；它来自用户/商户输入表达的意图，但不是原始自然语言本身
- 因此“spec 里展示自然语言 setup”和“runtime 里执行 `command_code = "onboarding.setup_suite"`”并不冲突，它们处于不同层
- 同样的宿主规则未来也适用于 `orders`、`payments`、`crm`、`seller-bi`；不要把这层通用能力收回到某个单独 skill 里

## 3. 宿主输入合同

输入上下文最小字段：

```json
{
  "channel": "telegram",
  "command_code": "onboarding.setup_suite",
  "user": {
    "external_user_id": "owner-001",
    "username": "alice"
  },
  "runtime": {
    "db_path": "data/dev/purr_suite_dev.sqlite3"
  }
}
```

要求：

- `channel` 目前固定使用 `telegram`
- `command_code` 必须精确命中 canonical `onboarding.setup_suite`
- `user.external_user_id` 必填
- `user.username` 可选但保留
- 正式入口只接收宿主归一后的 JSON，不直接解析 Telegram 原始 update

一个典型映射示例：

- spec / demo 中的用户表达：

```text
setup the purr suite
channel - telegram bot(token:xxxx)
database - local sqlite
```

- OpenClaw 归一后传给 runtime 的输入：

```json
{
  "channel": "telegram",
  "command_code": "onboarding.setup_suite",
  "user": {
    "external_user_id": "owner-001",
    "username": "alice"
  },
  "runtime": {
    "db_path": "data/dev/purr_suite_dev.sqlite3"
  }
}
```

owner 身份字段：

- `channel`
- `external_user_id`
- `username`

## 4. SQLite 写入合同

### 4.1 首次 setup

写入：

- `schema_migrations`
- `owners`
- `business_config`
- `audit_events`

默认 `business_config`：

- `channel_binding = "telegram_via_openclaw"`
- `database_mode = "local_sqlite"`
- `enabled_skills = ["onboarding","catalog","inventory","orders","payments","crm","seller-bi"]`
- `payment_provider = "mock"`

审计事件：

- `onboarding.setup_requested`
- `onboarding.owner_paired`

### 4.2 同一 owner 再次 setup

行为：

- 不新增 owner
- 刷新 `paired_at`
- 补齐缺失的默认配置键
- 写 `onboarding.setup_idempotent`

### 4.3 非 owner 再次 setup

行为：

- 不改动当前 owner
- 不重新初始化数据库
- 写 `onboarding.setup_rejected`

## 5. 响应合同

### 5.1 首次初始化成功

```json
{
  "status": "initialized",
  "reply": "Purr Suite initialized. Owner paired and local SQLite is ready."
}
```

### 5.2 幂等重复 setup

```json
{
  "status": "idempotent",
  "reply": "Purr Suite is already initialized for this owner."
}
```

### 5.3 被拒绝

```json
{
  "status": "rejected",
  "reply": "Purr Suite is already paired to another owner."
}
```

## 6. 防护约束

- v1 只允许 1 个激活 owner
- `owners(channel, external_user_id)` 唯一
- `business_config` 采用 key/value JSON，不把配置散落到多张表
- `payment_provider` 保留该字段名，但 v1 固定为 `mock`
- 不依赖真实 Telegram 或 OpenClaw 才能完成本地验证

## 7. 测试矩阵

- `scripts/test_skill.ts` 首次 setup：创建 SQLite，写入 `owners`、`business_config`、`audit_events`
- `scripts/run_skill.ts` 同一 owner 再次 setup：返回 `idempotent`
- `scripts/run_skill.ts` 第二个用户 setup：返回 `rejected`
- 旧的 slash command `/setup_purrfect_suite` 直传 runtime：返回 `ignored`
- `scripts/dev/db_inspect.ts` 可以看到本地数据库和默认配置
- 运行时代码必须位于 `scripts/` 体系，不写入 `skills/`

## 8. 后续扩展

- 安装态完成 `onboarding.setup_suite` 后，宿主或 Agent 必须根据 `skills/onboarding/cron/*.md` 通过 Gateway cron tool 检查并安装两个 OpenClaw cron 任务；runtime 本身不再直接注册定时任务
- 补充真正的 OpenClaw 集成测试
- 如需多 owner，再调整 owner 约束与角色模型
- 如果后续有真实支付 provider，再扩展 `payment_provider` 的可选值
