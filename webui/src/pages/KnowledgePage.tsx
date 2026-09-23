/**
 * 知识库页（PRD v0.7）：技能库 + 插件 + 剧本 + Analyzer 注册表。
 */
import { useCallback, useEffect, useState } from 'react';

interface PlaybookItem { name: string; description: string; mode: string; stepCount: number }
interface AnalyzerItem { name: string; category: string; description: string; types: string[] }
interface PluginItem { id: string; name: string; version: string; description: string | null; capabilities: string[]; enabled: boolean }
interface SkillItem { name: string; description: string; file: string }

export function KnowledgePage() {
  const [playbooks, setPlaybooks] = useState<readonly PlaybookItem[]>([]);
  const [analyzers, setAnalyzers] = useState<readonly AnalyzerItem[]>([]);
  const [plugins, setPlugins] = useState<readonly PluginItem[]>([]);
  const [skills, setSkills] = useState<readonly SkillItem[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [pb, az, pl, sk] = await Promise.all([
        fetch('/api/v1/playbooks', { credentials: 'include' }),
        fetch('/api/v1/analyzers', { credentials: 'include' }),
        fetch('/api/v1/plugins', { credentials: 'include' }),
        fetch('/api/v1/skills', { credentials: 'include' }),
      ]);
      if (pb.ok) setPlaybooks(((await pb.json()) as { playbooks: PlaybookItem[] }).playbooks);
      if (az.ok) setAnalyzers(((await az.json()) as { analyzers: AnalyzerItem[] }).analyzers);
      if (pl.ok) setPlugins(((await pl.json()) as { plugins: PluginItem[] }).plugins);
      if (sk.ok) setSkills(((await sk.json()) as { skills: SkillItem[] }).skills);
      setError(undefined);
    } catch { setError('网络不可达'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error !== undefined) return <div className="p-6 text-ui-base text-destructive">{error}</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-4 text-ui-lg font-semibold">知识库</h1>

      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-ui-base font-medium">运维技能（{skills.length}）</h2>
          {skills.length === 0 ? (
            <div className="rounded-lg border border-card-border bg-card p-3 text-ui-sm text-foreground-subtle">
              技能目录为空（skills/ 下每个子目录一个 SKILL.md，含 name/description frontmatter）
            </div>
          ) : (
            skills.map((s) => (
              <div key={s.name} className="mb-2 rounded-lg border border-card-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-ui-sm">{s.name}</span>
                  <span className="rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">SKILL</span>
                </div>
                <div className="mt-1 text-ui-caption text-foreground-subtle">{s.description}</div>
                <div className="mt-1 font-mono text-ui-xs text-foreground-subtlest">{s.file}</div>
              </div>
            ))
          )}
        </section>

        <section>
          <h2 className="mb-2 text-ui-base font-medium">剧本（{playbooks.length}）</h2>
          {playbooks.map((p) => (
            <div key={p.name} className="mb-2 rounded-lg border border-card-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-ui-sm">{p.name}</span>
                <span className={`rounded-md px-1.5 py-0.5 text-ui-xs ${p.mode === 'detect' ? 'bg-success text-success-foreground' : 'bg-tag'}`}>{p.mode}</span>
                <span className="text-ui-xs text-foreground-subtle">{p.stepCount} 步</span>
              </div>
              <div className="mt-1 text-ui-caption text-foreground-subtle">{p.description}</div>
            </div>
          ))}
        </section>

        <section>
          <h2 className="mb-2 text-ui-base font-medium">Analyzer（{analyzers.length}）</h2>
          {analyzers.map((a) => (
            <div key={a.name} className="mb-1 flex items-center gap-2 text-ui-sm">
              <span className="font-mono">{a.name}</span>
              <span className="rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">{a.category}</span>
              <span className="text-foreground-subtle">{a.description}</span>
            </div>
          ))}
        </section>

        <section>
          <h2 className="mb-2 text-ui-base font-medium">插件（{plugins.length}）</h2>
          {plugins.length === 0 ? (
            <div className="text-ui-caption text-foreground-subtle">暂无插件（通过 CLI skyport plugin install 安装）</div>
          ) : (
            plugins.map((p) => (
              <div key={p.id} className="mb-1 flex items-center gap-2 text-ui-sm">
                <span className="font-mono">{p.name}</span>
                <span className="text-foreground-subtle">v{p.version}</span>
                <span className={`text-ui-xs ${p.enabled ? 'text-success' : 'text-foreground-subtle'}`}>{p.enabled ? '●' : '○'}</span>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
