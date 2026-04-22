# Low Stock Scan Cron

## 用途

定时执行低库存扫描，更新当前低库存视图与提醒状态。

## 标准形态

- `name`: `Low Stock Scan`
- `description`: `purr-suite-managed:low_stock_scan`
- `schedule.kind`: `cron`
- `schedule.expr`: `*/5 * * * *`
- `schedule.tz`: `Asia/Shanghai`
- `agentId`: `main`
- `sessionTarget`: `isolated`
- `payload.kind`: `agentTurn`
- `payload.message`: `执行低库存扫描：运行命令 node <skill_package_root>/dist/scripts/run_low_stock_scan.js --db-path <skill_data_root>/purr_suite_prod.sqlite3`
- `delivery.mode`: `announce`
- `enabled`: `true`

其中：

- `<skill_package_name> = path.basename(<skill_package_root>)`
- `<skill_data_root> = path.resolve(<skill_package_root>, "..", "..", "data", <skill_package_name>)`

## 检测规则

1. 调用 `cron.list`，读取返回的 job 列表。
2. 在返回结果中查找 `description == "purr-suite-managed:low_stock_scan"` 的任务。
3. 若没有匹配项，执行下面的 `cron.add` 模板。
4. 若有多个匹配项，保留 `cron.list` 结果中的第一个 `jobId`，对其余任务执行 `cron.remove`，然后对保留项执行一次 `cron.update` 模板。
5. 若只有一个匹配项，但 `name`、`description`、`schedule.expr`、`schedule.tz`、`agentId`、`sessionTarget`、`payload.message`、`delivery.mode` 或 `enabled` 与标准形态不一致，执行 `cron.update` 模板。
6. 禁止调用 shell `openclaw cron ...`；只允许使用 cron tool。

## `cron.add` 模板

```json
{
  "name": "Low Stock Scan",
  "description": "purr-suite-managed:low_stock_scan",
  "enabled": true,
  "agentId": "main",
  "sessionTarget": "isolated",
  "schedule": {
    "kind": "cron",
    "expr": "*/5 * * * *",
    "tz": "Asia/Shanghai"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "执行低库存扫描：运行命令 node <skill_package_root>/dist/scripts/run_low_stock_scan.js --db-path <skill_data_root>/purr_suite_prod.sqlite3"
  },
  "delivery": {
    "mode": "announce"
  }
}
```

## `cron.update` 模板

```json
{
  "jobId": "<job-id>",
  "patch": {
    "name": "Low Stock Scan",
    "description": "purr-suite-managed:low_stock_scan",
    "enabled": true,
    "agentId": "main",
    "sessionTarget": "isolated",
    "schedule": {
      "kind": "cron",
      "expr": "*/5 * * * *",
      "tz": "Asia/Shanghai"
    },
    "payload": {
      "kind": "agentTurn",
      "message": "执行低库存扫描：运行命令 node <skill_package_root>/dist/scripts/run_low_stock_scan.js --db-path <skill_data_root>/purr_suite_prod.sqlite3"
    },
    "delivery": {
      "mode": "announce"
    }
  }
}
```

## `cron.remove` 模板

```json
{
  "jobId": "<duplicate-job-id>"
}
```
