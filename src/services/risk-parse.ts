/**
 * 命令解析（P0-S3 加固）：tokenizeCommand（执行层用）与 parseSegments（风险评估用）
 * 共享同一套引号语义——杜绝"评估看原始字符串、执行先剥引号"的两套语义不一致（红队 S3 根因）。
 */
import { createError, ERROR_CODES } from '../errors/errors';

/** 命令归一化：压缩空白、去首尾（白名单全等比较与分段解析共用） */
export function normalizeCommand(command: string): string {
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

export interface ParsedCommand {
  /** 按未加引号的分隔符切开后的 token 段 */
  readonly segments: readonly string[][];
  /** segments[i] 与 segments[i+1] 之间的分隔符（';' '|' '&&' '&'） */
  readonly separators: readonly string[];
  readonly hasSeparator: boolean;
  /** 存在未加引号的反引号或 $( ——命令替换，静态不可分析 */
  readonly hasSubstitution: boolean;
}

/**
 * 分段解析：在 tokenizeCommand 的引号规则之上，把未加引号的 ; | || && & 当作段边界。
 * 引号内的分隔符是字面量不切分（`echo "a;b"` 仍是单段）。
 */
export function parseSegments(command: string): ParsedCommand {
  const chars = normalizeCommand(command);
  const segments: string[][] = [];
  const separators: string[] = [];
  let current: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let hasSeparator = false;
  let hasSubstitution = false;
  let pendingSep: string | undefined;

  const flushToken = (): void => {
    if (token.length > 0) {
      current.push(token);
      token = '';
    }
  };
  const flushSegment = (sep: string | undefined): void => {
    flushToken();
    if (current.length > 0) {
      segments.push(current);
      current = [];
      if (pendingSep !== undefined) separators.push(pendingSep);
      pendingSep = sep;
    } else if (sep !== undefined && pendingSep === undefined) {
      pendingSep = sep; // 连续分隔符合并取第一个
    }
  };

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === undefined) break;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';') {
      flushSegment(';');
      hasSeparator = true;
      continue;
    }
    if (ch === '|') {
      if (chars[i + 1] === '|') i += 1;
      flushSegment('|');
      hasSeparator = true;
      continue;
    }
    if (ch === '&') {
      if (chars[i + 1] === '&') i += 1;
      flushSegment('&');
      hasSeparator = true;
      continue;
    }
    if (ch === '`') {
      hasSubstitution = true;
      token += ch; // 保留字符供内容扫描
      continue;
    }
    if (ch === '$' && chars[i + 1] === '(') {
      hasSubstitution = true;
      token += ch;
      continue;
    }
    if (ch === ' ') {
      flushToken();
      continue;
    }
    token += ch;
  }
  if (quote !== undefined) {
    throw createError(ERROR_CODES.ACTION_INVALID, '命令中的引号未闭合', { context: { command } });
  }
  flushSegment(undefined);
  return { segments, separators, hasSeparator, hasSubstitution };
}
