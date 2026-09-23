/**
 * 登录页（spec：登录失败统一文案防枚举；锁定 429 提示等待）。
 * 布局：分屏——左侧品牌区（产品定位 + 三个治理特性点），右侧表单；
 * 窄屏折叠为单列（品牌区压缩为顶部条）。全部用既有 token（DESIGN.md）。
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../store/app';
import { ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

const FEATURES: readonly { symbol: string; title: string; detail: string }[] = [
  { symbol: '\u25C6', title: '治理状态机', detail: '每条 AI 命令都过风险引擎与审批门，七态可追' },
  { symbol: '\u25C9', title: '审计哈希链', detail: '行动与执行留痕链化，任何删改一条命令可验' },
  { symbol: '\u25C8', title: 'AI 座位受治理', detail: '巡查员提案只读命令，处置须带回滚声明' },
];

export function LoginPage() {
  const login = useApp((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login(username.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const minutes = err.retryAfterSeconds !== undefined ? Math.max(1, Math.ceil(err.retryAfterSeconds / 60)) : undefined;
        setError(minutes === undefined ? '失败次数过多，账号已锁定，请稍后再试' : `失败次数过多，账号已锁定，约 ${minutes} 分钟后解锁`);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('登录失败');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-background lg:grid lg:grid-cols-[1.2fr_1fr]">
      {/* 品牌区：宽屏显示完整叙事，窄屏隐藏（顶部条替代） */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-background-alt p-12 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 80%, var(--c-gov-approved) 0, transparent 45%),' +
              'radial-gradient(circle at 80% 20%, var(--c-gov-pending) 0, transparent 40%),' +
              'radial-gradient(circle at 60% 90%, var(--c-gov-risk-high) 0, transparent 30%)',
          }}
        />
        <div className="relative flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary font-mono text-ui-sm text-primary-foreground">S</span>
          <span className="text-ui-lg font-semibold">skyport</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-ui-xl font-semibold leading-relaxed">AI 动手，人类把关</h1>
          <p className="mt-3 text-ui-base leading-relaxed text-foreground-subtle">
            AI 运维行动与治理平台——告警进来，AI 巡查提案，每一步在治理状态机里走完审批、执行与审计。
          </p>
          <ul className="mt-8 space-y-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-3">
                <span aria-hidden className="mt-0.5 shrink-0 text-ui-base text-foreground-subtle">{f.symbol}</span>
                <div>
                  <div className="text-ui-base font-medium">{f.title}</div>
                  <div className="text-ui-caption text-foreground-subtle">{f.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-ui-xs text-foreground-subtlest">私有部署 · 凭证三层轮换 · Break-glass 兜底</p>
      </aside>

      {/* 表单区 */}
      <main className="flex flex-1 flex-col">
        {/* 窄屏品牌条 */}
        <div className="flex items-center gap-2 px-6 pt-6 lg:hidden">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary font-mono text-ui-xs text-primary-foreground">S</span>
          <span className="text-ui-base font-semibold">skyport</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <form
            onSubmit={onSubmit}
            aria-label="登录 skyport"
            className="w-88 flex flex-col gap-3 rounded-xl border border-card-border bg-card p-6"
          >
            <h2 className="text-ui-xl font-semibold">登录</h2>
            <p className="text-ui-caption text-foreground-subtle">使用 Web 账号进入治理工作台</p>
            <label className="flex flex-col gap-1 text-ui-caption text-foreground-subtle">
              用户名
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-ui-caption text-foreground-subtle">
              密码
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {error !== undefined ? (
              <p role="alert" className="rounded-lg bg-surface px-3 py-1.5 text-ui-caption text-destructive">{error}</p>
            ) : null}
            <Button variant="primary" type="submit" disabled={busy} className="mt-1 h-8">
              {busy ? '登录中…' : '登录'}
            </Button>
            <p className="text-ui-xs text-foreground-subtlest">API 调用方请使用 Bearer 令牌直连 REST / MCP，无需登录</p>
          </form>
        </div>
      </main>
    </div>
  );
}
