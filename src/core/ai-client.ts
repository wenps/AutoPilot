/**
 * AI Client — 基于 fetch 的 AI 客户端。
 *
 * 使用原生 fetch API，浏览器天然支持。
 * 不依赖任何 SDK（@anthropic-ai/sdk、openai），零环境耦合。
 *
 * 支持三种 provider：
 * - "openai"    → OpenAI API (https://api.openai.com/v1)
 * - "copilot"   → GitHub Models API (https://models.inference.ai.azure.com)
 * - "anthropic" → Anthropic API (https://api.anthropic.com)
 *
 * 提供两层 API：
 * - 高层：createAIClient(config) → AIClient（封装完整的 chat 流程）
 * - 底层：buildChatRequest() + parseChatResponse()（用户自定义 fetch 逻辑）
 *
 * 使用方：
 *   core/ai-client.ts ←── web/index.ts（WebAgent）
 */
import type { AIClient, AIChatResponse, AIMessage, AIToolCall } from "./types.js";
import type { ToolDefinition } from "./tool-registry.js";

// Re-export 类型，方便外部统一从 ai-client 导入
export type { AIClient, AIChatResponse, AIMessage, AIToolCall } from "./types.js";

// ─── 类型定义 ───

/** AI 客户端配置 */
export type AIClientConfig = {
  /** AI 提供商: "openai" | "copilot" | "anthropic" */
  provider: string;
  /** 模型名称, 如 "gpt-4o", "claude-sonnet-4-20250514" */
  model: string;
  /** API Key / Token */
  apiKey: string;
  /** 自定义 API 基础 URL（可选） */
  baseURL?: string;
};

/** chat 方法的统一入参 */
export type ChatParams = {
  /** 系统提示词 */
  systemPrompt: string;
  /** 对话消息列表 */
  messages: AIMessage[];
  /** 可用工具定义列表 */
  tools?: ToolDefinition[];
};

/**
 * 构建好的 HTTP 请求对象 — 可直接传给 fetch。
 *
 * 使用示例：
 * ```ts
 * const req = buildChatRequest(config, params);
 * // 自定义修改 headers、body 等
 * req.headers["X-Custom"] = "value";
 * const { url, ...init } = req;
 * const res = await fetch(url, init);
 * const data = await res.json();
 * const response = parseChatResponse(config.provider, data);
 * ```
 */
export type ChatRequestInit = {
  /** 请求 URL */
  url: string;
  /** HTTP 方法 */
  method: "POST";
  /** 请求头 */
  headers: Record<string, string>;
  /** 请求体（JSON 字符串） */
  body: string;
};

// ─── 常量 ───

/** 各 Provider 的默认 API 端点 */
const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  copilot: "https://models.inference.ai.azure.com",
  anthropic: "https://api.anthropic.com",
};

// ─── 高层 API ───

/**
 * 创建 AI 客户端（高层 API）。
 *
 * 封装了请求构建、fetch 发送、响应解析的完整流程。
 * 返回 `AIClient` 实例，调用 `chat()` 即可与 AI 对话。
 *
 * @param config - 包含 provider、model、apiKey 等配置
 * @returns AIClient 实例
 */
export function createAIClient(config: AIClientConfig): AIClient {
  validateProvider(config.provider);

  return {
    async chat(params: ChatParams): Promise<AIChatResponse> {
      const req = buildChatRequest(config, params);

      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`AI API ${res.status}: ${errText.slice(0, 500)}`);
      }

      const data = await res.json();
      return parseChatResponse(config.provider, data);
    },
  };
}

// ─── 底层 API：请求构建 ───

/**
 * 构建 AI 聊天请求对象（底层 API）。
 *
 * 根据 provider 将统一的 ChatParams 转换为对应 API 格式的 HTTP 请求。
 * 返回 `ChatRequestInit`，用户可在发送前自定义修改 headers/body 等。
 *
 * @param config - AI 客户端配置
 * @param params - 统一格式的聊天参数
 * @returns 可直接传给 fetch 的请求对象
 */
export function buildChatRequest(
  config: AIClientConfig,
  params: ChatParams,
): ChatRequestInit {
  const { provider } = config;

  switch (provider) {
    case "openai":
    case "copilot":
      return buildOpenAIRequest(config, params);
    case "anthropic":
      return buildAnthropicRequest(config, params);
    default:
      throw new Error(
        `Unknown AI provider: ${provider}. Supported: openai, copilot, anthropic`,
      );
  }
}

// ─── 底层 API：响应解析 ───

/**
 * 解析 AI 聊天响应（底层 API）。
 *
 * 将各 provider 的原始 JSON 响应转换为统一的 `AIChatResponse` 格式。
 *
 * @param provider - AI 提供商名称
 * @param data - fetch 返回的原始 JSON 数据
 * @returns 统一格式的 AI 响应
 */
export function parseChatResponse(
  provider: string,
  data: unknown,
): AIChatResponse {
  switch (provider) {
    case "openai":
    case "copilot":
      return parseOpenAIResponse(data);
    case "anthropic":
      return parseAnthropicResponse(data);
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}

// ─── 内部工具函数 ───

/** 校验 provider 是否受支持 */
function validateProvider(provider: string): void {
  if (!PROVIDER_ENDPOINTS[provider]) {
    throw new Error(
      `Unknown AI provider: ${provider}. Supported: openai, copilot, anthropic`,
    );
  }
}

/** 解析 provider 对应的 API 基础 URL */
function resolveBaseURL(config: AIClientConfig): string {
  return config.baseURL ?? PROVIDER_ENDPOINTS[config.provider] ?? "";
}

/**
 * 清理 TypeBox Schema — 去除 Symbol 等不可序列化的属性。
 * TypeBox 的 Type.Object() 产物包含 Symbol key，JSON.stringify 会忽略，
 * 但某些 API 端点会报错，所以先做一次 JSON roundtrip 清理。
 */
function cleanSchema(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

// ─── OpenAI / Copilot 格式转换 ───

/** 将统一格式的 ChatParams 转换为 OpenAI API 请求 */
function buildOpenAIRequest(
  config: AIClientConfig,
  params: ChatParams,
): ChatRequestInit {
  const baseURL = resolveBaseURL(config);
  const { systemPrompt, messages, tools } = params;

  // ── 转换工具定义为 OpenAI function calling 格式 ──
  const openaiTools = tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: cleanSchema(t.schema),
    },
  }));

  // ── 转换消息为 OpenAI 格式 ──
  const openaiMessages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of messages) {
    if (m.role === "tool" && Array.isArray(m.content)) {
      // 工具结果 → 每个结果单独一条 tool 消息
      for (const tc of m.content) {
        openaiMessages.push({
          role: "tool",
          content: tc.result,
          tool_call_id: tc.toolCallId,
        });
      }
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      // AI 回复含工具调用
      openaiMessages.push({
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
      openaiMessages.push({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content),
      });
    }
  }

  // ── 构建请求体 ──
  const body: Record<string, unknown> = {
    model: config.model,
    messages: openaiMessages,
    temperature: 0.3,
    max_tokens: 8192,
  };

  if (openaiTools && openaiTools.length > 0) {
    body.tools = openaiTools;
    body.tool_choice = "auto";
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

/** 将 OpenAI API 原始响应解析为统一的 AIChatResponse */
function parseOpenAIResponse(data: unknown): AIChatResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API 响应无固定类型
  const d = data as any;
  const choice = d.choices?.[0];
  if (!choice) throw new Error("AI 未返回有效响应");

  const msg = choice.message;

  const toolCalls: AIToolCall[] | undefined = msg.tool_calls?.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }),
  );

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

// ─── Anthropic 格式转换 ───

/** 将统一格式的 ChatParams 转换为 Anthropic Messages API 请求 */
function buildAnthropicRequest(
  config: AIClientConfig,
  params: ChatParams,
): ChatRequestInit {
  const baseURL = resolveBaseURL(config);
  const { systemPrompt, messages, tools } = params;

  // ── 转换工具定义为 Anthropic 格式 ──
  const anthropicTools = tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: cleanSchema(t.schema),
  }));

  // ── 转换消息为 Anthropic 格式（system 通过 body.system 传入，不在消息数组中） ──
  const anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool" && Array.isArray(m.content)) {
        // 工具结果 → Anthropic 用 tool_result content block
        return {
          role: "user" as const,
          content: m.content.map((tc) => ({
            type: "tool_result" as const,
            tool_use_id: tc.toolCallId,
            content: tc.result,
          })),
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        // AI 回复含工具调用 → Anthropic 用 tool_use content block
        const content: Record<string, unknown>[] = [];
        if (m.content && typeof m.content === "string") {
          content.push({ type: "text", text: m.content });
        }
        for (const tc of m.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        return { role: "assistant" as const, content };
      }
      return {
        role: m.role as "user" | "assistant",
        content:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content),
      };
    });

  // ── 构建请求体 ──
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.model.includes("opus") ? 16384 : 8192,
    system: systemPrompt,
    messages: anthropicMessages,
  };

  if (anthropicTools && anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }

  return {
    url: `${baseURL}/v1/messages`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  };
}

/** 将 Anthropic Messages API 原始响应解析为统一的 AIChatResponse */
function parseAnthropicResponse(data: unknown): AIChatResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API 响应无固定类型
  const d = data as any;

  // 提取文本（可能有多个 text block，合并为一个字符串）
  const text = d.content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ?.filter((b: any) => b.type === "text")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((b: any) => b.text)
    .join("");

  // 提取工具调用
  const toolCalls: AIToolCall[] | undefined = d.content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ?.filter((b: any) => b.type === "tool_use")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((b: any) => ({
      id: b.id,
      name: b.name,
      input: b.input,
    }));

  return {
    text: text || undefined,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    usage: d.usage
      ? {
          inputTokens: d.usage.input_tokens,
          outputTokens: d.usage.output_tokens,
        }
      : undefined,
  };
}
