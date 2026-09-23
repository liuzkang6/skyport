/** 应用根：启动会话探测 + 视图切换（11 个视图，路由表与 store 的 VIEW_PATHS 同源） */
import { useEffect } from 'react';
import { useApp, viewFromPath } from './store/app';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { BoardPage } from './pages/BoardPage';
import { AssetsPage } from './pages/AssetsPage';
import { UsagePage } from './pages/UsagePage';
import { ConsolePage } from './pages/ConsolePage';
import { AuditPage } from './pages/AuditPage';
import { SettingsPage } from './pages/SettingsPage';
import { InboxPage } from './pages/InboxPage';
import { IncidentsPage } from './pages/IncidentsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { MinePage } from './pages/MinePage';
import { GovernancePage } from './pages/GovernancePage';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  const view = useApp((s) => s.view);
  const booted = useApp((s) => s.booted);
  const boot = useApp((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  // 浏览器前进/后退跟随路由
  useEffect(() => {
    const onPop = () => useApp.setState({ view: viewFromPath(location.pathname) });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!booted) {
    return <div className="flex h-full items-center justify-center text-ui-caption text-foreground-subtle">加载中…</div>;
  }
  if (view === 'login') return <LoginPage />;
  return (
    <ErrorBoundary>
    <AppShell>
      {view === 'assets' ? <AssetsPage />
        : view === 'usage' ? <UsagePage />
        : view === 'console' ? <ConsolePage />
        : view === 'audit' ? <AuditPage />
        : view === 'settings' ? <SettingsPage />
        : view === 'inbox' ? <InboxPage />
        : view === 'incidents' ? <IncidentsPage />
        : view === 'knowledge' ? <KnowledgePage />
        : view === 'mine' ? <MinePage />
        : view === 'governance' ? <GovernancePage />
        : <BoardPage />}
    </AppShell>
    </ErrorBoundary>
  );
}
