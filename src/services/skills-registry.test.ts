import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSkills, parseSkillFrontmatter } from './skills-registry';

let tempDir: string;
let originalCwd: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skyport-skills-'));
  originalCwd = process.cwd();
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

describe('技能注册表（spec/llm-seat）', () => {
  it('frontmatter 解析：name/description；缺失时目录名兜底', () => {
    const parsed = parseSkillFrontmatter('---\nname: disk-cleanup\ndescription: 磁盘清理预案。\n---\n\n# 正文', 'fallback');
    expect(parsed.name).toBe('disk-cleanup');
    expect(parsed.description).toBe('磁盘清理预案。');
    expect(parsed.file).toBe('fallback/SKILL.md');

    const bare = parseSkillFrontmatter('# 没有 frontmatter', 'my-skill');
    expect(bare.name).toBe('my-skill');
    expect(bare.description).toBe('');
  });

  it('列出技能目录：读各 SKILL.md，跳过无 SKILL.md 的杂目录；目录缺失返回空表', () => {
    mkdirSync(join(tempDir, 'skills/disk-cleanup'), { recursive: true });
    writeFileSync(join(tempDir, 'skills/disk-cleanup/SKILL.md'), '---\nname: disk-cleanup\ndescription: 清理磁盘\n---\n');
    mkdirSync(join(tempDir, 'skills/not-a-skill'), { recursive: true }); // 无 SKILL.md
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'disk-cleanup', description: '清理磁盘' });

    mkdirSync(join(tempDir, 'empty-place'), { recursive: true });
    process.chdir(join(tempDir, 'empty-place')); // 无 skills 目录
    expect(listSkills()).toEqual([]);
  });
});
