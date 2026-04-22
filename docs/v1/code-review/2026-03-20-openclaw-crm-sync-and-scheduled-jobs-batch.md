# 2026-03-20 更新批次说明：OpenClaw CRM Auto-Sync 与后台定时任务

## 1. 这一天我改了什么

这份说明对应今天围绕 Telegram CRM 自动入库与宿主侧后台任务调度完成的 3 个提交。

| Commit | 主题 | 一句话说明 |
| --- | --- | --- |
| `d3613af` | CRM auto-sync | 新增 `sync_crm_from_openclaw`，把 OpenClaw session 日志中的 Telegram 私聊自动导入 CRM。 |
| `54f4f9b` | Onboarding cron | 让 `onboarding.setup_suite` 默认安装/刷新两个后台 cron 任务：`crm_sync` 与 `low_stock_scan`。 |
| `edf72a4` | Docs | 把根 `SKILL.md`、子技能文档、执行计划和数据库说明同步到最新真相。 |

如果只想先看最终结论，可以先记住下面 4 点：

1. CRM 的主录入路径已经从“Agent 聊天时手工调 `crm.log_inquiry/log_reply`”改成“后台扫描 OpenClaw session 日志自动入库”。
2. `conversations` 现在有 `source_kind` / `source_event_key`，并新增了 `crm_sync_cursors` 表来保存每个 session 文件的游标和 peer context。
3. `onboarding.setup_suite` 现在会默认把 `sync_crm_from_openclaw` 和 `run_low_stock_scan` 装进宿主 `crontab`。
4. 技能文档已经明确：Telegram 私聊的正常 CRM 记录走后台任务，手工 `crm.log_inquiry/log_reply` 只保留为补录/调试入口。

## 2. 你需要先知道的最终状态

### 2.1 CRM 基线日志已经切到 OpenClaw session 日志

当前 CRM 的后台入口固定为：

```bash
node <skill_package_root>/dist/scripts/sync_crm_from_openclaw.js --mode incremental
```

它只扫描：

- `~/.openclaw/agents/*/sessions/*.jsonl`

并且只接受两类真正会写入 CRM 的记录：

- user inbound
  - `type = message`
  - `message.role = user`
  - 能解析出 `Conversation info (untrusted metadata)` 与 `Sender (untrusted metadata)`
  - 不是群聊
- assistant outbound
  - `type = message`
  - `message.role = assistant`
  - `provider = openclaw`
  - `model = delivery-mirror`

明确忽略：

- group chat
- `toolCall` / `toolResult` / `thinking`
- control-ui 噪音
- 原始 OpenAI assistant 文本
- 店铺自己发出的 Telegram 私聊消息

这意味着当前 Telegram 私聊的正常 CRM 基线已经不再依赖 Agent 在对话时主动调用 `crm.log_inquiry` / `crm.log_reply`。

### 2.2 数据库已经具备自动同步所需的去重和游标能力

这批 schema 更新做了两件关键事：

#### `conversations`

新增：

- `source_kind`
  - `manual`
  - `openclaw_inbound`
  - `openclaw_delivery_mirror`
- `source_event_key`
  - 自动同步时写入
  - 手工补录时允许为空
  - 通过唯一索引做幂等去重

因此同一条 OpenClaw session 事件不会因为 cursor 漂移或脚本重跑而重复写入 CRM。

#### `crm_sync_cursors`

新增表 `crm_sync_cursors` 用于保存：

- `session_relpath`
- `last_processed_line`
- `bootstrapped_at`
- `peer_channel`
- `peer_external_user_id`
- `peer_username`

它承担两个职责：

1. 防止重复扫描旧行
2. 让 delivery-mirror 的 outbound 回复能归属到当前私聊 peer

### 2.3 Onboarding 现在默认负责安装后台任务

当前 `onboarding.setup_suite` 的成功路径已经不只是：

- 初始化本地 SQLite
- 建 owner / agent identity
- 写默认 business config

现在还会继续执行：

- 安装或刷新受管 `crontab` block

默认会放进去两个任务：

1. `crm_sync`
   - `node <skill_package_root>/dist/scripts/sync_crm_from_openclaw.js --mode incremental`
2. `low_stock_scan`
   - `node <skill_package_root>/dist/scripts/run_low_stock_scan.js`

当前默认频率都是：

- `*/5 * * * *`

日志落盘位置：

- `data/logs/scheduled-jobs/crm_sync.log`
- `data/logs/scheduled-jobs/low_stock_scan.log`

同时 onboarding 返回里新增了 `background_jobs`，让调用方可以直接知道：

- 是否真的安装成功
- 是否是已经存在无需变更
- 是否被显式禁用
- 是否因为环境原因跳过

### 2.4 手工 CRM 命令还在，但已经降级成 fallback

当前 `run_skill --skill crm` 仍然保留：

- `crm.log_inquiry`
- `crm.log_reply`
- `crm.show_history`
- `crm.get_response_context`
- `crm.upsert_customer_summary`
- `crm.whoami`

但角色已经变成：

- `crm.log_inquiry`
  - 人工补录漏掉的 inbound
- `crm.log_reply`
  - 人工补录漏掉的 outbound

正常 Telegram 私聊链路不再要求聊天时手工补这两枪。

## 3. 这批改动里最值得注意的设计点

### 3.1 没有做“历史全量回放”，而是从 bootstrap 光标开始

当前 `sync_crm_from_openclaw` 的 `bootstrap` 语义是：

- 不导入历史消息
- 只把当前文件末尾写成 cursor 起点
- 同时抽出当前 session 的 peer context

`incremental` 首次遇到未知 session 时，也按这个 bootstrap 语义起步。

这样做的目的很明确：

- 避免一上来把历史 Telegram 会话整库灌入 CRM
- 避免尚未审查过的旧消息污染正式 customer history

### 3.2 delivery-mirror 的归属依赖 session 级 peer context

这批实现没有尝试从每一条 assistant outbound 文本里再反解 customer，而是依赖：

- 当前 OpenClaw 的 `session.dmScope = per-channel-peer`

因此同一个 DM session 内，delivery-mirror 回复会归到最近一次已确认的 Telegram 私聊 peer。

如果没有已知 peer context，当前策略不是“猜一个人”，而是：

- 跳过写入
- 记录 warning

这个边界是保守但正确的。

### 3.3 cron 安装被做成“受管 block”，而不是覆盖整个 crontab

当前不是每次 onboarding 都重写用户全部 crontab。

实现方式是：

- 用 `# BEGIN PURR_SUITE_SCHEDULED_JOBS` / `# END PURR_SUITE_SCHEDULED_JOBS` 包住一段受管 block
- 安装时先移除旧 block
- 再把最新 block 合并回现有 crontab

这意味着：

- 不会误删用户已有的其他 cron
- 同一个宿主上可重复执行 onboarding 而保持幂等

## 4. Code Review 结论

当前 review 结论：

- **没有发现阻塞合并的问题**

但有两类残余风险需要记住。

### 4.1 OpenClaw metadata 格式仍然是外部依赖

`sync_crm_from_openclaw` 目前依赖 OpenClaw session 文本里稳定出现这些 metadata block：

- `Conversation info (untrusted metadata)`
- `Sender (untrusted metadata)`

如果上游换了 block 标题、去掉 JSON fenced block，或者 delivery-mirror 的 provider/model 标识变了，parser 会需要同步调整。

这不是当前实现错误，而是接口边界风险。

### 4.2 真实 crontab 安装只在宿主上验证，测试里仍是 fake runner

当前测试已经覆盖：

- crontab block 渲染
- 合并已有 crontab
- 幂等安装

但测试用的是 fake `CrontabRunner`，不是 CI 里真的去写系统 `crontab`。

因此最高风险点仍然是：

- 某些宿主环境没有 `crontab`
- 某些系统对 `crontab -l` 的无配置输出文案不同
- 某些 Node/路径环境和当前机不同

这些都属于环境接入风险，不是当前 TypeScript 逻辑本身的 bug。

## 5. Review 时建议重点看什么

### 5.1 看 CRM parser 和去重

重点看：

- `scripts/lib/openclaw_crm_sync.ts`
- `scripts/lib/crm.ts`
- `scripts/db/migrations/0001_init.sql`

主要检查：

- inbound / delivery-mirror 的过滤条件是否够严
- `source_event_key` 是否真的能防重
- `crm_sync_cursors` 的 cursor 与 peer context 是否和预期一致

### 5.2 看 onboarding 的副作用边界

重点看：

- `scripts/lib/onboarding.ts`
- `scripts/lib/scheduled_jobs.ts`

主要检查：

- onboarding 在 `initialized` / `idempotent` 两个分支上是否都返回 `background_jobs`
- `runtime.install_cron = false` 是否只作为显式逃生口
- 受管 block 是否会误伤用户已有 cron

### 5.3 看文档层是否已经把新真相说清楚

重点看：

- 根 `SKILL.md`
- `skills/crm/SKILL.md`
- `skills/inventory/SKILL.md`
- `skills/onboarding/SKILL.md`
- `docs/v1/database/sqlite-design.md`

主要检查：

- 是否已经明确“正常 Telegram 私聊走后台 sync，不是手工 CRM log”
- 是否已经明确“onboarding 必须把两个后台任务装起来”
- 是否已经明确 `background_jobs.status` 不是 `installed` 时，调用方必须提示 owner

## 6. 一句话总结

这批更新把 CRM 从“聊天时手工补日志”推进到了“后台自动吃 OpenClaw session”，同时把 `crm_sync` 和 `low_stock_scan` 变成 onboarding 默认安装的宿主级后台任务，标志着 Purr Suite 第一次真正具备了持续运行的后台运营能力。
