/**
 * @zcode/contracts 垫片（skyport fork 维护）：
 * vendored ZCode 工作流引擎（scheduler/lifecycle/graph）依赖上游契约包的
 * 类型与派生函数；上游包未随源码 vendor，此文件按引擎的实际用法重建契约，
 * 使引擎能在 skyport 内真跑。字段一律 `?: T | undefined` 以兼容
 * exactOptionalPropertyTypes（引擎源码存在显式 undefined 赋值）。
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// ── 节点与图 ─────────────────────────────

export type WorkflowNodeStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface WorkflowGraphNode {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly prompt?: string | undefined;
  readonly phase?: string | undefined;
  readonly status: WorkflowNodeStatus;
  readonly attempts?: number | undefined;
  readonly error?: string | undefined;
  readonly reopenAttempts?: number | undefined;
  readonly kind?: string | undefined;
  readonly collectionId?: string | undefined;
  readonly dependsOn: readonly string[];
  /** skyport 扩展：受治理步骤语义（命令/失败策略/回滚引用） */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface WorkflowGraphEdge {
  readonly from: string;
  readonly to: string;
}

export type WorkflowGraphCollectionStatus = 'active' | 'draining' | 'exhausted';

export interface WorkflowGraphCollection {
  readonly collectionId: string;
  readonly title?: string | undefined;
  readonly goal?: string | undefined;
  readonly metric?: string | undefined;
  readonly phase?: string | undefined;
  readonly explorable?: boolean | undefined;
  readonly frontierTarget?: number | undefined;
  readonly nodeIds?: string[] | undefined;
  readonly analyzedNodeIds?: string[] | undefined;
  readonly errorCount?: number | undefined;
  readonly exhausted?: boolean | undefined;
  readonly plannerRuns?: number | undefined;
  readonly status?: WorkflowGraphCollectionStatus | undefined;
  readonly lastCompletionAt?: string | undefined;
  readonly lastGraphChangeAt?: string | undefined;
}

export interface WorkflowGraph {
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly collections?: readonly WorkflowGraphCollection[] | undefined;
}

// ── 运行快照 ─────────────────────────────

export interface WorkflowActivitySnapshot {
  readonly activityId: string;
  readonly kind: 'agent_session' | 'planner_agent';
  readonly nodeId?: string | undefined;
  readonly collectionId?: string | undefined;
  readonly phase: string;
  readonly status: WorkflowNodeStatus;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly model?: string | undefined;
  readonly parentSessionId?: string | undefined;
  readonly artifactPath?: string | undefined;
  readonly inputArtifactPaths: readonly string[];
  readonly outputArtifactPaths: readonly string[];
}

export interface WorkflowArtifact {
  readonly path: string;
  readonly label: string;
  readonly contentType: string;
  readonly createdAt: string;
  readonly phase: string;
}

export interface WorkflowPhaseSnapshot {
  readonly phase: string;
  readonly status: WorkflowNodeStatus;
  readonly error?: string | undefined;
  readonly completedAt?: string | undefined;
}

export interface WorkflowSessionLinks {
  readonly runId: string;
  readonly sessionIds: readonly string[];
  readonly links: readonly { readonly activityId: string; readonly sessionId: string }[];
}

export interface WorkflowRunSnapshot {
  readonly runId: string;
  readonly kind: string;
  readonly task: string;
  readonly cwd: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
  readonly strategy: {
    readonly executor: {
      readonly maxConcurrentLoops: number;
      readonly maxConsecutiveErrors: number;
      readonly maxPlannerRuns: number;
      readonly frontierTarget: number;
      readonly drainingChangeHours: number;
    };
  };
  readonly graph: WorkflowGraph;
  readonly phases: readonly WorkflowPhaseSnapshot[];
  readonly activities: readonly WorkflowActivitySnapshot[];
  readonly artifacts: readonly WorkflowArtifact[];
  readonly sessionLinks: WorkflowSessionLinks;
}

// ── 事件与记录 ─────────────────────────────

export interface WorkflowEvent {
  readonly kind: string;
  readonly type: string;
  readonly message?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
  readonly phase?: string | undefined;
  readonly runId: string;
  readonly timestamp: string;
}

export type WorkflowGraphRecord =
  | {
      readonly runId: string;
      readonly recordType: 'op';
      readonly nodeId: string;
      readonly phase: string;
      readonly status: WorkflowNodeStatus;
      readonly timestamp: string;
      readonly type: string;
    }
  | {
      readonly runId: string;
      readonly recordType: 'collection';
      readonly collection: WorkflowGraphCollection;
      readonly timestamp: string;
    }
  | {
      readonly runId: string;
      readonly recordType: 'node';
      readonly node: WorkflowGraphNode;
      readonly timestamp: string;
    }
  | {
      readonly runId: string;
      readonly recordType: 'edge';
      readonly edge: WorkflowGraphEdge;
      readonly timestamp: string;
    }
  | {
      readonly runId: string;
      readonly recordType: 'op';
      readonly collectionId: string;
      readonly edgeIds: readonly string[];
      readonly nodeIds: readonly string[];
      readonly payload: Readonly<Record<string, unknown>>;
      readonly phase: string;
      readonly timestamp: string;
      readonly type: string;
    };

/** 会话事件（引擎透传，具体形状由宿主定义） */
export interface SessionEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface TraceContext {
  readonly traceId: string;
  readonly spanId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

// ── 图种子与规划器结果（zod schema）──────────────

const graphSeedNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  collectionId: z.string().optional(),
  kind: z.string().optional(),
  phase: z.string().optional(),
});

const graphSeedEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

const graphSeedCollectionSchema = z.object({
  collectionId: z.string(),
  title: z.string().optional(),
  goal: z.string().optional(),
  metric: z.string().optional(),
  phase: z.string().optional(),
  explorable: z.boolean().optional(),
  frontierTarget: z.number().optional(),
  nodeIds: z.array(z.string()).optional(),
});

export interface WorkflowGraphSeed {
  readonly nodes: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string | undefined;
    readonly prompt?: string | undefined;
    readonly dependsOn?: readonly string[] | undefined;
    readonly collectionId?: string | undefined;
    readonly kind?: string | undefined;
    readonly phase?: string | undefined;
  }[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly collections: readonly {
    readonly collectionId: string;
    readonly title?: string | undefined;
    readonly goal?: string | undefined;
    readonly metric?: string | undefined;
    readonly phase?: string | undefined;
    readonly explorable?: boolean | undefined;
    readonly frontierTarget?: number | undefined;
    readonly nodeIds?: readonly string[] | undefined;
  }[];
}

export const WorkflowGraphSeedSchema: { parse(input: unknown): WorkflowGraphSeed } = {
  parse(input: unknown): WorkflowGraphSeed {
    const parsed = z.object({
      nodes: z.array(graphSeedNodeSchema),
      edges: z.array(graphSeedEdgeSchema).default([]),
      collections: z.array(graphSeedCollectionSchema).default([]),
    }).parse(input);
    return parsed as WorkflowGraphSeed;
  },
};

export interface WorkflowNodePromptUpdate {
  readonly id: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly prompt?: string | undefined;
}

export const WorkflowNodePromptUpdateSetSchema: { parse(input: unknown): { nodes: readonly WorkflowNodePromptUpdate[] } } = {
  parse(input: unknown): { nodes: readonly WorkflowNodePromptUpdate[] } {
    return z
      .object({ nodes: z.array(z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        prompt: z.string().optional(),
      })) })
      .parse(input) as { nodes: readonly WorkflowNodePromptUpdate[] };
  },
};

export interface WorkflowGraphPlannerNode {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly prompt?: string | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly collectionId?: string | undefined;
  readonly kind?: string | undefined;
  readonly phase?: string | undefined;
}

export interface WorkflowGraphPlannerResult {
  readonly nodes?: readonly WorkflowGraphPlannerNode[] | undefined;
  readonly edges?: readonly WorkflowGraphEdge[] | undefined;
  readonly collectionNodeIds?: readonly string[] | undefined;
  readonly exhausted?: boolean | undefined;
  readonly reasoning?: string | undefined;
}

export const WorkflowGraphPlannerResultSchema: { parse(input: unknown): WorkflowGraphPlannerResult } = {
  parse(input: unknown): WorkflowGraphPlannerResult {
    return z.object({
      nodes: z.array(graphSeedNodeSchema).optional(),
      edges: z.array(graphSeedEdgeSchema).optional(),
      collectionNodeIds: z.array(z.string()).optional(),
      exhausted: z.boolean().optional(),
      reasoning: z.string().optional(),
    }).parse(input) as WorkflowGraphPlannerResult;
  },
};

// ── 调度派生函数 ─────────────────────────────

export interface WorkflowSchedulerBlockedNode {
  readonly nodeId: string;
  readonly blockedBy: string[];
}

export interface WorkflowSchedulerState {
  readonly readyNodeIds: string[];
  readonly blockedNodes: WorkflowSchedulerBlockedNode[];
}

const COMPLETED_STATUSES: ReadonlySet<WorkflowNodeStatus> = new Set(['completed', 'cancelled', 'skipped']);

/** 图级调度状态：就绪 = pending 且全部上游已完成；阻塞 = pending 且存在未完成上游 */
export function deriveWorkflowSchedulerState(graph: WorkflowGraph): WorkflowSchedulerState {
  const statusById = new Map(graph.nodes.map((node) => [node.id, node.status] as const));
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }
  const readyNodeIds: string[] = [];
  const blockedNodes: WorkflowSchedulerBlockedNode[] = [];
  for (const node of graph.nodes) {
    if (node.status !== 'pending') continue;
    const deps = incoming.get(node.id) ?? [];
    const unmet = deps.filter((dep) => {
      const status = statusById.get(dep);
      return status === undefined || !COMPLETED_STATUSES.has(status);
    });
    if (unmet.length === 0) {
      readyNodeIds.push(node.id);
    } else {
      blockedNodes.push({ nodeId: node.id, blockedBy: unmet });
    }
  }
  return { readyNodeIds, blockedNodes };
}

export type WorkflowSchedulerDerivedNode = WorkflowGraphNode;

/** 运行快照级调度状态（snapshot.graph 的图级派生） */
export function deriveWorkflowRunSchedulerState(snapshot: WorkflowRunSnapshot): WorkflowSchedulerState {
  return deriveWorkflowSchedulerState(snapshot.graph);
}

/** 活动快照 → 会话链接索引 */
export function deriveWorkflowSessionLinks(input: {
  readonly activities: readonly WorkflowActivitySnapshot[];
  readonly runId: string;
}): WorkflowSessionLinks {
  const links = input.activities
    .filter((activity) => activity.sessionId !== undefined && activity.sessionId !== '')
    .map((activity) => ({ activityId: activity.activityId, sessionId: activity.sessionId as string }));
  return {
    runId: input.runId,
    sessionIds: [...new Set(links.map((link) => link.sessionId))],
    links,
  };
}

/** 派生子追踪上下文（traceId 继承，spanId 新开） */
export function createChildTraceContext(
  parent: TraceContext,
  options: {
    readonly attributes?: Readonly<Record<string, unknown>> | undefined;
    readonly sessionId?: string | undefined;
  },
): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomBytes(8).toString('hex'),
    sessionId: options.sessionId ?? parent.sessionId,
    attributes: { ...(parent.attributes ?? {}), ...(options.attributes ?? {}) },
  };
}
