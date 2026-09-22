# 参考项目内化清单（业务闭环的器官供体）

> 调研日期：2026-09-22。定位结论：以下项目分别实现了 skyport 业务闭环的某个器官，
> **没有一个具备治理脊椎（审批门/凭证租约/审计链/风险分级）**——那是 skyport 的独有定位。
> 本文记录每个项目"抄什么、抄到哪"，对应闭环编号见 PRD v3 业务闭环图。

## Keep（keephq/keep，★12.3k，Python）

AIOps 与告警管理平台，"监控界的 GitHub Actions"。

**内化 → ②归并 + L3 自动化配方**
- 声明式 YAML workflow 三段式：`triggers`（alert/incident/schedule/manual + filters）→ `steps`（取数/enrichment）→ `actions`（执行操作）
- 双轨制决策：**确定性自动化**（路由/通知/工单/enrichment）用 Keep 式 YAML 壳；**智能处置**用 SKILL.md 技能内核。L3 剧本 = YAML 编排壳 + 技能内核
- AI 做告警关联与 enrichment 的后端抽象

## Alerta（alerta/alerta，★2.5k，Python 9.x）

老牌分布式告警聚合控制台，三十年最佳实践沉淀。

**内化 → ②归并（告警数据模型直接沿用，不自己发明）**
- 告警字段：event / resource / severity（critical/warning/info...）/ value / text / tags / attributes / correlate
- 去重键（dedup）与关联键（correlate）分离；severity 变化产生历史而非覆盖
- 生命周期：open → ack → close，ack 是人已知的凭证
- 我们在其上叠加：证据链（告警→诊断→审批→执行全链可溯）

## versus-incident（VersusControl/versus-incident，★779，Go）

自托管 AI SRE agent + 事件多渠道分发。

**内化 → ②③（三件宝）**
- **三相模式**：`training`（只看不报）→ `shadow`（记"本应告警"日志，不真报）→ `detect`（真创建事件）——L3 自动化的毕业机制升级为同样的三相：训练 → 影子（记"本应执行"不真执行）→ 检测（真跑）
- **ACK SLA 升级链**：事件 N 分钟未确认 → 自动升级渠道/上报 on-call
- 模板化多渠道分发（Go 模板 + YAML 配置）；webhook 收任意来源（Alertmanager/Grafana/Sentry/SNS）

## k8sgpt（k8sgpt-ai/k8sgpt，★8.2k，Go）

K8s AI 诊断，CNCF 生态。

**内化 → ③诊断（分析器注册表模式）**
- 诊断分两层：**确定性 analyzer 先跑**（podAnalyzer/pvcAnalyzer/serviceAnalyzer 等内置注册表，可启停、可自定义）——免费、可靠、无幻觉；LLM 只负责解释结论与深入排查
- 我们的诊断技能格式增加 analyzer 层：每类资产（host/cluster/cloud）配内置 analyzer 集，AI 诊断前先跑匹配的 analyzer

## HolmesGPT（HolmesGPT/holmesgpt，★3.4k，CNCF 沙箱）

生产事故调查 agent（Robusta 创立，微软参与贡献）。

**内化 → ③诊断（agentic loop + 上下文预算工程）**
- Operator mode：后台 24/7 巡检 + 主动 Slack 上报——与我们"节点 agent 定时巡检 + 告警总线"同构，验证方向
- **上下文预算工程**（比我们的 100KB 截断精细一档）：server-side 过滤、JSON 树遍历、工具输出转换器防大载荷进上下文；per-tool 内存上限、大结果流式落盘、输出预算化防 OOM——进诊断工具集设计
- 双向告警集成（从 AlertManager/PagerDuty 拉告警 + 回写调查结论）

## OpenSRE（Tracer-Cloud/opensre，★11.2k，Apache-2.0，public alpha）

"构建你自己的 AI SRE agent"开源框架：60+ 工具集成 + 自定义工作流 + **训练与评估环境**。

**内化 → 运行时座位制（观察名单）**
- 专用 SRE agent 框架，可能比改造 coding agent（ZCode/Codex）更合身
- 其"训练/评估环境"概念强化我们的运行时认证套件设计（认证 = 跑通评估环境）
- 状态 public alpha：入观察名单，稳定后作为第三个认证运行时评估（与 dsh 同档）

## Plane（makeplane/plane，★59.8k，TypeScript）

开源 Jira/Linear/Monday 替代。

**内化 → WebUI（看板直接参照）**
- issue 数据模型（states/labels/priorities/cycles/modules）与看板交互模式作为 skyport 行动看板的参照
- 差异保留：我们的看板列由治理状态机固定（pending→approved→executing→success/failed/rejected/cancelled），拖拽语义 = 状态迁移受状态机约束（不是自由排序）
