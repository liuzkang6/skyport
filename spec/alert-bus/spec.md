# spec — 告警总线（v0.4 观测层核心）

状态：开发中 · 驱动：PRD §2 告警总线 + Alerta 模型 + versus ACK SLA

## 产品规则

### 告警数据模型（沿用 Alerta 成熟设计，不自创）

```
告警 = {
  event:     string          // 事件名（"磁盘使用率超阈值"）
  resource:  string          // 资源标识（资产名或自定义）
  severity:  critical|warning|info
  status:    open|ack|closed  // 生命周期
  value:     string          // 触发值（"91%"）
  text:      string          // 描述文本
  tags:      [string]        // 标签（env=prod,cloud=aliyun）
  attributes: {}             // 扩展属性
  correlate: [string]        // 关联事件名列表（severity 变化不产生新告警）
  origin:    string          // 来源（zabbix/prometheus/agent/api）
  timestamp: ISO8601
}
```

### 生命周期

```
open → ack（人已知的凭证）→ closed（恢复）
open → closed（自动恢复）
```

- severity 变化（如 warning→critical）**产生历史记录**，不创建新告警
- 去重键 = resource + event + origin（同一资源同一事件同一来源 = 重复，更新而不新建）

### 告警接入

REST 端点 `POST /api/v1/alerts`，接受三种格式适配器：

| 适配器 | Content-Type 判断 | 格式 |
| --- | --- | --- |
| Alertmanager | body 含 `alerts` 数组 | Prometheus Alertmanager webhook |
| Zabbix | body 含 `eventid` + `trigger` | Zabbix webhook media |
| 通用 | 其他 | skyport 原生格式 |

### ACK SLA 升级链

- critical 告警 5 分钟未 ack → webhook 升级通知（"⚠ critical 告警超 5 分钟未确认"）
- warning 告警 30 分钟未 ack → webhook 升级通知
- 升级不重复（每个告警最多升级一次）

### 告警→资产关联

- 按 resource 字段匹配资产名或地址
- 匹配成功 → 挂载 asset_id，可用于影响面查询
- 匹配失败 → 标记 uncorrelated

## 接口

| 端点 | 说明 |
| --- | --- |
| POST /api/v1/alerts | 告警接入（自动检测格式） |
| GET /api/v1/alerts?status=open | 查询告警列表 |
| PATCH /api/v1/alerts/:id/ack | 确认告警 |
| PATCH /api/v1/alerts/:id/close | 关闭告警 |
| GET /api/v1/alerts/stats | 统计（open/ack/closed by severity） |

## 验收场景

1. Alertmanager 格式 webhook POST → 解析为标准告警，状态 open
2. Zabbix 格式 webhook POST → 同上
3. 同 resource+event 重复告警 → 更新（不新建），severity 变化记历史
4. ack 后超时升级 → webhook 收到升级通知
5. 告警 resource 匹配资产 → asset_id 自动关联

## 失败路径

- 无效 JSON → 400
- 缺少必填字段 → 400
- 未知 severity → 400
- ack/close 不存在的告警 → 404
- 已 closed 的告警不能 ack → 400
