/**
 * 诊断双层 analyzer 注册表（k8sgpt 模式，PRD §2）：
 * 确定性 analyzer 先跑（免费可靠无幻觉），LLM 只解释与深入。
 * 每个 analyzer 知道查什么、怎么判正常、发现问题怎么给结构化结论。
 */
import { execute, type ExecResult } from '../executor/executor';
import type { Asset } from './assets';

export type AnalyzerCategory = 'disk' | 'process' | 'network' | 'security' | 'service' | 'custom';

export interface AnalyzerResult {
  readonly analyzer: string;
  readonly category: AnalyzerCategory;
  readonly ok: boolean;
  readonly summary: string;
  readonly detail: string | undefined;
  readonly suggestion: string | undefined;
}

export interface Analyzer {
  readonly name: string;
  readonly category: AnalyzerCategory;
  readonly description: string;
  readonly applicableTypes: readonly string[];
  /** 构造检查命令（参数数组，不走 shell） */
  buildCommand(asset: Asset): { command: string; args: readonly string[] } | undefined;
  /** 解析命令输出，返回结构化结论 */
  parse(output: string): Omit<AnalyzerResult, 'analyzer' | 'category'>;
}

// ── 内置 analyzer 注册表 ───────────────────────

const diskUsageAnalyzer: Analyzer = {
  name: 'disk-usage',
  category: 'disk',
  description: '检查各挂载点磁盘使用率',
  applicableTypes: ['host', 'cluster'],
  buildCommand: () => ({ command: 'df', args: ['-h', '--output=pcent,target'] }),
  parse(output) {
    const lines = output.trim().split('\n').slice(1);
    const overThreshold: string[] = [];
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)%\s+(.+)$/);
      if (match !== null && Number(match[1]) > 85) {
        overThreshold.push(`${match[2]}: ${match[1]}%`);
      }
    }
    return {
      ok: overThreshold.length === 0,
      summary: overThreshold.length === 0 ? '所有挂载点使用率正常（<85%）' : `${overThreshold.length} 个挂载点超 85%`,
      detail: overThreshold.length > 0 ? overThreshold.join('; ') : undefined,
      suggestion: overThreshold.length > 0 ? '建议执行磁盘清理技能（skills/disk-cleanup）' : undefined,
    };
  },
};

const memoryUsageAnalyzer: Analyzer = {
  name: 'memory-usage',
  category: 'process',
  description: '检查内存使用率',
  applicableTypes: ['host'],
  buildCommand: () => ({ command: 'free', args: ['-m'] }),
  parse(output) {
    const memLine = output.split('\n').find((l) => l.startsWith('Mem:'));
    if (memLine === undefined) return { ok: false, summary: '无法解析 free 输出', detail: undefined, suggestion: undefined };
    const parts = memLine.split(/\s+/);
    const total = Number(parts[1]);
    const available = Number(parts[6]);
    const usagePct = Math.round(((total - available) / total) * 100);
    return {
      ok: usagePct < 90,
      summary: `内存使用率 ${usagePct}%（${total}MB 总量，${available}MB 可用）`,
      detail: usagePct >= 90 ? '内存使用率超 90%，可能触发 OOM' : undefined,
      suggestion: usagePct >= 90 ? '检查高内存进程，考虑重启或扩容' : undefined,
    };
  },
};

const loadAverageAnalyzer: Analyzer = {
  name: 'load-average',
  category: 'process',
  description: '检查系统负载',
  applicableTypes: ['host'],
  buildCommand: () => ({ command: 'uptime', args: [] }),
  parse(output) {
    const match = output.match(/load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    if (match === null) return { ok: false, summary: '无法解析 uptime 输出', detail: undefined, suggestion: undefined };
    const load1 = Number(match[1]);
    const load5 = Number(match[2]);
    return {
      ok: load1 < 5 && load5 < 5,
      summary: `负载 ${match[1]} ${match[2]} ${match[3]}`,
      detail: load1 >= 5 ? '1 分钟负载超 5，系统过载' : undefined,
      suggestion: load1 >= 5 ? '检查高 CPU 进程（top -b -n1 | head -20）' : undefined,
    };
  },
};

const zombieProcessAnalyzer: Analyzer = {
  name: 'zombie-processes',
  category: 'process',
  description: '检查僵尸进程数量',
  applicableTypes: ['host'],
  buildCommand: () => ({ command: 'ps', args: ['-eo', 'stat,', '-o', 'pid,', '-o', 'comm'] }),
  parse(output) {
    const zombies = output.split('\n').filter((l) => l.trim().startsWith('Z'));
    return {
      ok: zombies.length === 0,
      summary: zombies.length === 0 ? '无僵尸进程' : `发现 ${zombies.length} 个僵尸进程`,
      detail: zombies.length > 0 ? zombies.slice(0, 5).join('; ') : undefined,
      suggestion: zombies.length > 0 ? '找到父进程并重启或 kill' : undefined,
    };
  },
};

const diskInodeAnalyzer: Analyzer = {
  name: 'disk-inode',
  category: 'disk',
  description: '检查 inode 使用率（小文件耗尽场景）',
  applicableTypes: ['host'],
  buildCommand: () => ({ command: 'df', args: ['-i', '--output=ipcent,target'] }),
  parse(output) {
    const lines = output.trim().split('\n').slice(1);
    const overThreshold: string[] = [];
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)%\s+(.+)$/);
      if (match !== null && Number(match[1]) > 90) {
        overThreshold.push(`${match[2]}: ${match[1]}%`);
      }
    }
    return {
      ok: overThreshold.length === 0,
      summary: overThreshold.length === 0 ? 'inode 使用率正常' : `${overThreshold.length} 个挂载点 inode 超 90%`,
      detail: overThreshold.length > 0 ? overThreshold.join('; ') : undefined,
      suggestion: overThreshold.length > 0 ? '大量小文件耗尽 inode，清理缓存/临时文件' : undefined,
    };
  },
};

/** 注册表（可扩展） */
export const ANALYZER_REGISTRY: readonly Analyzer[] = [
  diskUsageAnalyzer,
  diskInodeAnalyzer,
  memoryUsageAnalyzer,
  loadAverageAnalyzer,
  zombieProcessAnalyzer,
];

/** 运行指定资产的所有匹配 analyzer（确定性检查先跑，LLM 只解释） */
export async function runAnalyzers(
  asset: Asset,
  options: { names?: readonly string[] } = {},
): Promise<AnalyzerResult[]> {
  const applicable = ANALYZER_REGISTRY.filter((a) => {
    if (!a.applicableTypes.includes(asset.type)) return false;
    if (options.names !== undefined && !options.names.includes(a.name)) return false;
    return true;
  });

  const results: AnalyzerResult[] = [];
  for (const analyzer of applicable) {
    const spec = analyzer.buildCommand(asset);
    if (spec === undefined) continue;
    try {
      const execResult: ExecResult = await execute(spec.command, spec.args, { timeoutMs: 5_000, maxRetries: 0 });
      const parsed = analyzer.parse(execResult.stdout);
      results.push({ analyzer: analyzer.name, category: analyzer.category, ...parsed });
    } catch (error) {
      results.push({
        analyzer: analyzer.name,
        category: analyzer.category,
        ok: false,
        summary: `analyzer 执行失败: ${error instanceof Error ? error.message : String(error)}`,
        detail: undefined,
        suggestion: '检查 executor 权限与网络连通性',
      });
    }
  }
  return results;
}

/** 获取注册表摘要（供 UI/REST 展示） */
export function listAnalyzers(): { name: string; category: string; description: string; types: string[] }[] {
  return ANALYZER_REGISTRY.map((a) => ({
    name: a.name,
    category: a.category,
    description: a.description,
    types: [...a.applicableTypes],
  }));
}
