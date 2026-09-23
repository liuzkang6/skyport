/**
 * vendor 工作流引擎桥接模块：将 skyport 剧本定义映射到 vendored ZCode 工作流设计语法，
 * 并把执行交给 vendored WorkflowGraphScheduler 真跑（v0.6 收尾：不再委托原生引擎）。
 *
 * 类型映射（skyport → ZCode workflow）：
 *   PlaybookDefinition  ↔  WorkflowRunSnapshot（vendor/scheduler 的运行快照）
 *   PlaybookStep        ↔  WorkflowGraphNode（kind=步骤类型，metadata 携带命令/失败策略）
 *   PlaybookRunResult   ↔  WorkflowGraphSchedulerRunResult（reason/status → completed/aborted/awaiting）
 *   executeStep()       ↔  GovernedRunner.run()（vendor-engine.ts：每步经 skyport 行动系统）
 *   审批门              ↔  节点失败 → 引擎错误阈值 paused → awaiting-approval
 *   三相毕业            ↔  training/shadow（记录不执行）/detect（真执行）
 *
 * 原生 playbook.ts（executePlaybook）保留作为对照实现与降级路径。
 */

import type { PlaybookDefinition, PlaybookStep, PlaybookRunResult, PlaybookMode } from './playbook';
import type { ActorRef } from './agents';
import { executeViaVendorEngine, compilePlaybookToSnapshot, type VendorEngineOptions } from './vendor-engine';

// ── vendored 引擎类型引用（仅类型，不引入运行时依赖）──

/** 对应 vendor/workflow/definition.ts 中的定义结构 */
interface VendoredWorkflowDefinition {
  readonly id: string;
  readonly description: string;
  readonly phases: readonly string[];
  readonly nodes: readonly unknown[];
}

/** 桥接映射：skyport 剧本 → vendored 工作流定义 */
export function toVendoredDefinition(playbook: PlaybookDefinition): VendoredWorkflowDefinition {
  return {
    id: playbook.name,
    description: playbook.description,
    phases: ['training', 'shadow', 'detect'].slice(0, playbook.mode === 'training' ? 1 : playbook.mode === 'shadow' ? 2 : 3),
    nodes: playbook.steps.map(toVendoredNode),
  };
}

/** skyport 剧本步骤 → vendored 节点 */
function toVendoredNode(step: PlaybookStep): Record<string, unknown> {
  return {
    id: step.id,
    type: mapStepType(step.type),
    command: step.command,
    description: step.description,
    onFailure: step.onFailure,
    rollbackStepId: step.rollbackStepId,
  };
}

function mapStepType(type: string): string {
  const mapping: Record<string, string> = {
    'check': 'read',
    'action': 'execute',
    'approval-gate': 'gate',
    'verify': 'verify',
    'notify': 'notify',
    'rollback': 'rollback',
  };
  return mapping[type] ?? type;
}

/** 反向映射：vendored 节点 → skyport 剧本步骤 */
export function fromVendoredNode(node: Record<string, unknown>): PlaybookStep {
  const reverseMapping: Record<string, string> = {
    'read': 'check',
    'execute': 'action',
    'gate': 'approval-gate',
    'verify': 'verify',
    'notify': 'notify',
    'rollback': 'rollback',
  };
  return {
    id: String(node.id),
    type: (reverseMapping[String(node.type)] ?? String(node.type)) as PlaybookStep['type'],
    command: node.command !== undefined ? String(node.command) : undefined,
    description: String(node.description),
    onFailure: (node.onFailure ?? 'abort') as PlaybookStep['onFailure'],
    rollbackStepId: node.rollbackStepId !== undefined ? String(node.rollbackStepId) : undefined,
    notifyMessage: node.notifyMessage !== undefined ? String(node.notifyMessage) : undefined,
  };
}

/** 桥接执行：vendored WorkflowGraphScheduler 真跑（每步经 skyport 行动系统，治理透明生效） */
export async function executeViaBridge(
  playbook: PlaybookDefinition,
  actor: ActorRef,
  options: VendorEngineOptions = {},
): Promise<PlaybookRunResult> {
  return executeViaVendorEngine(playbook, actor, options);
}

/** 编译映射导出：剧本 → 引擎运行快照（调试/预热用） */
export function compileForEngine(playbook: PlaybookDefinition): ReturnType<typeof compilePlaybookToSnapshot> {
  return compilePlaybookToSnapshot(playbook);
}

/** 导出映射信息供文档/调试用 */
export function getBridgeMapping(): {
  skyportTypes: readonly string[];
  vendoredTypes: readonly string[];
  modeMapping: Record<PlaybookMode, string>;
} {
  return {
    skyportTypes: ['check', 'action', 'approval-gate', 'verify', 'notify', 'rollback'],
    vendoredTypes: ['read', 'execute', 'gate', 'verify', 'notify', 'rollback'],
    modeMapping: { training: 'phase-1', shadow: 'phase-2', detect: 'phase-3' },
  };
}
