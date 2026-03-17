/**
 * AI 客户端主入口（中）/ AI client entrypoint based on fetch (EN).
 *
 * 提供 provider 路由与统一类型导出。
 * Provides provider routing and unified type exports.
 */
import type { AIClient, AIMessage } from "../types.js";
import type { ToolDefinition } from "../tool-registry.js";
import { validateProvider } from "./constants.js";
import { OpenAIClient } from "./models/openai.js";
import { AnthropicClient } from "./models/anthropic.js";
import { DeepSeekClient } from "./models/deepseek.js";
import { DoubaoClient } from "./models/doubao.js";
import { QwenClient } from "./models/qwen.js";
import { MiniMaxClient } from "./models/minimax.js";

// Re-export 类型，方便外部统一从 ai-client 导入
export type { AIClient, AIChatResponse, AIMessage, AIToolCall } from "../types.js";

// Re-export 客户端类（基类 + 各 provider）
export { BaseAIClient, type BaseAIClientOptions, type ChatHandlerParams } from "./custom.js";
export { OpenAIClient, parseOpenAIStream } from "./models/openai.js";
export { AnthropicClient, parseAnthropicStream } from "./models/anthropic.js";
export { DeepSeekClient } from "./models/deepseek.js";
export { DoubaoClient } from "./models/doubao.js";
export { QwenClient } from "./models/qwen.js";
export { MiniMaxClient } from "./models/minimax.js";

// ─── 公共类型定义 ───

/** AI 客户端配置（中）/ AI client configuration (EN). */
export type AIClientConfig = {
  /** AI 提供商: "openai" | "copilot" | "anthropic" | "deepseek" | "doubao" | "qwen" | "minimax" */
  provider: string;
  /** 模型名称，如 "gpt-4o"、"claude-sonnet-4-20250514" */
  model: string;
  /** API Key / Token */
  apiKey: string;
  /** 自定义 API 基础 URL（可选，如本地 Ollama: http://localhost:11434/v1） */
  baseURL?: string;
  /** 是否启用流式输出（SSE）。默认 true；传 false 时使用 JSON 非流式响应。 */
  stream?: boolean;
  /** 单次请求超时（毫秒，默认 45000；<=0 表示不设置超时）。 */
  requestTimeoutMs?: number;
  /** 是否允许模型并行返回多个工具调用（默认 true）。 */
  parallelToolCalls?: boolean;
};

/** 统一 chat 入参（中）/ Unified chat parameters (EN). */
export type ChatParams = {
  /** 系统提示词 */
  systemPrompt: string;
  /** 对话消息列表 */
  messages: AIMessage[];
  /** 可用工具定义列表 */
  tools?: ToolDefinition[];
};

/**
 * HTTP 请求对象（中）/ Built HTTP request init payload (EN).
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

// ─── 高层 API ───

/**
 * 创建 AI 客户端（中）/ Create AI client by provider (EN).
 */
export function createAIClient(config: AIClientConfig): AIClient {
  validateProvider(config.provider);

  switch (config.provider) {
    case "openai":
    case "copilot":
      return new OpenAIClient(config);
    case "doubao":
      return new DoubaoClient(config);
    case "qwen":
      return new QwenClient(config);
    case "anthropic":
      return new AnthropicClient(config);
    case "deepseek":
      return new DeepSeekClient(config);
    case "minimax":
      return new MiniMaxClient(config);
    default:
      throw new Error(
        `Unknown AI provider: ${config.provider}. Supported: openai, copilot, anthropic, deepseek, doubao, qwen, minimax`,
      );
  }
}
