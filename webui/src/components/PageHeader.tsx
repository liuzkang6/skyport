/**
 * 统一页头：Linear 式——页面标题 + 一句描述 + 右侧主操作区。
 * 各内容页以 <PageHeader title desc actions> 开头，替代散落的 h1。
 */
import type { ReactNode } from 'react';

interface PageHeaderProps {
  readonly title: string;
  readonly desc?: string | undefined;
  readonly actions?: ReactNode;
}

export function PageHeader({ title, desc, actions }: PageHeaderProps) {
  return (
    <header className="mb-5 flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-ui-xl font-semibold text-foreground">{title}</h1>
        {desc !== undefined ? <p className="mt-1 text-ui-caption text-foreground-subtle">{desc}</p> : null}
      </div>
      {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
