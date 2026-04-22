# 2026-03-17 更新批次说明：Skill 文档重构与发布包移除

## 1. 这一天我改了什么

今天的改动主要集中在两类：

1. **删除旧的 runtime 发布包目录**  
   - 移除 `release/skill-package-runtime-v1/` 及其全部脚本、migrations 与 skill 文档。
   - 这表示旧的 release 包已不再作为维护对象。

2. **重构核心技能文档**  
   - 以 `skills/onboarding/SKILL.md` 的章节结构为基线，重排与统一 `catalog`、`inventory`、`crm` 的写法。
   - 统一入口称呼为 `run_skill`，避免“执行器/运行时”歧义。
   - 对 `catalog.add_sku` 补齐字段说明。
   - 对 `crm` 与 `inventory` 增加“结果呈现”与更明确的失败处理。
   - 根 `SKILL.md` 的描述与路由说明也同步更新，强调角色与路由规则。

## 2. 你需要先知道的最终状态

### 2.1 旧 release 包已移除

`release/skill-package-runtime-v1/` 全部删除，避免继续在旧包上做改动。

### 2.2 文档结构统一

`onboarding / catalog / inventory / crm` 现在均以同样的章节结构组织：

- 技能边界（强制）
- 命令表
- 输入判断
- 必做约束
- 工作流程
- 结果呈现
- 失败处理

### 2.3 catalog 字段解释补齐

`catalog.add_sku` 每个字段都补了用途说明，便于 Agent 生成正确参数。

### 2.4 CRM 和 inventory 的“结果呈现”明确

查询/写入后的自然语言输出规范已补齐，避免只给出 JSON。

## 3. 具体提交

| Commit | 主题 | 一句话说明 |
| --- | --- | --- |
| `chore(release): remove runtime v1 package` | release | 删除 `release/skill-package-runtime-v1` 全目录 |
| `docs(skills): refactor onboarding/catalog/inventory/crm` | docs | 统一结构并重写 4 个核心技能文档 |
| `docs(skills): refresh root and misc wording` | docs | 更新根 `SKILL.md` 与零散文案 |

## 4. 影响与注意点

- 旧 release 包被移除后，所有修改都应集中在主仓库的 `skills/` 文档。
- 任何后续如需发布包，需要重新生成或重建新的 release 目录。
