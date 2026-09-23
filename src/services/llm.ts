/**
 * LLM 客户端（spec/llm-seat）：OpenAI 兼容 chat/completions 调用。
 * - 出网走 http 适配器（AGENTS.md §4：业务代码禁止直接 fetch）
 * - API key 从模型配置 → 保险箱解析，绝不进日志/响应
 * - 每次调用记 usage_events（Token 用量治理），供用量看板与预算告警
 * - 输出侧注入防御：模型回复先过注入守卫，命中模式即拒绝采用
 */
import { httpRequest } from '../adapters/http';
import { createError, ERROR_CODES } from '../errors/errors';
import { rootLogger } from '../logger/logger';
import { resolveModelForTier, touchModelUsed, type ModelTier } from './model-config';
import { recordUsage } from './usage';
import { guardContent } from './injection-guard';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmCallOptions {
  readonly tier?: ModelTier | undefined;
  readonly temperature?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxTokens?: number | undefined;
  /** 调用方 agent id（usage 记账归属，必填——usage_events 有 agents 外键） */
  readonly agentId: string;
  /** 行动关联（若有） */
  readonly actionId?: string | undefined;
}

export interface LlmResult {
  readonly content: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly durationMs: number;
  readonly injectionsDetected: readonly string[];
}

interface OpenAiChatResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly error?: { readonly message?: string };
}

/** 一次对话补全：选型 → 调用 → 注入检查 → 用量记账 */
export async function chatComplete(messages: readonly ChatMessage[], options: LlmCallOptions): Promise<LlmResult> {
  const model = resolveModelForTier(options.tier ?? 'cheap');
  const body = JSON.stringify({
    model: model.modelId,
    messages,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
  });

  const startedAt = Date.now();
  const response = await httpRequest(`${model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // key 只在此处出现：不落日志、不进错误上下文
      Authorization: `Bearer ${model.apiKey}`,
    },
    body,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  const durationMs = Date.now() - startedAt;

  if (response.status !== 200) {
    // 错误信息可能含上游细节，剥掉 key（key 从不在响应体里，但保守起见只透传状态码与截断体）
    const detail = response.body.slice(0, 300).replace(model.apiKey, '***');
    rootLogger.warn('LLM 调用失败', { model: model.name, status: response.status });
    throw createError(ERROR_CODES.NETWORK_REQUEST_FAILED, `LLM 调用失败（${response.status}）: ${detail}`, {
      context: { model: model.name, status: response.status },
    });
  }

  let parsed: OpenAiChatResponse;
  try {
    parsed = JSON.parse(response.body) as OpenAiChatResponse;
  } catch {
    throw createError(ERROR_CODES.NETWORK_REQUEST_FAILED, 'LLM 响应不是合法 JSON', { context: { model: model.name } });
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content === '') {
    const reason = parsed.error?.message ?? '空回复';
    throw createError(ERROR_CODES.NETWORK_REQUEST_FAILED, `LLM 返回无内容: ${reason}`, { context: { model: model.name } });
  }

  // 输出侧注入防御：模型回复按不可信内容处理（观测数据可能带指令注入）
  const guard = guardContent(content, 'llm-output');

  // 用量记账（usage 表的 agent FK：调用方 agent 必须存在，缺省记到系统 id）
  const promptTokens = parsed.usage?.prompt_tokens ?? 0;
  const completionTokens = parsed.usage?.completion_tokens ?? 0;
  recordUsage({
    agentId: options.agentId,
    model: model.modelId,
    promptTokens,
    completionTokens,
    costUsd: 0, // 自托管/包月端点暂无单价；表结构已留，接计费 API 后填
    actionId: options.actionId,
  });
  touchModelUsed(model.name);

  rootLogger.info('LLM 调用完成', { model: model.name, promptTokens, completionTokens, durationMs, injections: guard.detectedPatterns.length });
  return { content: guard.sanitized, model: model.modelId, promptTokens, completionTokens, durationMs, injectionsDetected: guard.detectedPatterns };
}
