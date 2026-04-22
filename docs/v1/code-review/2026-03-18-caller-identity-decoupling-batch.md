# 2026-03-18 更新批次说明：Caller 身份解耦与权限强化

## 1. 这一天我改了什么

今天的改动主要集中在三类：

1. **数据库身份模型重构**
   - 将 `owners` 表正式重命名为 `identities`，支持 `owner` 和 `agent` 两种角色。
   - 新增 `0008_add_agent_role.sql` 迁移脚本，利用 `PRAGMA writable_schema=1` 做 CHECK 约束的原地替换，规避 SQLite 无法 ALTER CONSTRAINT 的限制。
   - 将 `CALLER_AUTH_IDENTITY_MODEL` 从 `active_owner_identity_reuse` 更名为 `caller_identity`。

2. **技能运行时权限解耦**
   - 所有 `_fetch_active_owner` 查询统一加了 `AND role = 'owner'`，防止 agent 身份被误判为 owner。
   - CRM：`log_inquiry` / `log_reply` / `get_response_context` / `upsert_customer_summary` 从 `_require_owner` 改为 `_require_store_representative`，对 caller（agent）放行。`show_history` 保持 owner-only。
   - Payments：`create_payment_link` / `confirm_mock_paid` 同样改用 `_require_store_representative`。`refund_mock_payment` 保持 owner-only。
   - `_require_store_representative` 不仅检查 `actor != customer`，还主动查 `identities` 表确认 actor 拥有 `owner` 或 `agent` 角色，防止 ID 伪造。
   - 所有 skill 的 `db_path` 均改为从 `context["runtime"]["db_path"]` 动态获取，不再硬编码 `DEFAULT_DB_PATH`。

3. **Onboarding Agent 身份自动创建**
   - 首次 setup 时自动插入一条 `role='agent'` 的身份记录，`external_user_id` 为 `agent-{uuid4()}`。
   - Onboarding 返回结果新增 `agent_id` 字段，`skills/onboarding/SKILL.md` 要求 Agent 提取并记忆该 ID 用于后续调用。

4. **测试框架动态 UUID 注入**
   - `test_crm.test.ts`、`test_payments.test.ts`、`load_fixture` 新增动态 agent ID 注入逻辑，在执行前从 SQLite 查出真实 agent UUID 替换 fixture 中的占位符 `agent-001`。
   - 所有 caller fixture 的 `user.external_user_id` 从 `owner-001` 改为 `agent-001`（占位符）。
   - 审计断言改为动态比对数据库中的真实 agent ID。

5. **发行包生成**
   - 按 `skill-package-release-cleanup.md` 规范生成 `release/purr-suite-v1/`，包含 34 个生产文件；排除 `tests/`、`docs/`、`scripts/dev/`、`scripts/test_skill.ts` 等开发专用内容。

## 2. 你需要先知道的最终状态

### 2.1 identities 表替代 owners

数据库不再有 `owners` 表。所有身份（owner 与 agent）统一存储在 `identities` 表中，通过 `role` 字段区分。

### 2.2 权限模型

| 命令 | 允许角色 |
|---|---|
| `crm.log_inquiry` / `log_reply` / `get_response_context` / `upsert_customer_summary` | owner, agent |
| `crm.show_history` | owner only |
| `payments.create_payment_link` / `confirm_mock_paid` | owner, agent |
| `payments.refund_mock_payment` | owner only |
| 其余 skill（catalog / inventory / orders / seller-bi / onboarding） | 不变 |

### 2.3 Agent 身份生命周期

1. Owner 首次 `onboarding.setup_suite` → 自动创建一条 `agent-{uuid4()}` 身份。
2. 返回结果包含 `agent_id`，Agent 需要记忆。
3. 后续 CRM / Payments 调用使用该 `agent_id` 作为 `user.external_user_id`。
4. `_require_store_representative` 会去 `identities` 表校验该 ID 确实存在且角色正确。

## 3. 具体提交

| Commit | 主题 | 一句话说明 |
|---|---|---|
| `feat(db): rename owners to identities and add agent role migration` | db | 新增 `0008` 迁移，重命名表并扩展角色约束 |
| `feat(auth): decouple caller from owner in skill runtimes` | auth | 8 个运行时文件统一改用 `_require_store_representative` 并动态解析 `db_path` |
| `test(auth): implement dynamic agent UUIDs in test harnesses` | test | 11 个测试/fixture 文件改用动态 UUID 注入机制 |

## 4. 影响与注意点

- `identities` 表是不可逆变更，现有数据库需执行 `0008` 迁移。
- 所有依赖 `owners` 表名的外部查询需同步更新。
- Fixture 中的 `agent-001` 仅作占位符，测试框架会在运行时自动替换为真实 UUID。
- `release/purr-suite-v1/` 不含测试代码，如需验证需回到主仓库运行 `pytest`。
