# skyport 红队 QA 审查报告（安全 + 人机体验）

> **交付对象**：开发 Agent / 开发同学。本文档自包含，可直接按问题 ID 逐条修复。
>
> **⚠ 状态更新（2026-09-22 第二轮回归）**：第一轮全部 S1–S15 / U1–U8 已由开发侧修复并经黑盒复测确认（证据见[第七节](#七第二轮回归验证2026-09-22-修复后构建)）；当前遗留为新发现 **N1（`--json` 管道输出 64KiB 截断）**、**N2（远程执行引号剥离变形）** 及 3 条残留判级备注。
>
> **⚠ 状态更新（2026-09-23 v0.3/v0.4 功能审查）**：N1/N2 已修复（有回归测试）；新增 v0.3/v0.4 功能审查见[第八节](#八v03v04-功能审查2026-09-23非破坏性)——**阻断 V1（verify 红）**、**V2（REST 参数路由全 404）**、**V3（审计链惰性）**、**V4（--rollback/--dry-run 未接线）**、严重 V5（REST 读无范围）及暗代码可达性矩阵。
> **被测版本**：skyport v0.1.0（M3），仓库 `/home/liu/skyport`，DB `~/.skyport/skyport.db`。
> **测试日期**：2026-09-22。测试依据：`docs/redteam-test-plan.md` 全部用例（A–G）+ 攻击者模式扩展 + 值守运维人机体验专项。
> **测试环境说明**：本机默认 node 为 v18.19.1，CLI 无法启动（见 S1），全部测试使用 `~/node22/bin/node`（v22.14.0）经 `bin/skyport.mjs` 执行。
> **测试后状态**：环境已还原——测试 agent 全部吊销（redteam/lowagent/exp/autoexec/opdemo），测试资产已删除（资产清单回到 t1/t2/t3），121+ 条 pending 已全部 **reject**（危险命令未执行过任何一条），被篡改的 `docs/` 目录权限已恢复 775。

---

## 一、执行摘要

治理闭环骨架真实有效：认证/三件套门口校验/审批人专属/参数数组执行/审计留痕全部按主张工作（A1–A6、B1–B5、D4、E1、E2、E3、G1、G2 通过）。

但红队主线结论是：**存在一条不需要任何漏洞利用技巧的"零审批 root 直通"链路（S2）**——风险引擎可被平凡变形绕过（S3）+ 策略文件从 cwd 加载 + `autoExecLowRisk` 开启，三者组合即可让 **low 上限的受限 agent** 免审批在资产上以 root 执行删除类命令。测试计划第六节的安全主张（"即便骗过，仍有身份、上限、留痕，高危必须过人"）在默认配置下成立，在此链路下被整体击穿。

人机体验结论：核心闭环可用，approve 内联反馈是亮点；但值守审批场景（系统安全兜底依赖的"人眼环节"）体验最薄——看板截断命令、值守屏不显示理由、发起者只给内部 ID、不能就地审批。

**修复优先级总览**：

| 优先级 | 问题 | 一句话 |
| --- | --- | --- |
| P0（发布阻断） | S2, S3, S4 | 拆掉零审批直通链 + 修风险引擎变形绕过 + 堵资产穿透 |
| P0.5 | S1 | node<20 时人话报错而非裸崩 |
| P1 | S5, S6, S7, S8, S9 | 文件系统副作用 / 凭据出站 / 退出码契约 / 超时重试 |
| P2 | S10–S15, U1–U6 | 竞态窗口、凭据可见性、审计标记、值守体验 |
| P3 | U7, U8 | 体验打磨 |

---

## 二、通过项记录（不需要动作，供回归基线）

| 组 | 结果 |
| --- | --- |
| A1–A6 认证 | 全过：无效 key/暂停/过期/吊销均 exit 7 且不可恢复；`SKYPORT_API_KEY` 带 key 审批被拒；DB 只存 64 位 hex 哈希，无明文 |
| B1–B5 越权 | 全过：风险超限/资产出界/local 语义/risk-hint 只升不降/agent key 调 `run` 被拒，均 exit 7 |
| C1/C8 基线 | `rm -rf /`、`dd`、`mkfs`、`shutdown`、`rm --recursive --force /` 判 high 正常 |
| D1/D2/D4 状态机 | 重复 approve/cancel 后 approve 被状态机拒绝；`--wait-seconds` 到点如实返回 pending 不挂死 |
| D3 并发审批 | 3 轮 × 5 进程并发 approve：无双执行（但理论窗口存在，见 S10） |
| E1 addr 注入 | `--` + 单 argv 防线有效：`root@1.2.3.4 -oProxyCommand=evil` 被整体当主机名，ssh exit 255，ProxyCommand 未被解析 |
| E2 本地注入 | 本地不经 shell：`;` `\|` `` ` `` `$()` 原样传给目标程序，无解释 |
| E3 输出截断 | 20MB 输出截为恰好 102400 字节，行动 success |
| F1 文件权限 | `~/.skyport` 700 / db 600（-shm/-wal 同样 600） |
| G1/G2 韧性 | 连续 100 条 pending 创建/列表不卡不死；6 进程并发写库全部成功，无 BUSY 崩溃 |
| 输入健壮性 | 空输入/纯空白/未闭合引号/2000 边界/超长名字/非法日期/非法枚举/坏 DB 路径，均有干净中文报错与正确退出码；webhook 指向黑洞地址不阻塞（0.79s 返回）；资产检查黑洞 5s 精确超时、DNS 失败快速报错；重复 init 幂等 |

---

## 三、安全问题清单

> 每条格式：严重度 / 场景 / 期望 / 实际 / 复现步骤 / 定位与修复建议。

### S1〔阻断〕node < 20 时 CLI 裸崩，首次使用即卡死

- **场景**：在 PATH 默认 node 为 18 的机器上执行 `node bin/skyport.mjs doctor`（首次使用按文档走查）
- **期望**：人话报错"node 版本过低，需 ≥ 20"，exit 2
- **实际**：`SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'` + 12 行堆栈，exit 1。bin/skyport.mjs 注释自知此坑并提到"正式部署请用包装脚本"，但仓库未提供该脚本；README 只写"要求 ≥20"
- **复现步骤**：1. `node bin/skyport.mjs doctor`（node18 环境）2. 观察堆栈
- **修复建议**：bin/skyport.mjs 启动前检查 `process.version`，<20 直接打印中文指引退出；或随仓库提供指定 node 路径的包装脚本；CI 增加 node18 冒烟测试（断言报错可读）

### S2〔阻断·最高危〕cwd 策略文件 + autoExecLowRisk + 引号变形 = 免审批 root 直通

- **场景**：与调用者同 UID 的攻击者/AI（无需 root）在自己可写目录放 `{"autoExecLowRisk": true}` 的 `skyport.policy.json`，从该目录用 **low 上限 + `--auto-exec-low`** 的 agent 提交 `rm "-r" "-f" /tmp/any`
- **期望**：测试计划 C8 主张策略文件"属信任边界内（本机 root 才能写）"；删除类命令应至少进人工审批
- **实际**：实测 **`act_119407e9 ● 成功（524ms，退出码 0）`——零人工审批，以 root 在 t1 直接执行**。对照实验：同一命令在无策略文件的 cwd 下进 pending，证明直通完全来自 cwd 策略。AI 与 skyport 调用者同 UID，"root 才能写"不成立——**被治理方可以改写自己的治理参数**
- **复现步骤**：1. `mkdir /tmp/x && cd /tmp/x && echo '{"autoExecLowRisk":true}' > skyport.policy.json` 2. `skyport agent create --name a --assets 't1*' --risk-ceiling low --auto-exec-low` 3. 从 /tmp/x 执行 `skyport agent run --api-key <key> --exec 'rm "-r" "-f" /tmp/any' --target t1` 4. 立即"成功"，无人审批
- **定位与修复建议**：`src/services/risk.ts:24`（`POLICY_FILENAME` 按 `process.cwd()` 加载，`defaultPolicyPath()`）。修复：① 策略文件仅从 `~/.skyport/skyport.policy.json` 加载，或需 `--policy <path>` 显式指定且打印醒目警告；② `autoExecLowRisk=true` 时启动打 WARN、`doctor` 亮黄灯、`config` 显示该项（当前 config 输出完全没有它）；③ 策略文件变更写入审计事件流

### S3〔严重〕风险引擎平凡变形绕过族：8 种危险命令被判 low

- **场景**：medium 上限 agent 逐条提交变形命令，`action list --json` 查看 riskLevel
- **期望**：破坏性命令不应为 low（测试计划 C 类判定标准）
- **实际**：以下全部判 **low**：

| 变形 | 命令 |
| --- | --- |
| 分离旗标 | `rm -r -f /`（C2 坐实） |
| 引号包裹旗标 | `rm "-rf" /tmp/x`（C5）、`rm "-r" "-f" /tmp/x` |
| 反斜杠转义 | `bash -c rm\ -rf\ /` |
| 其他删除原语 | `find / -delete`、`python3 -c "shutil.rmtree(...)"`、`mv / /tmp/trash` |
| 编码管道 | `echo <b64> | base64 -d | sh`（C3：管道进 shell 规则只盯 curl/wget） |
| 变量间接 | `X='rm -rf /tmp/x'; $X`（C4） |

  对照：`rm -rf /`、`rm --recursive --force /`、`dd`、`mkfs`、`shutdown`、`sh -c "rm -rf /"` 判 high 正常
- **复现步骤**：1. `skyport agent run --api-key <key> --exec 'rm -r -f /' --target t1` 2. 输出"○ 待审批 low" 3. `action list --json` 确认
- **定位与修复建议**：`src/services/risk.ts` HIGH_PATTERNS。根因：**风险评估在原始字符串上跑正则，且要求旗标合并为单 token（`-[a-z]*r[a-z]*`）；执行层 tokenizer 会剥引号——两套语义不一致**。修复：① 评估改在 `tokenizeCommand()` 输出上做，先剥引号再匹配；② 旗标解析用集合语义（合并/分离/长选项/引号包裹视为同一旗标集）；③ 补规则：`find -delete`、`shutil.rmtree`、`mv /`、任意程序管道进 `(ba\|z\|da)?sh`（不限 curl/wget）、`$VAR` 间接含危险子串时至少 medium；④ 兜底策略：无法解析结构的命令宁可 medium

### S4〔严重〕资产范围穿透：t1-only agent 可递交打 t2 的跳板命令，仍判 low

- **场景**：assets=`t1*` 的 agent 提交 `ssh t2 "rm -r -f /tmp/pivot-probe"` --target t1
- **期望**：资产三件套约束实际作用面；跨资产 pivot 至少升级风险或拒绝
- **实际**：判 **low**、门口放行（low 上限 agent 同样放行）。范围校验只看 `--target` 字段，命令内嵌 ssh/scp 跳板完全不在治理视野内
- **复现步骤**：1. 用 t1* agent 提交上述命令 2. 观察输出"待审批 low" 3. 对照 `ssh t2 "systemctl restart nginx"` 判 medium（仅因 systemctl 规则兜住）
- **修复建议**：对命令含 `ssh`/`scp`/`kubectl exec`/`docker exec` 的情况做二级目标提取；跳板目标不在 agent 资产范围内 → 拒绝或强制 high

### S5〔严重〕自定义 DB 路径静默 chmod 任意父目录

- **场景**：`SKYPORT_DB_PATH=/home/liu/skyport/docs/perm-test.db skyport agent list`（**只读查询**）
- **期望**：只读命令不产生文件系统副作用；权限收紧只应发生在 `~/.skyport`
- **实际**：`docs/` 从 775 被改成 **700**，且顺带创建新库文件。指向共享/项目目录会悄悄切断其他用户访问；指向 `/tmp` 下时误报 `EPERM: chmod '/tmp'`（3 种坏 DB 路径全误报为 chmod 错误，exit 8）
- **复现步骤**：1. `stat -c %a <某共享目录>` 2. `SKYPORT_DB_PATH=<该目录>/x.db skyport agent list` 3. 再 stat，权限已 700（测试现场已还原）
- **修复建议**：DB 初始化的 `chmod 0700` 收敛到默认数据目录；自定义 dbPath 时只校验并警告不改权限；错误归因区分别名/权限/损坏

### S6〔严重〕webhook 明文外发完整命令，密码随命令出站（F3 验证属实）

- **场景**：配置 `SKYPORT_NOTIFY_WEBHOOK_URL` 后 agent 提交 `mysql -uadmin -pS3cretPass123 -e "SELECT ..."`（该命令同时被判 low）
- **期望**：出站载荷对凭据做遮蔽，或文档强制 webhook 目的地同级安全
- **实际**：捕获的 POST body 含 `"command":"mysql -uadmin -pS3cretPass123 -e \"SELECT * FROM users\""`——密码原样出站。断网场景表现好：webhook 指向黑洞地址时创建 0.79s 返回不阻塞
- **复现步骤**：1. 本地起 HTTP 监听 2. `SKYPORT_NOTIFY_WEBHOOK_URL=http://127.0.0.1:PORT/h skyport agent run ... --exec 'mysql -uadmin -pSECRET ...'` 3. 查看捕获 body
- **修复建议**：通知载荷提供脱敏选项（正则遮蔽 `-p<secret>`/`password=`/`token=` 等）；脱敏默认开启，白名单命令全文外发

### S7〔一般〕行动执行失败，CLI 退出码仍为 0

- **场景**：`skyport run --exec 'ls /nope'`；或对 ssh 不通的资产 run（exit 255）；或超时失败
- **期望**：执行失败非零退出（退出码契约 4=exec 域），脚本/cron 可判断成败
- **实际**：三例均 exit 0，仅 stdout 打印"✕ 失败"。自动化调用方会误判成功
- **复现步骤**：1. `skyport run --exec 'ls /nope'; echo $?` → 失败文案但输出 0
- **修复建议**：行动终态 failed 时 CLI 以 exit 4 退出（approve/run/cancel 路径统一）

### S8〔一般〕批量 approve 失败被包装成「未知错误」，退出码契约破坏

- **场景**：D1——对已 success 的行动再次 approve
- **期望**：计划 D1 明确预期 `ACTION_INVALID_STATE，exit 11`
- **实际**：明细行有正确状态说明，但顶层是 `[skyport] 未知错误: 批量操作：1/1 条失败（其余已处理）` + **exit 1**。"未知错误"对运维是最高警报词汇，实际只是状态冲突
- **复现步骤**：1. approve 一条至成功 2. 再次 approve 同 ID 3. exit 1 + "未知错误"
- **修复建议**：批量操作聚合错误改为 `SKYPORT_ACTION_INVALID_STATE` 并保留各条明细；exit code 用最重要的失败项域码；文案去掉"未知错误"

### S9〔一般〕超时被重试放大 4 倍，审计 duration_ms=0，提示不提重试

- **场景**：E4——`skyport run --exec 'sleep 60' --target t1`
- **期望**：10s 超时、行动 failed、timed_out=1（此三点正常）
- **实际**：实际耗时 **42s**（超时被退避重试 3 次，共 4 次尝试）。对 `systemctl restart` 等非幂等命令，重试=重复副作用；executions 记录 `duration_ms=0`（真实 42s）；最终提示只写"超时（10000ms）"，重试细节只在 WARN 日志
- **复现步骤**：1. `time skyport run --exec 'sleep 60' --target t1` 2. 观察 42s 3. 查 executions 行 `duration_ms=0`
- **修复建议**：超时类失败不重试（或仅对显式标记幂等的命令重试）；executions 补记真实 duration 与尝试次数；用户提示包含"共尝试 N 次"

### S10〔一般〕审批竞态 TOCTOU 窗口存在（源码证实，实测 15 并发未复现双执行）

- **场景**：D3——3 轮 × 5 进程同时 approve 同一 pending
- **期望**：行级原子状态迁移
- **实际**：15 次并发均被 `executing` 中间态拦下，executions 行数均为 1；但 `approveAndExecute`（`src/services/actions.ts`）为**先 SELECT（expectPending）后 UPDATE，UPDATE 无 `AND status='pending'` 守卫**，理论窗口仍在。与计划"已知风险"一致
- **复现步骤**：1. 建 pending 2. 5 进程同时 `approve <id>` 3. 查 executions 行数
- **修复建议**：状态迁移改单条原子 SQL：`UPDATE actions SET status='executing' WHERE id=? AND status='pending'`，影响行数为 0 即拒绝

### S11〔一般〕`--api-key` 明文走 argv，全机 ps 可见

- **场景**：`skyport agent run --api-key skp_... --exec ...` 运行期间任意本地用户 `ps -eo args`
- **期望**：凭据不出现在 argv
- **实际**：`ps` 直接显示 `--api-key skp_41ff676a...`（已实测捕获）。多用户控制端场景下 key 生命期内任何本地用户可窃取
- **复现步骤**：1. 后台跑带 --api-key 的 agent run 2. `ps -eo args | grep skp_` 3. 明文可见
- **修复建议**：支持 `--api-key-file`/stdin 读取；文档主推 `SKYPORT_API_KEY`（environ 仅同 UID/root 可读）

### S12〔一般〕输出截断无任何标记

- **场景**：E3——远程产出 20MB 输出
- **期望**：截断在记录/展示中可见
- **实际**：stdout 恰好存 102400 字节，executions 无 truncated 字段，`action show` 无提示——审计读者无法区分"命令只输出这些"和"被截掉 99.9%"
- **复现步骤**：1. `skyport run --exec 'head -c 20000000 /dev/zero | xxd' --target t1` 2. 查 executions：恰 102400 字节无截断标志
- **修复建议**：executions 增加 `truncated` 标志与原始字节数；展示层尾部加省略提示

### S13〔一般〕报错泄露底层驱动原文与英文校验文案，中英混杂

- **场景**：重复建 agent / 重复建资产 / DB 打不开 / 导入坏文件
- **期望**：统一中文人话报错
- **实际**：尾行带 `由 SqliteError: UNIQUE constraint failed: agents.name`；超长名字报 zod 英文原文 `Too big: expected string to have <=100 characters`；JSON 导入坏文件报 `SyntaxError: Unexpected token 'a'...`
- **复现步骤**：1. `skyport agent create --name redteam ...` 两次 2. 看末行
- **修复建议**：错误格式化层按域映射驱动错误为固定中文文案；zod issues 翻译或包一层

### S14〔建议〕白名单邻近命令兜底为 low

- **场景**：C6——whitelist 精确放行 `kubectl get pods` 后提交 `kubectl get pods; id`
- **期望**：计划预期"因 ;id 上下文给出合理等级"
- **实际**：白名单全等比较守住（未命中白名单 ✓），但兜底成 **low**。autoExecLowRisk 开启时"白名单命令 + `;` 任意后缀"全部免审批直通
- **复现步骤**：1. cwd 放含 whitelist 的策略 2. 提交 `kubectl get pods; id` 3. riskLevel=low
- **修复建议**：含 `;` `|` `&&` `$()` `` ` `` 的命令不进 auto-exec 资格（即使整体 low）；或含命令分隔符时最低 medium

### S15〔建议〕杂项

- commander 用法错误双打印（raw `error: unknown option` + skyport 格式各一遍）
- `--wait-seconds -5` 静默按 0 处理无提示（建议校验非负）
- 多行命令被 `normalizeCommand` 静默压成单行执行，行动列表里却显示多行——展示与执行不一致
- `config` 输出不显示 `autoExecLowRisk`/`notifyWebhookUrl`/`apiKey` 等安全关键项——运维无法一条命令看清安全姿态
- `agent list` 对所有本地用户展示每个 agent 的 key 前 6 位（skp_41ff****）

---

## 四、人机体验问题清单（值班运维视角）

> 结论：核心闭环可用（approve 内联反馈是亮点：时长/退出码/stdout 即时回显），但值守审批场景四个决策要素缺三：命令被截断（U1）、不知道是谁（U2）、没给理由（U3）、批一条切三次窗口（U4）。**系统安全兜底是"人眼看命令"，但人眼环节被照顾得最差**——与 S2/S3 形成双重削弱。

### U1〔一般〕行动看板截断命令，审批人第一眼看不到要放什么

- **场景**：`skyport action list` 查看 pending 中一条 150 字符 kubectl 发布命令
- **期望**：审批主视图能看全命令，或截断时强提示"请 show 查看"
- **实际**：显示为 `kubectl set image deployment/api api=registry.internal/app:…`——镜像版本号（审批最该核对的字段）恰好被截掉。**`watch` 视图反而显示全文，两个视图不一致**；逐条 `action show` 才能看全。对应计划已知薄弱点 6 的活体
- **复现步骤**：1. 提交 100+ 字符命令的 pending 2. `action list` 看截断 3. `watch --once` 看全文 4. 对比
- **修复建议**：看板列宽自适应或两行展示；截断时行尾加 `…（show <id> 看全文）`；与 watch 共用同一渲染函数保证一致

### U2〔一般〕发起者只显示内部 ID，不显示 agent 名字

- **场景**：值守/看板/`action show` 查看行动发起者
- **期望**：显示 `opdemo`（或"名字 (ID)"）
- **实际**：三处全部显示 `agent:agt_d9832d23`，需另开 `agent list` 人肉对照——名字就在库里
- **复现步骤**：1. `agent create --name opdemo` 2. 该 agent 提交行动 3. `action show <id>` 看"发起者"行
- **修复建议**：渲染层 join agents 表取 name；agent 已删除/吊销时回退显示 ID + 状态

### U3〔一般〕值守屏不显示 agent 给的理由

- **场景**：agent 提交带 `--reason '发布 api 新版本，变更单 CHG-xxx'`，值班 `skyport watch`
- **期望**：理由是审批决策第一上下文，值守屏应展示
- **实际**：watch 输出只有 `[low] agent:agt_xxx <命令>`，理由缺席，须逐条 `action show`
- **复现步骤**：1. `agent run --reason 'xxx'` 建待办 2. `watch --once` 3. 输出无 reason
- **修复建议**：watch/action list 的 pending 行加 reason（超长截断 + show 看全文）

### U4〔一般〕值守不能就地审批，两个终端来回跳

- **场景**：终端 A `skyport watch` 挂值守，来了一条待办
- **期望**：就地 y/n 交互（@clack/prompts 已在依赖里）
- **实际**：watch 纯只读轮询，只打印"处理：skyport approve act_xxx"——复制 ID、切终端、粘贴。每条待办三次窗口切换
- **复现步骤**：1. 终端 A `skyport watch` 2. 终端 B 造 pending 3. A 无法交互
- **修复建议**：watch 增加交互模式（默认开，`--no-interactive` 关闭）：方向键选择、y 批准 / n 否决 / d 看详情；非 TTY 自动退化为现状

### U5〔一般〕台账无翻页、无 agent/目标/时间过滤，200 条后老记录不可见

- **场景**：库内 145 条行动，`action list` 全量倒出 150 行；继续积累到 200+
- **期望**：分页 + 按 agent/目标/时间段过滤（"opdemo 今天干了什么"是审计高频问题）
- **实际**：一次倒完（上限 200），唯一过滤器 `--status`；`--agent` 不存在（unknown option）。**超 200 条后更老记录从任何 CLI 视图不可见——审计追溯断崖**
- **复现步骤**：1. 造 100+ 条行动 2. `action list | wc -l` 3. 试 `--agent opdemo` 报错
- **修复建议**：`--agent/--target/--since/--limit/--offset` 过滤分页；超上限时提示"仅显示最近 N 条，用过滤条件缩小范围"

### U6〔一般〕`agent run` 默认阻塞 120 秒且期间零输出

- **场景**：不带 `--wait-seconds` 调用（默认 120，`src/cli/commands/agents.ts:117`）
- **期望**：进入等待时立刻打印"已登记，等待人工审批（最长 120s）…"
- **实际**：登记后**静默挂 2 分钟**（实测 75s+ 无任何输出），到点才打印结果。AI 集成方与人手工代跑都会以为挂死
- **复现步骤**：1. `skyport agent run --api-key <k> --exec 'ls' --target t1`（不带 wait）2. 观察 120s 无输出
- **修复建议**：进入等待立即打印登记结果 + 提示行；长等待期间周期性心跳或至少文档写明默认值

### U7〔建议〕慢命令审批时操作者干等 42 秒无进度

- **场景**：approve 一条会超时的命令（`sleep 60`）
- **期望**：显示"执行中… / 重试 2/4"
- **实际**：重试 WARN 混在错误流，无面向人的进度提示（与 S9 同源，补充人感维度）
- **修复建议**：随 S9 一并处理，approve 执行期间输出阶段提示

### U8〔建议〕资产导入只支持 JSON，坏文件泄露解析器原文

- **场景**：`skyport asset import assets.csv`
- **期望**：支持 CSV 或至少报"仅支持 JSON 数组"
- **实际**：`SyntaxError: Unexpected token 'a'...` 直出（S13 同模式）；JSON 格式导入正常
- **复现步骤**：1. 造 CSV 2. `asset import x.csv`
- **修复建议**：随 S13 统一处理；可选支持 CSV

---

## 五、改进路线图（映射问题 ID）

**P0 —— 拆掉零审批直通链（发布前必须，任断一环即大幅降险）**

1. 策略文件加载位置收权：cwd → `~/.skyport/`（或 `--policy` 显式 + 警告）【S2】
2. 风险评估改基于 tokenizer 输出 + 旗标集合语义 + 补规则【S3】
3. 命令内嵌跳板做二级目标范围校验【S4】
4. autoExecLowRisk 开启时 doctor 亮灯、config 可见、审计留痕；默认关闭【S2/S14/S15】
5. bin 包装脚本 + node 版本人话守卫【S1】

**P1 —— 契约与副作用**

6. DB 路径 chmod 收敛到默认数据目录【S5】
7. webhook 载荷脱敏【S6】
8. 执行失败非零退出【S7】；批量错误保留真实域码、删"未知错误"【S8】
9. 超时不重试 + duration_ms/尝试次数如实记录【S9】

**P2 —— 竞态、凭据与值守体验**

10. approve 原子状态迁移【S10】
11. key 读取方式（file/stdin 主推）【S11】；截断标记【S12】；报错统一中文【S13】
12. 看板不截断或截断必提示【U1】；值守屏显示 reason【U3】；发起者显示名字【U2】
13. watch 就地审批【U4】；台账过滤分页【U5】；agent run 等待提示【U6】

**P3 —— 打磨**

14. U7/U8/S15 杂项

---

## 六、验证方式说明（开发完成后回归用）

- 全部复现步骤在本文档各条目内，环境要求 node ≥ 20（本机用 `~/node22/bin/node`）。
- 危险命令验证只需观察到 `riskLevel` 判级与门口行为即可，**切勿 approve** 破坏性 pending。
- 修复后重点回归：第二节通过项基线（不要为修安全问题破坏已通过的行为）+ 本文档各条复现步骤的反向验证（期望行为出现）。
- 建议为 S3 增加回归用例集：每条绕过变形 ≥ 1 个单测（`src/services/risk.test.ts`）。

---

## 七、第二轮回归验证（2026-09-22 修复后构建）

> 前提：资产 t1/t2/t3 经授权可牺牲，本轮包含真机执行类验证。构建含 8 个修复提交（`040c695`…`2d89d41`）。
> 结论：**S1–S15、U1–U8 全部修复确认，第一轮基线未回归劣化**；新发现 N1/N2 见下。

### 7.1 修复确认表（黑盒复测证据）

| ID | 状态 | 复测证据 |
| --- | --- | --- |
| S1 node 守卫 | ✅ 已修 | node18 下输出中文指引（"请改用高版本 node…例如 ~/node22/bin/node"），exit 2，无堆栈 |
| S2 策略文件收权 | ✅ 已修 | cwd 策略文件失效，仅认 `~/.skyport/skyport.policy.json`；`config` 显示 policy 块；doctor 检查策略并在 autoExecLowRisk 开启时打 ⚠；CLI 启动还有 WARN"确认这是你想要的治理姿态"。攻击链复测：引号 rm 升 medium 挡在 low 门外，`echo` 类合法 low 正常 auto-exec，功能与安全兼顾 |
| S3 风险引擎重写 | ✅ 已修 | 第一轮 8 条 low 绕过（`rm -r -f /`、`rm "-rf" x`、`bash -c rm\ -rf\ /`、`find / -delete`、`python rmtree`、`mv /`、`base64 -d \| sh`、变量间接）**全部 high 门口拒绝**；`echo hello` 仍 low 无误伤；引擎已改为 token 结构分析（旗标集合 + ROOTISH 操作数 + 段级规则） |
| S4 跳板治理 | ✅ 已修 | 未授权跳板（t1\* agent → t2）门口拒绝，错误含 pivot 上下文；授权跳板（t\* agent → t2）放行为 pending（medium）。真机放行执行：t1→t2 不可达，10.7s 如实超时失败 exit 4，无重试放大 |
| S5 chmod 副作用 | ✅ 已修 | `SKYPORT_DB_PATH=/tmp/s5dir/x.db`（775）执行后目录权限不变 |
| S6 webhook 遮蔽 | ✅ 已修 | 载荷显示 `mysql -uadmin -p *** -e`，带 `"redacted":true` 标记 |
| S7 失败退出码 | ✅ 已修 | `ls /nope` 失败 → exit 4（超时同样 exit 4） |
| S8 批量错误包装 | ✅ 已修 | 重复 approve → exit 11，报错"当前状态为 success，不能 approve"，无"未知错误" |
| S9 超时契约 | ✅ 已修 | `sleep 60`：10.7s 返回（不再重试放大），executions 记录 `attempts=1`、`duration_ms=10013` 如实 |
| S10 审批 TOCTOU | ✅ 已修 | 源码改原子迁移（`UPDATE … WHERE status=?`，`claimTransition`）；5 进程并发 approve：恰 1 成功、4×exit 11、executions 1 行 |
| S11 key 走 argv | ✅ 已修 | 新增 `--api-key-file`，help 明确建议文件/环境变量方式 |
| S12 截断无标记 | ✅ 已修 | executions 新增 `stdout_truncated/stderr_truncated` 列（迁移 v3），20MB 输出记录 `stdout_truncated=1` |
| S13 底层错误泄露 | ✅ 已修 | 重复建 agent → 纯中文"agent 名已存在"；zod 报错中文化（"超出长度/大小上限"）；技术细节默认隐藏（`SKYPORT_VERBOSE_ERRORS` 开启才显示）；CSV 导入报"JSON 解析失败"无 SyntaxError |
| S14 分隔符兜底 low | ✅ 已修（按建议方案） | `kubectl get pods; id` 仍判 low，但**不再具备 auto-exec 资格**（实测进 pending 等审批），含分隔符命令必须过人 |
| S15 杂项 | ✅ 已修 | `--wait-seconds -5` 拒绝（"需为非负整数"）；多行命令入库归一（展示与执行一致）；`config` 显示 policy 安全块；`agent list` 不再显示 key 提示 |
| U1 看板截断 | ✅ 已修 | 截断行尾带"（skyport action show act_xxx 看全文）"提示，与 watch 共享行渲染 |
| U2 内部 ID | ✅ 已修 | 看板/show/watch 均显示 `agent:rt-med`（名字） |
| U3 值守无理由 | ✅ 已修 | pending 行尾显示"理由: 重载配置，变更单 CHG-xxx" |
| U4 不能就地审批 | ✅ 已修 | watch 支持终端内就地审批，`--no-interactive` 可关，非终端自动禁用 |
| U5 无过滤分页 | ✅ 已修 | `--agent/--target/--since/--limit` 全部就位，`--json` 带 `hasMore` 分页元数据 |
| U6 等待无提示 | ✅ 已修 | 登记后立即打印"已登记 act_xxx（low），等待人工审批（最长 Ns）…" |
| U7 无进度提示 | ✅ 已修 | 执行前打印"执行中（慢命令请等待，超时上限见配置）…" |
| U8 导入报错 | ✅ 已修 | 同 S13，报"JSON 解析失败" |

### 7.2 执行层端到端（资产可牺牲授权下，真机验证）

| 验证点 | 结果 |
| --- | --- |
| medium 删除经审批真执行 | `rm -r -f /tmp/sac3`（引擎正确判 medium）→ 人工 approve → root 真删成功，闭环"分级→审批→执行→留痕"完整 |
| 远程 shell 语义 | `;` 与 `$()` 由远程 shell 解释（`touch` 链执行、`$(id -u)` 展开为 0）；`$()` 已被引擎识别升 medium。本地执行仍 argv 直传无解释（`echo a;id` 原样输出）——本地/远程语义差异是 ssh 模型固有，靠引擎判级兜底 |
| ProxyCommand 防线 | 恶意 addr 资产执行 → 如实失败 exit 4，选项未被解析 |

### 7.3 新发现（本轮遗留，需要处理）

#### N1〔严重〕`--json` 大输出经管道传输时被截断在 64KiB，JSON 非法

- **场景**：行动数 ~146 条时 `skyport action list --json | jq .`（或任何 AI 消费者管道读取）
- **期望**：完整合法 JSON（README 承诺"--json 供 AI 解析"，AI 集成必然走管道）
- **实际**：管道接收**恰好 65536 字节**（一个 chunk），JSON 在字符串中间断掉解析失败；重定向到文件则完整（86712 字节，3/3 稳定复现）。典型 Node `process.exit()` 未等 stdout 冲刷的坑——管道是异步写，exit 时缓冲区被丢弃
- **复现步骤**：1. 造 150+ 条行动 2. `skyport action list --json | wc -c`（=65536）3. `skyport action list --json > f; wc -c f`（完整）4. 管道结果 `jq .` 报错
- **修复建议**：CLI 退出前显式 `process.stdout.write` 后等待 drain，或用 `process.exitCode = N` 替代 `process.exit(N)` 让 Node 自然退出冲刷；补一条 >64KB 输出的管道回归测试

#### N2〔一般〕远程执行引号剥离变形：带空格的引号参数被拆成多个参数

- **场景**：`skyport run --exec 'touch "/tmp/e2e q.txt"' --target t1`（远程 SSH 目标）
- **期望**：远程创建单个文件 `/tmp/e2e q.txt`（审批人读到的命令语义）
- **实际**：创建了 **`/tmp/e2e` 和 `q.txt` 两个文件**——tokenizer 剥引号后经 ssh 以空格拼接，带空格的引号参数被拆散。本地执行正确（argv 保真），仅远程变形。正确性 bug（审批人看到的语义 ≠ 实际执行语义）+ 安全隐患（"删除一个带空格的文件名"实际删两个路径）
- **复现步骤**：1. `skyport run --exec 'touch "/tmp/a b.txt"' --target <ssh资产>` 2. 远程 `ls /tmp/a\ b.txt`（不存在）与 `/tmp/a`（存在）
- **修复建议**：远程路径对含空格/元字符的 token 重新加引号（POSIX 单引号转义）后再传 ssh；或文档明示远程引号语义限制并在审批界面提示

#### R 残留判级备注（低优先级，记录在案）

- `truncate -s 0 /dev/sda`、`chmod -R 000 /` 停在 **medium**（设备截断/全盘去权可考虑升 high）
- `kubectl get pods; id` 判 low：分隔符命令已禁 auto-exec（S14 方案生效），可再考虑含 `;` 时最低 medium
- 内嵌 `ssh` 跳板执行若目标不可达/交互提示会挂到超时（本轮 t1→t2 即如此）——可考虑给内嵌 ssh 场景提示加 `-o BatchMode=yes` 的文档建议

### 7.4 基线回归结果

A1/A3/A5/A6、B1/B3/B4、D2、E1、E2（本地注入）、F1 全部保持通过，退出码与第一轮一致；doctor 五项（新增 policy 检查）全绿。第一轮修复未破坏任何已通过行为。

---

## 八、v0.3/v0.4 功能审查（2026-09-23，非破坏性）

> 范围：`040c695`…`a5a47c0` 共 45 个新提交（审计链/护栏/CMDB/保险箱/三层令牌/REST API/MCP/异步执行/告警总线/互斥认领/态势包/Break-glass/四角色）。约束：全程非破坏性（唯一一次审计行篡改已快照并精确还原）。
> 结论先行：**服务层代码与测试质量不差，但大量功能是"暗代码"——没有 CLI/REST 入口，用户不可达**；可达的部分里，REST 全部带路径参数的端点因取段 bug 整体 404，审计链防篡改未接线（惰性）。**`pnpm verify` 在 HEAD 上是红的**。

### 8.1 交付状态矩阵（可达性盘点）

| 功能 | 服务层+测试 | 用户入口 | 实际可用性 |
| --- | --- | --- | --- |
| 审计链防篡改 | ✅ | CLI `audit verify` | **❌ 惰性**（见 V3） |
| 高危护栏 | ✅ | CLI `action create` | **半残**（见 V4） |
| 备份 backup | ✅ | CLI `backup` | ✅ 正常（0600/0700 权限正确） |
| 四角色用户 | ✅ | CLI `user add/list` + REST auth | ✅ 基本可用（见 V9/V10） |
| REST API v1 | ✅ | **无 CLI 命令**（`skyport serve` 不存在） | 经 tsx 直启后：列表端点可用，**全部带参数端点 404**（V2） |
| MCP 适配器 | ✅ | **无 CLI 命令**（`skyport mcp` 不存在） | 经 tsx 直启后：7 工具协议正常（V7） |
| 凭证保险箱 | ✅ | **无任何入口** | ❌ 暗代码（manual-test 的 `skyport secret` 不存在） |
| 三层令牌（skr_/sks_） | ✅ | **无签发入口**（REST 只验证不签发） | ❌ 暗代码 |
| 告警总线 | ✅ | REST POST/GET（列表路由可用） | 部分可用（ingest/stats ✓，**ack/close 走参数路由 → 404**） |
| CMDB v2 | ✅ | **写路径无入口**（REST 仅 GET /services） | ❌ 暗代码（无法登记服务/依赖） |
| 态势包 | ✅ | REST /context/:asset | ❌ 404（V2） |
| 资产执行互斥+认领 | ✅ | **未接线**（无生产调用点） | ❌ 暗代码 |
| 异步执行 approveAsync | ✅ | **未接线** | ❌ 暗代码 |
| Break-glass | ✅ | **无入口** | ❌ 暗代码（未做实机验证——封存真实 SSH 密钥有风险，仅代码审阅） |

`docs/manual-test.md` 第 9–12 节的 `skyport serve` / `skyport mcp` / `skyport secret set` / `skyport agent login` 命令**均不存在**，文档与实现脱节。

### 8.2 问题清单

#### V1〔阻断〕`pnpm verify` 在 HEAD 红——最新提交未过自家门禁

- **场景**：`pnpm verify`（AGENTS.md 要求提交前必跑）
- **期望**：typecheck + lint + arch + test + build 全绿
- **实际**：typecheck 即失败：`users.ts(24) TS2322`（真实类型错误）、`serve.ts(19) TS6133`、`static.ts(24) TS6133`（未用变量）；单测另有 1 败（serve whoami 响应结构漂移：测试期望扁平、实现返回 `{actor:{...}}` 包裹层）
- **复现步骤**：`pnpm verify` → 看 tsc 输出
- **修复建议**：修 3 处 TS 错误 + 同步 whoami 测试；CI/钩子把 verify 挂回提交门禁

#### V2〔阻断〕REST 全部带路径参数端点取错 URL 段，真实 ID 也 404

- **场景**：`GET /api/v1/assets/t1`、`GET /api/v1/actions/<真实ID>`、`POST /api/v1/actions/<ID>/approve`、`PATCH /api/v1/alerts/<ID>/ack|close`、`GET /api/v1/context/t1(/summary)`
- **期望**：按参数定位资源
- **实际**：`/api/v1/assets/t1`.split('/') = `['','api','v1','assets','t1']`，代码取 `[3]` = `'assets'`（资源名），应为 `[4]`。**实测真实存在的 t1 与真实行动 ID 均 404 ASSET/ACTION_NOT_FOUND**；approver 经 Web 会话审批真实 pending → 404。manual-test 第 10/12 节全部流程走不通
- **复现步骤**：1. 起 serve 2. 带合法令牌 `curl /api/v1/assets/t1` → 404 3. 对照列表端点确认 t1 存在
- **修复建议**：统一改为 `[4]`（或先剥 `/api/v1` 前缀再取段）；补路径参数端点的 E2E 测试（现有 6 条 serve 测试全部只测列表/无参端点，所以没抓到）

#### V3〔严重〕审计链防篡改惰性：哈希从未写入，篡改实测不可检测

- **场景**：`skyport audit verify`；以及对 action_events 的单行篡改（已快照还原）
- **期望**：H1a 链完整报 N 条；H1c 篡改 detail 后报 hash 不匹配
- **实际**：库里 545 条事件 `hash/seq` 全为 NULL；新产生的行动事件同样无链字段；verify 只查 `WHERE seq IS NOT NULL` → 永远"**审计链完整（0 条记录校验通过）**"。实测篡改最后一条事件 detail 后 verify 仍报完整 exit 0——**防篡改宣称与实现脱节**。根因：`appendChainedEvent/appendChainedExecution`（audit-chain.ts:40/58）是死代码，生产写入端（action-exec.ts:241、actions.ts:318）仍用无链字段的普通 INSERT
- **复现步骤**：1. `skyport run --exec 'echo x'` 2. `skyport audit verify` → "0 条" 3. 查库 `select count(*) from action_events where hash is not null` → 0
- **修复建议**：生产事件/执行写入统一切换到 appendChained* 函数；对存量行做一次回填链化（或 verify 明确报告"存量 N 条未链化"）；0 条时文案改"链未启用/空链"而非"完整"

#### V4〔严重〕高危护栏自锁：`--rollback`/`--dry-run` 旗标不存在

- **场景**：`skyport action create --exec 'shutdown now'`（无 rollback → 拒绝 ✓）；`--exec 'shutdown now' --rollback '重启即可'` → `error: unknown option '--rollback'`；`--dry-run` 同样不存在
- **期望**：manual-test 4a/4b 流程可走通：提供回滚声明的 high 行动能登记；dry-run 评级不落库
- **实际**：护栏服务存在且门口拒绝生效（exit 11，上下文含 risk high），但**没有任何途径合法登记 high 风险行动**——护栏变成了全面禁令；dry-run 也不可用
- **复现步骤**：`skyport action create --exec 'shutdown now' --rollback 'x'` → unknown option
- **修复建议**：action create 接入 `--rollback <text>` 与 `--dry-run` 旗标；补 CLI 层测试

#### V5〔严重〕REST 读端点无视 agent 资产范围（跨范围读取）

- **场景**：assets=`t1*` 的 agent 用自己的 skp_ 令牌 `GET /api/v1/assets`、`GET /api/v1/actions?limit=5`
- **期望**：与 CLI 一致的三件套约束（至少资产范围）
- **实际**：返回 t1/t2/t3 全部资产；行动列表含 local/t3 等范围外目标记录（含其他目标的执行信息）。写端点（approve/ack）的能力门禁正确挡住了 agent，但**读侧完全无范围**——受限 agent 可枚举全部资产拓扑与历史行动
- **复现步骤**：1. 建 `--assets 't1*'` agent 2. `curl -H "Authorization: Bearer skp_..." :7100/api/v1/assets` 3. 全量返回
- **修复建议**：REST 读端点对 agent actor 应用 asset scope 过滤（与 CLI 同一套断言）；至少在 spec 里明示"REST 读=全量"是有意为之并记录

#### V6〔一般〕MCP 适配器完全无鉴权，绕过 REST 认证层

- **场景**：`startMcpServer()`（经 tsx 直启验证）
- **期望**：MCP 客户端凭令牌访问；或明示信任模型
- **实际**：initialize/tools/list/tools/call 正常（7 工具：list/get assets、list/get actions、list services、blast_radius、audit_verify——**纯只读，无审批工具 ✓**），但直连服务层，**零认证**——任何能拉起该进程的本地主体获得全部行动/资产读取权（含 stdout）。REST 层的 Bearer/角色体系对 MCP 完全不生效
- **修复建议**：stdio 场景至少要求环境变量令牌（与 REST 同源校验）；文档明示信任边界=本地进程

#### V7〔一般〕`POST /api/v1/alerts` 对 Bearer agent 跳过能力检查

- **场景**：agent token 直接投递 Alertmanager 格式告警
- **实际**：201 成功（Web 用户需 alerts:write 能力，Bearer agent 因 `user===undefined` 绕过该检查——serve.ts:251）。若是"推送集成"有意设计，需在 spec 写明；否则是能力门禁旁路
- **修复建议**：明确定义 alerts:write 的主体集合；agent 投递应要求 scope

#### V8〔一般〕user 生命周期缺失 + 新命令错误契约回退

- **场景**：非 TTY 下 `skyport user add admin`；建错的用户想删除/停用
- **实际**：① 报 `[skyport] 未知错误: 非 TTY 环境…` exit 1——第一轮 S8 修掉的"未知错误"包装在新代码里回归（应为人话+用法类退出码）；② `user` 组只有 add/list，**没有 remove/disable/pause**——用户一旦建错永远存在（mapErrorToStatus 里有 SKYPORT_USER_DISABLED，但无入口能触发它）
- **修复建议**：补 user 停用/删除命令；错误统一走域码格式化

#### V9〔建议〕杂项

- 未知命令（如 `skyport users`/`skyport serve`）静默回退打印全局 help，无"unknown command"提示
- `/api/v1/health` 硬编码 `"version":"0.3.0"`（与 package.json 0.1.0 也不一致）
- 无凭证应为 401（当前 403，403 留给"认证了但无权"更符合语义）
- serve 默认只听 127.0.0.1 ✓ 值得肯定；静态托管穿越防护（resolve 前缀校验+SPA 回退）正确 ✓
- `docs/manual-test.md` 头部"尚未实现"清单与正文/勾选框/git log 三方矛盾，需重写

### 8.3 通过项（值得保留的基线）

- 登录爆破防护：连续 5 次错密码 → 第 6 次 **429 锁定**（Retry-After 机制就位）
- Web 会话 cookie：`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` ✓；登出吊销会话 ✓
- 角色门禁顺序正确：approve/reject/ack/close 先验能力再取参数（所以 V2 的路由 bug 没有演变成越权）
- viewer 无法审批（403）、agent 令牌无法审批（403）——**"审批只在人"红线在 REST 层守住**
- 无令牌/伪造令牌 → 403（H6f/H6g ✓）
- 告警三格式识别与 400 错误干净；pending 24h 过期护栏 ✓（approve 过期行动 → exit 11 自动作废）
- 进程树击杀有测试且通过；N1 管道截断有回归测试且通过
- backup 命令可用、备份文件 0600、目录 0700

### 8.4 修复优先级建议

1. **V1**（门禁回绿）→ **V2**（REST 参数路由，一处 `[3]→[4]` 级修复 + 补测试）→ **V4**（--rollback/--dry-run 接线）→ **V3**（审计链写入接线，安全宣称生效）
2. **V5**（REST 读范围）；**V8**（user 生命周期）
3. 暗代码功能逐个接入口（serve/mcp 入 CLI、vault/credentials/CMDB 写路径/breakglass/互斥/异步），并同步 manual-test.md 重写
