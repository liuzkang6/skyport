/**
 * vendor 工作流引擎桥接模块：将 skyport 剧本定义映射到 vendored ZCode 工作流设计语法。
 * vendor/zcode-runtime/workflow/ 中的引擎提供了 reference 实现（scheduler/lifecycle/journal），
 * 本桥接模块建立类型映射与适配接口，使 playbook.ts 的运行时可以逐步迁移到 vendored 引擎。
 *
 * 类型映射（skyport → ZCode workflow）：
 *   PlaybookDefinition  ↔  WorkflowDefinition（vendor/workflow/definition.ts）
 *   PlaybookStep        ↔  WorkflowNode（vendor/scheduler/graph.ts 的节点概念）
 *   PlaybookRunResult   ↔  WorkflowSchedulerRunResult（vendor/scheduler/types.ts）
 *   executeStep()       ↔  runWorkflowNode()（vendor/scheduler/node-runner.ts）
 *   审批门              ↔  Phase 边界（vendor/workflow/lifecycle.ts 的 phase 概念）
 *   三相毕业            ↔  Phase 状态（training/shadow/detect 对应 ZCode 的阶段推进）
 */

import type { PlaybookDefinition, PlaybookStep, PlaybookRunResult, PlaybookMode } from './playbook';
import type { ActorRef } from './agents';
import { executePlaybook } from './playbook';

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

/** 桥接执行：当前委托给原生 playbook 引擎，逐步迁移到 vendored 引擎 */
export async function executeViaBridge(
  playbook: PlaybookDefinition,
  actor: ActorRef,
): Promise<PlaybookRunResult> {
  // 当前实现：委托给原生 playbook.ts（已有 10 条测试覆盖）
  // 迁移路径：当 vendored 引擎的运行时依赖被解析后，
  // 将此委托替换为 vendored scheduler 的调用
  return executePlaybook(playbook, actor);
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
