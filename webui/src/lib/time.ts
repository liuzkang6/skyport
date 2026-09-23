/**
 * 时间显示统一口径（QA #8）：全站本地时区、同一格式——
 * 此前看板本地时间 / 审计 UTC 截断 / 我的原始 ISO 串三种口径混用（UTC+8 下差 8 小时）。
 */

/** 完整时间：2026-09-23 15:19:38（本地时区） */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 短时间：15:19:38（本地时区，看板卡片/时间线用） */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 中时间：09-23 15:19（列表行用，保持紧凑） */
export function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
