# 2026-03-18 更新批次说明：Agent 身份探测、绝对路径重构与路由触发词增强

## 1. 这一批改了什么

这份说明对应为了解决 OpenClaw 宿主环境下 Agent 调用技能时的路径、身份与路由识别问题而作出的更新。

| 主题 | 一句话说明 |
| --- | --- |
| **绝对路径重构** | 将所有 `SKILL.md` 里的调用示例从相对路径改为了基于波浪号 `~` 的绝对路径，防止跨目录执行失败。 |
| **Agent 身份探测 (`whoami`)** | 在 `crm` 和 `payments` 技能中引入了 `whoami` 子命令，允许 Agent 动态查询自身在数据库中的 `agent` 身份。 |
| **顶级路由触发词增强** | 丰富了根目录 `SKILL.md` 的 `description` 字段，为每个核心模块补充了贴近真实对话的自然语言触发词。 |

## 2. 你需要先知道的最终状态

### 2.1 脚本执行路径不再依赖当前工作目录 (CWD)

此前文档中所有约束调用的指令是：
`node dist/scripts/run_skill.js --skill <skill-name>`

现在已全面更新为跨环境兼容的绝对路径：
`node <skill_package_root>/dist/scripts/run_skill.js --skill <skill-name>`

此改动覆盖了根目录的 `SKILL.md` 以及各个子技能（`onboarding`, `catalog`, `orders`, `payments`, `crm`, `inventory`, `seller-bi`）的说明文档。

### 2.2 Agent 具备了“我是谁”的自我探查能力

之前在 `crm` 和 `payments` 中，当要求“你（代表店铺）”执行操作时，Agent 经常因为不知道填什么 `user.external_user_id` 而卡住或伪造 ID，导致鉴权失败或审计日志错乱。

现在新增了两个命令：
- `crm.whoami`
- `payments.whoami`

底层逻辑（`scripts/lib/crm.ts` 和 `scripts/lib/payments.ts`）已经放宽了对 `whoami` 命令的 `user.external_user_id` 的必填校验，并会在数据库上下文中真实执行如下查询：
```sql
SELECT external_user_id FROM identities WHERE channel = ? AND role = 'agent' AND is_active = 1 LIMIT 1
```
查到后返回确切的 `Channel` 与 `Agent ID`，Agent 可将其用于后续真实的业务调用。

### 2.3 根技能拥有了更清晰的召回描述

根 `SKILL.md` 的 `description` 被大幅度增强。从干瘪的场景罗列，变成了带有真实触发语句的列表。例如：
- 订单处理 (Orders)：如“我要买这个”、“帮我建个单”。
- 客户关系 (CRM)：如“客户问这个怎么卖”、“记录一下他的需求”。
这能极大提高 OpenClaw 底层 LLM 在做第一层 Tool/Skill 路由时的准确率，避免 Agent 不敢触发或误触发。

## 3. 这批改动里最值得注意的设计点

### 3.1 为什么用 `~` 而不是硬编码 `/Users/eight/`？

如果直接硬编码 `/Users/eight/`，在其他开发者的机器或云端容器部署时，路径会立刻失效。而底层 Shell 和大多数执行引擎都能自动将 `~` 展开为当前系统执行用户的 `$HOME` 目录，从而兼顾了“绝对路径”和“环境无关性”。

### 3.2 `whoami` 为什么必须进数据库查？

最初的初步思路是让 Python 脚本直接返回传入的参数。但仔细一想，Agent 调用 `whoami` 的目的正是因为 **它不知道自己的 ID**，无法在 payload 里传值。

因此最终的实现在 `handle_crm` 和 `handle_payments` 中做了特判：
1. 放行 `whoami` 缺失 `external_user_id` 的输入。
2. 连上数据库，去查当前 `channel`（如 `telegram`）下面被指派为 `role = 'agent'` 的那一条 active 记录。

这使得身份探测具备了真正的真实性，返回的是系统真正分配的 Agent Identity。

## 4. Review 时建议重点看什么

### 4.1 看文档层的约束对齐
- 检查根 `SKILL.md` 的 description 是否自然、丰富且包含了必须自动触发 CRM 的提示。
- 检查所有 `SKILL.md` 的路径是否已统一修改为 `~/.openclaw/skills/purr-suite/...`。
- 检查 `crm` 和 `payments` 的命令表中是否已经正确加入了 `whoami` 的说明。

### 4.2 看 Runtime 层的特判与 SQL
- **`scripts/lib/crm.ts`** & **`scripts/lib/payments.ts`**:
  - 确认 `if not actor_external_user_id and command_code != "*.whoami":` 的特判是否安全。
  - 确认 `SELECT external_user_id FROM identities ...` 的 SQL 语法和逻辑（`role = 'agent'` 和 `is_active = 1`）是否正确。
  - 确认如果未找到 active agent 时，返回的 `not_found` 结构是否符合现有错误 payload 规范。

## 5. 一句话总结

这批更新不仅彻底消除了 Agent 跨目录执行脚本的路径顽疾，还给 OpenClaw 提供了一把探测自身身份的“钥匙” (`whoami`) 和更灵敏的意图“雷达”（触发词增强），使 Agent 代店铺执行操作时的容错性和准确度大幅提升。
