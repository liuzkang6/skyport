---
name: disk-cleanup
description: 磁盘空间清理处置预案。当收到磁盘告警（使用率超阈值）时使用此技能。包含诊断步骤、安全清理命令、回滚方案。
---

# 磁盘空间清理

## 适用场景
磁盘使用率超过阈值（通常 85%+），需要定位大文件并安全清理。

## 诊断步骤（调查员执行）

1. 确认当前使用率：`df -h <挂载点>`
2. 找出大目录（只读）：`du -sh /* 2>/dev/null | sort -rh | head -10`
3. 检查日志目录：`du -sh /var/log/* 2>/dev/null | sort -rh | head -5`
4. 检查临时文件：`find /tmp -type f -size +100M 2>/dev/null | head -10`
5. 检查是否有已删除但仍占空间的文件：`lsof +L1 | head -10`

## 处置方案（处置员提案）

### 安全清理（推荐，中风险）
```bash
# 清理 7 天前的日志（回滚方案：文件移入隔离区）
mkdir -p /var/quarantine
find /var/log -name "*.log" -mtime +7 -exec mv {} /var/quarantine/ \;
journalctl --vacuum-time=7d
```
回滚声明：文件移入 /var/quarantine，可随时移回。

### 深度清理（高风险，需审查员复核）
```bash
# 清理包管理器缓存
apt-get clean  # 或 yum clean all
# 清理 Docker 无用镜像
docker system prune -af --volumes 2>/dev/null || true
```
回滚声明：包缓存可重新下载；Docker 镜像可重新拉取。

## 验证步骤
清理后执行 `df -h <挂载点>` 确认使用率降至安全线（通常 <80%）。

## 告警指纹
- `DiskUsage*` / `disk_full` / `HighDiskUsage`
