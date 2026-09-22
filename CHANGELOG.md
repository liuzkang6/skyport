# Changelog

## v0.2.0（2026-09-22）

MVP 全量交付 + 两轮红队对抗修复 + 工程化收尾。

### 治理核心
- 资产台账（登记/导入/检查/看板）与 SQLite 存储底座（顺序迁移，当前 v3）
- Agent 身份与权限三件套（风险上限 × 资产范围 × 动作范围），key 只显一次、库中仅存哈希
- 风险分级引擎：分段 token 解析 + 旗标集合语义 + 跳板二级目标校验；策略文件只信 `~/.skyport`
- 审批闭环：人工 approve/reject/cancel（原子状态迁移）、人直通 run、AI 一站式 agent run
- 审计：行动事件流 + 执行明细（总耗时/尝试次数/截断标志）

### 红队两轮修复（28 项全闭环）
- P0：拆掉"cwd 策略 + 引号变形 + autoExec"零审批直通链；风险引擎按 token 结构重写
- P1/P2：DB chmod 副作用、webhook 凭据遮蔽、失败退出码 4、超时默认不重试、审批 TOCTOU、`--api-key-file`、错误中文化
- P3：值守体验（就地审批/理由/发起者名字/过滤分页/等待提示）
- 第二轮新发现：`--json` 管道 64KiB 截断（exitCode 自然退出）、SSH 远程引号语义变形（原样传串）

### 工程化
- CI（GitHub Actions：verify 矩阵 node 20/22 + node18 版本守卫冒烟）
- 构建产物化（esbuild 单文件 dist，`skyport` 命令启动 ~0.2s）
- `skyport backup`（SQLite 在线备份 + 保留策略清理）
- 测试 119 条；退出码契约 0-11 按错误域

## v0.1.0（2026-09-22）

初始骨架：AGENTS/PRD/DESIGN 规范体系、分层架构（executor/adapters/services/cli）、
严格模式 TS + oxlint + vitest 门禁。
