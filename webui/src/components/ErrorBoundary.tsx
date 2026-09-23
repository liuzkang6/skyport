/**
 * 渲染错误边界：单页崩溃不再拖垮整个应用（白屏）——
 * 显示错误卡片 + 返回看板按钮，侧边栏与导航保持可用。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | undefined;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[skyport-webui] 页面渲染崩溃', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-card-border bg-card p-6">
          <h2 className="mb-2 text-ui-base font-semibold text-destructive">页面渲染出错</h2>
          <p className="mb-1 text-ui-caption text-foreground-subtle">其余页面不受影响，可返回看板继续使用。</p>
          <pre className="mb-4 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 font-mono text-ui-xs text-foreground-subtle">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => { this.setState({ error: undefined }); window.history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}
            className="rounded-lg bg-primary px-4 py-1.5 text-ui-sm text-primary-foreground hover:opacity-90"
          >
            返回看板
          </button>
        </div>
      </div>
    );
  }
}
