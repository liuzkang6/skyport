/**
 * 技能注册表（spec/llm-seat）：读取 skills 目录下各技能的 SKILL.md frontmatter，
 * 供知识库页与角色运行时发现可用技能。文件读取走 fs 适配器（AGENTS.md §4）。
 */
import { listDirSync, readTextFileSync } from '../adapters/fs';
import { join } from 'node:path';
import { rootLogger } from '../logger/logger';

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly file: string;
}

/** 解析 frontmatter（name/description 两个字段；无 frontmatter 时用目录名兜底） */
export function parseSkillFrontmatter(markdown: string, fallbackName: string): SkillInfo {
  let name = fallbackName;
  let description = '';
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (match !== null) {
    const nameMatch = match[1]?.match(/^name:\s*(.+)$/m);
    const descMatch = match[1]?.match(/^description:\s*(.+)$/m);
    if (nameMatch?.[1] !== undefined) name = nameMatch[1].trim();
    if (descMatch?.[1] !== undefined) description = descMatch[1].trim();
  }
  return { name, description, file: `${fallbackName}/SKILL.md` };
}

/** 列出全部技能（skills 目录缺失时返回空表——技能是可选资产） */
export function listSkills(): SkillInfo[] {
  const skillsDir = join(process.cwd(), 'skills');
  const entries = listDirSync(skillsDir);
  if (entries === undefined) {
    rootLogger.debug('skills 目录不存在，技能注册表为空', { skillsDir });
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries.sort()) {
    const file = join(skillsDir, entry, 'SKILL.md');
    try {
      skills.push(parseSkillFrontmatter(readTextFileSync(file), entry));
    } catch {
      // 非 skill 目录（无 SKILL.md）跳过
    }
  }
  return skills;
}
