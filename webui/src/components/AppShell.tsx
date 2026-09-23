/**
 * 应用外壳：侧栏导航（PRD 拍板命名——本刀只亮"动态"，其余占位置灰）+ 顶栏（主题切换/登出）。
 * 禁用项保留布局仅降文本色（DESIGN.md §5 菜单规则）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useApp, type View } from '../store/app';

/** 顶栏语境提示：随当前视图切换 */
const VIEW_HINTS: Readonly<Record<string, string>> = {
  board: '行动看板 · 列 = 治理状态机',
  console: 'Agent 操作台 · 态势包 + AI 巡查 + 就地审批',
  inbox: '收件箱 · 待我处理的更新',
  mine: '我的 · 我创建的行动',
  incidents: '事件 · 告警流（确认 / 关闭）',
  assets: '资产 · 清单与健康',
  knowledge: '知识库 · 技能与剧本',
  audit: '审计 · 哈希链账本',
  governance: '治理 · 月报与交接班',
  usage: '用量 · Token 消耗',
  settings: '设置 · 模型 / 保险箱 / 运行时 / 插件',
};

/** 分节导航：节标题（工作区/资源/治理）+ 条目——结构对齐 Linear 式侧栏 */
const NAV_SECTIONS: readonly { title: string; items: readonly { key: string; label: string }[] }[] = [
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
    items: [
      { key: 'settings', label: '设置' },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [live, setLive] = useState(false);
  // SSE 实时事件流订阅（spec/webui：serve 推送 /api/v1/events/stream）
  useEffect(() => {
    const es = new EventSource('/api/v1/events/stream');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
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
        <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pb-2 pt-4">
          <span className="text-ui-lg font-semibold">skyport</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {NAV_SECTIONS.map((section) => (
            <section key={section.title} className="mb-3">
              <h3 className="px-3 pb-1 pt-2 text-ui-xs font-medium text-foreground-subtlest">{section.title}</h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item.key}>
                    {/* QA #10：button 化——纯键盘可切换页面，带 aria-current */}
                    <button
                      type="button"
                      onClick={() => navigate(item.key as View)}
                      aria-current={view === item.key ? 'page' : undefined}
                      className={`flex h-8 w-full cursor-pointer items-center rounded-lg px-3 text-left text-ui-base ${
                        view === item.key ? 'bg-selected font-medium text-foreground' : 'text-foreground hover:bg-hover'
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
        </div>
        {/* 底部状态区：实时连接 + 版本 */}
        <footer className="shrink-0 border-t border-border px-4 py-3">
          <div className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
            <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${live ? 'bg-success' : 'bg-warning'}`} />
            {live ? '实时已连接' : '实时重连中…'}
          </div>
          <div className="mt-1 text-ui-xs text-foreground-subtlest">skyport v0.2.0</div>
        </footer>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-header px-4">
          <span className="truncate text-ui-caption text-foreground-subtle">
            {boardError !== undefined ? <span className="text-warning">{boardError}（自动重试中）</span> : (VIEW_HINTS[view] ?? view)}
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
