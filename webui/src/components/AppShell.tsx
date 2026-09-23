/**
 * 应用外壳（Linear 式信息架构）：
 * - 侧栏 240px：logo 行 / 分组导航（工作区·资源·治理·系统）/ 底部用户卡 + 实时连接
 * - 顶栏 44px：面包屑（skyport / 当前页）+ ⌘K 命令面板入口
 * - 内容区由各页自管滚动；命令面板全局挂载
 * 设计依据 DESIGN.md §5 菜单规则：选中浅底、hover 微亮。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useApp, type View } from '../store/app';
import { CommandPalette } from './CommandPalette';

/** 分节导航：节标题 + 条目 */
const NAV_SECTIONS: readonly { title: string; items: readonly { key: View; label: string }[] }[] = [
  {
    title: '工作区',
    items: [
      { key: 'board', label: '动态' },
      { key: 'inbox', label: '收件箱' },
      { key: 'mine', label: '我的' },
      { key: 'console', label: '操作台' },
    ],
  },
  {
    title: '资源',
    items: [
      { key: 'incidents', label: '事件' },
      { key: 'assets', label: '资产' },
      { key: 'knowledge', label: '知识库' },
    ],
  },
  {
    title: '治理',
    items: [
      { key: 'audit', label: '审计' },
      { key: 'governance', label: '治理' },
      { key: 'usage', label: '用量' },
    ],
  },
  {
    title: '系统',
    items: [{ key: 'settings', label: '设置' }],
  },
];

const VIEW_TITLES: Readonly<Record<string, string>> = {
  board: '动态', console: '操作台', inbox: '收件箱', mine: '我的',
  incidents: '事件', assets: '资产', knowledge: '知识库', audit: '审计',
  governance: '治理', usage: '用量', settings: '设置',
};

const VIEW_HINTS: Readonly<Record<string, string>> = {
  board: '列 = 治理状态机',
  console: '态势包 + AI 巡查 + 就地审批',
  inbox: '待我处理的更新',
  mine: '我创建的行动',
  incidents: '告警流（确认 / 关闭）',
  assets: '清单与健康',
  knowledge: '技能与剧本',
  audit: '哈希链账本',
  governance: '月报与交接班',
  usage: 'Token 消耗',
  settings: '模型 / 保险箱 / 运行时 / 插件',
};

export function AppShell({ children }: { children: ReactNode }) {
  const [live, setLive] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const user = useApp((s) => s.user);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const logout = useApp((s) => s.logout);
  const boardError = useApp((s) => s.boardError);
  const view = useApp((s) => s.view);
  const navigate = useApp((s) => s.navigate);

  // ⌘K / Ctrl+K 全局开合命令面板（面板未挂载时也要能唤起）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // SSE 实时事件流订阅（spec/webui）：事件到达即触发投影刷新
  useEffect(() => {
    const es = new EventSource('/api/v1/events/stream');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { event: string };
        if (data.event === 'connected') return;
        useApp.getState().refreshBoard().catch(() => undefined);
      } catch { /* 忽略解析失败 */ }
    };
    return () => es.close();
  }, []);

  const initial = (user?.name ?? '?').slice(0, 1).toUpperCase();

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        {/* logo 行 */}
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary font-mono text-ui-xs text-primary-foreground">S</span>
          <span className="text-ui-base font-semibold">skyport</span>
          <span className="ml-auto font-mono text-ui-2xs text-foreground-subtlest">v0.2.0</span>
        </div>

        {/* 分组导航 */}
        <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {NAV_SECTIONS.map((section) => (
              <section key={section.title} className="mb-3">
                <h3 className="px-2.5 pb-1 pt-2 text-ui-xs font-medium text-foreground-subtlest">{section.title}</h3>
                <ul>
                  {section.items.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => navigate(item.key)}
                        aria-current={view === item.key ? 'page' : undefined}
                        className={`flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-ui-base transition-colors ${
                          view === item.key ? 'bg-selected font-medium text-foreground' : 'text-foreground-subtle hover:bg-hover hover:text-foreground'
                        }`}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {/* 底部：连接状态 + 用户卡 */}
          <div className="shrink-0 border-t border-border p-2">
            <div className="flex items-center gap-2 px-1.5 pb-2 pt-1 text-ui-xs text-foreground-subtlest">
              <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${live ? 'bg-success' : 'bg-warning'}`} />
              {live ? '实时已连接' : '实时重连中…'}
            </div>
            <div className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-hover">
              <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-ui-caption font-semibold text-foreground-subtle">{initial}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui-caption font-medium text-foreground">{user?.name}</div>
                <div className="text-ui-2xs text-foreground-subtlest">{user?.role}</div>
              </div>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
                className="rounded-md px-1.5 py-1 text-ui-caption text-foreground-subtle hover:bg-surface hover:text-foreground"
              >{theme === 'dark' ? '☀' : '☾'}</button>
              <button
                type="button"
                onClick={() => void logout()}
                aria-label="登出"
                className="rounded-md px-1.5 py-1 text-ui-caption text-foreground-subtle hover:bg-surface hover:text-foreground"
              >⏻</button>
            </div>
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：面包屑 + 命令面板入口 */}
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-4">
          <span className="text-ui-caption text-foreground-subtlest">skyport</span>
          <span aria-hidden className="text-ui-caption text-foreground-subtlest">/</span>
          <span className="text-ui-caption font-medium text-foreground">{VIEW_TITLES[view] ?? view}</span>
          <span className="ml-3 hidden text-ui-xs text-foreground-subtlest md:inline">{VIEW_HINTS[view] ?? ''}</span>
          <div className="ml-auto flex items-center gap-3">
            {boardError !== undefined ? <span className="text-ui-xs text-warning">{boardError}（自动重试中）</span> : null}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-input-border bg-input px-2.5 py-1 text-ui-caption text-foreground-subtle hover:border-border-hover hover:text-foreground"
            >
              <span aria-hidden>⌕</span>
              <span className="hidden sm:inline">搜索…</span>
              <kbd className="rounded border border-input-border bg-surface px-1 font-mono text-ui-2xs text-foreground-subtlest">⌘K</kbd>
            </button>
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-5">{children}</main>
      </div>

      {paletteOpen ? <CommandPalette /> : null}
    </div>
  );
}
