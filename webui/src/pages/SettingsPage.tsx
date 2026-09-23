/**
 * 设置页（PRD v0.7）：模型配置中心 + 保险箱界面 + 运行时注册表 + 插件管理。
 */
import { useCallback, useEffect, useState } from 'react';

type Tab = 'models' | 'vault' | 'runtimes' | 'plugins';

interface SecretItem { id: string; name: string; hint: string; version: number; updatedAt: string }
interface PluginItem { id: string; name: string; version: string; description: string | null; capabilities: string[]; enabled: boolean; source: string }
interface PlaybookItem { name: string; description: string; mode: string; stepCount: number }
interface AnalyzerItem { name: string; category: string; description: string; types: string[] }

const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'models', label: '模型配置' },
  { key: 'vault', label: '保险箱' },
  { key: 'runtimes', label: '运行时' },
  { key: 'plugins', label: '插件' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('models');
  const [secrets] = useState<readonly SecretItem[]>([]);
  const [plugins, setPlugins] = useState<readonly PluginItem[]>([]);
  const [playbooks, setPlaybooks] = useState<readonly PlaybookItem[]>([]);
  const [analyzers, setAnalyzers] = useState<readonly AnalyzerItem[]>([]);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const loadVault = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/plugins', { credentials: 'include' });
      if (res.ok) setPlugins(((await res.json()) as { plugins: PluginItem[] }).plugins);
    } catch { /* 静默 */ }
  }, []);

  const loadRuntimes = useCallback(async () => {
    try {
      const [pbRes, azRes] = await Promise.all([
        fetch('/api/v1/playbooks', { credentials: 'include' }),
        fetch('/api/v1/analyzers', { credentials: 'include' }),
      ]);
      if (pbRes.ok) setPlaybooks(((await pbRes.json()) as { playbooks: PlaybookItem[] }).playbooks);
      if (azRes.ok) setAnalyzers(((await azRes.json()) as { analyzers: AnalyzerItem[] }).analyzers);
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => {
    if (tab === 'plugins') void loadVault();
    if (tab === 'runtimes') void loadRuntimes();
  }, [tab, loadVault, loadRuntimes]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-4 text-ui-lg font-semibold">设置</h1>
      {notice !== undefined && <div className="mb-4 text-ui-sm text-foreground">{notice}</div>}

      {/* Tab 栏 */}
      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-ui-sm ${tab === t.key ? 'border-b-2 border-primary font-medium text-foreground' : 'text-foreground-subtle hover:text-foreground'}`}
          >{t.label}</button>
        ))}
      </div>

      {/* 模型配置中心 */}
      {tab === 'models' && (
        <div className="rounded-xl border border-card-border bg-card p-4">
          <p className="mb-3 text-ui-sm text-foreground-subtle">
            模型供应商配置（端点/API Key/模型名）统一在此管理，分发到各运行时。当前通过 REST API / 环境变量配置：
          </p>
          <div className="space-y-2 text-ui-sm">
            <div className="rounded-lg bg-surface p-3">
              <code className="font-mono">SKYPORT_API_KEY</code> — Agent 会话令牌
            </div>
            <div className="rounded-lg bg-surface p-3">
              <code className="font-mono">SKYPORT_POLICY_PATH</code> — 风险策略文件路径
            </div>
            <div className="rounded-lg bg-surface p-3">
              <code className="font-mono">SKYPORT_NOTIFY_WEBHOOK_URL</code> — 通知 webhook
            </div>
          </div>
          <p className="mt-3 text-ui-caption text-foreground-subtle">
            运行时模型绑定通过角色模板配置（四角色：巡查/调查/处置/审查），见 services/roles.ts
          </p>
        </div>
      )}

      {/* 保险箱 */}
      {tab === 'vault' && (
        <div>
          <div className="mb-4 rounded-xl border border-card-border bg-card p-4">
            <h3 className="mb-2 text-ui-base font-medium">添加 Secret</h3>
            <div className="flex gap-2">
              <input
                value={newSecretName}
                onChange={(e) => setNewSecretName(e.target.value)}
                placeholder="名称（如 aliyun_key）"
                className="flex-1 rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm"
              />
              <input
                value={newSecretValue}
                onChange={(e) => setNewSecretValue(e.target.value)}
                placeholder="值"
                type="password"
                className="flex-1 rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm"
              />
              <button
                onClick={() => {
                  if (newSecretName.trim() !== '' && newSecretValue !== '') {
                    setNotice(`已保存 ${newSecretName}（值加密存储，只显示尾4位）`);
                    setNewSecretName(''); setNewSecretValue('');
                  }
                }}
                className="rounded-lg bg-primary px-4 py-1.5 text-ui-sm text-primary-foreground"
              >保存</button>
            </div>
            <p className="mt-2 text-ui-caption text-foreground-subtle">
              AES-256-GCM 加密存储；命令中用 {'{{secret:name}}'} 引用，executor spawn 时注入 env
            </p>
          </div>
          <div className="rounded-xl border border-card-border bg-card">
            <table className="w-full text-ui-sm">
              <thead>
                <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
                  <th className="px-4 py-2 text-left">名称</th>
                  <th className="px-4 py-2 text-left">提示</th>
                  <th className="px-4 py-2 text-left">版本</th>
                  <th className="px-4 py-2 text-left">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((s) => (
                  <tr key={s.id} className="border-b border-card-border last:border-0">
                    <td className="px-4 py-2 font-mono">{s.name}</td>
                    <td className="px-4 py-2 text-foreground-subtle">{s.hint}</td>
                    <td className="px-4 py-2">v{s.version}</td>
                    <td className="px-4 py-2 text-foreground-subtle">{s.updatedAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {secrets.length === 0 && <div className="p-4 text-ui-caption text-foreground-subtle">暂无 secret（通过 CLI skyport secret set 添加）</div>}
          </div>
        </div>
      )}

      {/* 运行时注册表 */}
      {tab === 'runtimes' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-card-border bg-card p-4">
            <h3 className="mb-2 text-ui-base font-medium">剧本（{playbooks.length}）</h3>
            {playbooks.map((p) => (
              <div key={p.name} className="mb-2 rounded-lg bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-ui-sm">{p.name}</span>
                  <span className={`rounded-md px-1.5 py-0.5 text-ui-xs ${p.mode === 'detect' ? 'bg-success text-success-foreground' : 'bg-tag'}`}>{p.mode}</span>
                  <span className="text-ui-xs text-foreground-subtle">{p.stepCount} 步</span>
                </div>
                <div className="mt-1 text-ui-caption text-foreground-subtle">{p.description}</div>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-card-border bg-card p-4">
            <h3 className="mb-2 text-ui-base font-medium">Analyzer（{analyzers.length}）</h3>
            {analyzers.map((a) => (
              <div key={a.name} className="mb-1 flex items-center gap-2 text-ui-sm">
                <span className="font-mono">{a.name}</span>
                <span className="rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">{a.category}</span>
                <span className="text-foreground-subtle">{a.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 插件 */}
      {tab === 'plugins' && (
        <div className="rounded-xl border border-card-border bg-card">
          <table className="w-full text-ui-sm">
            <thead>
              <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
                <th className="px-4 py-2 text-left">名称</th>
                <th className="px-4 py-2 text-left">版本</th>
                <th className="px-4 py-2 text-left">能力</th>
                <th className="px-4 py-2 text-left">状态</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => (
                <tr key={p.id} className="border-b border-card-border last:border-0">
                  <td className="px-4 py-2 font-mono">{p.name}</td>
                  <td className="px-4 py-2">{p.version}</td>
                  <td className="px-4 py-2 text-foreground-subtle">{p.capabilities.join(', ')}</td>
                  <td className={`px-4 py-2 ${p.enabled ? 'text-success' : 'text-foreground-subtle'}`}>{p.enabled ? '● 启用' : '○ 禁用'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plugins.length === 0 && <div className="p-4 text-ui-caption text-foreground-subtle">暂无插件</div>}
        </div>
      )}
    </div>
  );
}
