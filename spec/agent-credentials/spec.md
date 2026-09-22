# spec — 凭证三层（v0.3.x 核心）

状态：开发中 · 驱动：PRD §2 凭证三层 + 用户按需时长租约设计 + ZCode 工程约束

## 产品规则

### 令牌分层

| 令牌 | 格式 | 生命周期 | 存储 | 用途 |
| --- | --- | --- | --- | --- |
| 刷新令牌 | `skr_` + 64 hex | 长期（默认 90 天上限） | 文件 0600，库中 SHA-256 哈希 | 唯一用途：换取会话令牌 |
| 会话令牌 | `sks_` + 32 hex | 短（默认 30 分钟，策略封顶 4h） | 内存/env，过期即弃 | 实际调用 action create / agent run |
| 静态 key | `skp_` + 32 hex | 永久（legacy） | 库中哈希 | 兼容存量 agent |

### 核心流程

```
skyport agent create → 发 skr_（只显一次，写入文件）
skyport agent login --refresh-token-file <path>
  → 验证 skr_（哈希查库、未吊销、未过期）
  → 铸 sks_（30 分钟）
  → 输出 {"sessionToken": "sks_...", "expiresAt": "..."}
export SKYPORT_API_KEY=sks_...
skyport agent run --exec 'uptime' --target t1  ← 用 sks_
```

### 轮换双模式

1. **换票即轮换**：`agent login` 时自动轮换 skr_（CLI 原子写回文件）
2. **手动轮换**：`skyport agent rotate <name>`（怀疑泄漏时用）
3. **复用检测**：已作废旧 skr_ 被再次出示 → 自动吊销整个 agent

### 会话令牌生命周期

- 默认 TTL 30 分钟（`SKYPORT_SESSION_TTL_MINUTES` 可配）
- 闲置超时 15 分钟无调用自动作废
- 每次 API 调用验证：哈希匹配 + 未过期 + 未闲置超时

## 接口

| 命令 | 说明 |
| --- | --- |
| `skyport agent login --refresh-token-file <path>` | 换取会话令牌 |
| `skyport agent rotate <name>` | 手动轮换刷新令牌 |
| `skyport agent sessions <name>` | 列出活跃会话 |

## 验收场景

1. create → login → run 全链路走通（skr_ 换 sks_ → 执行命令）
2. 会话过期后调用被拒（PERMISSION_DENIED）
3. 轮换后旧 skr_ 立即失效
4. 复用已轮换的旧 skr_ → 整个 agent 被吊销

## 失败路径

- skr_ 无效/过期/已吊销 → PERMISSION_DENIED
- sks_ 过期/闲置超时 → PERMISSION_DENIED
- 轮换时文件写回失败 → 原子操作，新旧均可用（先写新文件再作废旧）
- 并发 login → 单飞锁保护（同一 agent 同时只有一个 login 生效）
