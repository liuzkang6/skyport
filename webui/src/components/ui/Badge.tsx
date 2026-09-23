/** 基础原语：徽章（计数器/快捷键用 text-ui-xs；状态徽章走 GovBadge） */
import type { ReactNode } from 'react';

export function Badge({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-ui-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}
