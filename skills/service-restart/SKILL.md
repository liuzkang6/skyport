---
name: service-restart
description: 服务重启处置预案。当收到服务异常告警（5xx/超时/OOM）时使用。包含诊断、分级重启、回滚。
---

# 服务重启

## 适用场景
服务响应异常（超时/5xx/OOM/进程崩溃），需要重启恢复。

## 诊断步骤（调查员执行）

1. 检查服务状态：`systemctl status <service>`
2. 检查最近日志：`journalctl -u <service> --since "10 minutes ago" | tail -50`
3. 检查资源：`systemctl show <service> -p MemoryCurrent`
4. 检查进程：`ps aux | grep <service>`

## 处置方案（处置员提案）

### 软重启（中风险）
```bash
systemctl restart <service>
```
回滚声明：服务重启即恢复操作。如重启后仍异常，考虑回滚最近变更。

### 硬杀后重启（高风险，需审查员复核）
```bash
systemctl stop <service>
pkill -9 -f <service_pattern>
systemctl start <service>
```
回滚声明：强杀可能导致数据不一致，需检查服务健康。

## 验证步骤
1. `systemctl is-active <service>` → active
2. 健康检查端点返回 200
3. 日志无 ERROR 级别条目持续 60 秒

## 告警指纹
- `ServiceDown*` / `HTTP5xx*` / `OOMKilled*` / `ProcessCrash*`
