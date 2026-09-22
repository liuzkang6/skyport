/**
 * 风险分级引擎（M2，spec/governance-loop/spec.md）：
 * 判定顺序 = 策略白名单（全等）→ 策略规则（正则）→ 内置保守规则 → 兜底 low。
 * AI 自报 hint 只升不降（治理前提：不能让被管对象自己降低风险等级）。
 * 命令切分用保守的引号感知 tokenizer，执行时绝不拼接 shell 字符串。
 */
import { readJsonFileSync } from '../adapters/fs';
import { createError, ERROR_CODES, isSkyportError } from '../errors/errors';
import { join } from 'node:path';
import { z } from 'zod';

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_WEIGHT: Readonly<Record<RiskLevel, number>> = { low: 10, medium: 20, high: 30 };

/** 策略文件名（cwd 约定，与 skyport.config.json 同级） */
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
}

export function defaultPolicyPath(): string {
  return join(process.cwd(), POLICY_FILENAME);
}

export function loadPolicy(policyPath: string = defaultPolicyPath()): RiskPolicy {
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
      context: {
        path: policyPath,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

/** 命令归一化：压缩空白、去首尾，用于白名单全等比较 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/**
 * 引号感知的命令切分（单/双引号，不支持转义——保守设计，文档已注明）。
 * 执行层只接受切分后的参数数组，杜绝 shell 注入。
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const ch of normalizeCommand(command)) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote !== undefined) {
    throw createError(ERROR_CODES.ACTION_INVALID, '命令中的引号未闭合', { context: { command } });
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** 内置保守规则（启发式，策略文件可覆盖）：先判 high 再判 medium */
const HIGH_SUBSTRINGS: readonly string[] = [
  'mkfs',
  'dd if=',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
  'drop database',
  'drop table',
  'truncate table',
  'init 0',
  'init 6',
  ':(){',
];

const HIGH_PATTERNS: readonly RegExp[] = [
  /rm\s+[^;|&]*-[a-z]*r[a-z]*\s+(\/|~|\*)(\s|$)/i, // rm -r 于根/家目录/通配
  /rm\s+[^;|&]*-[a-z]*r[a-z]*f?\s+\/(\S+)?$/i, // rm -r[f] 以 / 开头路径收尾
  /kubectl\s+delete\s+(ns|namespace|nodes|node)\b/i,
  /(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/i, // 下载管道进 shell
  /chmod\s+(-r\s+)?777\s+\/($|\s)/i,
  /chown\s+-r\s+[^ ]+\s+\/($|\s)/i,
];

const MEDIUM_PATTERNS: readonly RegExp[] = [
  /systemctl\s+(stop|restart|kill|mask|disable|isolate)\b/i,
  /\bservice\s+\S+\s+(stop|restart)\b/i,
  /kubectl\s+(delete|scale|rollout\s+undo|drain|cordon)\b/i,
  /docker\s+(rm|rmi|stop|kill|restart|prune)\b/i,
  /(pkill|killall)\b/i,
  /\bkill\s+-9\b/i,
  /\b(chmod|chown)\b/i,
  /(apt|apt-get|yum|dnf)\s+(remove|purge|erase)\b/i,
  /git\s+push\s+.*(-f|--force)\b/i,
  /\btruncate\b/i,
];

export function assessRisk(command: string, policy: RiskPolicy): RiskAssessment {
  const normalized = normalizeCommand(command);
  // ① 策略白名单：全等匹配，最高优先级
  if (policy.whitelist.some((entry) => normalizeCommand(entry) === normalized)) {
    return { level: 'low', source: 'policy-whitelist', matched: normalized };
  }
  // ② 策略规则（正则）可覆盖内置
  for (const rule of policy.rules) {
    if (new RegExp(rule.pattern, 'i').test(normalized)) {
      return { level: rule.level, source: 'policy-rule', matched: rule.pattern };
    }
  }
  // ③ 内置保守规则
  const lowered = normalized.toLowerCase();
  for (const needle of HIGH_SUBSTRINGS) {
    if (lowered.includes(needle)) {
      return { level: 'high', source: 'builtin-rule', matched: needle };
    }
  }
  for (const pattern of HIGH_PATTERNS) {
    if (pattern.test(normalized)) {
      return { level: 'high', source: 'builtin-rule', matched: pattern.source };
    }
  }
  for (const pattern of MEDIUM_PATTERNS) {
    if (pattern.test(normalized)) {
      return { level: 'medium', source: 'builtin-rule', matched: pattern.source };
    }
  }
  // ④ 兜底 low
  return { level: 'low', source: 'default-low', matched: undefined };
}

/** 最终风险 = max(规则结果, hint)——hint 只升不降（治理前提：被管对象不能自己降级） */
export function applyHint(assessment: RiskAssessment, hint: RiskLevel | undefined): RiskAssessment {
  if (hint === undefined || RISK_WEIGHT[hint] <= RISK_WEIGHT[assessment.level]) return assessment;
  return { level: hint, source: assessment.source, matched: `risk-hint:${hint}` };
}
