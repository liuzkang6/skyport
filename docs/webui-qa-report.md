# skyport WebUI QA 诊断报告

> 检查对象：`http://127.0.0.1:7100`（serve 构建产物，webui/dist 构建于 2026-09-23 09:58，与源码同步）
> 检查日期：2026-09-23
> 检查方式：webui 源码全量走查（约 2800 行）+ 后端 `src/cli/serve.ts` 路由层核对 + 37 组 HTTP 黑盒实测（真实登录、审批、并发、边界、角色门禁）。
> **限制**：本机无可用浏览器，页面实际渲染（明暗主题、间距、布局）未能截图验证，视觉类结论来自源码与构建产物 CSS 核对，已逐条标注。

---

## 一、总览

整体评价：**后端 API 层质量明显高于前端**。状态机并发一致性好（并发双批准一个 200 一个 409）、错误文案全是中文人话、登录锁定有 Retry-After、命令长度有校验（1-2000）、React 转义无 XSS 问题。前端的主要问题集中在：**两个功能是"假的"或"坏的"（保险箱、我的页）**、**数据静默截断（审计页）**、**一个安全洞（SSE 无鉴权）**、**一半页面绕过了全局 401 处理和 API 分层**。

最该先处理：#1（保险箱假保存，会骗用户）、#2（我的页永远为空）、#3（审计页静默丢 63% 数据）、#4（SSE 泄漏，绑定 0.0.0.0）。

**做得好的地方**（供参考，不用改）：

- 并发双击批准被状态机正确挡住（一个 200，一个 409，无竞态副作用）
- 命令超长（>2000）/空白有明确报错文案
- 登录锁定机制：5 次错密即 429 + Retry-After: 300
- 告警 ack→close 生命周期完整
- viewer 的每个 403 都带"需要什么权限"的人话说明

---

## 二、问题清单（按严重度排序）

### 阻断

无（没有发现白屏/崩溃级问题，ErrorBoundary 兜底也在）。

---

### 严重

**编号：#1**
**严重度**：严重
**位置**：设置页 → 保险箱 tab；`webui/src/pages/SettingsPage.tsx:24`（secrets 永远是空数组）、`SettingsPage.tsx:211-219`（假保存按钮）
**现象**："添加 Secret"点保存后提示"已保存 xxx（值加密存储，只显示尾4位）"，但**没有任何 API 调用**，纯前端 setState。后端根本不存在 secrets 的 REST 端点（serve.ts 全文无 `/api/v1/secrets`）。同时 secret 列表表格永远渲染不出数据——DB 里实际有 3 条 secret（`model:deepseek-v4-flash` 等），UI 永远显示"暂无 secret"。UI 提示的"只显示尾4位"（hint 列）也永远不会有内容。
**复现**：1. 登录 approver → 设置 → 保险箱；2. 输入名称/值点"保存"；3. 出现"已保存"提示，刷新页面列表仍为空，命令里引用 `{{secret:该名称}}` 也不存在。
**期望**：要么接真接口（GET/POST secrets），要么把 tab 标成"只读视图/未实现"，禁止假成功提示。
**改进方向**：后端补 secrets 只读+写入端点，或前端先下线保存按钮、明确标注"经 CLI 管理"。

---

**编号：#2**
**严重度**：严重
**位置**：我的页；`webui/src/pages/MinePage.tsx:30`（传 `user.name`）+ `src/services/action-queries.ts:68-81`（actor 过滤实现）
**现象**："我的"页对所有 Web 用户**永远显示 0 条**。human 行动的 `actor_id` 存的是用户 ID（如 `usr_d10cafc42f45`），MinePage 却传用户名（`qa-approver`）去匹配 `actor_id`；SQL 里只对 agent 名做了名字→ID 解析，human 用户名没有解析直接匹配，永远查不到。已实测：qa-approver 名下有 2 条行动（DB 按 `usr_d10cafc42f45` 查得到），`?actor=qa-approver` 返回 0。
**复现**：1. 用任意 Web 账号经 REST 创建一条行动（成功入库）；2. 打开"我的"页；3. 显示"还没有创建过行动"。
**期望**：显示当前用户创建的行动。
**改进方向**：在 actor 过滤里给 human 加用户名→用户 ID 的解析（对称于 agent 的处理），或 MinePage 改传 user.id。

---

**编号：#3**
**严重度**：严重
**位置**：审计页 + 看板；`webui/src/pages/AuditPage.tsx:28`（请求不带 limit）+ `src/cli/serve.ts:455`（默认 limit=50）+ `webui/src/store/app.ts:58`（看板 limit=200）；`hasMore` 字段全站无人消费
**现象**：审计页标题是"全量行动台账"，实际只显示**最近 50 条**且无分页、无任何"还有更多"提示。当前库里有 222 条行动，142 条（63%）在审计页永远看不到，状态过滤也在截断后的子集里做。看板同理：limit=200，hasMore=true 时静默丢弃。
**复现**：1. `curl /api/v1/actions`（认证后）返回 50 条、`hasMore:true`（库里 222 条）；2. 打开审计页数行数 = 50。
**期望**：审计页分页或至少显示"共 N 条，显示最近 50"；hasMore 被消费。
**改进方向**：审计页加分页/滚动加载（offset 参数后端已支持），看板加"仅显示最近 200 条"提示。

---

**编号：#4**
**严重度**：严重（安全）
**位置**：`src/cli/serve.ts:366-382`（SSE 端点在 `requireAuth` 之前且自身不校验凭证）+ 启动参数 `--host 0.0.0.0`
**现象**：`GET /api/v1/events/stream` 无需登录即可订阅。已实测：未认证 curl 挂上后，能实时收到 `action-created`（含行动 ID、操作者用户 ID）、`alerts-ingested` 等全部业务事件。serve.ts:384 自己的注释写明"数据全部经认证 API"，SSE 是被漏掉的数据通道。服务绑定 0.0.0.0，同网段任何机器无需凭证即可监听平台的行动动态。
**复现**：1. 不带 cookie 执行 `curl -N http://<host>:7100/api/v1/events/stream`；2. 另一终端创建行动；3. 未认证连接立刻收到该事件 JSON。
**期望**：SSE 与其他 API 一致要求 Web 会话（EventSource 同源默认带 cookie，前端零改动）。
**改进方向**：在 SSE 分支加 `requireAuth`（无凭证拒绝），并评估默认绑定 127.0.0.1。

---

**编号：#5**
**严重度**：严重
**位置**：全部 raw-fetch 页面（操作台/设置/资产/事件/知识库/用量/治理/收件箱/我的/审计）+ `webui/src/api/client.ts:38`（401 全局广播只有走 api 层才触发）
**现象**：会话过期（cookie 12h）后，看板会正常跳登录页，但其余 10 个页面只会把整页替换成"加载失败： 401"这类文字，**不跳登录**，侧栏还挂着用户名，用户不知道该干嘛，只能自己想到去点"登出"。与 store 注释声明的"401 → 全局跳登录，避免逐组件弹错"设计不符——一半页面绕过了该机制。
**复现**：1. 登录后在 DevTools 删掉会话 cookie（或等过期）；2. 点侧栏进"资产"；3. 整页只显示"加载失败： 401"，不回登录页。
**期望**：任何页面收到 401 统一跳登录。
**改进方向**：把 10 个页面的数据请求收敛回 api/client.ts（见 #13），一处广播全局生效。

---

### 一般

**编号：#6**
**严重度**：一般
**位置**：`webui/src/styles.css`（@theme 只定义了 `success/warning/destructive`，未定义 `positive` 及任何 `*-foreground`）vs 使用方：`ConsolePage.tsx:137-139,226`、`InboxPage.tsx:40`、`MinePage.tsx:14-20`、`SettingsPage.tsx:260,337`、`GovernancePage.tsx:286`
**现象**：构建产物 CSS 里 `text-positive / bg-positive / text-positive-foreground / text-success-foreground / text-warning-foreground / text-destructive-foreground / border-positive` **全部不存在**（已 grep 构建产物核实）。后果：操作台和收件箱的中/高危风险徽章、提案状态徽章文字颜色缺失（继承前景色压在同色背景上，对比度差甚至不可读）；我的页"成功"状态徽章完全没有背景色；设置页 detect 徽章、治理页资产健康徽章丢色。属于"毛坯感"的直接来源之一。（注：页面实际渲染效果未能截图验证，但类名缺失是构建产物实锤。）
**复现**：1. `grep -c '\.text-positive' webui/dist/assets/*.css` → 0；2. 打开操作台看待审批卡片的中危徽章。
**期望**：徽章按 DESIGN.md 治理色域正常显示。
**改进方向**：统一色名（positive→success 二选一）并在 @theme 补齐 `*-foreground` token，改动前先更新 DESIGN.md（AGENTS.md §6 流程）。

---

**编号：#7**
**严重度**：一般
**位置**：`src/cli/serve.ts:167-177`（`mapErrorToStatus` 无 `SKYPORT_CONFIG_INVALID` 分支，落入兜底 500）+ 各 raw-fetch 页面错误提示（如 `SettingsPage.tsx:95,107`）
**现象**：两类问题叠加。① 后端：删除不存在的模型、空模型名保存，返回 **HTTP 500**（语义应为 404/400），已实测；`usage?hours=abc` 也 500（"Invalid time value"）。② 前端：设置页等错误提示只拼状态码——"保存失败： 403"、"删除失败： 500"——**不读 body.error 里的人话**（对比：看板/抽屉会读）。用户删一个不存在的模型会看到"删除失败： 500"，以为服务器崩了。
**复现**：1. approver 登录，设置 → 模型，对已删名称调 DELETE（或 UI 上并发删同一行）；2. 提示"删除失败： 500"。
**期望**：4xx 语义 + 前端透出后端 message（"模型配置不存在： no-such"本来就是人话）。
**改进方向**：mapErrorToStatus 补 CONFIG_INVALID→400（带 id 的 NOT_FOUND→404）；前端错误提示统一走 `body.error ?? statusText`。

---

**编号：#8**
**严重度**：一般
**位置**：时间显示三种口径混用——`ActionCard.tsx:20`（本地时间）、`DetailDrawer.tsx:125`（本地）、`AuditPage.tsx:103`/`GovernancePage.tsx`（UTC ISO 截断）、`MinePage.tsx:58`（**原始 ISO 串，带 T 和 Z 直接上屏**）
**现象**：同一条行动，看板卡片显示本地时间，审计页显示 UTC 时间（UTC+8 部署下**差 8 小时**），我的页显示 `2026-09-23T10:54:41.587Z` 原文。跨页核对时间线必然对不上，易误导排障。
**复现**：1. 创建一条行动；2. 对比看板卡片右上角时间与审计页"时间"列；3. 相差 8 小时。
**期望**：全站统一的本地化时间格式。
**改进方向**：抽一个 `formatTime()` 工具（`new Date(iso).toLocaleString('zh-CN')`）替换所有 slice/replace 手法。

---

**编号：#9**
**严重度**：一般
**位置**：`src/cli/serve.ts:462-484`（`POST /api/v1/actions` 只有 `requireAuth`，无 `action:create` 能力检查）
**现象**：前端权限镜像（`lib/governance.ts:30-35`）声明 viewer 只有 `read`，但后端实测 **viewer 能成功创建行动**（返回 201 入库）。权限模型前后端不一致；虽然目前 UI 无创建入口，但"前端绕过不构成越权、服务端始终复核"的防线在创建这一环是缺的。
**复现**：1. viewer 会话 `POST /api/v1/actions` `{"command":"echo x"}`；2. 返回 201。
**期望**：`requireCapability(req, 'action:create')`（与 users.ts 的能力表一致）。
**改进方向**：补能力检查；若"viewer 可建行动待审"是产品意图，则更新 PRD 与前端权限镜像，两处必须一致。

---

**编号：#10**
**严重度**：一般
**位置**：`webui/src/components/AppShell.tsx:93-100`（侧栏导航是 `<span onClick>`，无 tabindex/role/键盘事件）+ `AuditPage.tsx:92-97`（表行点击同样不可键盘达）
**现象**：纯键盘用户**无法切换任何页面**（Tab 根本到不了导航项），也无法打开审计事件回放。DESIGN.md §8 自称"键盘一等公民"（看板卡片倒是做了 tabIndex+Enter，导航没做）。
**复现**：1. 打开页面，只用 Tab 键遍历；2. 焦点跳过整个侧栏。
**期望**：导航可 Tab 聚焦、Enter 触发、带 aria-current。
**改进方向**：span 改 `<button>`（或加 role/tabIndex/keydown），顺带补 aria-current="page"。

---

**编号：#11**
**严重度**：一般
**位置**：`webui/src/components/Board.tsx:90-97`（只有 approved/rejected 列注册了 drop；`Board.tsx:111` viewer 也能拖起 pending 卡）
**现象**：与 `Board.tsx` 头注释的 spec 相悖（"其他落点一律回弹并提示状态机约束"）：拖到非法列（如 pending→success）浏览器**静默取消**，没有任何提示——因为非法列没有 onDragOver/onDrop，drop 事件根本不触发。另外 viewer 也拖得动 pending 卡，但没有任何可落点，同样是静默无效。
**复现**：1. approver 拖一条 pending 卡到"成功"列松手；2. 卡片弹回，无任何提示；3. viewer 拖卡，同样无反馈。
**期望**：非法落点给出状态机约束提示（代码里提示逻辑已有，只是触发不到）；无权限者干脆不可拖。
**改进方向**：所有列注册 drop handler（非法落点走已有的 `setNotice` 路径）；`draggable` 增加 approver 条件。

---

**编号：#12**
**严重度**：一般
**位置**：`SettingsPage.tsx:181`（删除模型一键直达）、`DetailDrawer.tsx:182-188`（批准执行一键直达，含高危命令）、`ConsolePage.tsx:147`（同）、`SettingsPage.tsx:265`（剧本手动触发）
**现象**：全站没有任何二次确认（grep `confirm` 为 0）。删除模型配置不可恢复；批准高危命令（风险徽章红色 ▲▲）也是单击立即进执行。对"高危逐条过人"的治理哲学来说，"过人"这一下本身没有摩擦设计，容易误点。
**复现**：1. 详情抽屉打开一条 high 风险 pending；2. 单击"批准执行"立即执行，无确认步。
**期望**：至少高危行动批准、模型删除两类操作加确认步（输入命令关键片段或勾选确认均可）。
**改进方向**：加轻量确认弹层（复用 ui/ 组件），高危可要求输入回滚声明关键词。

---

### 建议

**编号：#13**
**严重度**：建议
**位置**：Console/Settings/Governance/Audit/Usage/Incidents/Assets/Inbox/Mine/Knowledge 共 10 个页面 + `DetailDrawer.tsx:56`，全部绕过 `api/client.ts` 直接 `fetch`
**现象**：违反 `api/client.ts` 头注释"分层铁律：UI 只经此层访问 /api/v1"（AGENTS.md §4 外部 I/O 收敛的同源精神）。直接后果就是 #5（401 不广播）和 #7（错误提示只拼状态码）两条。另外 `ConsolePage.tsx:55` 拼 URL 没过 `encodeURIComponent`（其余处都过了）。
**复现**：`grep -rn "fetch(" webui/src/pages/ | wc -l` ≈ 20 处。
**期望**：API 调用收敛到 client.ts。
**改进方向**：把各端点补进 api 对象（顺带获得统一 401/错误处理），视为技术债一次性还掉。

---

**编号：#14**
**严重度**：建议
**位置/现象**（一组空态与反馈缺口）：
- 操作台 `ConsolePage.tsx:31-39`：资产名输入为空时点"查询"**静默无反应**（无提示）；加载态势包无 loading 态，慢时像卡死；
- 操作台待审批列表只在挂载时拉一次，不随轮询/SSE 刷新，新 pending 不会出现（看板会）；
- `DetailDrawer.tsx:150-152`：success/failed 状态的行动若详情请求失败（!res.ok 直接 return），会**永远显示"执行结果加载中…"**；
- 用量页 `UsagePage.tsx:76-107`：byModel/byAgent 为空时只剩表头的空表，无"暂无数据"；知识库页剧本/Analyzer 为 0 时同样只有"（0）"没有空态文案（技能和插件有）。
**期望**：可交互处均有反馈；空态有引导文案。
**改进方向**：逐项补 loading/空态/空输入提示；抽屉详情失败时显示"加载失败"而非永久"加载中"。

---

**编号：#15**
**严重度**：建议
**位置/现象**（一组 a11y 与文案细节）：
- 详情抽屉 `role="dialog"` 无 `aria-modal`、无焦点移入/焦点陷阱，Esc 可关但焦点留在原处；
- 设置页/操作台所有表单用 placeholder 当 label（无 `<label>`），读屏与密码管理器不友好（登录页做对了，可对照）；
- 收件箱/操作台里 `info` 级告警显示 warning 橙色（`InboxPage.tsx:58`、`ConsolePage.tsx:113` 的三元只有 critical/warning 两分支）；
- 锁定文案写死"锁定 5 分钟"（`LoginPage.tsx:23`），而后端 429 返回了精确解锁时间，可透出。
**改进方向**：按登录页的标准补 label；severity 色映射补 info 档（`IncidentsPage.tsx:12` 已有正确映射可复用）。

---

**编号：#16**
**严重度**：建议（杂项打包）
- `BoardPage.tsx:41`：`{boardError === undefined ? null : null}` 死代码（错误条实际在外壳顶栏渲染）；
- `SettingsPage.tsx:41-46`：`loadVault` 实际拉的是 plugins 接口，命名误导（保险箱 tab 因此没人写真逻辑，助长 #1）；
- favicon 无声明，`/favicon.ico` 走 SPA fallback 返回 HTML 当图标（浏览器标签无图标）；
- `serve.ts:580-592`：alert ack/close 对路径段做了**双重 `decodeURIComponent`**，id 含 `%` 时会抛 URIError 变 500（当前 id 为 `alt_` 前缀安全，属埋雷）；
- 后端 `serve.ts:685-692`：`/api/v1/baselines/<name>` 取 `path.split('/')[3]`，恒等于字面量 `'baselines'`，该端点**任何请求都 404**（DB 里 12 条基线数据完全读不出来；无 UI 消费方，属后端问题，顺带报告）。
**改进方向**：随手清理类问题可并入下次触达对应文件时一并处理。

---

## 三、没检查 / 看不准的清单

1. **页面实际渲染效果（全部页面、明暗两主题）**：没有可用浏览器，间距/对齐/层级/布局错位只能靠代码判断；#6 徽章丢色的实际观感是按构建产物缺类名推断的，需开发在浏览器里过一眼。
2. **HTML5 拖拽审批**（pending 卡拖到已放行/已否决列）的真实浏览器行为：逻辑已代码走查，但 DnD 交互无法无头验证。
3. **AI 巡查"立即巡查"真实链路**：会调用已配置的两个真实 LLM（glm-5-3-flash / deepseek-v4-flash），为不烧 token 未实测，只验证了 viewer 的 403 门禁。
4. **剧本手动触发**的完整执行：两个内置剧本都是 training 模式（只看），未实际触发。
5. **长时间稳定性**：8s 轮询 + SSE 断线重连在数小时会话下的表现、`visibilitychange` 暂停恢复，未做 soak 测试。
6. **移动端/窄屏**：登录框 `w-88` 固定宽，小屏会溢出（代码推断，未实测）。
7. **待确认**：`POST /handover` 无角色门禁（viewer 可创建交接班快照）是否产品意图；audit verify 返回 `unchained: 618`（大量未入链记录但 ok=true）是否符合预期——这两条需要和产品/后端确认，没有下结论。

---

## 附：本次 QA 测试残留

为测试创建并保留在环境中（`~/.skyport` 数据目录）：

- 账号：`qa-approver`（approver）、`qa-viewer`（viewer）、`qa-lock`（viewer，锁定测试触发 429，5 分钟后自动解锁）
- 若干 echo 测试行动（已批准/已否决，留痕在审计链：`act_efe7140b`、`act_9110a617`、`act_f1bfd6f2`、`act_ee2e6144` 等）
- 一条已关闭的测试告警 `QaWebuiCheck`（resource t3）
- 一条 QA 交接班快照（notes: "QA 交接备注"）
- 测试模型 `qa-test-model` 已删除，模型配置已恢复原状

如需清理上述残留，另行处理（本次 QA 遵守只读约定，未动任何既有数据）。
