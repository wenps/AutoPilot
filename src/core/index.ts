/**
 * Core 模块入口 — 环境无关的 AI Agent 引擎。
 *
 * 纯 TypeScript + fetch，可在任何 JS 运行时使用（浏览器/Worker/Extension）。
 * 不含 DOM API，不依赖 Node.js。
 */

// AI 客户端
export {
  createAIClient,
  type AIClientConfig,
  type ChatParams,
  type ChatRequestInit,
  type AIClient,
  type AIChatResponse,
  type AIMessage,
  type AIToolCall,
  BaseAIClient,
  type BaseAIClientOptions,
  type ChatHandlerParams,
  OpenAIClient,
  AnthropicClient,
} from "./ai-client/index.js";

// 工具注册表
export {
  ToolRegistry,
  type ToolDefinition,
  type ToolCallResult,
  readStringParam,
  readNumberParam,
  jsonResult,
} from "./tool-registry.js";

// 决策循环
export {
  executeAgentLoop,
  type AgentLoopParams,
  type AgentLoopResult,
  type AgentLoopCallbacks,
} from "./agent-loop/index.js";

// 系统提示词
export { buildSystemPrompt, type SystemPromptParams } from "./system-prompt.js";
