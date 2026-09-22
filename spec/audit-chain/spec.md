# spec — 审计链防篡改（v0.3.x）

状态：开发中 · 驱动：PRD §2 关键机制 / 红队 F2

## 产品规则

- 事件名从自由字符串改为 **ActionEventType 枚举**（TS 类型约束 + zod 校验），拼错在编译期暴露
- action_events 表新增 **全局单调 seq**（SQLite AUTOINCREMENT 已保证，但跨表排序靠 created_at 不可靠——加 seq 列作为权威排序键）
- action_events + executions 新增 **prev_hash / hash** 两列：每条记录的 hash = SHA-256(prev_hash + 本条内容 JSON)，形成**链式哈希**
- `skyport audit verify` 命令：遍历两表按 seq 排序，重算每条 hash 验证链完整性——**任何单条删改都会断链**
- 链断裂时报告第一条违规记录的位置与 seq

## 接口

| 命令 | 说明 |
| --- | --- |
| `skyport audit verify` | 校验审计链完整性，输出 OK 或断链位置 |

## 验收场景

1. 正常创建行动后 `audit verify` 输出链完整
2. 直改库删一条事件后 `audit verify` 报断链（seq 定位）
3. 直改库改一条事件内容后 `audit verify` 报 hash 不匹配

## 失败路径

- 空表（无行动）→ verify 输出"空链，无记录可校验"，exit 0
- 序列不连续（gap）→ 报告 gap 位置
- 多进程并发写 → better-sqlite3 串行保证写入原子性；hash 计算在写入前完成，不依赖锁
