import { describe, expect, it } from 'vitest';
import { runDoctor } from './doctor';

describe('doctor 环境自检服务', () => {
  it('正常路径：本机 node 可用、配置可加载，整体通过', async () => {
    const report = await runDoctor();
    expect(report.ok).toBe(true);
    const names = report.checks.map((check) => check.name);
    expect(names).toContain('node-runtime');
    expect(names).toContain('config');
    expect(names).toContain('project-config-file');
  });
});
