# PRD — skyport（一页纸）

> 需求活文档：需求变更时先增量更新本文件对应章节，再动 spec 与代码（AGENTS.md §1）。

## 1. 解决什么问题

skyport 是类 Linear 的 AI 运维行动与治理平台：把 AI 发起的每一次运维动作统一纳入"登记—审批—执行—审计"闭环，让"AI 做运维"这件事本身可管控、可追溯、可追责。

## 2. MVP 做什么

**治理核心**

1. **行动（Action）登记**：把一次 AI 运维动作（命令/脚本）登记为行动单，含意图说明、风险等级与状态机（pending → approved / rejected → executing → success / failed / cancelled）。
2. **风险分级与审批门禁**：规则引擎 = 内置默认规则 ∪ 项目策略文件（skyport.policy.json）；AI 自报风险只升不降；低危白名单可自动放行；人工 `approve` / `reject` 两段式放行。
3. **受控执行**：行动经统一执行器运行（超时/退避重试/输出截断/退出码归一化）；执行目标可以是本机或已登记资产（SSH 复用本机凭据，不存密码）。
4. **审计与查询**：行动与执行全留痕，actor 区分 human / agent，支持按行动单查询历史。

**资产与身份**

5. **资产清单**：机器 / 集群 / 云账户的登记（`asset add`）、批量导入、`skyport list` 看板、`show` 下钻、TCP 连通性检查；行动单的 `target` 引用资产 ID——资产是权限范围的锚点。
6. **Agent 身份与权限**：签发 key（只显示一次、库中仅存哈希）；三态 active / paused / revoked；权限三件套 = 动作范围 × 资产范围（通配）× 风险上限，超限行动在门口拒绝。

**可用性粘合**

7. **通知与看板**：pending 行动产生时发通用 webhook（出站 JSON，不做平台特定集成）；`watch` 前台提醒；list 交互式选择。
8. **直通与一站式**：`skyport run`（人自用，免审批但留痕）；`skyport agent run`（创建 → 等审批 → 取最终结果，AI 免轮询）；`skyport init` 初始化引导。

**里程碑**：M1 数据底座与资产台账（SQLite + 迁移 + 资产 CRUD / 检查 / init）→ M2 治理闭环（agent 权限 + 行动 + 审批 + 本机/SSH 受控执行 + run / agent run）→ M3 体验与运营（webhook / watch / 交互选择 / pause-revoke / 批量审批）。

## 3. 明确不做什么（MVP 阶段）

- 不做 Web UI 与多人 RBAC（多人 = v2 server 模式：SSO/OIDC + admin/approver/viewer；MVP 信任模型为"OS 会话 + 文件权限"——数据目录 0700、库文件 0600，审计记录 OS 用户名与 actor 类型）
- 不做节点 agent 反向连接（v2 特性，connect_mode 字段已预留；MVP 用 SSH agentless，凭据复用本机 `~/.ssh` 配置）
- 不做云资产自动发现（AWS/阿里云/K8s 同步；MVP 为手动登记 + JSON 导入）
- 不做 AI Agent 本身：skyport 管控 AI 的运维动作，不实现大模型调度与推理
- 不做分布式 / 多节点并行执行、定时任务、实时监控与告警
- 不做凭据保险箱（不存 SSH 私钥 / 云密码；agent key 是自签发身份凭证，仅存哈希）
- 不做 IM 平台特定集成（仅通用 webhook 出站通知）

## 4. 技术选型

TypeScript + pnpm + Node.js（≥ 20）；CLI 形态（commander 解析参数，zod 做运行时校验，vitest 单元测试）；存储 better-sqlite3（WAL，默认 `~/.skyport/skyport.db`，`SKYPORT_DB_PATH` 可覆盖，顺序迁移机制）；配置统一前缀 skyport_，优先级：项目配置 > 环境变量 > 默认值。
