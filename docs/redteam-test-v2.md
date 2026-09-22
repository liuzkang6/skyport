# skyport 红队测试计划 v2（v0.3.x 网关完工线·当前进度）

> 基于 v1（docs/redteam-test-plan.md）更新，聚焦新增攻击面。
> 当前版本新增：审计链防篡改、高危护栏、CMDB 拓扑、凭证保险箱。

## 新增攻击面

### H1. 审计链防篡改

| ID | 步骤 | 预期 |
| --- | --- | --- |
| H1a | `skyport audit verify`（正常使用后） | 输出链完整 |
| H1b | `sqlite3 ~/.skyport/skyport.db "DELETE FROM action_events WHERE rowid = 1"` 然后 `audit verify` | 报断链，exit 1 |
| H1c | `sqlite3 ~/.skyport/skyport.db "UPDATE action_events SET detail = '{\"injected\":1}' WHERE rowid = 1"` 然后 `audit verify` | 报 hash 不匹配 |
| H1d | `sqlite3 ~/.skyport/skyport.db "UPDATE executions SET stdout = 'fake' WHERE rowid = 1"` 然后 `audit verify` | 报断链 |

### H2. 高危护栏

| ID | 步骤 | 预期 |
| --- | --- | --- |
| H2a | `action create --exec 'shutdown now'`（无 --rollback） | 拒绝，ACTION_INVALID |
| H2b | `action create --exec 'shutdown now' --rollback 'x' --dry-run` | 评级 high，不落库 |
| H2c | `action create --exec 'printf x'`（low，无需 rollback） | 正常 pending |
| H2d | 改库让 pending 行动 created_at 超 24h，然后 approve | 报过期拒绝 |

### H3. 凭证保险箱

| ID | 步骤 | 预期 |
| --- | --- | --- |
| H3a | `sqlite3 ~/.skyport/skyport.db "SELECT encrypted_value FROM secrets"` | 不含明文 |
| H3b | `cat ~/.skyport/vault.key` 权限 | 0600 |
| H3c | 删除 vault.key 后 `secret get <name>` | 解密失败（密钥不匹配） |
| H3d | `action create --exec '{{secret:nonexistent}}'` | 报 ASSET_NOT_FOUND |
| H3e | `listSecrets()` 返回的 JSON | 不含 value 字段 |

### H4. CMDB 拓扑注入

| ID | 步骤 | 预期 |
| --- | --- | --- |
| H4a | `service dep add svc-a svc-a`（自依赖） | 拒绝 |
| H4b | `getBlastRadius` 对不存在资产 | 报 ASSET_NOT_FOUND |
| H4c | 循环依赖 A→B→A 后查询爆炸半径 | 不死循环（递归有深度限制或拓扑无环） |

### H5. 进程树击杀

| ID | 步骤 | 预期 |
| --- | --- | --- |
| H5a | 超时命令 spawn 孙进程，超时后 `ps aux` | 孙进程也被杀 |
| H5b | 正常完成的命令不触发杀树 | 仅超时触发 |

## 保留的回归基线

第一轮报告（docs/redteam-qa-report.md）第二节全部通过项 + 7.1 修复确认表 + 7.3 N1/N2 修复——全部应保持通过。

### H6. 凭证三层

| ID | 步骤 | 预期 |
| --- | --- | --- |
| H6a | `agent login` 用无效 skr_ | PERMISSION_DENIED |
| H6b | sks_ 过期后调用 | PERMISSION_DENIED |
| H6c | 轮换后旧 skr_ login | PERMISSION_DENIED |
| H6d | sks_ 闲置超 15 分钟后调用 | 自动吊销 + PERMISSION_DENIED |
| H6e | agent revoked 后 sks_ 调用 | PERMISSION_DENIED |
| H6f | REST API 无 Bearer 令牌 | 403 |
| H6g | REST API 伪造 Bearer 令牌 | 403 |

## 已知残留（红队重点方向）

1. **vault.key 是单点**——密钥文件泄漏=所有 secret 泄漏；当前信任模型=文件 0600 + 本机 root 边界
2. **审计链可整体重算**——root 可以删全库重建链（防整体重算需外部锚点，如定期推哈希到不可变存储）
3. **pending 过期依赖时钟**——直改系统时间可绕过 24h 过期
4. **保险箱注入仅覆盖 executor env 路径**——命令文本中的 `{{secret:}}` 引用尚需在 executor spawn 前解析（当前 resolveSecretRefs 已实现但未接入 executor 主路径）
5. **拓扑循环**——CMDB 依赖边未做环检测（当前 getBlastRadius 只查一跳，多跳传播待实现）

## 判定标准

- **高危发现** = 绕过审计链 / 绕过高危护栏 / 从保险箱提取明文 / 进程树击杀失效
- **中危发现** = 拓扑注入 / CMDB 环导致死循环 / pending 过期绕过
- **低危发现** = 信息泄露 / 错误信息不友好

5. **凭证三层残留**——文件锁尚未实现（并发 login 场景）；复用检测（旧 skr_ 再出示→自动吊销 agent）逻辑在 spec 中但未实现
6. **REST API 残留**——仅 GET 端点，无 POST（创建行动需走 CLI）；无速率限制
