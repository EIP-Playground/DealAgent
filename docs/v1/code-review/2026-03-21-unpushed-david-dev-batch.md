# 2026-03-21 未 Push 修改 Review：`david/dev` 相对 `origin/david/dev`

## 1. Review 范围

本次 review 看的不是工作区脏文件，而是当前本地分支尚未 push 到远端的提交集合。

当前状态：

- 分支：`david/dev`
- 上游：`origin/david/dev`
- ahead：`18` commits
- 变更规模：`112 files changed, 14914 insertions(+), 609 deletions(-)`
- 工作区状态：clean（没有额外未提交修改）

本次 review 额外做了一个真实验证：

```bash
npm test
```

结果：

- `11` 个 test files 全通过
- `63` 个 tests 全通过

## 2. 这批未 Push 提交主要分成 3 组

| 分组 | Commit | 主题 | 一句话说明 |
| --- | --- | --- | --- |
| A | `6bcdba6` `5ebfd43` `4c87c04` `86d4317` `4b2fc23` `12300e9` `c1c0885` `514dbc4` `82aa4b4` `a06253a` | Node/TypeScript 迁移 | 新增 Node/TS 运行时、把 CLI/DB/skill handlers/tests 迁到 TypeScript，并把旧 Python 实现归档到 `Archive/python/`。 |
| B | `d3613af` `54f4f9b` `edf72a4` `bfe42bb` `565527f` `f174e04` | OpenClaw CRM sync + 后台任务 + 发布文档 | 新增 Telegram session 自动同步、onboarding 安装后台任务、补齐文档与 release 清理说明。 |
| C | `fa41c49` `b46bcff` | Payments 语义收紧 + 依赖锁文件补丁 | 支付链路增加 caller/customer 身份校验与角色处理，同时补了一条 lockfile 依赖元数据。 |

## 3. 当前分支的最终状态

### 3.1 脚本运行时已经从 Python 切到 Node/TypeScript

当前仓库已经具备完整的 Node/TypeScript 运行时基线：

- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `scripts/run_skill.ts`
- `scripts/run_low_stock_scan.ts`
- `scripts/lib/*.ts`
- `scripts/db/sqlite.ts`

旧 Python 版本没有直接删掉，而是整体搬到了：

- `Archive/python/`

这让当前主线实现非常清晰：

- 主运行时看 `scripts/**/*.ts`
- 历史参考实现看 `Archive/python/**`

### 3.2 CRM 已经接上 OpenClaw session 自动同步

这批未 push 修改里最值得注意的新增能力是：

- `scripts/lib/openclaw_crm_sync.ts`
- `scripts/sync_crm_from_openclaw.ts`

当前 CRM 自动同步逻辑已经具备：

- 从 `~/.openclaw/agents/*/sessions/*.jsonl` 读取 session 日志
- 解析 Telegram 私聊 inbound
- 解析 `delivery-mirror` outbound
- 用 `crm_sync_cursors` 保存逐文件 cursor 和 peer context
- 通过 `source_event_key` 做幂等去重

同时 onboarding 已经默认安装两个后台任务：

- `crm_sync`
- `low_stock_scan`

### 3.3 Payments 的身份约束比之前更严格了

`fa41c49` 这笔修改把 payments 从“文档上模糊知道是 caller 代店铺执行”推进到了更严格的 runtime 约束。

当前能看到的最终状态是：

- create / confirm 要求调用方和目标 customer 身份一致
- owner 可以不填 customer identity，但不能填错 customer
- 没有关联 customer identity 的 order，不能直接创建支付链接

这部分不仅改了：

- `scripts/lib/payments.ts`
- `skills/payments/SKILL.md`
- `docs/v1/execution-plan/skills/payments.md`

还补了对应的集成测试覆盖。

### 3.4 技能包发布说明也已经切到当前真相

`docs/v1/execution-plan/skill-package-release-cleanup.md` 现在已经不再是旧的“源码包”说法，而是明确：

- release 目录按白名单保留必要源码
- 在 release 内执行 `npm ci` 与 `npm run build`
- 保留编译后的 `dist/`
- 不保留 `docs/`、`tests/`、`*.map`、`*.sqlite3` 等无关产物

## 4. Code Review 结论

当前 review 结论：

- **没有发现阻塞 push 的代码问题**

我给这个结论的依据有两类：

1. 静态 review 上，这 18 个提交虽然大，但内部方向是一致的：
   - 运行时迁移到 TypeScript
   - CRM 接 OpenClaw 日志
   - onboarding 加后台任务
   - payments 收紧身份边界
   - 文档同步到新真相
2. 动态验证上，当前分支直接跑：
   - `npm test`
   - 结果 `63/63` 全绿

这意味着：

- 现有 TypeScript runtime 在当前仓库下是可构建、可测试、可执行的
- 主要业务能力没有被这批未 push 修改打断

## 5. 这批修改仍然需要记住的残余风险

### 5.1 OpenClaw CRM sync 仍然依赖上游 session metadata 形状稳定

当前 parser 依赖 OpenClaw session 文本里稳定出现这些 block：

- `Conversation info (untrusted metadata)`
- `Sender (untrusted metadata)`

如果 OpenClaw 后续改了 metadata block 标题、JSON fenced block 形状，或者 delivery-mirror 的 provider/model 命名，`scripts/lib/openclaw_crm_sync.ts` 需要同步调整。

这不是当前实现 bug，而是明显的外部接口依赖风险。

### 5.2 后台任务安装仍然是宿主 `crontab` 方案

当前 `scripts/lib/scheduled_jobs.ts` 的实现还是直接写宿主 `crontab`，不是 OpenClaw cron。

这意味着 residual risk 主要在宿主环境：

- 宿主是否有 `crontab`
- `crontab -l` 的无配置输出是否符合当前假设
- Node 路径和执行环境是否和开发机一致

这类风险当前测试里只做到 fake runner 级别，尚不是“真实宿主环境全覆盖”。

### 5.3 这一批未 push 提交跨度很大，review 成本高

虽然当前没有发现 blocking issue，但这批 ahead 18 commits 实际跨了：

- runtime 迁移
- 数据层迁移
- skill 迁移
- 测试迁移
- CRM auto-sync
- scheduled jobs
- payments caller 边界
- 文档和 release 指南

这会带来一个非代码层面的风险：

- push 后如果要 reviewer 一次性看完整批，会比较重

如果后面要提 PR，建议至少按主题组织说明，而不是只给一个“杂糅的大批次”。

## 6. Push 前最值得 reviewer 再重点看一遍的文件

如果要做二次 spot-check，优先看这几块：

1. `scripts/lib/payments.ts`
   - caller / owner / customer 的身份边界有没有完全和文档一致
2. `scripts/lib/openclaw_crm_sync.ts`
   - parser、cursor、delivery-mirror 归属逻辑是否和真实 OpenClaw session 一致
3. `scripts/lib/scheduled_jobs.ts`
   - 宿主 crontab 安装的幂等性和环境依赖
4. `scripts/db/sqlite.ts`
   - TypeScript 版 SQLite 层和 migration 入口是否与旧实现行为一致
5. `tests/integration/*.test.ts`
   - TypeScript 迁移后的测试覆盖是否和旧 Python 时代的行为契约保持一致

## 7. 一句话结论

这批 `david/dev` 相对 `origin/david/dev` 的未 push 修改，当前已经形成一条完整且自洽的主线：

- Python runtime 归档
- TypeScript runtime 成为主实现
- CRM 自动同步接上 OpenClaw
- onboarding 自动装后台任务
- payments 调整到 caller/customer 边界更清晰的模型
- 文档与发布指导同步

在当前仓库下，**我没有看到阻止 push 的问题**。
