# spec — 高危护栏（v0.3.x）

状态：开发中 · 驱动：PRD §2 高危防线

## 产品规则

1. **回滚必填**：创建 high 风险行动时 `--rollback` 参数必填，否则拒绝登记
2. **强确认**：approve 一条 high 风险行动时，CLI 要求键入完整 action ID（防手滑），加 `--force` 可跳过（不推荐）
3. **pending 24h 过期**：pending 行动超过 24 小时自动作废（防止积压旧待办在环境变化后被误批）
4. **dry-run**：`action create --dry-run` 只做风险评级与展示，不落库不执行
5. **僵尸对账**：`doctor` 检查 `executing` 状态超过 10 分钟的行动并标记为可疑

## 接口

| 变更 | 说明 |
| --- | --- |
| `action create` 加 `--rollback <text>` 与 `--dry-run` | 回滚声明；预演模式 |
| `approve <id>` 对 high 风险加确认 | 需键入完整 ID 或 `--force` |
| doctor 加僵尸检查项 | executing 超 10 分钟告警 |

## 失败路径

- high 风险无 `--rollback` → `ACTION_INVALID`
- approve high 时键入的 ID 不匹配 → 拒绝（不限重试次数，Ctrl+C 退出）
- pending 超 24h → 自动标记为 `cancelled`（事件 `expired`）
- dry-run → 输出评级结果后 exit 0，不产生任何库写入
