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
| `pnpm test` | vitest 单元测试 |
| `pnpm verify` | 组合门禁：typecheck + lint + test |
| `pnpm dev` | 以 tsx 直接运行 CLI（如 `pnpm dev doctor`） |

CLI 子命令（`skyport <命令>`）：`init`（初始化）、`list`（资产清单，= `asset list`）、`asset add / import / list / show / check / remove`、`config`（打印生效配置）、`doctor`（自检）。查询类命令带 `--json` 可输出机器可读格式（供 AI 解析）。

退出码约定：0 成功；1 未知错误；2 用法错误；3-7 config/exec/fs/network/permission 域；8 db 域；9 asset 域。

## 配置

- 环境变量前缀：`SKYPORT_`（如 `SKYPORT_LOG_LEVEL=debug`）
- 优先级：项目配置 `skyport.config.json` > 环境变量 > 默认值
- 可配置项：`logLevel` / `logFile` / `execTimeoutMs` / `execMaxRetries` / `execMaxOutputBytes` / `execBackoffBaseMs` / `dbPath` / `checkTimeoutMs`（执行默认：超时 10s、重试 3 次、输出截断 100KB；检查超时默认 5s）
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
