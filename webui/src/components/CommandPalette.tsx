/**
 * 命令面板（⌘K / Ctrl+K）：Linear 式快速跳转。
 * 页面导航 + 主题切换；↑↓ 选择、Enter 跳转、Esc 关闭。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, type View } from '../store/app';

interface Command {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const navigate = useApp((s) => s.navigate);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<readonly Command[]>(() => {
    const pages: readonly { view: View; label: string }[] = [
      { view: 'board', label: '动态' },
      { view: 'inbox', label: '收件箱' },
      { view: 'mine', label: '我的' },
      { view: 'console', label: '操作台' },
      { view: 'incidents', label: '事件' },
      { view: 'assets', label: '资产' },
      { view: 'knowledge', label: '知识库' },
      { view: 'audit', label: '审计' },
      { view: 'governance', label: '治理' },
      { view: 'usage', label: '用量' },
      { view: 'settings', label: '设置' },
    ];
    return [
      ...pages.map((p) => ({ key: `go-${p.view}`, label: `前往 ${p.label}`, group: '导航', run: () => navigate(p.view) })),
      { key: 'theme', label: '切换明暗主题', group: '操作', run: () => toggleTheme() },
    ];
  }, [navigate, toggleTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [commands, query]);

  // 开合由 AppShell 的全局 ⌘K 监听控制（paletteOpen prop 化由父级条件挂载）；
  // 此组件仅在挂载时重置输入并聚焦

  useEffect(() => {
    if (open) {
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const runAt = (index: number) => {
    const command = filtered[index];
    if (command === undefined) return;
    command.run();
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[15vh]"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-label="命令面板"
    >
      <div
        className="w-96 overflow-hidden rounded-xl border border-card-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); runAt(cursor); }
          }}
          placeholder="搜索页面或操作…"
          aria-label="搜索命令"
          className="w-full border-b border-card-border bg-input px-3 py-2.5 text-ui-base text-foreground placeholder:text-foreground-subtlest focus:outline-none"
        />
        <ul className="max-h-72 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-2 py-3 text-ui-caption text-foreground-subtle">没有匹配的命令</li>
          ) : (
            filtered.map((c, i) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => runAt(i)}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-ui-sm ${
                    i === cursor ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-hover'
                  }`}
                >
                  <span>{c.label}</span>
                  <span className="text-ui-xs text-foreground-subtlest">{c.group}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-card-border px-3 py-1.5 text-ui-xs text-foreground-subtlest">
          ↑↓ 选择 · Enter 跳转 · Esc 关闭
        </div>
      </div>
    </div>
  );
}
