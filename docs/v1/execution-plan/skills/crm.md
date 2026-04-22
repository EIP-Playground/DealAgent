# CRM Skill 详细设计（v1）

## 1. 目标

`crm` 负责把客户会话与客户轻量画像沉淀到共享数据层，并在需要回复客户时返回稳定的上下文窗口。

当前 v1 拆成两条路径：

- 后台路径：`sync_crm_from_openclaw` 定时扫描 OpenClaw session 日志，把 Telegram 私聊会话自动导入 CRM
- 手工路径：`crm.log_inquiry` / `crm.log_reply` 只作为补录与调试兜底

明确延期：

- 自动摘要生成
- 自动回复草稿生成
- 多 SKU 结构化关联
- 群聊 CRM 自动同步
- 历史全量回放

## 2. 技能边界

`crm` 负责：

- 维护客户基线日志、历史窗口与回复上下文
- 基于 `(channel, external_user_id)` 自动 upsert customer identity
- 替换持久化 `customers.summary_json`
- 通过后台 sync 自动写入 Telegram 私聊 inbound / delivery-mirror outbound
- 允许调用方手工补录漏掉的 inquiry / reply

`crm` 不负责：

- 判断非 Telegram 消息源是否应该自动记 CRM
- 自动生成 `summary_json`
- 订单创建、支付确认、库存动作
- 多轮 session 管理
- 多 SKU 结构化关系建模

固定前提：

- v1 自动同步只处理 Telegram 私聊
- 当前 `~/.openclaw/openclaw.json` 依赖 `session.dmScope = per-channel-peer`
- `orders.session_id` 继续只服务订单链路，不扩到 CRM

## 3. Public Interfaces

### 3.1 后台同步入口

后台命令固定为：

```bash
node <skill_package_root>/dist/scripts/sync_crm_from_openclaw.js --mode incremental
```

默认宿主策略：

- `onboarding.setup_suite` 成功且数据库存在后，宿主或 Agent 必须按 `skills/onboarding/cron/crm-sync.md` 通过 Gateway cron tool 检查并安装受管 OpenClaw cron 任务，让上面的命令按 5 分钟周期运行

CLI 参数：

- `--db-path <sqlite-path>`：可选，默认沿用 runtime 默认 DB
- `--openclaw-root <path>`：可选，默认 `~/.openclaw`
- `--mode incremental|bootstrap`：默认 `incremental`

约定：

- `bootstrap` 不导入历史消息，只建立 cursor 与 peer context
- `incremental` 只处理 cursor 之后的新行；若首次运行遇到未知 session，也按 bootstrap 语义起步，避免历史回放
- 同步器只扫描 `~/.openclaw/agents/*/sessions/*.jsonl`

### 3.2 `run_skill --skill crm`

`run_skill` 侧保留这些能力：

- `crm.log_inquiry`
- `crm.log_reply`
- `crm.show_history`
- `crm.get_response_context`
- `crm.upsert_customer_summary`
- `crm.whoami`

但其中：

- `crm.log_inquiry`
- `crm.log_reply`

仅用于人工补录或调试，不再是 Telegram 私聊正常链路的主入口。

### 3.3 自动同步过滤规则

入站候选必须满足：

- JSONL `type = message`
- `message.role = user`
- 能解析出 `Conversation info (untrusted metadata)` 与 `Sender (untrusted metadata)`
- 不是群聊
- 不是 `openclaw-control-ui`
- 清洗掉 `System:`、reply context、chat history、queued wrapper 后仍有正文

出站候选必须满足：

- JSONL `type = message`
- `message.role = assistant`
- `provider = openclaw`
- `model = delivery-mirror`
- 文本非空

明确忽略：

- 群聊
- `toolCall` / `toolResult` / `thinking`
- 原始 OpenAI assistant 文本
- control-ui / 运维噪音
- 代表店铺自己的 Telegram 私聊消息

## 4. SQLite 读写合同

当前 CRM 自动同步直接落在这些表：

- `customers`
- `conversations`
- `crm_sync_cursors`
- `audit_events`

### 4.1 `conversations`

新增字段：

- `source_kind`
  - `manual`
  - `openclaw_inbound`
  - `openclaw_delivery_mirror`
- `source_event_key`
  - 自动同步时必填
  - 手工补录时允许为空
  - 通过唯一索引去重

写入语义：

- inbound sync
  - `direction = inbound`
  - `channel_message_id = Telegram message_id`
  - `source_kind = openclaw_inbound`
- outbound sync
  - `direction = outbound`
  - `channel_message_id = NULL`
  - `source_kind = openclaw_delivery_mirror`
- manual log
  - `source_kind = manual`
  - `source_event_key = NULL`

### 4.2 `crm_sync_cursors`

用途：记录每个 session 文件的同步游标和当前 peer context。

关键字段：

- `session_relpath`
- `last_processed_line`
- `bootstrapped_at`
- `peer_channel`
- `peer_external_user_id`
- `peer_username`

用途：

- 避免重复扫旧行
- 让 delivery-mirror 回复可以归属到当前私聊 peer
- session 文件缩短或重置时允许重新 bootstrap

### 4.3 `audit_events`

自动同步新增事件类型：

- `crm.inquiry_synced`
- `crm.reply_synced`

固定写法：

- `actor_type = system`
- `actor_id = openclaw:session-sync`
- `payload_json` 至少带：
  - `source_kind`
  - `session_file`
  - `session_message_id`
  - `telegram_sender_id`

手工 `crm.log_inquiry` / `crm.log_reply` 仍保持原有：

- `crm.inquiry_logged`
- `crm.reply_logged`
- `actor_type = caller`

## 5. 读取与上下文语义

- `crm.show_history`
  - 继续按时间正序返回 conversation window
  - 不区分消息来源；manual 与 auto-sync 统一展示
- `crm.get_response_context`
  - 继续基于最近 conversation 历史构造上下文
  - `primary_sku_ref` 与 `current_sku_snapshot` 语义不变
- `crm.upsert_customer_summary`
  - 仍只做摘要替换，不与后台 sync 混写逻辑耦合

## 6. 测试冻结

最小回归覆盖：

- parser 能正确抽出私聊 user message 的 sender / username / message_id / 正文
- parser 会忽略 group、control-ui、raw assistant，并只认 delivery-mirror 为真正 outbound
- bootstrap 只写 cursor，不导入历史 conversation
- incremental 能导入新增 inbound / outbound，并依赖 cursor 中的 peer context 归属 delivery-mirror
- 重复执行 incremental 不会重复写 `conversations` 或 `audit_events`
- 没有 peer context 的 outbound 会被跳过并记 warning
- `crm.show_history` / `crm.get_response_context` 对自动同步后的数据仍正常工作
- 手工 `crm.log_inquiry` / `crm.log_reply` 仍保持可用
