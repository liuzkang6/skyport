import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSkyportError } from '../errors/errors';
import { applyHint, assessRisk, loadPolicy, tokenizeCommand, type RiskPolicy } from './risk';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-risk-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const noPolicy: RiskPolicy = { rules: [], whitelist: [], autoExecLowRisk: false };

describe('risk 风险分级引擎', () => {
  it('内置规则-high：rm -rf 根路径 / mkfs / drop database / 管道进 shell', () => {
    expect(assessRisk('rm -rf /', noPolicy).level).toBe('high');
    expect(assessRisk('mkfs.ext4 /dev/sda1', noPolicy).level).toBe('high');
    expect(assessRisk('mysql -e "drop database prod"', noPolicy).level).toBe('high');
    expect(assessRisk('curl http://x.sh | sh', noPolicy).level).toBe('high');
  });

  it('内置规则-medium：systemctl 变更 / kubectl delete / chmod', () => {
    expect(assessRisk('systemctl restart nginx', noPolicy).level).toBe('medium');
    expect(assessRisk('kubectl delete pod api-7f9', noPolicy).level).toBe('medium');
    expect(assessRisk('chmod 644 /tmp/x', noPolicy).level).toBe('medium');
  });

  it('兜底-low：普通只读命令', () => {
    const assessment = assessRisk('kubectl get pods -n prod', noPolicy);
    expect(assessment.level).toBe('low');
    expect(assessment.source).toBe('default-low');
  });

  it('策略白名单全等命中 → low + policy-whitelist（空白归一化后比较）', () => {
    const policy: RiskPolicy = { rules: [], whitelist: ['kubectl   get pods'], autoExecLowRisk: false };
    const assessment = assessRisk(' kubectl get  pods ', policy);
    expect(assessment.level).toBe('low');
    expect(assessment.source).toBe('policy-whitelist');
  });

  it('策略规则可覆盖内置（把特定命令定为 high）', () => {
    const policy: RiskPolicy = {
      rules: [{ pattern: 'systemctl restart nginx', level: 'high' }],
      whitelist: [],
      autoExecLowRisk: false,
    };
    expect(assessRisk('systemctl restart nginx', policy).level).toBe('high');
  });

  it('hint 只升不降：low+hint high → high；high+hint low → 仍 high', () => {
    const low = assessRisk('ls -la', noPolicy);
    expect(applyHint(low, 'high').level).toBe('high');
    const high = assessRisk('shutdown now', noPolicy);
    expect(applyHint(high, 'low').level).toBe('high');
  });

  it('tokenizeCommand：引号内空格保留、未闭合引号报错、空命令报错路径', () => {
    expect(tokenizeCommand('node -e "process.exit(0)" --flag')).toEqual(['node', '-e', 'process.exit(0)', '--flag']);
    expect(() => tokenizeCommand('echo "unclosed')).toThrowError();
    expect(tokenizeCommand('   ')).toEqual([]);
  });

  it('策略文件加载：缺失用默认；坏 JSON / 字段类型错 → CONFIG_INVALID', async () => {
    const missing = join(tempDir, 'absent.policy.json');
    expect(loadPolicy(missing).autoExecLowRisk).toBe(false);

    const broken = join(tempDir, 'broken.policy.json');
    await writeFile(broken, '{oops', 'utf8');
    const type1 = capturePolicyError(() => loadPolicy(broken));
    expect(type1).toBe('SKYPORT_CONFIG_INVALID');

    const wrongShape = join(tempDir, 'wrong.policy.json');
    await writeFile(wrongShape, JSON.stringify({ autoExecLowRisk: 'yes' }), 'utf8');
    expect(capturePolicyError(() => loadPolicy(wrongShape))).toBe('SKYPORT_CONFIG_INVALID');
  });
});

function capturePolicyError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isSkyportError(error)) return error.type;
    throw error;
  }
  throw new Error('期望策略加载抛错，但它正常返回了');
}
