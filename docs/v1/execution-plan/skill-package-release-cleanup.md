# Skill Package 保留文件

正式发布目录保留下面这些文件，并在 release 目录内执行 `npm ci` 与 `npm run build`，保留编译后的 `dist/` 产物，确保收包后可直接运行。

安装态数据目录约定：

- skill 代码安装到 `~/.openclaw/skills/<skill-package-name>/`
- 可变数据外置到 `~/.openclaw/data/<skill-package-name>/`
- 默认生产库路径是 `~/.openclaw/data/<skill-package-name>/purr_suite_prod.sqlite3`
- 后台定时任务由 OpenClaw cron 托管，不再依赖宿主 `crontab` 日志重定向

## 根目录

- `SKILL.md`
- `package.json`
- `package-lock.json`
- `tsconfig.json`

## 源码脚本

- `scripts/run_skill.ts`

- `scripts/run_low_stock_scan.ts`

- `scripts/sync_crm_from_openclaw.ts`

- `scripts/lib/*.ts`

- `scripts/db/sqlite.ts`
- `scripts/db/migrations/*.sql`

## 构建产物

- `dist/scripts/run_skill.js`
- `dist/scripts/run_low_stock_scan.js`
- `dist/scripts/sync_crm_from_openclaw.js`
- `dist/scripts/lib/*.js`
- `dist/scripts/db/sqlite.js`

## 技能文档

- `skills/onboarding/SKILL.md`
- `skills/onboarding/cron/crm-sync.md`
- `skills/onboarding/cron/low-stock-scan.md`
- `skills/catalog/SKILL.md`
- `skills/catalog/reference/*`
- `skills/inventory/SKILL.md`
- `skills/orders/SKILL.md`
- `skills/payments/SKILL.md`
- `skills/crm/SKILL.md`
- `skills/seller-bi/SKILL.md`

## 不保留

- `data/`
- `node_modules/`
- `docs/`
- `tests/`
- `scripts/dev/`
- `scripts/test_skill.ts`
- `*.map`
- `*.sqlite3`
- `.DS_Store`
- `release/` 里的旧产物
