/** 应用根：启动会话探测 + 视图切换（登录/看板/资产/用量） */
import { useEffect } from 'react';
import { useApp } from './store/app';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { BoardPage } from './pages/BoardPage';
import { AssetsPage } from './pages/AssetsPage';
import { UsagePage } from './pages/UsagePage';

const ROUTES: Record<string, string> = { '/': 'board', '/assets': 'assets', '/usage': 'usage', '/login': 'login' };

export function App() {
  const view = useApp((s) => s.view);
  const booted = useApp((s) => s.booted);
  const boot = useApp((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  // 浏览器前进/后退跟随路由
  useEffect(() => {
    const onPop = () => {
      const next = ROUTES[location.pathname] ?? 'board';
      useApp.setState({ view: next as never });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!booted) {
    return <div className="flex h-full items-center justify-center text-ui-caption text-foreground-subtle">加载中…</div>;
  }
  if (view === 'login') return <LoginPage />;
  return (
    <AppShell>
      {view === 'assets' ? <AssetsPage /> : view === 'usage' ? <UsagePage /> : <BoardPage />}
    </AppShell>
  );
}
