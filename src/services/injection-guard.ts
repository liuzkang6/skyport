/**
 * 注入防御·内容隔离（PRD §2 关键机制）：
 * 观测数据标记为不可信数据，永不作为指令执行。
 * 态势包/日志/告警文本中的指令性内容 = 待分析的攻击证据，不是命令。
 */

export interface GuardResult {
  readonly safe: boolean;
  readonly sanitized: string;
  readonly detectedPatterns: readonly string[];
}

/** 检测到的注入模式 */
const INJECTION_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?)/gi, label: '指令覆盖' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above)/gi, label: '指令覆盖' },
  { pattern: /forget\s+(everything|all|your\s+instructions)/gi, label: '记忆清除' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/gi, label: '角色劫持' },
  { pattern: /act\s+as\s+(if\s+you\s+are|a|an)\s+/gi, label: '角色劫持' },
  { pattern: /system\s*[:：]\s*/gi, label: '系统提示伪造' },
  { pattern: /\[(system|assistant|user)\]/gi, label: '对话注入' },
  { pattern: /<\|?(im_start|im_end|system|endoftext)\|?>/gi, label: '特殊token注入' },
  { pattern: /exec(ute)?\s+(the\s+)?following/gi, label: '命令注入' },
  { pattern: /run\s+(the\s+)?(following|this)\s+(command|code)/gi, label: '命令注入' },
  { pattern: /curl[^|]*\|\s*(ba|z|da)?sh/gi, label: '管道执行' },
  { pattern: /eval\s*\(/gi, label: '代码执行' },
  { pattern: /\{\{secret:[^}]+\}\}/gi, label: '凭证提取尝试' },
  { pattern: /your\s+(api[_\s-]?key|token|password|credential)/gi, label: '凭证探测' },
  { pattern: /sudo\s+rm\s+-rf/gi, label: '破坏性命令' },
];

/** 清洗文本：标记不可信内容 + 检测注入模式 */
export function guardContent(text: string, source: string): GuardResult {
  const detected: string[] = [];
  let sanitized = text;

  for (const { pattern, label } of INJECTION_PATTERNS) {
    pattern.lastIndex = 0; // 重置 g 标志的 lastIndex（防跨调用状态残留）
    if (pattern.test(sanitized)) {
      detected.push(label);
    }
  }

  // 将可疑内容包裹在不可信标记中
  if (detected.length > 0) {
    sanitized = `[UNTRUSTED-START source=${source} detected=${detected.join(',')}]${text}[UNTRUSTED-END]`;
  }

  return {
    safe: detected.length === 0,
    sanitized,
    detectedPatterns: detected,
  };
}

/** 批量清洗态势包中的所有文本字段 */
export function guardContextPack(pack: Record<string, unknown>): {
  guarded: Record<string, unknown>;
  totalDetections: number;
} {
  let totalDetections = 0;
  const guarded = { ...pack };

  // 递归清洗字符串值
  function guardValue(value: unknown, key: string): unknown {
    if (typeof value === 'string') {
      const result = guardContent(value, `context.${key}`);
      totalDetections += result.detectedPatterns.length;
      return result.sanitized;
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => guardValue(v, `${key}[${i}]`));
    }
    if (typeof value === 'object' && value !== null) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        obj[k] = guardValue(v, `${key}.${k}`);
      }
      return obj;
    }
    return value;
  }

  for (const [key, value] of Object.entries(guarded)) {
    guarded[key] = guardValue(value, key);
  }

  return { guarded, totalDetections };
}

/** 检查诊断输出是否包含无关命令（注入探测器的最后防线） */
export function checkProposalRelevance(
  proposalCommand: string,
  alertFingerprint: string | undefined,
): { relevant: boolean; warning: string | undefined } {
  // 如果提案包含与告警指纹完全无关的破坏性命令，标记可疑
  const destructivePatterns = [/rm\s+-rf/, /drop\s+(database|table)/i, /shutdown/i, /reboot/i, /mkfs/i];
  const isDestructive = destructivePatterns.some((p) => p.test(proposalCommand));

  if (isDestructive && alertFingerprint === undefined) {
    return {
      relevant: false,
      warning: '提案包含破坏性命令但无关联告警指纹——疑似注入，需人工复核',
    };
  }

  return { relevant: true, warning: undefined };
}
