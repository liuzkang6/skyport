# spec — 通知与值守体验（M3）

状态：开发中 · 驱动：PRD §2.7（通知与看板）、§2.8

## 产品规则

### webhook 通知（出站、通用）
- 触发点：行动创建后**最终停留在 pending**（中/高危等人）时，向配置的 webhook URL 发一条 JSON POST。
- 配置：`notifyWebhookUrl`（env `SKYPORT_NOTIFY_WEBHOOK_URL` 或 skyport.config.json）；未配置 = 不发送（无副作用）。
- 载荷字段：`event: "skyport.action.pending"`、`actionId`、`command`、`riskLevel`、`target`、`actor`（type:id）、`reason`、`hint`（审批命令提示）。
- **失败不阻断治理**：发送失败/非 2xx 只记 WARN 日志，行动照常创建；超时 5s。
- 只在创建时通知一次：approve/reject 产生的状态变化不重复通知（v2 再考虑结果回推）。

### watch 前台值守（P2 加固后）
- `skyport watch [--interval 秒=3] [--once] [--no-interactive]`：轮询 pending 行动；新 pending → 输出 + 终端铃（\x07）；已见行动离开 pending → 输出其终态。
- **值守行显示完整决策要素（红队 U1/U2/U3）**：风险、发起者（agent 名字而非内部 ID）、目标、命令（截断必提示 show 看全文）、**理由**；与 `action list` 共用同一渲染函数保证一致。
- **就地审批（红队 U4）**：终端环境默认交互——新待办出现后方向键选择 批准/否决/详情/跳过；`--no-interactive` 或非 TTY 自动退化为纯播报。
- `--once`：单次巡检后退出（给 cron/脚本用），不响铃、不交互。
- Ctrl+C 干净退出（退出码 0）。

### 行动台账（红队 U5）
- `action list` 支持 `--agent <名|ID>` / `--target <资产名>` / `--since <ISO>` / `--limit` / `--offset` 过滤分页；达到页大小时尾部提示"仅显示最近 N 条，用过滤条件缩小范围"。
- 发起者一律显示 agent 名字（已删除/吊销的回退显示 ID）。

### agent run 等待体验（红队 U6/U7）
- 进入等待**立即打印**登记结果与"等待人工审批（最长 Ns）"提示，不静默挂住。
- approve/run 执行前打印"执行中"阶段提示（慢命令不再干等无输出）。

### key 读取（红队 S11）
- 支持 `--api-key-file <路径>`（从文件读 key，避免 argv 泄露）；推荐顺序：`SKYPORT_API_KEY` 环境变量 > `--api-key-file` > `--api-key`（argv，最不安全）。

### 交互式选择（list --select）
- `skyport list --select`：终端内方向键选资产 → 显示该资产详情与检查历史，可连续选择，取消退出。
- **非 TTY 或管道环境自动降级**为普通清单输出（脚本安全），`--select` 不报错。
- 交互库：@clack/prompts（纯 JS 依赖）；默认（不带 --select）行为完全不变。

### 批量审批
- `skyport approve <id...>` / `skyport reject <id...> [--note]`：可变参数，逐条处理逐条输出。
- 部分失败不中断后续；结束后若有失败则整体非零退出并汇总（exit 1 + 汇总信息）。

## 接口（CLI）

| 命令 | 说明 |
| --- | --- |
| `skyport watch [--interval N] [--once]` | 前台值守 pending |
| `skyport list --select` | 交互式选择资产（非 TTY 自动降级） |
| `skyport approve <id...> [--json]` | 批量批准执行 |
| `skyport reject <id...> [--note]` | 批量否决 |
| env `SKYPORT_NOTIFY_WEBHOOK_URL` | pending 通知 webhook（钉钉/飞书/Slack incoming webhook 均可收） |

## 验收场景

1. 配置 webhook 后创建中危行动 → 服务端收到 JSON（含 actionId/command/risk），行动创建不被通知失败拖垮。
2. 未配置 webhook → 创建 pending 行为与 M2 完全一致，无网络调用。
3. watch：启动即报当前 pending；新增 pending 触铃；审批后 watch 输出该行动终态。
4. `list --select` 在 TTY 可选择并下钻；非 TTY 输出清单 + 降级提示。
5. `approve id1 id2`：两条都执行；其中一条状态不合法时另一条仍处理，退出码非零。

## 失败路径

- webhook 不可达 / 超时 / 非 2xx → WARN 日志，命令本身成功（通知是尽力而为）
- watch 轮询间隔非法（≤0）→ 用法错误 exit 2
- 批量审批含不存在/状态不合法的 id → 该条报错继续下一条，结束非零退出
- 非法 notifyWebhookUrl（如无协议前缀）→ 发送失败同样降级为 WARN（CONFIG 不强校验 URL 格式，避免阻断创建）

## 明确不做（本里程碑）
- 不做 IM 平台特定卡片格式；不做 approve/reject 的结果回推通知；watch 不做长期驻留/开机自启。
