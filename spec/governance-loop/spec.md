# spec — 治理闭环（M2）

状态：开发中 · 驱动：PRD §2.1-2.4、§2.6、§2.8

## 产品规则

### 行动（Action）与状态机
- 行动 = 一次受控运维动作：命令（字符串入库，执行时按引号规则切分为参数数组，**绝不经 shell 拼接**）、目标（本机或已登记资产的 SSH）、理由、风险等级。
- 状态机：`pending → approved → executing → success / failed`；`pending → rejected / cancelled`。非法迁移一律 `ACTION_INVALID_STATE`。
- 每次状态迁移写一条 `action_events`（事件 + actor + 时间），执行结果写 `executions`（stdout/stderr 截断、退出码、耗时、超时标志）——审计只增不改。
- actor 二元：`human`（本地 OS 用户，免密钥，信任模型 = OS 会话）或 `agent`（凭 API key 识别）。**approve / reject / cancel / run（人自用直通）只允许 human**，带 key 调用即 `PERMISSION_DENIED`。

### Agent 身份与权限三件套
- `agent create` 签发 key：格式 `skp_` + 32 hex，**只在创建时显示一次**；库中仅存 SHA-256 哈希与 `skp_前4位****` 提示串。
- 三态：`active / paused / revoked`；可选到期时间（ISO，过期即失效）。pause = 冻结（可恢复），revoke = 永久。
- 权限三件套，行动创建时在门口校验：
  1. 风险上限（risk-ceiling low|medium|high）：行动风险超上限 → `PERMISSION_DENIED`（连 pending 都不进）。
  2. 资产范围（asset patterns，`*` 通配）：目标资产名（本机用 `local`）不匹配任何模式 → `PERMISSION_DENIED`。
  3. 动作范围（scopes）：默认 `action:create`；`auto-exec-low` 允许低危自动执行。
- key 无效 / paused / revoked / 过期 → `PERMISSION_DENIED`。

### 风险分级（P0 加固后）
- 三档：low / medium / high。AI 自报 `--risk-hint` **只升不降**：最终 = max(规则结果, hint)。
- **策略文件只从 `~/.skyport/skyport.policy.json` 加载**（数据目录 0700，与 DB 同信任边界——被治理的 AI 与调用者同 UID，cwd 是它的可写区，禁止作为治理参数来源）；`SKYPORT_POLICY_PATH` 可显式指定（开启时启动 WARN）。`autoExecLowRisk` 默认 false，开启时 doctor 警示、config 可见。
- **评估在 parseSegments() 的输出上做**（与执行层同一套引号语义，杜绝"评估看字符串、执行剥引号"两套语义）：
  - 组合命令按未加引号的 `;` `|` `&&` `&` 切分段，逐段评估取最大值；
  - 旗标按集合语义：`-rf` = `-r -f` = `--recursive --force`；引号包裹的旗标先剥引号；
  - 结构规则：rm 递归+根/通配路径 → high，rm 递归 → medium；dd/mkfs/shutdown/reboot/halt/poweroff/init 0|6 → high；find -delete/-exec → high；mv/chmod 777/chown -R 于根 → high；systemctl 变更类/kubectl delete|scale/docker 删除类/kill 类/包卸载/git push --force → medium；
  - 执行原语：任意段程序为 shell 且经管道进入 → high；解释器（bash/sh/python/node 等）带 -c/-e → 至少 medium；段内含 rmtree/os.system/subprocess/child_process → high；
  - 地板规则：未加引号的反引号/`$(`（命令替换）→ 整体至少 medium；**无法静态确认结构的命令宁可 medium**；
  - 兜底 low。
- **白名单只对"单段且无命令替换"的命令生效**（全等比较）——`kubectl get pods; id` 这类加后缀的组合不吃白名单。
- **自动执行资格**：多段或有命令替换 → 一律不具备 autoExecLowRisk 资格（即使整体 low 也要人工审批）。
- **跳板治理**：任一段程序为 ssh/scp 时提取二级目标——目标是已登记资产且不在 agent 资产范围 → 门口拒绝；无法解析目标 → 强制 high。kubectl exec / docker exec / nsenter → high（上下文逃逸，无法静态分析）。
- 路径映射：风险 low 且具备资格且策略 autoExecLowRisk 且（agent 需含 `auto-exec-low` scope）→ 创建即自动批准并执行；medium/high → pending 等人。**human 的 `run` 直通不受风险拦截**（人是 root），但风险照算照记。

### 执行
- 唯一出口仍是 executor（超时/重试/截断/退出码归一化全复用）。
- **本地执行**：命令切分为参数数组直 exec，不经 shell——`;` `|` `$()` 等元字符原样传给目标程序。
- **SSH 执行**（红队 N2 加固）：**入库的原始命令字符串原样作为单一参数**交给 ssh，由远端 shell 解释——审批人读到的命令语义即远端实际执行语义（`touch "/tmp/a b.txt"` 创建单文件而非两个）；host:port 从资产 addr 解析，addr 也可直接填 `~/.ssh/config` 的别名；凭据一律走本机 SSH 配置；外层 ssh 固定 `BatchMode=yes`（密钥认证无交互，异常快速失败不挂死）。**命令里再内嵌 ssh 跳板时请自行加 `-o BatchMode=yes`**，否则内嵌连接可能交互挂到超时。
- 判级补充（红队 R）：`truncate` 作用于 `/dev/*` 设备 → high；`chmod 777/000` 作用于系统路径 → high；**含分隔符命令维持 low 但永无自动执行资格**（刻意决策：升 medium 会误伤 `hostname && uptime` 类只读组合，审批负担换不来安全收益——兜底是"必须过人"本身）。
- approve = 放行并**立即同步执行**（M2 无常驻调度），结果当场返回并落审计。

## 接口（CLI）

| 命令 | 说明 |
| --- | --- |
| `skyport agent create --name --assets <p1,p2> --risk-ceiling <low\|medium\|high> [--auto-exec-low] [--expires <ISO>]` | 签发 key（只显示一次） |
| `skyport agent list / show <name> / pause <name> / revoke <name>` | 管理与状态 |
| `skyport action create --exec "<cmd>" [--target <asset>] [--reason] [--risk-hint] [--api-key] [--json]` | 登记行动（AI 走 --api-key 或 SKYPORT_API_KEY） |
| `skyport agent run --exec "<cmd>" ... [--wait-seconds N] [--json]` | AI 一站式：创建 → 等审批 → 取结果 |
| `skyport action list [--status] [--json]` / `action show <id> [--json]` | 行动看板与详情（含事件与执行结果） |
| `skyport approve <id> [--json]` / `reject <id> [--note]` / `cancel <id>` | 人工审批（禁止带 key） |
| `skyport run --exec "<cmd>" [--target] [--reason] [--json]` | 人自用直通（免审批，全程留痕） |

## 验收场景

1. agent create 显示 skp_ key 一次；库中查不到明文。
2. 低危命令（如 `node -e "..."`）+ auto-exec 策略 → 创建即执行成功，审计链完整（created → auto-approved → exec-started → exec-finished + executions 行）。
3. 中危命令（`systemctl restart nginx` 类）→ pending；`approve` 后执行并返回结果；`reject`/`cancel` 分别落 rejected/cancelled。
4. agent 超风险上限或资产不在范围 → 创建被拒（PERMISSION_DENIED），无行动记录。
5. `run` 直通执行并留痕；agent run 对 pending 行动等到超时后如实返回 pending。
6. paused/revoked/过期/错 key → 一律 PERMISSION_DENIED。
7. approve/reject/run 带 key 调用 → PERMISSION_DENIED（审批权只在人）。

## 失败路径

- 空输入：--exec 缺失或切分后无 token → `ACTION_INVALID`；引号未闭合 → `ACTION_INVALID`
- 超长：命令 > 2000 字符、reason > 500 → `ACTION_INVALID`
- 权限不足：三件套任一不满足 / key 无效或状态不 active / 到期 / 审批类操作带 key → `PERMISSION_DENIED`
- 不存在：目标资产 / 行动 / agent → `ASSET_NOT_FOUND` / `ACTION_NOT_FOUND` / `AGENT_NOT_FOUND`
- 状态冲突：对非 pending 行动 approve/reject/cancel → `ACTION_INVALID_STATE`；**状态迁移全部原子**（`UPDATE ... WHERE status = <from>`，影响行数 0 即冲突），并发审批只有一个成功（红队 S10）
- 超时：执行超时 → 行动 failed + executions.timed_out=1；**超时默认不重试**（非幂等命令重复执行有副作用），显式 `retryOnTimeout` 才退避重试；executions 如实记录**总耗时与尝试次数**（红队 S9）
- 执行失败退出码：行动终态 failed 时 approve/run/agent run 的 CLI 退出码为 4（exec 域）；批量操作保留最重要失败的域码，不出现"未知错误"（红队 S7/S8）
- 断网语义：SSH 不可达 / 命令不存在 → 行动 failed，stderr/错误留痕（行动失败是数据，命令退出码按域映射）
- 策略文件非法（坏 JSON / 字段类型错）→ `CONFIG_INVALID`；文件不存在 → 用默认策略
- 并发：状态迁移靠原子 UPDATE 兜底；执行不在 SQLite 事务内（异步），状态以事件流为准
- 存储：executions 记录尝试次数与 stdout/stderr 截断标志（迁移 v3，红队 S12）
