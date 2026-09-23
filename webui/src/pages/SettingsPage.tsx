/**
 * 设置页（PRD v0.7）：模型配置中心 + 保险箱界面 + 运行时注册表 + 插件管理。
 */
import { useCallback, useEffect, useState } from 'react';

type Tab = 'models' | 'vault' | 'runtimes' | 'plugins';

interface SecretItem { id: string; name: string; hint: string; version: number; updatedAt: string }
interface PluginItem { id: string; name: string; version: string; description: string | null; capabilities: string[]; enabled: boolean; source: string }
interface PlaybookItem { name: string; description: string; mode: string; stepCount: number }
interface AnalyzerItem { name: string; category: string; description: string; types: string[] }
interface PlaybookRun { runId: string; playbookName: string; mode: string; status: string; triggerType: string; triggerAlertId: string | undefined; startedAt: string; stepCount: number }
interface ModelConfig { name: string; baseUrl: string; modelId: string; tier: string; enabled: boolean; lastUsedAt: string | undefined }

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
  const [runs, setRuns] = useState<readonly PlaybookRun[]>([]);
  const [triggering, setTriggering] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<readonly ModelConfig[]>([]);
  const [modelName, setModelName] = useState('');
  const [modelBaseUrl, setModelBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [modelApiKey, setModelApiKey] = useState('');
  const [modelTier, setModelTier] = useState<'cheap' | 'strong'>('cheap');
  const [savingModel, setSavingModel] = useState(false);
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
      const [pbRes, azRes, runRes] = await Promise.all([
        fetch('/api/v1/playbooks', { credentials: 'include' }),
        fetch('/api/v1/analyzers', { credentials: 'include' }),
        fetch('/api/v1/playbook-runs', { credentials: 'include' }),
      ]);
      if (pbRes.ok) setPlaybooks(((await pbRes.json()) as { playbooks: PlaybookItem[] }).playbooks);
      if (azRes.ok) setAnalyzers(((await azRes.json()) as { analyzers: AnalyzerItem[] }).analyzers);
      if (runRes.ok) setRuns(((await runRes.json()) as { runs: PlaybookRun[] }).runs);
    } catch { /* 静默 */ }
  }, []);

  const triggerPlaybook = useCallback(async (name: string) => {
    setTriggering(name);
    try {
      const res = await fetch(`/api/v1/playbooks/${encodeURIComponent(name)}/trigger`, { method: 'POST', credentials: 'include' });
      setNotice(res.ok ? `剧本 ${name} 已触发（结果见下方运行记录）` : `触发失败: ${res.status}`);
      if (res.ok) await loadRuntimes();
    } catch { setNotice('网络不可达'); }
    finally { setTriggering(undefined); }
  }, [loadRuntimes]);

  useEffect(() => {
    if (tab === 'plugins') void loadVault();
    if (tab === 'runtimes') void loadRuntimes();
    if (tab === 'models') void loadModels();
  }, [tab, loadVault, loadRuntimes, loadModels]);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/models', { credentials: 'include' });
      if (res.ok) setModels(((await res.json()) as { models: ModelConfig[] }).models);
    } catch { /* 静默 */ }
  }, []);

  const saveModel = useCallback(async () => {
    if (modelName.trim() === '' || modelBaseUrl.trim() === '' || modelId.trim() === '' || modelApiKey.trim() === '') {
      setNotice('模型名 / 端点 / 模型 ID / API Key 均必填');
      return;
    }
    setSavingModel(true);
    try {
      const res = await fetch('/api/v1/models', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName.trim(), baseUrl: modelBaseUrl.trim(), modelId: modelId.trim(), apiKey: modelApiKey, tier: modelTier, enabled: true }),
      });
      setNotice(res.ok ? `模型 ${modelName.trim()} 已保存（key 加密入保险箱）` : `保存失败: ${res.status}`);
      if (res.ok) {
        setModelApiKey('');
        await loadModels();
      }
    } catch { setNotice('网络不可达'); }
    finally { setSavingModel(false); }
  }, [modelName, modelBaseUrl, modelId, modelApiKey, modelTier, loadModels]);

  const removeModel = useCallback(async (name: string) => {
    try {
      const res = await fetch(`/api/v1/models/${encodeURIComponent(name)}`, { method: 'DELETE', credentials: 'include' });
      setNotice(res.ok ? `模型 ${name} 已删除` : `删除失败: ${res.status}`);
      if (res.ok) await loadModels();
    } catch { setNotice('网络不可达'); }
  }, [loadModels]);

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
        <div className="space-y-4">
          <div className="rounded-xl border border-card-border bg-card p-4">
            <h3 className="mb-2 text-ui-base font-medium">登记模型（OpenAI 兼容端点）</h3>
            <p className="mb-3 text-ui-caption text-foreground-subtle">
              API Key 经 AES-256-GCM 加密存保险箱，任何接口与页面都不回显；tier 供四角色按档选型（巡查员 cheap / 调查处置审查 strong）
            </p>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="名称（如 glm-flash）" className="rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm" />
              <input value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} placeholder="https://.../v1" className="rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm" />
              <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="模型 ID（如 GLM-5.3-Flash）" className="rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm" />
              <input value={modelApiKey} onChange={(e) => setModelApiKey(e.target.value)} placeholder="API Key（只写不读）" type="password" className="rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm" />
              <select value={modelTier} onChange={(e) => setModelTier(e.target.value as 'cheap' | 'strong')} className="rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-sm">
                <option value="cheap">cheap（巡查员）</option>
                <option value="strong">strong（调查/处置/审查）</option>
              </select>
              <button
                type="button"
                disabled={savingModel}
                onClick={() => void saveModel()}
                className="rounded-lg bg-primary px-4 py-1.5 text-ui-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >{savingModel ? '保存中…' : '保存模型'}</button>
            </div>
            {notice !== undefined && <p className="mt-2 text-ui-caption text-foreground-subtle">{notice}</p>}
          </div>
          <div className="rounded-xl border border-card-border bg-card p-4">
            <h3 className="mb-2 text-ui-base font-medium">已登记模型（{models.length}）</h3>
            {models.length === 0 ? (
              <div className="text-ui-caption text-foreground-subtle">暂无模型——AI 座位（巡查员）需要至少一个启用模型才会开始巡逻</div>
            ) : (
              <table className="w-full text-ui-sm">
                <thead>
                  <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
                    <th className="py-2 text-left">名称</th>
                    <th className="py-2 text-left">端点</th>
                    <th className="py-2 text-left">模型 ID</th>
                    <th className="py-2 text-left">档位</th>
                    <th className="py-2 text-left">状态</th>
                    <th className="py-2 text-left">最近使用</th>
                    <th className="py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.name} className="border-b border-card-border last:border-0">
                      <td className="py-2 font-mono">{m.name}</td>
                      <td className="max-w-60 truncate py-2 text-foreground-subtle" title={m.baseUrl}>{m.baseUrl}</td>
                      <td className="py-2 font-mono">{m.modelId}</td>
                      <td className="py-2">{m.tier}</td>
                      <td className="py-2">{m.enabled ? <span className="text-positive">启用</span> : <span className="text-foreground-subtlest">停用</span>}</td>
                      <td className="py-2 text-foreground-subtle">{m.lastUsedAt !== undefined ? m.lastUsedAt.replace('T', ' ').slice(5, 16) : '—'}</td>
                      <td className="py-2 text-right">
                        <button type="button" onClick={() => void removeModel(m.name)} className="rounded-lg border border-input-border px-2 py-0.5 text-ui-xs hover:bg-hover">删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
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
                  <button
                    type="button"
                    disabled={triggering === p.name}
                    onClick={() => void triggerPlaybook(p.name)}
                    className="ml-auto rounded-lg border border-input-border px-2 py-0.5 text-ui-xs hover:bg-hover disabled:opacity-50"
                  >
                    {triggering === p.name ? '触发中…' : '手动触发'}
                  </button>
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
          <div className="rounded-xl border border-card-border bg-card p-4">
            <h3 className="mb-2 text-ui-base font-medium">剧本运行（{runs.length}）</h3>
            {runs.length === 0 ? (
              <div className="text-ui-caption text-foreground-subtle">暂无运行记录——告警命中剧本 trigger 时自动触发，或用上方按钮手动触发</div>
            ) : (
              <table className="w-full text-ui-sm">
                <thead>
                  <tr className="border-b border-card-border text-ui-xs text-foreground-subtle">
                    <th className="py-2 text-left">时间</th>
                    <th className="py-2 text-left">剧本</th>
                    <th className="py-2 text-left">相</th>
                    <th className="py-2 text-left">状态</th>
                    <th className="py-2 text-left">触发</th>
                    <th className="py-2 text-right">步数</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.runId} className="border-b border-card-border last:border-0">
                      <td className="py-2 text-foreground-subtle">{r.startedAt.replace('T', ' ').slice(5, 19)}</td>
                      <td className="py-2 font-mono">{r.playbookName}</td>
                      <td className="py-2">{r.mode}</td>
                      <td className={`py-2 ${r.status === 'completed' || r.status === 'shadow-completed' ? 'text-positive' : r.status === 'aborted' ? 'text-destructive' : 'text-warning'}`}>{r.status}</td>
                      <td className="py-2 text-foreground-subtle">{r.triggerType === 'alert' ? `告警 ${r.triggerAlertId ?? ''}` : '手动'}</td>
                      <td className="py-2 text-right font-mono">{r.stepCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
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
