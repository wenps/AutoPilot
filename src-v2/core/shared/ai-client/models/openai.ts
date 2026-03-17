/**
 * OpenAI/Copilot 客户端（中）/ OpenAI-compatible client implementation (EN).
 *
 * 对接 OpenAI Chat Completions API（https://platform.openai.com/docs/api-reference/chat）。
 * 同时兼容 GitHub Copilot（Azure inference endpoint）及所有 OpenAI 兼容协议的 provider。
 *
 * 核心能力：
 * - 支持流式（SSE）与非流式（JSON）两种模式，默认流式
 * - 非流式模式内置超时 + 自动重试（超时后重试 1 次）
 * - 流式模式支持 stream_options.include_usage 获取 token 用量
 * - 流式模式下若服务端返回 application/json（如降级），自动回退为 JSON 解析
 * - 支持 parallel_tool_calls 配置，允许模型并行返回多个工具调用
 *
 * 本文件同时被 DeepSeek / Doubao / Qwen / MiniMax 等 OpenAI 兼容 provider 继承复用。
 */
import type { AIChatResponse, AIMessage, AIToolCall } from "../../types.js";
import type { AIClientConfig, ChatParams, ChatRequestInit } from "../index.js";
import { BaseAIClient } from "../custom.js";
import type { ChatHandlerParams } from "../custom.js";
import { consumeSSEJSON } from "../sse.js";
import { resolveBaseURL, cleanSchema } from "../constants.js";

// ─── OpenAI 原始 API 响应类型 ───

/**
 * OpenAI 工具调用原始类型（中）/ Raw OpenAI tool_call shape in API response (EN).
 * 注意：`arguments` 是 JSON 字符串，需要调用方自行 `JSON.parse`。
 */
type OpenAIRawToolCall = {
  /** 工具调用唯一 ID，用于后续 tool result 关联 */
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * OpenAI 原始响应类型（中）/ Raw OpenAI chat completion response shape (EN).
 * 仅提取 SDK 关心的字段：choices[0].message 和 usage。
 */
type OpenAIRawResponse = {
  choices?: Array<{
    message: {
      /** 模型文本回复，无内容时为 null */
      content: string | null;
      /** 模型请求的工具调用列表（可选） */
      tool_calls?: OpenAIRawToolCall[];
    };
  }>;
  /** Token 用量统计 */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

/** 单次请求默认超时时间（毫秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
/** JSON（非流式）模式超时后的最大重试次数 */
const JSON_TIMEOUT_RETRY_COUNT = 1;

/**
 * 判断错误是否为请求超时错误（中）/ Check if error is a request timeout (EN).
 * 仅匹配 `fetchWithTimeout` 抛出的特定格式错误消息。
 */
function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof Error && /^AI request timeout \(\d+ms\)$/.test(error.message);
}

/**
 * 带超时的 fetch 封装（中）/ Fetch wrapper with AbortController-based timeout (EN).
 *
 * 工作原理：
 * 1. 创建 AbortController，设置 setTimeout 在超时后调用 controller.abort()
 * 2. 将 controller.signal 注入 fetch 请求
 * 3. 若 fetch 被 abort，捕获 AbortError 并转换为语义明确的超时错误
 * 4. 无论成功或失败，finally 中清除定时器避免泄漏
 *
 * @param input - 请求 URL 或 Request 对象
 * @param init - fetch 请求配置
 * @param timeoutMs - 超时毫秒数（<=0 或非有限数时不设超时）
 * @returns fetch Response
 * @throws Error - 超时时抛出 "AI request timeout (Xms)"
 */
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
 * OpenAIClient 类（中）/ OpenAI & Copilot client implementation (EN).
 *
 * 继承 BaseAIClient，通过注入 chatHandler 实现 OpenAI Chat Completions 协议。
 * 根据 `config.stream`（默认 true）自动选择流式（SSE）或非流式（JSON）模式。
 *
 * 非流式模式特性：
 * - 使用 `fetchWithTimeout` + AbortController 实现请求级超时
 * - 超时后自动重试 1 次（`JSON_TIMEOUT_RETRY_COUNT`），应对单次网络抖动
 * - 非超时错误不重试，直接抛出
 *
 * 流式模式特性：
 * - 通过 SSE 逐 chunk 接收 delta 内容和工具调用片段
 * - 若服务端返回 application/json（如模型降级），自动回退为 JSON 解析
 * - 单次 chunk 读取超时 20s（`readTimeoutMs`）
 *
 * 本类也是 DeepSeek / Doubao / Qwen / MiniMax 等兼容 provider 的基类。
 */
export class OpenAIClient extends BaseAIClient {
  /** AI 客户端配置（provider / model / apiKey / baseURL） */
  protected config: AIClientConfig;

  /**
   * 构造 OpenAIClient 实例。
   * @param config - AI 客户端配置，需包含 provider / model / apiKey
   */
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
 * 构建 OpenAI Chat Completions 请求（中）/ Build OpenAI chat request payload (EN).
 *
 * 将统一的 ChatParams 转换为 OpenAI 协议格式：
 * - system prompt 作为 messages 数组首条 system 消息
 * - 工具定义转换为 `{ type: "function", function: { name, description, parameters } }` 格式
 * - 流式模式设置 `stream: true` + `stream_options: { include_usage: true }` 获取用量
 * - 有工具时设置 `tool_choice: "auto"` + `parallel_tool_calls`（默认允许并行）
 * - temperature 固定 0.3（偏确定性，适合工具调用场景）
 * - 认证使用 `Authorization: Bearer <apiKey>`
 *
 * 构建后的请求体示例（流式 + 含工具）：
 * ```json
 * // POST https://api.openai.com/v1/chat/completions
 * // Headers: { "Authorization": "Bearer sk-xxx", "Content-Type": "application/json" }
 * {
 *   "model": "gpt-4o",
 *   "messages": [
 *     { "role": "system", "content": "You are a browser automation agent..." },
 *     { "role": "user", "content": "Click the submit button" }
 *   ],
 *   "tools": [
 *     {
 *       "type": "function",
 *       "function": {
 *         "name": "dom",
 *         "description": "DOM interaction tool. Actions: click, fill, ...",
 *         "parameters": { "type": "object", "properties": { "action": { ... }, "selector": { ... } } }
 *       }
 *     }
 *   ],
 *   "tool_choice": "auto",
 *   "parallel_tool_calls": true,
 *   "temperature": 0.3,
 *   "max_tokens": 4096,
 *   "stream": true,
 *   "stream_options": { "include_usage": true }
 * }
 * ```
 *
 * @param config - AI 客户端配置
 * @param params - 统一聊天参数（systemPrompt / messages / tools）
 * @returns 构建好的 HTTP 请求对象（url / method / headers / body）
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
 * 解析 OpenAI JSON 响应（中）
 *
 * 从 choices[0].message 中提取文本和工具调用，并映射 usage 统计。
 * 工具调用的 `arguments` 字段为 JSON 字符串，此处解析为对象。
 *
 * 输入示例（非流式 JSON 响应）：
 * ```json
 * {
 *   "choices": [{
 *     "message": {
 *       "content": null,
 *       "tool_calls": [{
 *         "id": "call_abc123",
 *         "type": "function",
 *         "function": {
 *           "name": "dom",
 *           "arguments": "{\"action\":\"click\",\"selector\":\"#submit-btn\"}"
 *         }
 *       }]
 *     }
 *   }],
 *   "usage": { "prompt_tokens": 1200, "completion_tokens": 45 }
 * }
 * ```
 *
 * 输出（统一 AIChatResponse）：
 * ```json
 * {
 *   "text": undefined,
 *   "toolCalls": [{ "id": "call_abc123", "name": "dom", "input": { "action": "click", "selector": "#submit-btn" } }],
 *   "usage": { "inputTokens": 1200, "outputTokens": 45 }
 * }
 * ```
 *
 * @param data - OpenAI API 返回的原始 JSON 对象
 * @returns 统一的 AIChatResponse
 * @throws Error - choices 为空时抛出 "AI 未返回有效响应"
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
 * 统一消息格式转换为 OpenAI 格式（中）/ Convert unified AIMessage[] to OpenAI message format (EN).
 *
 * 转换规则：
 * - system prompt → 首条 `{ role: "system", content }` 消息
 * - `tool` 角色 → 展开为多条 `{ role: "tool", tool_call_id, content }` 消息（OpenAI 要求每个结果独立一条）
 * - `assistant` 带 toolCalls → `{ role: "assistant", content, tool_calls }` 消息
 * - 其他（user / assistant 纯文本）→ 直接映射
 *
 * 输入示例（统一 AIMessage[]）：
 * ```ts
 * messages = [
 *   { role: "user", content: "帮我点击提交按钮" },
 *   { role: "assistant", content: "好的", toolCalls: [
 *     { id: "call_abc", name: "dom", input: { action: "click", selector: "#btn" } }
 *   ]},
 *   { role: "tool", content: [
 *     { toolCallId: "call_abc", result: "点击成功" }
 *   ]}
 * ]
 * ```
 *
 * 输出示例（OpenAI 格式）：
 * ```json
 * [
 *   { "role": "system", "content": "You are a browser automation agent..." },
 *   { "role": "user", "content": "帮我点击提交按钮" },
 *   { "role": "assistant", "content": "好的", "tool_calls": [
 *     { "id": "call_abc", "type": "function", "function": { "name": "dom", "arguments": "{\"action\":\"click\",\"selector\":\"#btn\"}" } }
 *   ]},
 *   { "role": "tool", "tool_call_id": "call_abc", "content": "点击成功" }
 * ]
 * ```
 *
 * @param systemPrompt - 系统提示词
 * @param messages - 统一消息列表
 * @returns OpenAI 格式的消息数组
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

/**
 * 流式 tool_call 增量类型（中）/ Tool-call delta fragment in SSE stream (EN).
 * 每个 chunk 可能只包含工具调用的部分信息（如只有 arguments 片段），
 * 需要按 `index` 累积拼接完整的工具调用。
 */
type OpenAIStreamToolCallDelta = {
  /** 工具调用在数组中的索引，用于累积同一工具调用的多个 delta */
  index: number;
  /** 工具调用 ID（仅首次 delta 包含） */
  id?: string;
  function?: { name?: string; arguments?: string };
};

/**
 * 流式 SSE chunk 类型（中）/ OpenAI SSE chunk shape (EN).
 * 每个 chunk 对应一个 `data:` 行的 JSON，包含增量文本、工具调用片段和 usage。
 */
type OpenAIStreamChunk = {
  choices?: Array<{
    delta: {
      /** 增量文本内容 */
      content?: string;
      /** 增量工具调用片段 */
      tool_calls?: OpenAIStreamToolCallDelta[];
    };
  }>;
  /** 最终 chunk 中携带的 token 用量（需 stream_options.include_usage=true） */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * 解析 OpenAI SSE 流式响应（中）/ Parse OpenAI SSE stream into unified AIChatResponse (EN).
 *
 * 工作原理：
 * 1. 通过 `consumeSSEJSON` 逐 chunk 消费 SSE 事件
 * 2. 文本内容（`delta.content`）逐 chunk 拼接为完整字符串
 * 3. 工具调用按 `delta.tool_calls[].index` 累积：
 *    - 首个 delta 包含 id 和 name
 *    - 后续 delta 只包含 arguments 片段，需要拼接
 *    - 最终按 index 排序，逐个 JSON.parse 解析 arguments
 * 4. usage 信息来自最终 chunk（需 `stream_options.include_usage=true`）
 * 5. 遇到 `[DONE]` 信号自动结束（`stopOnDone: true`）
 *
 * SSE 流示例（含工具调用）：
 * ```
 * data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"dom","arguments":""}}]}}]}
 * data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"action"}}]}}]}
 * data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"click\",\"selector"}}]}}]}
 * data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"#submit-btn\"}"}}]}}]}
 * data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1200,"completion_tokens":45}}
 * data: [DONE]
 * ```
 *
 * SSE 流示例（纯文本）：
 * ```
 * data: {"choices":[{"delta":{"content":"我"}}]}
 * data: {"choices":[{"delta":{"content":"已经"}}]}
 * data: {"choices":[{"delta":{"content":"完成了"}}]}
 * data: {"choices":[{"delta":{"content":"任务。"}}]}
 * data: {"choices":[{"delta":{}},"usage":{"prompt_tokens":800,"completion_tokens":12}]}
 * data: [DONE]
 * ```
 *
 * 最终输出（统一 AIChatResponse）：
 * ```json
 * {
 *   "text": "我已经完成了任务。",
 *   "toolCalls": undefined,
 *   "usage": { "inputTokens": 800, "outputTokens": 12 }
 * }
 * ```
 *
 * 回退：若 response.body 不可用（无 ReadableStream 支持），回退为 JSON 解析。
 *
 * @param response - OpenAI API 的流式 HTTP 响应
 * @param readTimeoutMs - 单次 chunk 读取超时（毫秒，默认 20000）
 * @returns 统一的 AIChatResponse（文本 + 工具调用 + usage）
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
