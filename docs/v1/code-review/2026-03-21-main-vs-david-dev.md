# 2026-03-21 `david/dev` 相对 `main` 的代码审查

## Findings

### 1. `announce` 交付会把后台任务结果绑定到“最后一次回复路由”，可能把运维输出发到错误会话，且目标缺失时会直接让 job 失败

- 位置：`skills/onboarding/cron/crm-sync.md:18`, `skills/onboarding/cron/crm-sync.md:54`, `skills/onboarding/cron/low-stock-scan.md:18`, `skills/onboarding/cron/low-stock-scan.md:53`
- 当前文档把两个后台任务都固定为 `delivery.mode = "announce"`，但没有同时固定 `delivery.channel` / `delivery.to`。
- 按 OpenClaw 官方 cron 文档，这种配置会回退到 main session 的 “last route”；如果目标缺失或无效，job 会失败；如果 last route 已经漂到客户会话，后台任务摘要会直接发到那个客户会话。
- 这和这两个任务的用途不匹配：`CRM Sync` 与 `Low Stock Scan` 都是后台维护任务，不应该依赖最近一次聊天路由，更不应该把执行摘要按 5 分钟周期直接投递到用户会话。
- 相比 `main` 分支里的宿主 `crontab` 方案，这里引入了新的可靠性和信息泄漏风险。

### 2. 这两个定时任务现在只是自由文本 `agentTurn` prompt，没有“精确执行命令”的约束，行为从确定性 shell 执行退化成模型解释执行

- 位置：`skills/onboarding/cron/crm-sync.md:17`, `skills/onboarding/cron/crm-sync.md:52`, `skills/onboarding/cron/low-stock-scan.md:17`, `skills/onboarding/cron/low-stock-scan.md:51`
- 当前 `payload.message` 只有“执行 XXX：运行命令 node …”这一句，已经不再像之前实现那样明确要求“run this exact host command once and do not modify it”。
- 按 OpenClaw 官方 cron 文档，`agentTurn` 的 `payload.message` 本质上只是给 agent 的普通文本提示，而不是受约束的命令执行槽位。
- 结果是这两个后台任务从 `main` 分支中的确定性 shell/`crontab` 执行，退化成模型是否理解并忠实执行提示词的问题：
  - 可能漏掉 flag
  - 可能替换路径
  - 可能只总结命令而不是执行
  - 可能在失败时返回看似合理的自然语言而不是真实进程错误
- 对同步和库存扫描这种维护任务，这种非确定性是不合适的。

## Summary

- 对比范围：`main..david/dev`
- 提交数：`11` 个 commit
- 主要主题：
  - 安装态数据外置到 `~/.openclaw/data/<skill-package-name>/`
  - 从 runtime 内注册定时任务切换到 skill 文档驱动
  - 定时任务说明从 CLI `openclaw cron ...` 改到 Gateway cron tool
  - 新增 `release/purr-suite-skill-package-2026-03-21/` 与对应 zip
- 代码层面我没有看到新的 SQLite/业务逻辑回归；本次审查的主要问题集中在“后台 cron 从确定性执行退化为文档驱动 + agentTurn prompt”这一设计变化上。

## Validation

- `git rev-list --left-right --count main...HEAD`：`0 11`
- `npm test`：通过
- 测试结果：`11` 个 test files，`63` 个 tests 全通过

## Residual Risks / Gaps

- 当前没有自动化测试去校验 `skills/onboarding/cron/*.md` 里的 JSON 形状是否持续符合 OpenClaw 官方 cron tool schema；现在只能靠人工维护。
- `onboarding.setup_suite` 已不再返回 `background_jobs`，因此直接调用 `run_skill --skill onboarding` 的程序化调用方拿不到机器可读的“cron 尚未完成”信号，这一责任完全转移到上层技能编排。
- release 构建仍然有 Node engine 偏差：本机 `v24.13.0`，`package.json` 要求 `24.14.0`；当前构建成功，但仍建议在发布环境对齐版本。

## References

- OpenClaw cron docs: https://docs.openclaw.ai/automation/cron-jobs
