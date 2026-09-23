# skyport 手动验证清单（v0.3.x 网关完工线·当前进度）

> 给人的验证步骤。按顺序跑，每步写明预期。当前版本包含：工程化小批、审计链、高危护栏、CMDB v2。
> 已接入口：serve（REST）/ mcp / agent login / agent rotate / user 管理 / audit verify+backfill。
> **尚未接入口（服务层已就绪、CLI 未接）**：凭证保险箱（§6 `skyport secret`）、CMDB 写路径（§5 `skyport service`）。

## 前置条件

```bash
export PATH=/home/liu/node22/bin:$PATH
cd /home/liu/skyport
pnpm install && pnpm build
skyport init
```

## 1. 环境自检

```bash
skyport doctor
```
**预期**：五项全绿（运行时/配置/项目配置/数据库/策略），数据库 schema 版本 ≥ 7。

## 2. 资产管理

```bash
skyport asset add --name test-01 --type host --addr 127.0.0.1:22 --connect-mode local --label env=test
skyport list
skyport asset check test-01
skyport asset remove test-01
```
**预期**：登记→列表可见→检查→删除后消失。

## 3. 审计链验证

```bash
skyport run --exec 'echo audit-test' --reason '审计验证'
skyport audit verify
```
**预期**：`audit verify` 输出"审计链完整（N 条记录校验通过）"。

**篡改检测（可选，需 sqlite3 CLI）**：
```bash
sqlite3 ~/.skyport/skyport.db "DELETE FROM action_events WHERE rowid = (SELECT MAX(rowid) FROM action_events)"
skyport audit verify
```
**预期**：报告"审计链断裂"（exit 1）。恢复：`skyport backup` 有备份。

## 4. 高危护栏

### 4a. 回滚必填
```bash
skyport action create --exec 'shutdown now'
```
**预期**：拒绝，报 `SKYPORT_ACTION_INVALID: high 风险行动必须提供 --rollback 回滚声明`。

```bash
skyport action create --exec 'shutdown now' --rollback '重启机器即可'
```
**预期**：正常登记为 pending。

### 4b. Dry-run
```bash
skyport action create --exec 'rm -rf /' --dry-run
```
**预期**：输出风险评级 high，但**不落库**——`skyport action list` 里看不到这条。

### 4c. Pending 过期
1. 创建一条行动
2. 直改库把 created_at 改到 25 小时前：
   ```bash
   sqlite3 ~/.skyport/skyport.db "UPDATE actions SET created_at = datetime('now', '-25 hours') WHERE id = '<行动ID>'"
   ```
3. 尝试审批：
   ```bash
   skyport approve <行动ID>
   ```
**预期**：报告"行动已过期（pending 超 24h）"。

## 5. CMDB 服务与拓扑

```bash
skyport service add --name svc-api --owner liu
skyport service add --name svc-db
skyport service dep add svc-api svc-db
skyport asset add --name db-01 --type host --addr 10.0.2.10
skyport service link db-01 svc-db
```
**预期**：服务创建成功，依赖边添加成功。（CLI 命令尚未接入，当前通过 API 调用。）

## 6. 凭证保险箱

```bash
skyport secret set aliyun_key
# 按提示输入值
skyport secret list
# 预期：显示 ****尾4位
skyport secret get aliyun_key
# 预期：显示完整值
```
**加密验证**：
```bash
sqlite3 ~/.skyport/skyport.db "SELECT encrypted_value FROM secrets WHERE name = 'aliyun_key'"
```
**预期**：输出 base64 密文，不含明文。

## 7. 进程树击杀验证

```bash
skyport run --exec 'node -e "require(\"child_process\").spawn(\"sleep\",[\"60\"]);setInterval(()=>{},1000)"' --json 2>&1 | python3 -c "import json,sys; print(json.load(sys.stdin)['execution']['timedOut'])"
```
**预期**：超时后 `timed_out: true`，且 `sleep 60` 进程也被杀（`ps aux | grep sleep` 无残留）。

## 8. 双远端同步

```bash
./scripts/push-all.sh
```
**预期**：GitHub 与本地 Gitea 两个远端都推送成功。

## 9. 凭证三层

```bash
skyport agent create --name cred-test --assets '*' --risk-ceiling medium
# 记下输出的 skr_ 令牌（agent create 不再直接发 skr_ 时，先 rotate 一次拿 skr_）
skyport agent rotate cred-test
# 输出新的 skr_（只显示一次），旧的立即失效
skyport agent login --refresh-token-file <(echo 'skr_...')
# 输出 sks_ 会话令牌（30 分钟有效；令牌只认文件/stdin，不上 argv）
```

## 10. REST API v1

```bash
skyport serve --port 7100 &
curl http://127.0.0.1:7100/api/v1/health
# 预期：{"status":"ok"}

TOKEN="sks_..."  # 从 agent login 获取
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7100/api/v1/whoami
# 预期：{"actor":{"type":"agent","name":"..."}}

curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7100/api/v1/assets
# 预期：资产列表

curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7100/api/v1/audit/verify
# 预期：{"ok":true,"checked":N}

curl -w '%{http_code}\n' http://127.0.0.1:7100/api/v1/assets
# 预期：401（无凭证；403 留给"认证了但无权"，红队 V9）
```

## 11. MCP 适配器

```bash
# 红队 V6：MCP 与 REST 同源校验——无令牌直接拒绝启动（SKYPORT_AUTH_REQUIRED）
SKYPORT_API_KEY=sks_... skyport mcp  # stdio 模式启动（令牌经环境变量，不上 argv）
# 在另一个终端发 JSON-RPC：
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | SKYPORT_API_KEY=sks_... skyport mcp
# 预期：返回 serverInfo
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | SKYPORT_API_KEY=sks_... skyport mcp
# 预期：返回 7 个工具（纯只读；agent 令牌读面按其资产范围过滤，与 REST 一致）
```

## 12. 告警总线

```bash
skyport serve --port 7100 &
# 红队 V7：alerts:write 只属于 Web 会话角色（approver/admin）——Bearer agent 令牌投递告警 → 403。
# 先拿 Web 会话 cookie：
curl -c /tmp/skp.jar -X POST -H "Content-Type: application/json" \
  -d '{"username":"<approver用户>","password":"<密码>"}' \
  http://127.0.0.1:7100/api/v1/auth/login

# Alertmanager 格式（带 Web 会话 cookie）
curl -b /tmp/skp.jar -X POST -H "Content-Type: application/json" \
  -d '{"alerts":[{"labels":{"alertname":"HighDisk","instance":"t1","severity":"critical"},"annotations":{"summary":"Disk 91%"}}]}' \
  http://127.0.0.1:7100/api/v1/alerts
# 预期：201 + 告警创建（用 Bearer sks_/skp_ 调用则 403）

# 查看告警
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7100/api/v1/alerts?status=open
# 预期：包含 HighDisk 告警

# ACK
ALERT_ID=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7100/api/v1/alerts | python3 -c "import json,sys; print(json.load(sys.stdin)['alerts'][0]['id'])")
curl -X PATCH -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7100/api/v1/alerts/$ALERT_ID/ack
# 预期：status 变为 ack

# 统计
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7100/api/v1/alerts/stats
```

## 已实现清单（对照 PRD 路线图，2026-09 更新）

- [x] 凭证三层（刷新令牌 + 会话令牌 + 轮换，自动+手动双模式）
- [x] REST API v1（30 路由：会话/资产/行动/审批/告警/态势包/用量/插件/基线/剧本/治理）
- [x] MCP 适配器（7 工具/JSON-RPC stdio）
- [x] 执行异步化（approveAsync + webhook 回推）
- [x] 云 CLI 可操作（cloud-account → CLI 通道）
- [x] 节点 agent Go v0.2.0（心跳 + CPU/内存/磁盘指标，3 台机器 systemd 常驻）
- [x] 态势包 v1（Context Pack：资产+检查+告警+行动+拓扑自动组装，REST 端点 /api/v1/context/:asset）
- [x] 告警总线（Alerta 模型 + Alertmanager/Zabbix/原生 适配器 + ACK SLA + REST 端点）
- [x] 基线三相训练（指标采集→基线计算→异常检测）
- [x] 资产执行互斥 + 事件认领
- [x] Break-glass 兜底（封存 SSH 私钥 + 告警 + 4h 自动回封）
- [x] 四角色 + 运维技能库（巡查/调查/处置/审查，4 个 SKILL.md）
- [x] 编排引擎（剧本 6 步类型 + 审批门 + 三相毕业 + vendor 工作流桥接）
- [x] 僵尸对账（serve 每 5 分钟自动 + reconcile CLI + doctor 可见性）
- [x] SSE 实时事件流（审批/否决/告警摄入/僵尸对账广播，Web UI 即时刷新）
- [x] Web UI（11 视图：动态/操作台/收件箱/我的/事件/资产/知识库/审计/用量/设置/登录）
- [x] 注入防御（15 模式检测 + 内容隔离层）
- [x] 治理月报 + 交接班（REST 端点 + Web UI 治理页专属界面）
- [x] agent 反向通道（SSE 下行 + 结果上行；Go agent v0.3.0 三台常驻；REST POST /actions 补全）
- [x] vendored ZCode 引擎真跑（contracts 垫片 + 受治理驱动 + 桥接切换，8 条引擎测试）
- [x] 告警闭环（调度器自动触发剧本：事件/severity 匹配 + 5 分钟冷却 + playbook_runs 留痕）
- [x] 交接班落库（handovers 表 + GET /handover/latest + 治理页预载）
- [x] AI 座位：模型配置中心（v14 + key 入保险箱 + CRUD）+ LLM 客户端（usage 记账 + 注入防御）+ 巡查员（15 分钟定时巡逻 + 白名单约束）
- [x] 生产数据积累闭环：指标（CPU/内存/磁盘/日志错误率 30s 采集）→ 基线（每小时重算 p50/p95）→ 异常检测；30 天保留自动清理

## 僵尸对账（v0.3.x 网关完工线收尾）

前置：初始化库并创建一条行动，手动把它置为超时 executing（模拟网关崩溃残留）。

```bash
skyport doctor
# 预期：checks 里出现 zombie-actions 项，正常时 detail 为"超时阈值 15 分钟"

skyport reconcile --threshold 1
# 预期：输出 {"scanned":N,"reconciled":N,"actionIds":[...]}，超时行动被标记 failed

skyport audit verify
# 预期：ok=true——对账事件(zombie-reconciled)已入链，actor 为 system:skyport-reconciler
```

serve 常驻时每 5 分钟自动对账一次，无需人工触发。

## SSE 实时事件流（Web UI 联动）

前置：`skyport serve` 运行中，两个浏览器标签登录不同角色。

```bash
curl -N http://127.0.0.1:7100/api/v1/events/stream
# 预期：收到 {"event":"connected",...}，之后每 15s 一条 keep-alive 注释

# 另一会话审批/否决一条行动后，上面的流应立即收到：
# {"event":"action-approved"/"action-rejected","actionId":"...","by":"..."}
# 告警摄入后收到 {"event":"alerts-ingested","count":N}
```

Web UI 侧：A 标签审批，B 标签看板无需等 8s 轮询即刷新。

## Web UI 导航（11 视图全亮）

- 动态/操作台/收件箱/我的/事件/资产/知识库/审计/用量/设置 全部可点，选中态高亮随 URL 同步
- "我的"页：按当前登录用户名过滤行动时间线（GET /api/v1/actions?actor=<name>）
- 深链直达：浏览器直接打开 /assets、/audit 等不再回落看板

## agent 反向通道（v0.4 收尾：命令执行走 agent 通道而非网关 SSH）

前置：三台节点 agent v0.3.0 常驻（心跳 + 反向通道双循环），令牌经 systemd `SKYPORT_AGENT_TOKEN` 注入。

```bash
# 1. 通道在线确认（serve 日志）
grep 'agent 通道已连接' ~/.skyport/serve.log | tail -3
# 预期：t1/t2/t3 各一条（agent 断线 3s 自动重连）

# 2. REST 创建行动（POST /api/v1/actions 已补全）+ 审批 → 命令经通道下发
curl -X POST http://127.0.0.1:7100/api/v1/actions -H "Authorization: Bearer <na-t1 的 skp_ key>" \
  -H 'Content-Type: application/json' -d '{"command":"hostname","target":"t1","reason":"通道验证"}'
# 审批后 serve 日志出现"经 agent 反向通道执行"，t1 上 journalctl 出现"命令已执行并回传"

# 3. 门禁：无令牌挂通道 → 401；Web 会话 → 403；未登记 hostname → 400
```

## 治理页（v0.7 补全：月报 + 交接班专属 UI）

- 侧栏"治理"：治理月报标签（周期 24h/7d/30d 切换，行动×状态/风险/操作者分布 + 高频命令 Top10 + 审计链完整性横幅）
- 交接班标签：手写备注 + 一键生成快照（开放告警/待审批/资产健康）

## vendored ZCode 引擎真跑（v0.6 收尾）

- `executeViaBridge` 不再委托原生 playbook：剧本编译为 WorkflowRunSnapshot，
  由 vendor WorkflowGraphScheduler 调度（并发/错误阈值/前沿事件/死锁检测来自引擎本体）
- 治理语义不变：training/shadow 记录不执行；detect 每步经行动系统；
  审批门停等人工；行动 pending 时引擎轮询审批结果

## 告警闭环（spec/alert-dispatcher，业务闭环第一环）

前置：serve 运行中（内置剧本 training 相——自动触发只记录不执行，毕业到 detect 才真动手）。

```bash
# 1. 投递磁盘告警（Web 会话角色）
curl -X POST http://127.0.0.1:7100/api/v1/alerts -H "Cookie: <skyport_session=...>" \
  -H 'Content-Type: application/json' \
  -d '{"event":"DiskFull","resource":"t1","severity":"critical","origin":"manual","text":"验证"}'
# 预期：201 新建告警；serve 日志依次出现"告警命中剧本"→"调度器系统 agent 已开通"→"vendored 引擎执行剧本"

# 2. 运行留痕
curl -H "Cookie: ..." http://127.0.0.1:7100/api/v1/playbook-runs
# 预期：disk-cleanup / triggerType=alert / triggerAlertId 指向上面的告警 / mode=training

# 3. 冷却窗口：5 分钟内再投 HighDiskUsage → runs 不增加

# 4. 手动触发（approver+）
curl -X POST http://127.0.0.1:7100/api/v1/playbooks/service-restart/trigger -H "Cookie: ..."
# 预期：200，runs 新增 triggerType=manual 记录
```

Web UI：设置 → 运行时 → 剧本卡片"手动触发"按钮 + "剧本运行"历史表（时间/剧本/相/状态/触发来源/步数）。

## AI 巡查员（spec/llm-seat：业务闭环第二环——AI 主动感知→提案→治理→执行）

前置：模型已登记（设置 → 模型配置，key 加密入保险箱，永不回显）。

```bash
# 1. 登记模型（OpenAI 兼容端点；tier: cheap=巡查员 / strong=调查处置审查）
curl -X POST http://127.0.0.1:7100/api/v1/models -H "Cookie: ..." -H 'Content-Type: application/json' \
  -d '{"name":"glm-5-3-flash","baseUrl":"https://.../v1","modelId":"GLM-5.3-Flash","apiKey":"<key>","tier":"cheap","enabled":true}'

# 2. 手动巡查（serve 亦每 15 分钟自动巡查）
curl -X POST http://127.0.0.1:7100/api/v1/patroller/run -H "Cookie: ..." -d '{}'
# 预期：LLM 读基线异常+开放告警简报，输出决策 JSON；
# 只读提案（df/uptime/journalctl 等白名单头）经 createAction 建行动（低危自动执行，否则待审批）

# 3. 治理不变：审批 AI 提案 → 经 agent 反向通道真执行
curl -X POST http://127.0.0.1:7100/api/v1/actions/<id>/approve -H "Cookie: ..."

# 4. 用量：LLM 调用记 usage_events（模型/token 归属巡查员 agent），用量页可查
```

Web UI：操作台顶部"AI 巡查员"卡片（最近巡查结论/异常数/提案状态 + 立即巡查按钮）。
安全：巡查员是系统 agent（低危上限）；LLM 输出过注入守卫标记 + 决策 JSON 严格校验 +
只读命令白名单（危险头/片段拒绝）；单次巡查提案上限 3 条。

## 生产数据积累（spec/baseline：攒 → 学 → 检测）

数据流：Go agent 每 30s 心跳带指标（cpu_usage / mem_usage / disk_usage / log_error_rate_5m）
→ metric_points 入库 → serve 每小时重算基线（p50/p95，样本 ≥10 才算）→ 巡查员巡查时
按"最新值 > p95×1.2"判异常。原始点保留 30 天（每天自动清理），基线聚合值永久。

```bash
# 手动重算 + 查看（serve 常驻时每小时自动）
skyport baseline compute        # {"computed":9,"skipped":3}
skyport baseline show t1        # 各指标 p50/p95/样本数

# 指标在攒的证据
sqlite3 ~/.skyport/skyport.db "SELECT a.name, m.metric, COUNT(*) FROM metric_points m JOIN assets a ON a.id=m.asset_id GROUP BY 1,2"

# 日志错误率：agent 经 journalctl 统计近 5 分钟 err 级条数（log_error_rate_5m），
# 正常机器≈0；制造日志风暴可验证异常检测：
logger -p user.err "test error $(date +%s)"   # 在目标机器发一条 err 日志，等下个心跳+巡查
```

部署新机器：安装 agent（v0.4+）→ asset add 登记（名字=hostname）→ 指标自动开始积累，
样本攒够 10 个（约 5 分钟）基线自动建立。
