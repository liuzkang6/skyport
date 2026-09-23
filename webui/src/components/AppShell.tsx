/**
 * 应用外壳：侧栏导航（PRD 拍板命名——本刀只亮"动态"，其余占位置灰）+ 顶栏（主题切换/登出）。
 * 禁用项保留布局仅降文本色（DESIGN.md §5 菜单规则）。
 */
import { useEffect, type ReactNode } from 'react';
import { useApp, type View } from '../store/app';

const NAV_ITEMS: readonly { key: string; label: string }[] = [
  { key: 'board', label: '动态' },
  { key: 'console', label: '操作台' },
  { key: 'inbox', label: '收件箱' },
  { key: 'mine', label: '我的' },
  { key: 'incidents', label: '事件' },
  { key: 'assets', label: '资产' },
  { key: 'knowledge', label: '知识库' },
  { key: 'audit', label: '审计' },
  { key: 'governance', label: '治理' },
  { key: 'usage', label: '用量' },
  { key: 'settings', label: '设置' },
];

export function AppShell({ children }: { children: ReactNode }) {
  // SSE 实时事件流订阅（spec/webui：serve 推送 /api/v1/events/stream）
  useEffect(() => {
    const es = new EventSource('/api/v1/events/stream');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { event: string };
        if (data.event === 'connected') return;
        // 触发 store 刷新（不直接改状态，UI 自行拉取最新投影）
        useApp.getState().refreshBoard().catch(() => undefined);
      } catch { /* 忽略解析失败 */ }
    };
    return () => es.close();
  }, []);
  const user = useApp((s) => s.user);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const logout = useApp((s) => s.logout);
  const boardError = useApp((s) => s.boardError);
  const view = useApp((s) => s.view);
  const navigate = useApp((s) => s.navigate);

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="主导航" className="flex w-44 shrink-0 flex-col bg-sidebar">
        <div className="px-4 pb-2 pt-4">
          <span className="text-ui-lg font-semibold">skyport</span>
        </div>
        <ul className="flex-1 px-2">
          {NAV_ITEMS.map((item) => (
            <li key={item.key}>
              <span
                onClick={() => navigate(item.key as View)}
                className={`flex h-8 cursor-pointer items-center rounded-lg px-3 text-ui-base ${
                  view === item.key ? 'bg-selected font-medium text-foreground' : 'text-foreground hover:bg-hover'
                }`}
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-header px-4">
          <span className="truncate text-ui-caption text-foreground-subtle">
            {boardError !== undefined ? <span className="text-warning">{boardError}（自动重试中）</span> : '行动看板 · 列 = 治理状态机'}
          </span>
          <div className="flex shrink-0 items-center gap-2 text-ui-caption text-foreground-subtle">
            <span className="font-mono">{user?.name}</span>
            <span className="rounded-full bg-surface px-2 py-0.5 text-ui-xs">{user?.role}</span>
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-lg px-2 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground-subtle"
              aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            >
              {theme === 'dark' ? '☀ 亮色' : '☾ 暗色'}
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-lg px-2 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground-subtle"
            >
              登出
            </button>
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">{children}</main>
      </div>
    </div>
  );
}
