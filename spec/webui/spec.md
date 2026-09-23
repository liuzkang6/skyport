# spec — WebUI 第一刀（v0.7 拉前）：登录+角色四分+行动看板+审批

状态：开发中 · 驱动：PRD §2（⑦ WebUI）、§3 v0.7、§6 决策「WebUI 提前启动」
范围说明：v0.7 全量（Agent 操作台/保险箱界面/模型配置中心/交接班/月报/用量看板/插件页/SSE）分切片后续交付；
本 spec 只定义第一刀：**登录会话 + 角色四分 + 行动看板 + 就地审批**。

## 产品规则

### 用户与角色四分（PRD §2 多人协作）
- 角色四级：`viewer`（只读）/ `operator`（读+创建行动）/ `approver`（+审批+告警处置）/ `admin`（+用户与 agent 管理）。
  能力集严格递增：viewer ⊂ operator ⊂ approver ⊂ admin。
- 用户由 admin 通过 CLI `skyport user add` 创建（首个用户离线引导，见 CLI 节）；密码哈希 scrypt（N=16384），
  库中只存 `salt + hash`，禁止明文/日志/审计出现密码。
- 用户名规则：`^[a-z0-9][a-z0-9-_]{1,31}$`；禁止与现有用户重名（USER_DUPLICATE_NAME）。

### 登录与会话（Web 会话，与 agent 会话分离）
- 登录：`POST /api/v1/auth/login {username, password}` → 签发 Web 会话令牌 `skw_`（256 位随机，库中 SHA-256）。
- 会话经 `Set-Cookie: skyport_session=skw_...; HttpOnly; SameSite=Strict; Path=/`（本地 HTTP 不加 Secure；
  cookie 有效期 12h，闲置 2h 作废——值守场景允许长班次，闲置兜底防挂机）。
- 登出：`POST /api/v1/auth/logout` → 吊销当前会话 + 清 cookie。
- 登录失败统一报错文案（不区分"用户不存在/密码错误"，防枚举）；连续失败 5 次锁 5 分钟（per-username）。
- Bearer 认证（sks_/skp_）与 Web 会话并行：API 消费方继续用 Bearer，浏览器用 cookie。

### 行动看板（列=治理状态机）
- 七列固定顺序：`pending ○ 待审批 / approved ◐ 已放行 / executing ⟳ 执行中 / success ● 成功 /
  failed ✕ 失败 / rejected ⊘ 已否决 / cancelled – 已取消`（与 CLI render 符号一一对应）。
- 卡片要素（审批决策一眼可读，对齐红队 U1/U2/U3 修复后的 CLI 值守行）：风险徽章（颜色+文字双编码）、
  发起者（agent 名字）、目标资产、命令（font-mono，超长截断必须带"详情看全文"入口）、创建时间。
- 拖拽 = 受约束迁移（PRD）：pending→approved 仅经"批准"动作（拖到 approved 列等价点批准，approver 校验）；
  pending→rejected 仅经"否决"；其余列**不可拖入**（非法落点回弹并提示状态机约束）。这是治理约束，不是排序自由度。
- 审批操作仅 `approver`/`admin` 可见可用；viewer/operator 看板只读。
- 刷新：本刀用 8s 轮询（页面可见时）；SSE 事件流属后续切片。

### 就地审批（详情抽屉）
- 点卡片开右侧抽屉：命令全文、理由、回滚声明、执行结果/事件流。
- 抽屉内批准/否决按钮（否决可填 note）；结果回写看板卡片状态（受约束迁移，不整页刷新）。

## 状态所有者与事件顺序（登录-审批主链路）

```
浏览器                serve(REST)              users 服务            actions 服务
  │ POST /auth/login    │                        │                    │
  │────────────────────>│ verifyLogin(u,p)       │                    │
  │                     │───────────────────────>│ scrypt 校验+锁定检查 │
  │                     │<───User{id,role}───────│                    │
  │                     │ issueWebSession→skw_   │                    │
  │<──Set-Cookie + me───│                        │                    │
  │ GET /actions        │ (cookie→verifyWebSession，闲置滚动更新)        │
  │────────────────────>│ listActions─────────────────────────────────>│
  │ POST /actions/:id/approve (approver)          │                    │
  │────────────────────>│ requireRole(approver) │                    │
  │                     │ approveAction(id, actor=human:user)────────>│
  │                     │                         │   状态机 pending→approved（原子）
  │<──200 Action────────│                         │                    │
```
- 会话状态唯一所有者 = `web_sessions` 表（users 服务单写）；行动状态唯一所有者 = 行动状态机（actions 服务），
  serve 只做鉴权与翻译，不缓存行动状态。
- 令牌竞争：浏览器多标签页共享同一 cookie 会话，`last_used_at` 单写路径滚动更新（SQL 原子 UPDATE）。

## 接口

### REST（新增）
| 端点 | 方法 | 角色 | 说明 |
| --- | --- | --- | --- |
| `/api/v1/auth/login` | POST | 公开 | `{username,password}` → 200 `{user}`+Set-Cookie；失败 401 统一文案 |
| `/api/v1/auth/logout` | POST | 任一会话 | 吊销会话+清 cookie |
| `/api/v1/auth/me` | GET | 任一会话 | `{user:{id,name,role}}`（未登录 401） |
| `/api/v1/users` | GET | admin | 用户清单（无哈希无盐） |
| `/api/v1/actions/{id}/approve` | POST | approver+ | 委托 approveAction |
| `/api/v1/actions/{id}/reject` | POST | approver+ | `{note?}` 委托 rejectAction |

- 既有 GET 端点对四个角色全量开放（viewer 起步）；告警 ack/close、POST /alerts 维持现状（Bearer），
  cookie 会话下告警写操作需 approver+（第一刀收紧为 approver+）。
- serve 静态托管 `webui/dist/`（存在才启用）：非 `/api` 路径 fallback `index.html`（SPA）；不存在时行为与现在一致。

### CLI（新增）
| 命令 | 说明 |
| --- | --- |
| `skyport user add <名> [--role viewer|operator|approver|admin]` | 创建用户；密码经 stdin 安全提示输入两次（TTY）或 `SKYPORT_USER_PASSWORD` 环境变量（脚本用） |
| `skyport user list` | 清单（admin 语义；本地 OS 用户即运维面，不做服务端校验） |

### WebUI 应用（`webui/`，独立 npm 项目）
- 栈：Vite + React 18 + TypeScript + Tailwind v4 + Zustand；构建产物 `webui/dist/` 由 serve 托管。
- 分层铁律（AGENTS.md §10）：UI 只经 `/api/v1` 访问；禁止 import services/adapters/executor、禁止直连 SQLite。
- 导航（PRD 拍板命名）：动态（看板，本刀落地）/ 收件箱 / 审批 / 我的 / 事件 / 资产 / 知识库 / 审计 / 设置——
  本刀只落地"动态（看板）"，其余入口置灰占位（禁用项保留布局仅降文本色，DESIGN.md §5）。
- 路由：`/login` 与 `/`（看板）；未认证访问 `/` 重定向 `/login`。

## 验收场景
1. `user add admin` 后浏览器登录 → 看 board（七列）；未登录访问 `/` 跳 `/login`。
2. approver 拖 pending 卡到 approved 列（或抽屉点批准）→ 卡片迁列、状态机事件 +1、审计链 +1。
3. 拖 pending 卡到 success 列 → 回弹 + 状态机约束提示（受约束迁移）。
4. viewer 登录 → 看板只读，无批准/否决控件；直接调 approve API → 403。
5. 密码错 5 次 → 第 6 次即使密码正确也 429（锁定 5 分钟）。
6. 登出后 cookie 失效，原会话调 API → 401。
7. 亮暗双主题切换，状态颜色+文字双编码在两主题下均可读。

## 失败路径
- 登录：用户不存在/密码错 → 401 统一文案；锁定中 → 429（带 Retry-After）；禁用用户 → 403。
- 会话：cookie 无效/过期/闲置超时 → 401，前端统一跳登录页（不弹错误风暴）。
- 审批：非 approver → 403；行动不存在 → 404；状态不合法（如 approve 已 success）→ 409（状态机拒绝）。
- 用户创建：重名 → 409；非法用户名/角色 → 400；弱密码（<8 字符）→ 400。
- webui/dist 不存在：serve 正常提供 API（静态托管静默跳过）；SPA fallback 只对非 /api 路径。
- 前端断网/后端不可达：请求失败显示可重试错误条，不白屏；轮询失败退避（8s→30s）。

## 明确不做（本刀）
- SSE/WebSocket 实时推送（下一刀）；用户管理界面（CLI 管）；模型配置中心/保险箱界面/交接班/月报/用量看板/插件页；
- 拖拽以外的批量审批；多因子认证；HTTPS 终止（部署层负责）；注册自助（管理员制）。
