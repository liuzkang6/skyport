/** 登录页（spec：登录失败统一文案防枚举；锁定 429 提示等待） */
import { useState, type FormEvent } from 'react';
import { useApp } from '../store/app';
import { ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

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
        setError('失败次数过多，账号已锁定 5 分钟，请稍后再试');
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
    <div className="flex h-full items-center justify-center bg-background">
      <form
        onSubmit={onSubmit}
        aria-label="登录 skyport"
        className="w-88 flex flex-col gap-3 rounded-xl border border-card-border bg-card p-6"
      >
        <h1 className="text-ui-xl font-semibold">skyport</h1>
        <p className="text-ui-caption text-foreground-subtle">AI 运维行动与治理平台 · 登录</p>
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
      </form>
    </div>
  );
}
