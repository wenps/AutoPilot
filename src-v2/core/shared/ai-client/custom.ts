/**
 * 可继承 AI 客户端基类（中）/ Extensible base AI client class (EN).
 *
 * 支持注入 chatHandler 或子类覆写 chat。
 * Supports injected chatHandler or subclass override.
 */
import type { AIChatResponse, AIClient, AIMessage } from "../types.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  consumeSSEJSON,
  type SSEConsumeOptions,
  type SSEJSONHandler,
} from "./sse.js";

// ─── 类型定义 ───

/** chat 入参（中）/ Chat handler params aligned with AIClient.chat (EN). */
export type ChatHandlerParams = {
  /** 系统提示词 */
  systemPrompt: string;
  /** 对话消息列表 */
  messages: AIMessage[];
  /** 可用工具定义列表 */
  tools?: ToolDefinition[];
};

/** BaseAIClient 选项（中）/ BaseAIClient constructor options (EN). */
export type BaseAIClientOptions = {
  /** 对话处理函数 — 接收 ChatHandlerParams，返回 AIChatResponse */
  chatHandler: (params: ChatHandlerParams) => Promise<AIChatResponse>;
};

export {
  consumeSSEJSON,
  type SSEConsumeOptions,
  type SSEJSONHandler,
} from "./sse.js";

// ─── BaseAIClient 类 ───

/**
 * BaseAIClient 实现（中）/ BaseAIClient implementation of AIClient (EN).
 */
export class BaseAIClient implements AIClient {
  /** 用户提供的对话处理函数 */
  protected chatHandler: (params: ChatHandlerParams) => Promise<AIChatResponse>;

  constructor(options: BaseAIClientOptions) {
    this.chatHandler = options.chatHandler;
  }

  /**
   * 发送对话请求（中）/ Dispatch chat request via handler (EN).
   */
  async chat(params: ChatHandlerParams): Promise<AIChatResponse> {
    return this.chatHandler(params);
  }

  /** SSE 消费复用入口（中）/ Reusable SSE(JSON) consumer for subclasses (EN). */
  protected async consumeSSEJSON(
    response: Response,
    onEvent: SSEJSONHandler,
    options?: SSEConsumeOptions,
  ): Promise<void> {
    return consumeSSEJSON(response, onEvent, options);
  }
}
