/**
 * Anthropic 客户端实现（中）/ Anthropic Messages API client implementation (EN).
 *
 * 对接 Anthropic Messages API（https://docs.anthropic.com/en/api/messages），
 * 支持流式（SSE）与非流式（JSON）两种模式，默认流式。
 *
 * 与 OpenAI 协议的主要差异：
 * - system prompt 作为请求体顶层字段，而非消息列表中的 system 角色
 * - 工具定义使用 `input_schema` 字段（而非 `parameters`）
 * - 工具结果以 `user` 角色 + `tool_result` content block 返回
 * - SSE 事件结构不同：message_start / content_block_start / content_block_delta / content_block_stop / message_delta
 * - 认证使用 `x-api-key` 头（而非 `Authorization: Bearer`）
 */
import type { AIChatResponse, AIMessage, AIToolCall } from "../../types.js";
import type { AIClientConfig, ChatParams, ChatRequestInit } from "../index.js";
import { BaseAIClient } from "../custom.js";
import type { ChatHandlerParams } from "../custom.js";
import { consumeSSEJSON } from "../sse.js";
import { resolveBaseURL, cleanSchema } from "../constants.js";

// ─── Anthropic 原始 API 响应类型 ───

/**
 * Anthropic 文本块（中）/ Anthropic text content block (EN).
 * 对应 Messages API 响应中 `type: "text"` 的内容块。
 */
type AnthropicTextBlock = {
  type: "text";
  /** 文本内容 */
  text: string;
};

/**
 * Anthropic 工具调用块（中）/ Anthropic tool_use content block (EN).
 * 对应 Messages API 响应中 `type: "tool_use"` 的内容块，表示模型请求调用一个工具。
 */
type AnthropicToolUseBlock = {
  type: "tool_use";
  /** 工具调用唯一 ID，用于后续 tool_result 关联 */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具调用参数（已解析为对象） */
  input: unknown;
};

/**
 * Anthropic 内容块联合类型（中）/ Anthropic content block union (EN).
 * Messages API 响应的 `content` 数组中每个元素为文本块或工具调用块。
 */
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

/**
 * Anthropic 原始响应类型（中）/ Raw Anthropic Messages API response (EN).
 * 仅提取 SDK 关心的字段：content blocks 和 usage 统计。
 */
type AnthropicRawResponse = {
  /** 响应内容块数组（文本 + 工具调用） */
  content?: AnthropicContentBlock[];
  /** Token 用量统计 */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
};

// ─── AnthropicClient 类 ───

/**
 * AnthropicClient 类（中）/ AnthropicClient class (EN).
 *
 * 继承 BaseAIClient，通过注入 chatHandler 实现 Anthropic Messages API 的请求与响应处理。
 * 根据 `config.stream`（默认 true）自动选择 SSE 流式 或 JSON 非流式模式。
 *
 * 流式模式下，若服务端返回 `application/json`（如模型降级），自动回退为 JSON 解析。
 */
export class AnthropicClient extends BaseAIClient {
  /** AI 客户端配置（provider / model / apiKey / baseURL） */
  protected config: AIClientConfig;

  /**
   * 构造 AnthropicClient 实例。
   * @param config - AI 客户端配置，需包含 provider="anthropic"、model、apiKey
   */
  constructor(config: AIClientConfig) {
    // 注入 chatHandler — 根据 config.stream 选择流式或 JSON（默认流式）
    super({
      chatHandler: async (params: ChatHandlerParams): Promise<AIChatResponse> => {
        const req = buildAnthropicRequest(this.config, params);
        const useStream = this.config.stream ?? true;

        if (!useStream) {
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
          return parseAnthropicResponse(data);
        }

        // 流式模式：请求体已在 buildAnthropicRequest 中包含 stream 字段
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`AI API ${res.status}: ${errText.slice(0, 500)}`);
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const data = await res.json();
          return parseAnthropicResponse(data);
        }

        return parseAnthropicStream(res);
      },
    });
    this.config = config;
  }
}

// ─── 底层 API：请求构建 ───

/**
 * 构建 Anthropic Messages API 请求（中）/ Build Anthropic Messages API request payload (EN).
 *
 * 将统一的 ChatParams 转换为 Anthropic 协议格式：
 * - system prompt 放顶层 `system` 字段（非消息数组）
 * - 工具定义使用 `input_schema`（非 `parameters`）
 * - max_tokens 根据模型名自动调整（opus 系列 16384，其他 8192）
 * - 认证头使用 `x-api-key` + `anthropic-version`
 *
 * 构建后的请求体示例（流式 + 含工具）：
 * ```json
 * // POST https://api.anthropic.com/v1/messages
 * // Headers: { "x-api-key": "sk-ant-xxx", "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
 * {
 *   "model": "claude-sonnet-4-20250514",
 *   "max_tokens": 8192,
 *   "system": "You are a browser automation agent...",
 *   "messages": [
 *     { "role": "user", "content": "Click the submit button" }
 *   ],
 *   "tools": [
 *     {
 *       "name": "dom",
 *       "description": "DOM interaction tool. Actions: click, fill, ...",
 *       "input_schema": { "type": "object", "properties": { "action": { ... }, "selector": { ... } } }
 *     }
 *   ],
 *   "stream": true
 * }
 * ```
 *
 * @param config - AI 客户端配置
 * @param params - 统一聊天参数（systemPrompt / messages / tools）
 * @returns 构建好的 HTTP 请求对象（url / method / headers / body）
 */
export function buildAnthropicRequest(
  config: AIClientConfig,
  params: ChatParams,
): ChatRequestInit {
  const baseURL = resolveBaseURL(config);
  const { systemPrompt, messages, tools } = params;

  // 转换工具定义为 Anthropic 格式（input_schema 而非 parameters）
  const anthropicTools = tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: cleanSchema(t.schema),
  }));

  // 转换消息为 Anthropic 格式（过滤掉 system 角色消息）
  const anthropicMessages = convertMessages(messages);

  // 构建请求体 — system 作为顶层字段
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.model.includes("opus") ? 16384 : 8192,
    system: systemPrompt,
    messages: anthropicMessages,
  };

  if (config.stream ?? true) {
    body.stream = true;
  }

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

// ─── 响应解析 ───

/**
 * 解析 Anthropic JSON 响应（中）/ Parse raw Anthropic JSON response into unified AIChatResponse (EN).
 *
 * 从 content 数组中提取所有 text 块（合并为字符串）和 tool_use 块（转为 AIToolCall），
 * 并映射 usage 字段为统一的 inputTokens / outputTokens。
 *
 * 输入示例（非流式 JSON 响应）：
 * ```json
 * {
 *   "content": [
 *     { "type": "text", "text": "好的，我来点击提交按钮。" },
 *     {
 *       "type": "tool_use",
 *       "id": "toolu_01A09q90qw90lq917835lhds",
 *       "name": "dom",
 *       "input": { "action": "click", "selector": "#submit-btn" }
 *     }
 *   ],
 *   "usage": { "input_tokens": 1500, "output_tokens": 62 }
 * }
 * ```
 *
 * 输出（统一 AIChatResponse）：
 * ```json
 * {
 *   "text": "好的，我来点击提交按钮。",
 *   "toolCalls": [{ "id": "toolu_01A09q90qw90lq917835lhds", "name": "dom", "input": { "action": "click", "selector": "#submit-btn" } }],
 *   "usage": { "inputTokens": 1500, "outputTokens": 62 }
 * }
 * ```
 *
 * @param data - Anthropic API 返回的原始 JSON 对象
 * @returns 统一的 AIChatResponse
 */
export function parseAnthropicResponse(data: unknown): AIChatResponse {
  const d = data as AnthropicRawResponse;

  // 提取所有文本块，合并为单个字符串
  const text = d.content
    ?.filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // 提取所有工具调用块
  const toolCalls: AIToolCall[] | undefined = d.content
    ?.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use")
    .map((b) => ({
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

// ─── 内部辅助函数 ───

/**
 * 统一消息格式转换为 Anthropic 格式（中）/ Convert unified AIMessage[] to Anthropic message format (EN).
 *
 * 转换规则：
 * - 过滤掉 `system` 角色消息（system prompt 已由顶层 `system` 字段处理）
 * - `tool` 角色 → Anthropic `user` 角色 + `tool_result` content blocks
 * - `assistant` 带 toolCalls → text block + tool_use blocks
 * - 其他 → 直接映射 role + content
 *
 * 输入示例（统一 AIMessage[]）：
 * ```ts
 * messages = [
 *   { role: "user", content: "帮我点击提交按钮" },
 *   { role: "assistant", content: "好的", toolCalls: [
 *     { id: "toolu_01A", name: "dom", input: { action: "click", selector: "#btn" } }
 *   ]},
 *   { role: "tool", content: [
 *     { toolCallId: "toolu_01A", result: "点击成功" }
 *   ]}
 * ]
 * ```
 *
 * 输出示例（Anthropic 格式）：
 * ```json
 * [
 *   { "role": "user", "content": "帮我点击提交按钮" },
 *   { "role": "assistant", "content": [
 *     { "type": "text", "text": "好的" },
 *     { "type": "tool_use", "id": "toolu_01A", "name": "dom", "input": { "action": "click", "selector": "#btn" } }
 *   ]},
 *   { "role": "user", "content": [
 *     { "type": "tool_result", "tool_use_id": "toolu_01A", "content": "点击成功" }
 *   ]}
 * ]
 * ```
 *
 * @param messages - 统一消息列表
 * @returns Anthropic 格式的消息数组
 */
function convertMessages(
  messages: AIMessage[],
): Record<string, unknown>[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool" && Array.isArray(m.content)) {
        // 工具结果 → Anthropic 用 user 角色 + tool_result content block
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
        // AI 回复含工具调用 → text block + tool_use blocks
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
      // 普通消息（user / assistant 纯文本）
      return {
        role: m.role as "user" | "assistant",
        content:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content),
      };
    });
}

// ─── 流式响应解析 ───

/**
 * 解析 Anthropic SSE 流式响应（中）/ Parse Anthropic SSE stream into unified AIChatResponse (EN).
 *
 * 事件处理流程：
 * - `message_start`    → 提取 input_tokens
 * - `content_block_start` → 识别 tool_use 块，开始累积工具参数 JSON
 * - `content_block_delta`  → 累积文本（text_delta）或工具参数片段（input_json_delta）
 * - `content_block_stop`   → 完成当前工具调用，解析参数 JSON
 * - `message_delta`        → 提取 output_tokens
 *
 * SSE 流示例（含工具调用）：
 * ```
 * event: message_start
 * data: {"type":"message_start","message":{"usage":{"input_tokens":1500}}}
 *
 * event: content_block_start
 * data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 * event: content_block_delta
 * data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的，我来点"}}
 *
 * event: content_block_delta
 * data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"击提交按钮。"}}
 *
 * event: content_block_stop
 * data: {"type":"content_block_stop","index":0}
 *
 * event: content_block_start
 * data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01A09q","name":"dom"}}
 *
 * event: content_block_delta
 * data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"action\":"}}
 *
 * event: content_block_delta
 * data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"click\",\"selector\":\"#submit-btn\"}"}}
 *
 * event: content_block_stop
 * data: {"type":"content_block_stop","index":1}
 *
 * event: message_delta
 * data: {"type":"message_delta","usage":{"output_tokens":62}}
 *
 * event: message_stop
 * data: {"type":"message_stop"}
 * ```
 *
 * 最终输出（统一 AIChatResponse）：
 * ```json
 * {
 *   "text": "好的，我来点击提交按钮。",
 *   "toolCalls": [{ "id": "toolu_01A09q", "name": "dom", "input": { "action": "click", "selector": "#submit-btn" } }],
 *   "usage": { "inputTokens": 1500, "outputTokens": 62 }
 * }
 * ```
 *
 * 注意：Anthropic SSE 不发送 `[DONE]`，因此 `stopOnDone` 设为 false，
 * 依赖流关闭来结束消费。
 *
 * @param response - Anthropic API 的流式 HTTP 响应
 * @returns 统一的 AIChatResponse（文本 + 工具调用 + usage）
 */
export async function parseAnthropicStream(response: Response): Promise<AIChatResponse> {
  // 回退：无 ReadableStream 支持
  if (!response.body) {
    const data = await response.json();
    return parseAnthropicResponse(data);
  }

  let text = "";
  const toolCalls: AIToolCall[] = [];
  let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  await consumeSSEJSON(
    response,
    (event) => {
      switch (event.type) {
        case "message_start": {
          const msg = event.message as { usage?: { input_tokens?: number } } | undefined;
          inputTokens = msg?.usage?.input_tokens ?? 0;
          break;
        }

        case "content_block_start": {
          const block = event.content_block as { type: string; id?: string; name?: string } | undefined;
          if (block?.type === "tool_use") {
            currentToolUse = { id: block.id ?? "", name: block.name ?? "", inputJson: "" };
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta as { type: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === "text_delta") {
            text += delta.text ?? "";
          } else if (delta?.type === "input_json_delta" && currentToolUse) {
            currentToolUse.inputJson += delta.partial_json ?? "";
          }
          break;
        }

        case "content_block_stop":
          if (currentToolUse) {
            try {
              toolCalls.push({
                id: currentToolUse.id,
                name: currentToolUse.name,
                input: JSON.parse(currentToolUse.inputJson || "{}"),
              });
            } catch {
              // 工具参数 JSON 解析失败，跳过
            }
            currentToolUse = null;
          }
          break;

        case "message_delta": {
          const deltaUsage = (event as { usage?: { output_tokens?: number } }).usage;
          outputTokens = deltaUsage?.output_tokens ?? 0;
          break;
        }
      }
    },
    { stopOnDone: false },
  );

  return {
    text: text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: inputTokens > 0 || outputTokens > 0 ? { inputTokens, outputTokens } : undefined,
  };
}
