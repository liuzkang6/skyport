/**
 * 面向人的错误文案（红队 S13）：zod 校验 issue 的中文映射，替代英文原文直出。
 * 映射不全时回退通用"字段不合法"，绝不泄露解析器英文原文。
 */
interface IssueLike {
  readonly code: string;
  readonly path: readonly (string | number | symbol)[];
  readonly message?: string | undefined;
  readonly expected?: unknown;
}

export function translateIssue(issue: IssueLike): string {
  const path = issue.path.map(String).join('.') || '(根)';
  const detail: string = (() => {
    switch (issue.code) {
      case 'invalid_type':
        return `类型不正确（应为 ${String(issue.expected ?? '合法类型')}）`;
      case 'invalid_value':
      case 'invalid_enum_value':
        return '值不在允许范围内';
      case 'too_big':
        return '超出长度/大小上限';
      case 'too_small':
        return '低于长度/大小下限';
      case 'invalid_string':
        return '字符串格式不合法';
      case 'unrecognized_keys':
        return '包含未知字段（请检查拼写）';
      default:
        return '字段不合法';
    }
  })();
  return `${path}: ${detail}`;
}

export function translateIssues(issues: readonly IssueLike[]): { path: string; message: string }[] {
  return issues.map((issue) => ({ path: issue.path.map(String).join('.') || '(根)', message: translateIssue(issue) }));
}
