# spec — 数据库备份（ops 工具）

状态：开发中 · 驱动：工程化第 1 档（审计数据无备份是 MVP 已知欠账）

## 产品规则

- `skyport backup [--dir <目录>] [--keep <份数>]`：用 SQLite 在线备份（`db.backup()`，WAL 安全）生成完整副本。
- 默认位置 `~/.skyport/backups/skyport-<时间戳>.db`；保留策略默认 10 份（`SKYPORT_BACKUP_KEEP` 可配），按修改时间新→旧保留，超出删除并在输出中报告清理数。
- 权限边界（与 S5 同规矩）：**默认目录** mkdir 0700、备份文件 0600；**自定义 `--dir` 只使用不 chmod**（不动使用者的目录权限）。
- 备份内容含 agent key 哈希与全部审计——属敏感文件，权限收紧同数据库本体。
- 失败 → `SKYPORT_DB_BACKUP_FAILED`（db 域，exit 8），中文人话。
- 纯人工运维命令：不接受任何 key（无 --api-key 选项）。

## 接口（CLI）

| 命令 | 说明 |
| --- | --- |
| `skyport backup` | 备份到默认目录并按保留策略清理 |
| `skyport backup --dir /mnt/nfs/skyport` --keep 5 | 指定目录与份数 |

## 验收场景

1. 默认目录备份 → 文件存在、可被 SQLite 打开且 `schema_version` 与主库一致；目录 0700 / 文件 0600。
2. `--keep 2` 下预先放 3 份旧备份 → 执行后只剩最新 2+1 份中最新的 2 份，输出报告清理数。
3. 自定义目录（0755）备份成功且目录权限不变。
4. 备份失败（目录不可写）→ `SKYPORT_DB_BACKUP_FAILED`，exit 8。

## 失败路径

- 目标目录不可写 → `DB_BACKUP_FAILED`（cause 保留，verbose 可查）
- keep 非法（<0）→ 用法错误（commander 校验）
- 磁盘满等 IO 错误 → `DB_BACKUP_FAILED`
