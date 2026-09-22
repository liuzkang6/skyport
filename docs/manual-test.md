# skyport 手动验证清单（v0.3.x 网关完工线·当前进度）

> 给人的验证步骤。按顺序跑，每步写明预期。当前版本包含：工程化小批、审计链、高危护栏、CMDB v2、保险箱。
> 凭证三层 / REST API / MCP 适配器尚未实现，待后续版本。

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
# 记下输出的 skr_ 令牌
skyport agent login --refresh-token-file <(echo 'skr_...')
# 输出 sks_ 会话令牌（30 分钟有效）
skyport agent rotate cred-test
# 输出新的 skr_，旧的立即失效
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

curl http://127.0.0.1:7100/api/v1/assets
# 预期：403（无令牌）
```

## 11. MCP 适配器

```bash
skyport mcp  # stdio 模式启动
# 在另一个终端发 JSON-RPC：
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | skyport mcp
# 预期：返回 serverInfo
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | skyport mcp
# 预期：返回 7 个工具
```

## 尚未实现（v0.4+ 待后续版本）

- [x] 凭证三层（刷新令牌 + 会话令牌 + 轮换）
- [x] REST API v1（serve 进程 + 核心端点 + Bearer 认证）
- [x] MCP 适配器（7 工具/JSON-RPC stdio）
- [x] 执行异步化（approveAsync + webhook 回推）
- [x] 云 CLI 可操作（cloud-account → CLI 通道）
- [ ] 节点 agent（Go）
- [ ] 告警总线（Alerta 模型 + Zabbix/Prometheus 适配器）
- [ ] 基线三相训练 + 态势包
- [ ] 资产执行互斥 + 事件认领
- [ ] Break-glass 兜底
- [ ] 运行时认证（ZCode fork 集成 + 四角色）
- [ ] 编排引擎（vendor 工作流引擎 + L3 剧本）
- [ ] Web UI
