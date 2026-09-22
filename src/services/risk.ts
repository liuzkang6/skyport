/**
 * 风险分级引擎（P0-S3/S4/S14 加固，spec/governance-loop/spec.md「风险分级」节）。
 * 关键决定：
 * - 评估基于 parseSegments 的 token 段（与执行层同一引号语义），组合命令逐段评估取最大值；
 * - 旗标按集合语义（-rf = -r -f = --recursive --force），引号包裹先剥；
 * - 白名单与自动执行资格只给"单段且无命令替换"的命令；
 * - ssh/scp 段提取二级目标（pivots）交由 actions 层做资产范围校验；kubectl/docker exec/nsenter 直接 high；
 * - 地板规则：命令替换（反引号/$()）至少 medium；无法确认结构的命令宁可 medium。
 */
import { readJsonFileSync } from '../adapters/fs';
import { DATA_DIR, getConfig } from '../config/config';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { translateIssues } from '../errors/messages';
import { rootLogger } from '../logger/logger';
import { normalizeCommand, parseSegments } from './risk-parse';
import { z } from 'zod';

export { normalizeCommand, tokenizeCommand } from './risk-parse';

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_WEIGHT: Readonly<Record<RiskLevel, number>> = { low: 10, medium: 20, high: 30 };

/** 策略文件名（只放在数据目录 ~/.skyport/，红队 S2：cwd 是被治理方可写区） */
export const POLICY_FILENAME = 'skyport.policy.json';

export const COMMAND_MAX_LENGTH = 2_000;
export const REASON_MAX_LENGTH = 500;

const policySchema = z.strictObject({
  rules: z.array(z.strictObject({ pattern: z.string().min(1), level: z.enum(RISK_LEVELS) })).default([]),
  whitelist: z.array(z.string().min(1)).default([]),
  autoExecLowRisk: z.boolean().default(false),
});

export interface RiskPolicy {
  readonly rules: readonly { readonly pattern: string; readonly level: RiskLevel }[];
  readonly whitelist: readonly string[];
  readonly autoExecLowRisk: boolean;
}

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly source: 'policy-whitelist' | 'policy-rule' | 'builtin-rule' | 'default-low';
  readonly matched: string | undefined;
  /** 各段规范化文本（审批界面与诊断用） */
  readonly segments: readonly string[];
  /** 多段或有命令替换 → 不具备 autoExecLowRisk 资格（即使整体 low 也要人工审批） */
  readonly autoExecEligible: boolean;
  /** ssh/scp 段解析出的二级目标候选（主机名），由 actions 层做资产范围校验 */
  readonly pivots: readonly string[];
}

export function defaultPolicyPath(): string {
  return `${DATA_DIR}/${POLICY_FILENAME}`;
}

export function loadPolicy(policyPath: string = getConfig().policyPath ?? defaultPolicyPath()): RiskPolicy {
  const explicit = getConfig().policyPath;
  if (explicit !== undefined) {
    warnOnce(`策略文件为显式自定义路径: ${explicit}（请确认该路径在信任边界内）`);
  }
  let raw: unknown;
  try {
    raw = readJsonFileSync(policyPath);
  } catch (error) {
    if (isSkyportError(error) && error.type === ERROR_CODES.FS_NOT_FOUND) {
      return policySchema.parse({});
    }
    // 策略文件是安全资产：读得出但坏内容时宁拒不猜
    throw createError(ERROR_CODES.CONFIG_INVALID, `策略文件读取失败: ${policyPath}`, {
      cause: error,
      context: { path: policyPath },
    });
  }
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    throw createError(ERROR_CODES.CONFIG_INVALID, `策略文件不合法: ${policyPath}`, {
      context: { path: policyPath, issues: translateIssues(parsed.error.issues) },
    });
  }
  if (parsed.data.autoExecLowRisk) {
    warnOnce('autoExecLowRisk 已开启：低危命令将免审批自动执行（确认这是你想要的治理姿态）');
  }
  return parsed.data;
}

let warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  rootLogger.warn(message);
}

// ── 内置规则表 ─────────────────────────────────────────────────────────────

const SHELL_PROGRAMS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'perl', 'ruby', 'deno', 'bun']);
const CODE_FLAGS = new Set(['-c', '-e']);
/** rm/mv/chmod 的"根或通配"操作数：命中即最高危 */
const ROOTISH_OPERANDS = new Set(['/', '/*', '~', '~/*', '*', '$HOME', '$HOME/*']);
const DANGEROUS_CODE_SUBSTRINGS = [
  'rmtree',
  'os.system',
  'subprocess',
  'child_process',
  'drop database',
  'drop table',
  'truncate table',
];
const HIGH_KEYWORDS = ['mkfs', 'dd if=', 'shutdown', 'reboot', 'poweroff', 'halt', ':(){'];

const SYSTEMCTL_CHANGE_SUBS = new Set(['stop', 'restart', 'kill', 'mask', 'disable', 'isolate']);
const KUBECTL_MEDIUM_SUBS = new Set(['delete', 'scale', 'rollout', 'drain', 'cordon']);
const DOCKER_MEDIUM_SUBS = new Set(['rm', 'rmi', 'stop', 'kill', 'restart', 'prune']);
const PACKAGE_REMOVE_SUBS = new Set(['remove', 'purge', 'erase']);

interface SegmentFinding {
  readonly level: RiskLevel;
  readonly matched: string | undefined;
  readonly pivot: string | null | undefined; // undefined=非跳板段；null=跳板但解析不出目标
}

function programOf(tokens: readonly string[]): string {
  const head = tokens[0] ?? '';
  const base = head.includes('/') ? (head.split('/').pop() ?? head) : head;
  return base.toLowerCase();
}

/** 段级结构规则（token + 旗标集合语义） */
function structuralFinding(tokens: readonly string[]): SegmentFinding {
  const prog = programOf(tokens);
  const args = tokens.slice(1);
  const shortFlags = args.filter((t) => t.startsWith('-') && !t.startsWith('--')).join('');
  const longFlags = args.filter((t) => t.startsWith('--'));
  const operands = args.filter((t) => !t.startsWith('-'));
  const has = (short: string, long: string): boolean =>
    shortFlags.includes(short) || longFlags.includes(long);
  const touchesRoot = operands.some((operand) => ROOTISH_OPERANDS.has(operand));

  if (prog === 'rm') {
    const recursive = has('r', '--recursive');
    if (recursive && touchesRoot) return { level: 'high', matched: 'rm 递归删除根/通配路径', pivot: undefined };
    if (recursive) return { level: 'medium', matched: 'rm 递归删除', pivot: undefined };
    return { level: 'low', matched: undefined, pivot: undefined };
  }
  if (['dd', 'shutdown', 'reboot', 'poweroff', 'halt'].includes(prog) || prog.startsWith('mkfs')) {
    return { level: 'high', matched: `危险程序 ${prog}`, pivot: undefined };
  }
  if (prog === 'init' && ['0', '6'].includes(operands[0] ?? '')) {
    return { level: 'high', matched: 'init 关机/重启', pivot: undefined };
  }
  if (prog === 'find' && args.some((t) => t === '-delete' || t === '-exec')) {
    return { level: 'high', matched: 'find -delete/-exec', pivot: undefined };
  }
  if (prog === 'mv' && touchesRoot) return { level: 'high', matched: 'mv 根路径', pivot: undefined };
  if (prog === 'chmod') {
    // 红队 R：777 放权与 000 去权作用于系统路径同等危险
    if (['777', '000'].includes(operands[0] ?? '') && (operands[1] ?? '').startsWith('/')) {
      return { level: 'high', matched: 'chmod 777/000 系统路径', pivot: undefined };
    }
    return { level: 'medium', matched: 'chmod', pivot: undefined };
  }
  if (prog === 'truncate' && operands.some((operand) => operand.startsWith('/dev/'))) {
    // 红队 R：清空块设备等价于毁盘
    return { level: 'high', matched: 'truncate 设备路径', pivot: undefined };
  }
  if (prog === 'chown') {
    if ((shortFlags.includes('R') || longFlags.includes('--recursive')) && touchesRoot) {
      return { level: 'high', matched: 'chown -R 根路径', pivot: undefined };
    }
    return { level: 'medium', matched: 'chown', pivot: undefined };
  }
  if (prog === 'systemctl' && SYSTEMCTL_CHANGE_SUBS.has(operands[0] ?? '')) {
    return { level: 'medium', matched: `systemctl ${operands[0]}`, pivot: undefined };
  }
  if (prog === 'service' && ['stop', 'restart'].includes(operands[1] ?? '')) {
    return { level: 'medium', matched: 'service 变更', pivot: undefined };
  }
  if (prog === 'kubectl') {
    if (operands[0] === 'exec') return { level: 'high', matched: 'kubectl exec（上下文逃逸）', pivot: undefined };
    if (KUBECTL_MEDIUM_SUBS.has(operands[0] ?? '')) {
      return { level: 'medium', matched: `kubectl ${operands[0]}`, pivot: undefined };
    }
    return { level: 'low', matched: undefined, pivot: undefined };
  }
  if (prog === 'docker' || prog === 'podman') {
    if (operands[0] === 'exec') return { level: 'high', matched: 'docker exec（上下文逃逸）', pivot: undefined };
    if (DOCKER_MEDIUM_SUBS.has(operands[0] ?? '')) {
      return { level: 'medium', matched: `docker ${operands[0]}`, pivot: undefined };
    }
    return { level: 'low', matched: undefined, pivot: undefined };
  }
  if (['kill', 'pkill', 'killall', 'nsenter', 'eval', 'xargs'].includes(prog)) {
    const level: RiskLevel = prog === 'nsenter' ? 'high' : 'medium';
    return { level, matched: prog, pivot: undefined };
  }
  if (['apt', 'apt-get', 'yum', 'dnf'].includes(prog) && PACKAGE_REMOVE_SUBS.has(operands[0] ?? '')) {
    return { level: 'medium', matched: '包卸载', pivot: undefined };
  }
  if (prog === 'git' && operands[0] === 'push' && args.some((t) => t === '-f' || t === '--force')) {
    return { level: 'medium', matched: 'git push --force', pivot: undefined };
  }
  if (prog === 'ssh' || prog === 'scp') {
    return { level: 'medium', matched: `${prog} 跳板（需二级目标校验）`, pivot: extractPivotTarget(args) };
  }
  if ((INTERPRETERS.has(prog) || SHELL_PROGRAMS.has(prog)) && args.some((t) => CODE_FLAGS.has(t))) {
    return { level: 'medium', matched: `${prog} -c/-e 任意代码（内容另行扫描）`, pivot: undefined };
  }
  return { level: 'low', matched: undefined, pivot: undefined };
}

/** ssh/scp 二级目标提取：跳过旗标及其取值，取第一个位置参数，剥 user@ 与 :path */
function extractPivotTarget(args: readonly string[]): string | null {
  const skipValueFlags = new Set(['-p', '-i', '-o', '-l', '-F', '-J', '-P']);
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;
    if (token.startsWith('-')) {
      index += skipValueFlags.has(token) ? 2 : 1;
      continue;
    }
    let host = token;
    const at = host.indexOf('@');
    if (at > 0) host = host.slice(at + 1);
    host = host.split(':')[0] ?? host;
    return host.length > 0 ? host : null;
  }
  return null;
}

/** 段文本内容扫描（结构规则的兜底：赋值、解释器代码、SQL 等"藏在参数里"的危险内容） */
function contentScanLevel(segmentText: string): RiskLevel {
  const lowered = segmentText.toLowerCase().replace(/\\/g, '');
  for (const keyword of HIGH_KEYWORDS) {
    if (lowered.includes(keyword)) return 'high';
  }
  for (const keyword of DANGEROUS_CODE_SUBSTRINGS) {
    if (lowered.includes(keyword)) return 'high';
  }
  // 经典 rm -rf 形态（合并旗标）——分离旗标由结构规则兜住
  if (/rm\s+[^;|&]*-[a-z]*r[a-z]*f?\s+\/(\S+)?$/.test(lowered)) return 'high';
  if (/(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/.test(lowered)) return 'high';
  if (/\b(chmod|chown|truncate)\b/.test(lowered)) return 'medium';
  if (/(pkill|killall)\b/.test(lowered)) return 'medium';
  return 'low';
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_WEIGHT[b] > RISK_WEIGHT[a] ? b : a;
}

export function assessRisk(command: string, policy: RiskPolicy): RiskAssessment {
  const full = normalizeCommand(command);
  const parsed = parseSegments(command);
  const single = parsed.segments.length === 1 && !parsed.hasSeparator && !parsed.hasSubstitution;
  const segmentsText = parsed.segments.map((segment) =>
    normalizeCommand(segment.join(' ')).replace(/\\/g, ''),
  );

  // ① 白名单：只对单段且无命令替换的命令生效（全等，红队 S14）
  if (single && policy.whitelist.some((entry) => normalizeCommand(entry) === full)) {
    return { level: 'low', source: 'policy-whitelist', matched: full, segments: segmentsText, autoExecEligible: true, pivots: [] };
  }

  let level: RiskLevel = 'low';
  let matched: string | undefined;
  const pivots: string[] = [];
  let unresolvedPivot = false;

  for (const [index, segment] of parsed.segments.entries()) {
    const finding = structuralFinding(segment);
    const text = segmentsText[index] ?? '';
    const content = contentScanLevel(text);
    const segmentLevel = maxLevel(maxLevel(finding.level, content), 'low');
    if (segmentLevel !== 'low' && RISK_WEIGHT[segmentLevel] > RISK_WEIGHT[level]) {
      level = segmentLevel;
      matched = finding.matched ?? '内容规则';
    }
    if (finding.pivot !== undefined) {
      if (finding.pivot === null) unresolvedPivot = true;
      else pivots.push(finding.pivot);
    }
  }

  // 管道进 shell：任意段的输出经 | 进入 shell 一律 high（不限 curl/wget，红队 S3）
  for (let i = 0; i < parsed.separators.length; i += 1) {
    const sep = parsed.separators[i];
    const next = parsed.segments[i + 1];
    if (sep === '|' && next !== undefined && SHELL_PROGRAMS.has(programOf(next))) {
      level = 'high';
      matched = '管道进入 shell';
    }
  }

  // 地板规则：命令替换静态不可分析 → 至少 medium；跳板目标解析失败 → high
  if (parsed.hasSubstitution && level === 'low') {
    level = 'medium';
    matched = '命令替换（$()/反引号）';
  }
  if (unresolvedPivot) {
    level = 'high';
    matched = '跳板目标无法解析';
  }

  const source = level === 'low' ? 'default-low' : 'builtin-rule';

  // ② 策略规则（正则，可信管理员配置）可覆盖内置判级——pivots 与资格判定不受覆盖影响
  for (const rule of policy.rules) {
    if (new RegExp(rule.pattern, 'i').test(full)) {
      return { level: rule.level, source: 'policy-rule', matched: rule.pattern, segments: segmentsText, autoExecEligible: single, pivots };
    }
  }

  return { level, source, matched, segments: segmentsText, autoExecEligible: single, pivots };
}

/** 最终风险 = max(规则结果, hint)——hint 只升不降（治理前提：被管对象不能自己降级） */
export function applyHint(assessment: RiskAssessment, hint: RiskLevel | undefined): RiskAssessment {
  if (hint === undefined || RISK_WEIGHT[hint] <= RISK_WEIGHT[assessment.level]) return assessment;
  return { ...assessment, level: hint, matched: `risk-hint:${hint}` };
}
