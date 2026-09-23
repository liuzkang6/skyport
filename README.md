# skyport

类 Linear 的 AI 运维行动与治理平台（CLI 形态）：把 AI 发起的每一次运维动作纳入"登记—审批—执行—审计"闭环。
当前仓库为工程骨架，业务功能按 spec 逐步交付（路线见 PRD.md）。

## 环境要求

- Node.js ≥ 20
- pnpm ≥ 9

## 快速开始

```bash
pnpm install
pnpm dev init      # 初始化数据目录与数据库（~/.skyport/skyport.db）
pnpm dev doctor    # 环境自检（运行时 / 配置 / 数据库）
pnpm dev asset add --name web-01 --type host --addr 10.0.1.11 --label env=prod
pnpm dev list      # 资产清单
pnpm dev asset check web-01   # TCP 连通性检查
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | TypeScript 类型检查（tsc --noEmit，严格模式三开关全开） |
| `pnpm lint` | oxlint 静态检查 |
| `pnpm arch:check` | 架构门禁：services 禁直连 fs/child_process/env、adapters 禁反向依赖、exit 只在 CLI 入口（AGENTS §4 的机器强制） |
| `pnpm arch:context <路径>` | 模块阅读包：文件/行数/依赖/反向依赖/违规清单（改不熟悉的模块前先看） |
| `pnpm test` | vitest 单元测试 |
| `pnpm build` | esbuild 打包单文件产物 `dist/cli/index.mjs`（bin 入口优先使用产物，启动 ~0.2s） |
| `pnpm verify` | 组合门禁：typecheck + lint + arch:check + test + build |
| `pnpm coverage` | 测试覆盖率报告 |
| `pnpm dev` | 以 tsx 直接运行 CLI（如 `pnpm dev doctor`） |

部署：克隆后 `pnpm install && pnpm build`，把 `bin/skyport.mjs` 软链或包装到 PATH（内含 node≥20 版本守卫，优先走 dist 产物）。CI（`.github/workflows/ci.yml`）在 node 20/22 矩阵跑 verify，并冒烟 node18 下的人话报错。数据备份：`skyport backup`（默认 `~/.skyport/backups`，保留份数 `SKYPORT_BACKUP_KEEP` 可配，自定义目录不动权限）。

CLI 子命令（`skyport <命令>`）：`init`、`list`（资产清单，`--select` 交互下钻）、`asset add / import / list / show / check / remove`、`agent create / list / show / pause / activate / revoke / run`（AI 一站式，key 可用 `--api-key-file` 读文件）、`action create / list / show`（台账支持 `--status/--agent/--target/--since/--limit/--offset` 过滤分页）、`approve <id...> / reject <id...>`（可批量）、`cancel`、`run`（人自用直通）、`watch`（前台值守，终端内可就地 y/n 审批，`--once` 单次巡检）、`user add / list`（Web 用户与角色四分）、`serve`、`config`、`doctor`。查询类命令带 `--json` 输出机器可读格式。

## WebUI（v0.7 第一刀，spec/webui）

浏览器治理入口：登录会话 + 角色四分 + 行动看板（列=治理状态机）+ 就地审批。

```bash
# 1) 建首个管理员（密码经 TTY 两次输入；脚本用 SKYPORT_USER_PASSWORD）
skyport user add ops-admin --role admin
# 2) 构建 WebUI 并启动服务（默认 127.0.0.1:7100，静态托管 webui/dist）
cd webui && pnpm install && pnpm build && cd .. && skyport serve
```

浏览器打开 `http://127.0.0.1:7100/`：登录 → 看板七列（待审批/已放行/执行中/成功/失败/已否决/已取消）；
approver/admin 可把"待审批"卡拖到"已放行/已否决"列或点开抽屉就地审批（拖到其他列会被状态机拒绝并回弹）。
角色四分 viewer⊂operator⊂approver⊂admin：viewer 只读，operator 可创建行动，approver 可审批与告警处置，admin 另管用户。
认证双轨：浏览器走会话 cookie（`skw_`，HttpOnly/SameSite=Strict，12h 有效/2h 闲置作废，失败 5 次锁 5 分钟）；
API 消费方继续用 Bearer（sks_/skp_）。WebUI 代码在 `webui/`（独立 npm 项目），门禁 `cd webui && pnpm verify`；
UI 只经 `/api/v1` 访问（AGENTS.md §10 分层铁律）。

治理速览：AI 以 `--api-key`（或 `SKYPORT_API_KEY` / `--api-key-file`）发起行动 → 风险分级（低危且策略允许可自动执行；AI 自报风险只升不降）→ 中高危进 pending 等人（可配 `SKYPORT_NOTIFY_WEBHOOK_URL` 推送——载荷自动遮蔽命令中的密码/token；或 `skyport watch` 前台值守）→ `skyport approve <id>` 放行即执行 → 全程事件与执行留痕。执行契约：**超时默认不重试**（幂等命令可显式开 retryOnTimeout）、executions 如实记录总耗时/尝试次数/截断标志；**行动执行失败 CLI 退出码 4**，批量操作保留真实域码。风险策略放 **`~/.skyport/skyport.policy.json`**（数据目录 0700，**不从 cwd 读取**；`SKYPORT_POLICY_PATH` 可显式指定）；`autoExecLowRisk` 默认关闭，开启后 doctor/config 会警示，且组合命令与命令替换永远不享受自动执行。报错默认只出中文人话（`SKYPORT_VERBOSE_ERRORS=true` 显示底层技术细节）。

执行语义：**本地**命令切参数数组直 exec（不经 shell）；**SSH 远程**把命令字符串**原样**交给远端 shell 解释——审批人看到的即远端实际执行的（含引号/重定向/管道语义）；外层 ssh 固定 `BatchMode=yes`，命令内嵌 ssh 跳板时建议自行加 `-o BatchMode=yes` 防交互挂死。

退出码约定：0 成功；1 未知错误；2 用法错误（含 node 版本过低）；3-7 config/exec/fs/network/permission 域；8 db；9 asset；10 agent；11 action。行动执行失败统一按 4。

## 配置

- 环境变量前缀：`SKYPORT_`（如 `SKYPORT_LOG_LEVEL=debug`）
- 优先级：项目配置 `skyport.config.json` > 环境变量 > 默认值
- 可配置项：`logLevel` / `logFile` / `execTimeoutMs` / `execMaxRetries` / `execMaxOutputBytes` / `execBackoffBaseMs` / `dbPath` / `checkTimeoutMs` / `apiKey` / `notifyWebhookUrl`（执行默认：超时 10s、重试 3 次、输出截断 100KB；检查超时默认 5s）
- 存储：SQLite（better-sqlite3，WAL），默认 `~/.skyport/skyport.db`（目录 0700 / 文件 0600），`SKYPORT_DB_PATH` 可覆盖；打开即自动迁移
- 默认值集中在 `src/config/config.ts` 的 schema 中，业务代码禁止硬编码

## 架构分层

见 AGENTS.md 附：文件地图。要点：外部 I/O 收敛——命令执行走 `src/executor/`，文件/网络/TCP 探测/数据库走 `src/adapters/`，环境变量与项目配置走 `src/config/`；错误码集中在 `src/errors/errors.ts`（按域分组）；`src/cli/index.ts` 是全局唯一 catch 处，统一格式化错误并决定退出码。

## 开发规范

- 开工前通读 AGENTS.md → PRD.md → 相关 spec →（改 UI 时）DESIGN.md
- 提交前必须跑 `pnpm verify`，并在自测报告里如实记录结果（AGENTS.md §5 / §8）
- 提交信息前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`，一个功能一个独立 commit

## Git 钩子

仓库自带 `.githooks/pre-push`（推送前自动跑 `pnpm verify`）。克隆后执行一次：

```bash
git config core.hooksPath .githooks
```
