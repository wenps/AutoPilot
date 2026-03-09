/**
 * OpenAI/Copilot 客户端（中）/ OpenAI-compatible client implementation (EN).
 */
import type { AIChatResponse, AIMessage, AIToolCall } from "../types.js";
import type { AIClientConfig, ChatParams, ChatRequestInit } from "./index.js";
import { BaseAIClient } from "./custom.js";
import type { ChatHandlerParams } from "./custom.js";
import { consumeSSEJSON } from "./sse.js";
import { resolveBaseURL, cleanSchema } from "./constants.js";

// ─── OpenAI 原始 API 响应类型 ───

/** OpenAI 工具调用原始类型（中）/ Raw OpenAI tool_call shape (EN). */
type OpenAIRawToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** OpenAI 原始响应类型（中）/ Raw OpenAI chat completion response (EN). */
type OpenAIRawResponse = {
  choices?: Array<{
    message: {
      content: string | null;
      tool_calls?: OpenAIRawToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
const JSON_TIMEOUT_RETRY_COUNT = 1;

function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof Error && /^AI request timeout \(\d+ms\)$/.test(error.message);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(input, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`AI request timeout (${timeoutMs}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenAIClient 类 ───

/**
 * OpenAIClient 类（中）/ OpenAIClient class for OpenAI & Copilot (EN).
 */
export class OpenAIClient extends BaseAIClient {
  /** AI 客户端配置（provider / model / apiKey / baseURL） */
  protected config: AIClientConfig;

  constructor(config: AIClientConfig) {
    // 注入 chatHandler — 根据 config.stream 选择流式或 JSON（默认流式）
    super({
      chatHandler: async (params: ChatHandlerParams): Promise<AIChatResponse> => {
        const req = buildOpenAIRequest(this.config, params);
        const useStream = this.config.stream ?? true;
        const requestTimeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

        if (!useStream) {
          let lastError: unknown;

          for (let attempt = 0; attempt <= JSON_TIMEOUT_RETRY_COUNT; attempt++) {
            try {
              const res = await fetchWithTimeout(req.url, {
                method: req.method,
                headers: req.headers,
                body: req.body,
              }, requestTimeoutMs);

              if (!res.ok) {
                const errText = await res.text();
                throw new Error(`AI API ${res.status}: ${errText.slice(0, 500)}`);
              }

              const data = await res.json();
              return parseOpenAIResponse(data);
            } catch (error) {
              lastError = error;
              const shouldRetry = attempt < JSON_TIMEOUT_RETRY_COUNT && isRequestTimeoutError(error);
              if (!shouldRetry) throw error;
            }
          }

          throw lastError instanceof Error ? lastError : new Error("AI request failed");
        }

        // 流式模式：请求体已在 buildOpenAIRequest 中包含 stream 字段
        const streamRes = await fetchWithTimeout(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        }, requestTimeoutMs);

        if (!streamRes.ok) {
          const errText = await streamRes.text();
          throw new Error(`AI API ${streamRes.status}: ${errText.slice(0, 500)}`);
        }

        const contentType = streamRes.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const data = await streamRes.json();
          return parseOpenAIResponse(data);
        }

        return parseOpenAIStream(streamRes, 20000);
      },
    });
    this.config = config;
  }
}

// ─── 底层 API：请求构建 ───

/**
 * 构建 OpenAI 请求（中）/ Build OpenAI chat request payload (EN).
 */
export function buildOpenAIRequest(
  config: AIClientConfig,
  params: ChatParams,
): ChatRequestInit {
  const baseURL = resolveBaseURL(config);
  const { systemPrompt, messages, tools } = params;

  // 转换工具定义为 OpenAI function calling 格式
  const openaiTools = tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: cleanSchema(t.schema),
    },
  }));

  // 转换消息为 OpenAI 格式
  const openaiMessages = convertMessages(systemPrompt, messages);

  // 构建请求体
  const body: Record<string, unknown> = {
    model: config.model,
    messages: openaiMessages,
    temperature: 0.3,
    max_tokens: 4096,
  };

  if (config.stream ?? true) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  if (openaiTools && openaiTools.length > 0) {
    body.tools = openaiTools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = config.parallelToolCalls ?? true;
  }

  return {
    url: `${baseURL}/chat/completions`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

// ─── 响应解析 ───

/**
 * 解析 OpenAI 响应（中）/ Parse raw OpenAI response into AIChatResponse (EN).
 */
export function parseOpenAIResponse(data: unknown): AIChatResponse {
  const d = data as OpenAIRawResponse;
  const choice = d.choices?.[0];
  if (!choice) throw new Error("AI 未返回有效响应");

  const msg = choice.message;

  // 解析工具调用：arguments 是 JSON 字符串，需要 parse 为对象
  const toolCalls: AIToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments),
  }));

  return {
    text: msg.content || undefined,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    usage: d.usage
      ? {
          inputTokens: d.usage.prompt_tokens ?? 0,
          outputTokens: d.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

// ─── 内部辅助函数 ───

/**
 * 消息转换（中）/ Convert unified messages to OpenAI format (EN).
 */
function convertMessages(
  systemPrompt: string,
  messages: AIMessage[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of messages) {
    if (m.role === "tool" && Array.isArray(m.content)) {
      // 工具结果 → 每个结果单独一条 tool 消息（OpenAI 要求按 tool_call_id 对应）
      for (const tc of m.content) {
        result.push({
          role: "tool",
          content: tc.result,
          tool_call_id: tc.toolCallId,
        });
      }
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      // AI 回复含工具调用 → 带 tool_calls 字段
      result.push({
        role: "assistant",
        content: typeof m.content === "string" ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        })),
      });
    } else {
      // 普通消息（user / assistant 纯文本）
      result.push({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content),
      });
    }
  }

  return result;
}

// ─── 流式响应解析 ───

/** 流式 tool_call 增量类型（中）/ Tool-call delta type in SSE stream (EN). */
type OpenAIStreamToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

/** 流式 chunk 类型（中）/ SSE chunk type (EN). */
type OpenAIStreamChunk = {
  choices?: Array<{
    delta: {
      content?: string;
      tool_calls?: OpenAIStreamToolCallDelta[];
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * 解析 OpenAI SSE（中）/ Parse OpenAI SSE stream into unified response (EN).
 */
export async function parseOpenAIStream(
  response: Response,
  readTimeoutMs = 20000,
): Promise<AIChatResponse> {
  // 回退：无 ReadableStream 支持
  if (!response.body) {
    const data = await response.json();
    return parseOpenAIResponse(data);
  }

  let text = "";
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: AIChatResponse["usage"];
  await consumeSSEJSON(
    response,
    (event) => {
      const chunk = event as OpenAIStreamChunk;
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) text += delta.content;

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallMap.get(idx);
          if (existing) {
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          } else {
            toolCallMap.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          }
        }
      }

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    },
    { readTimeoutMs, stopOnDone: true },
  );

  // 组装工具调用
  const toolCalls: AIToolCall[] = [];
  for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
    try {
      toolCalls.push({ id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) });
    } catch {
      // 工具参数 JSON 解析失败，跳过
    }
  }

  return {
    text: text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}
