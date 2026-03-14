/**
 * Core 模块入口（中）/ Core entrypoint (EN).
 *
 * 纯 TypeScript + fetch，可在任何 JS 运行时使用（浏览器/Worker/Extension）。
 * 不含 DOM API，不依赖 Node.js。
 * Pure TypeScript + fetch that runs across browser/worker/extension runtimes,
 * with no DOM API coupling and no Node.js-only dependency.
 *
 * 流程图（文本）：
 *
 *   用户任务
 *      │
 *      ▼
 *   构建系统提示词（buildSystemPrompt）
 *      │
 *      ▼
 *   创建 AI 客户端（createAIClient） ───────────────┐
 *      │                           │
 *      ▼                           │
 *   执行决策循环（executeAgentLoop）               │
 *      │                           │
 *      ├─ 工具分发执行（ToolRegistry.dispatch） ◄──┘
 *      │
 *      ▼
 *   输出结果（reply / toolCalls / messages / metrics）
 */

// ─────────────────────────────────────────────────────────────────────────────
// AI 客户端能力（中）/ AI client exports (EN)
// ─────────────────────────────────────────────────────────────────────────────

/** 创建统一 AI 客户端工厂 / Factory for provider-specific AI clients. */
export {
  /** 按 provider 创建客户端实例 / Create client instance by provider. */
  createAIClient,
  /** AI 客户端配置类型 / AI client configuration type. */
  type AIClientConfig,
  /** chat 输入参数类型 / Chat request params type. */
  type ChatParams,
  /** chat 底层请求配置类型 / Low-level chat request init type. */
  type ChatRequestInit,
  /** AI 客户端接口 / Unified AI client interface. */
  type AIClient,
  /** AI chat 响应结构 / Unified AI chat response shape. */
  type AIChatResponse,
  /** 对话消息类型 / Conversation message type. */
  type AIMessage,
  /** 工具调用类型 / Tool-call payload type from model. */
  type AIToolCall,
  /** 可自定义 chatHandler 的基类 / Base client with pluggable chat handler. */
  BaseAIClient,
  /** BaseAIClient 构造参数类型 / BaseAIClient options type. */
  type BaseAIClientOptions,
  /** chatHandler 入参类型 / Params type for custom chat handler. */
  type ChatHandlerParams,
  /** OpenAI/Copilot 协议客户端 / OpenAI/Copilot protocol client. */
  OpenAIClient,
  /** Anthropic 协议客户端 / Anthropic protocol client. */
  AnthropicClient,
  /** DeepSeek 协议客户端 / DeepSeek protocol client. */
  DeepSeekClient,
  /** OpenAI SSE 解析器 / OpenAI stream parser helper. */
  parseOpenAIStream,
  /** Anthropic SSE 解析器 / Anthropic stream parser helper. */
  parseAnthropicStream,
} from "./ai-client/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 工具注册与参数工具（中）/ Tool registry exports (EN)
// ─────────────────────────────────────────────────────────────────────────────

/** 工具注册表与参数辅助 / Tool registry and parameter helpers. */
export {
  /** 工具注册表类 / Tool registry class. */
  ToolRegistry,
  /** 工具定义类型 / Tool definition type. */
  type ToolDefinition,
  /** 工具调用结果类型 / Tool call result type. */
  type ToolCallResult,
  /** 读取字符串参数 / Read string param safely. */
  readStringParam,
  /** 读取数字参数 / Read number param safely. */
  readNumberParam,
  /** 构建 JSON 结果 / Build normalized JSON result. */
  jsonResult,
} from "./tool-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent 决策循环（中）/ Agent loop exports (EN)
// ─────────────────────────────────────────────────────────────────────────────

/** 决策循环主能力与类型 / Main loop API and related types. */
export {
  /** 执行完整 Agent 循环 / Execute full agent loop. */
  executeAgentLoop,
  /** Agent 循环入参类型 / Agent loop input type. */
  type AgentLoopParams,
  /** Agent 循环返回类型 / Agent loop result type. */
  type AgentLoopResult,
  /** Agent 循环回调类型 / Agent loop callback hooks. */
  type AgentLoopCallbacks,
  /** Agent 循环指标类型 / Agent loop metrics type. */
  type AgentLoopMetrics,
  /** 停机原因类型 / Agent loop stop reason type. */
  type StopReason,
  /** 轮次后稳定等待配置类型 / Round-level stability barrier config type. */
  type RoundStabilityWaitOptions,
  /** 包裹快照边界文本 / Wrap snapshot with boundary markers. */
  wrapSnapshot,
  /** 断言评估入口 / Evaluate task assertions via independent AI call. */
  evaluateAssertions,
  /** 任务断言定义类型 / Single task assertion definition. */
  type TaskAssertion,
  /** 断言配置类型 / Assertion config with task list. */
  type AssertionConfig,
  /** 断言结果类型 / Overall assertion evaluation result. */
  type AssertionResult,
  /** 单任务断言结果类型 / Per-task assertion result. */
  type TaskAssertionResult,
} from "./agent-loop/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词构建（中）/ System prompt exports (EN)
// ─────────────────────────────────────────────────────────────────────────────

/** 系统提示词构建器与参数类型 / System prompt builder and params type. */
export { buildSystemPrompt, type SystemPromptParams } from "./system-prompt.js";

// ─────────────────────────────────────────────────────────────────────────────
// 快照生命周期能力（中）/ Snapshot lifecycle exports (EN)
// ─────────────────────────────────────────────────────────────────────────────

/** 快照读取/包裹/剥离能力聚合出口 / Snapshot lifecycle facade exports. */
export {
  readPageUrl,
  readPageSnapshot,
  stripSnapshotFromPrompt,
} from "./agent-loop/snapshot/index.js";

/** 浏览器运行时消息桥接能力（实现位于 core，供 web 转发使用）。 */
export {
  createProxyExecutor,
  registerToolHandler,
  type ToolCallMessage,
  type ToolCallResponse,
  type ToolExecutorMap,
} from "./messaging.js";

/** 运行时事件监听追踪能力（实现位于 core，供快照/动作评分复用）。 */
export {
  installEventListenerTracking,
  getTrackedElementEvents,
  hasTrackedElementEvents,
} from "./event-listener-tracker.js";
