/** 基础原语：按钮（DESIGN.md §5——变体集合，不新建高度系统） */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'outline' | 'ghost' | 'destructive';

const VARIANT_CLASS: Readonly<Record<Variant, string>> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border border-border bg-transparent text-foreground hover:bg-hover',
  ghost: 'bg-transparent text-foreground hover:bg-hover',
  destructive: 'bg-destructive text-white hover:opacity-90',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
  readonly children: ReactNode;
}

export function Button({ variant = 'outline', className = '', children, ...rest }: ButtonProps) {
  return (
    <button
      className={`inline-flex h-7 items-center justify-center gap-1 rounded-lg px-3 text-ui-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground-subtle ${VARIANT_CLASS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
