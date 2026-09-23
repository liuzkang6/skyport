/**
 * 运行时集成层（v0.5 智能层）：生成任何 MCP 客户端（ZCode/Claude/Cursor）
 * 连接 skyport 的配置。核心三件事：MCP server 指令 + agent key 注入 + 技能挂载。
 */
import { join } from 'node:path';
import { createError, ERROR_CODES } from '../errors/errors';
import { ROLE_TEMPLATES, getRoleSystemPrompt, type RoleName } from './roles';

export interface RuntimeConfig {
  /** skyport mcp 命令（stdio 模式 JSON-RPC） */
  readonly mcpCommand: string;
  readonly mcpArgs: readonly string[];
  /** 环境变量 */
  readonly env: Readonly<Record<string, string>>;
  /** 系统提示词 */
  readonly systemPrompt: string;
  /** 挂载的技能路径 */
  readonly skillsPath: string;
}

export interface RuntimeSetupInput {
  readonly role: RoleName;
  readonly sessionToken: string;
  readonly projectRoot?: string | undefined;
}

/** 生成运行时配置（ZCode 或任何 MCP 客户端可用） */
export function buildRuntimeConfig(input: RuntimeSetupInput): RuntimeConfig {
  const template = ROLE_TEMPLATES[input.role];
  if (template === undefined) {
    throw createError(ERROR_CODES.AGENT_INVALID, `未知角色: ${input.role}`, { context: { role: input.role } });
  }
  const root = input.projectRoot ?? process.cwd();
  return {
    mcpCommand: 'node',
    mcpArgs: [join(root, 'dist', 'cli', 'index.mjs'), 'mcp'],
    env: {
      SKYPORT_API_KEY: input.sessionToken,
      SKYPORT_ROLE: input.role,
    },
    systemPrompt: getRoleSystemPrompt(input.role),
    skillsPath: join(root, 'skills'),
  };
}

/** 生成 ZCode 的 MCP 配置片段（写入 zcode 的配置文件） */
export function toMcpConfig(input: RuntimeSetupInput): Record<string, unknown> {
  const config = buildRuntimeConfig(input);
  return {
    mcpServers: {
      skyport: {
        command: config.mcpCommand,
        args: config.mcpArgs,
        env: { ...config.env },
      },
    },
  };
}

/** 生成环境变量导出脚本（供 shell source） */
export function toEnvScript(input: RuntimeSetupInput): string {
  const config = buildRuntimeConfig(input);
  const lines = [
    `# skyport 运行时配置（角色：${ROLE_TEMPLATES[input.role]?.displayName ?? input.role}）`,
    `export SKYPORT_API_KEY="${config.env.SKYPORT_API_KEY}"`,
    `export SKYPORT_ROLE="${config.env.SKYPORT_ROLE}"`,
    `# MCP server 启动命令`,
    `# ${config.mcpCommand} ${config.mcpArgs.join(' ')}`,
    `# 技能路径`,
    `# ${config.skillsPath}`,
  ];
  return lines.join('\n');
}
