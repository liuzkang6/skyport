/**
 * 态势包 v1 / Context Pack（PRD 知识层核心）：告警触发时平台自动组装的
 * 有界结构化简报，AI 拿包开工，永远不从零开始。
 * 组装来源：资产卡 + 基线对照 + 近期变更 + 历史档案 + 告警上下文 + 爆炸半径。
 */
import { getAsset, type Asset } from './assets';
import { getBlastRadius, getAssetServices, type Service } from './cmdb';
import { listAlerts, type Alert } from './alert-bus';
import { listActions } from './action-queries';
import { getCheckHistory } from './assets';

export interface ContextPack {
  /** 资产卡 */
  readonly asset: {
    readonly name: string;
    readonly type: string;
    readonly addr: string | undefined;
    readonly labels: Readonly<Record<string, string>>;
    readonly status: string;
    readonly lastCheckAt: string | undefined;
    readonly lastCheckLatencyMs: number | undefined;
  };
  /** 基线对照（检查历史摘要） */
  readonly checks: readonly {
    readonly ok: boolean;
    readonly latencyMs: number | undefined;
    readonly error: string | undefined;
    readonly checkedAt: string;
  }[];
  /** 关联告警（同资产的开放告警） */
  readonly openAlerts: readonly Alert[];
  /** 近期变更（该资产上最近 N 条行动） */
  readonly recentActions: readonly {
    readonly id: string;
    readonly command: string;
    readonly status: string;
    readonly actor: string;
    readonly createdAt: string;
  }[];
  /** 拓扑影响面 */
  readonly blastRadius: {
    readonly services: readonly string[];
    readonly upstream: readonly string[];
    readonly downstream: readonly string[];
  };
  /** 关联服务 */
  readonly services: readonly string[];
  /** 组装时间 */
  readonly assembledAt: string;
}

const RECENT_ACTIONS_LIMIT = 5;
const CHECK_HISTORY_LIMIT = 5;

/** 组装态势包（平台负责组装，AI 不从零开始） */
export function buildContextPack(assetNameOrId: string): ContextPack {
  const asset = getAsset(assetNameOrId);
  const checks = getCheckHistory(asset.id, CHECK_HISTORY_LIMIT);
  const openAlerts = listAlerts('open').filter(
    (alert) => alert.assetId === asset.id || alert.resource === asset.name,
  );
  const recentActions = listActions({ target: asset.name, limit: RECENT_ACTIONS_LIMIT });
  const blast = safeBlastRadius(asset);
  const services = safeAssetServices(asset);

  return {
    asset: {
      name: asset.name,
      type: asset.type,
      addr: asset.addr,
      labels: asset.labels,
      status: asset.status,
      lastCheckAt: asset.lastCheckAt,
      lastCheckLatencyMs: asset.lastCheckLatencyMs,
    },
    checks: checks.map((c) => ({
      ok: c.ok,
      latencyMs: c.latencyMs,
      error: c.error,
      checkedAt: c.checkedAt,
    })),
    openAlerts,
    recentActions: recentActions.actions.map((a) => ({
      id: a.id,
      command: a.command,
      status: a.status,
      actor: `${a.actorType}:${a.actorName ?? a.actorId}`,
      createdAt: a.createdAt,
    })),
    blastRadius: blast,
    services,
    assembledAt: new Date().toISOString(),
  };
}

/** REST 端点用的摘要版（不含完整告警对象） */
export interface ContextPackSummary {
  readonly assetName: string;
  readonly assetStatus: string;
  readonly openAlertCount: number;
  readonly recentActionCount: number;
  readonly serviceCount: number;
  readonly blastRadiusDownstream: number;
  readonly assembledAt: string;
}

export function summarizeContextPack(pack: ContextPack): ContextPackSummary {
  return {
    assetName: pack.asset.name,
    assetStatus: pack.asset.status,
    openAlertCount: pack.openAlerts.length,
    recentActionCount: pack.recentActions.length,
    serviceCount: pack.services.length,
    blastRadiusDownstream: pack.blastRadius.downstream.length,
    assembledAt: pack.assembledAt,
  };
}

function safeBlastRadius(asset: Asset): { services: string[]; upstream: string[]; downstream: string[] } {
  try {
    const blast = getBlastRadius(asset.name);
    return {
      services: blast.services.map((s) => s.name),
      upstream: blast.upstream.map((s) => s.name),
      downstream: blast.downstream.map((s) => s.name),
    };
  } catch {
    return { services: [], upstream: [], downstream: [] };
  }
}

function safeAssetServices(asset: Asset): string[] {
  try {
    return getAssetServices(asset.id).map((s: Service) => s.name);
  } catch {
    return [];
  }
}
