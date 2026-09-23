/** 基础原语：输入框（安静不发光，错误态仅用于真实校验问题） */
import type { InputHTMLAttributes } from 'react';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-8 w-full rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground placeholder:text-foreground-subtlest hover:border-border-hover focus:border-border-hover focus:outline-none ${className}`}
      {...rest}
    />
  );
}
