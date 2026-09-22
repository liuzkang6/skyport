# spec — 资产台账（M1）

状态：开发中 · 驱动：PRD §2.5（资产清单）

## 产品规则

- 资产是治理的锚点：M2 起行动单的 `target` 引用资产 ID、agent 的资产范围授权也以资产为对象。
- 资产三类型：`host`（机器）/ `cluster`（集群）/ `cloud-account`（云账户）。
- 资产字段：`name`（全局唯一、人可读，长度 1-100）、`type`、`addr`（`[user@]host[:port]`——带 user 时 SSH 以该用户登录，省略 user 则用本机当前用户；连通性检查始终只探测 host）、`connect_mode`（local | ssh | agent；host 默认 ssh；**agent 模式 v2 开放，M1 拒绝**）、`labels`（键 `[A-Za-z0-9_.-]+` 的自由键值对）、`status`（unknown | up | down）。
- host 必须有 addr；cluster / cloud-account 的 addr 可选。
- **status 不是手工字段**：唯一写者是检查逻辑；`unknown` = 从未检查过。
- 凭据不落库：库里只有地址与连接模式，连接复用本机 SSH 配置。
- 存储：SQLite（better-sqlite3，WAL + foreign_keys），默认 `~/.skyport/skyport.db`，`SKYPORT_DB_PATH` 覆盖；**数据目录 0700、库文件 0600**（信任模型的文件层加固）。
- 迁移：`schema_version` 表 + 顺序迁移；重复打开幂等（已应用版本跳过）。
- 检查 = TCP 连接探测（超时默认 5000ms，`SKYPORT_CHECK_TIMEOUT_MS` 可调）；端口缺省规则：ssh 模式默认 22，其余模式必须写明 `host:port`。
- **检查失败是数据不是错误**：主机不可达记为 `down`（含原因与延迟），命令退出 0；操作失败（如未登记地址）才报错。

## 状态所有者

- `assets` 表拥有资产主数据 + 最近一次检查快照（`last_check_*` 冗余列，list 免联表）。
- `asset_checks` 表拥有检查历史（append-only，随资产删除级联清理）。

## 接口（CLI）

| 命令 | 说明 |
| --- | --- |
| `skyport init` | 初始化数据目录与数据库，打印上手命令 |
| `skyport asset add --name --type [--addr] [--label k=v]... [--connect-mode]` | 登记单台 |
| `skyport asset import <file.json>` | 批量导入（JSON 数组，全有或全无） |
| `skyport list` / `skyport asset list [--type] [--label k=v] [--json]` | 资产清单（裸 list 即资产） |
| `skyport asset show <name\|id> [--json]` | 详情 + 最近检查历史 |
| `skyport asset check <name\|id> [--json]` | 连通性检查并落状态 |
| `skyport asset remove <name\|id>` | 删除（级联检查历史） |

## 验收场景

1. `add` 登记主机后 `list` 可见（unknown 状态），`show` 回显全部字段，`add` 默认 host → ssh 模式。
2. `import` 一次登记多台；`list --type` / `list --label` 过滤正确。
3. `check` 对监听中的端口返回 up + 延迟并写历史；对拒绝连接的端口返回 down + 原因，两者退出码均为 0。
4. `remove` 后资产与检查历史一并消失。
5. 裸 `skyport list` 与 `skyport asset list` 输出一致。

## 失败路径

- 空输入：name 缺失/空白 → `ASSET_INVALID`（CLI requiredOption + 服务层 zod 双保险）
- 超长：name > 100、addr > 255 → `ASSET_INVALID`
- 重复：name 撞库 / 撞导入文件内既有 → `ASSET_DUPLICATE_NAME`（context 带 name 与导入条目序号）
- 不存在：show / check / remove 找不到目标 → `ASSET_NOT_FOUND`
- 命令不存在 / 超时 / 断网语义：TCP 探测失败 → 记 `down` 数据（含原因），退出 0，不是错误
- 并发：单进程 CLI 同步串行写；多进程同库由 SQLite 锁兜底，busy 归一化为 `DB_QUERY_FAILED`
- 导入文件不存在 → `FS_NOT_FOUND`；非数组 / 条目非法 → `ASSET_INVALID`（整个事务回滚，不留半批数据）
- 库打开失败（目录不可写等）→ `DB_OPEN_FAILED`；迁移失败 → `DB_MIGRATION_FAILED`
- 非法用法：标签无 `=`、host 缺 addr、connect_mode=agent、非 ssh 模式地址缺端口 → `ASSET_INVALID`
