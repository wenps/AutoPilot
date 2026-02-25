/**
 * WebAgent — 浏览器端 AI Agent 类。
 *
 * 封装了完整的 Agent 能力，可在浏览器中独立运行：
 * - 对话（chat）   → 发消息、获取 AI 回复
 * - 工具注册       → 注册内置 Web 工具或自定义工具
 * - 决策循环       → 复用 core/agent-loop.ts 的通用逻辑
 * - AI 连接        → 复用 core/ai-client.ts（基于 fetch，跨平台）
 *
 * 使用示例：
 * ```ts
 * const agent = new WebAgent({ token: "ghp_xxx", provider: "copilot" });
 * agent.registerTools();     // 注册内置 Web 工具
 * agent.callbacks.onText = (text) => console.log(text);
 *
 * const result = await agent.chat("获取页面标题");
 * console.log(result.reply);
 * ```
 *
 * 架构位置：
 *   ┌──────────────────────────────────────────────────┐
 *   │  WebAgent（浏览器端入口）                         │
 *   │  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
 *   │  │ core/    │  │ core/      │  │ web/       │ │
 *   │  │ ai-client│  │ agent-loop │  │ (DOM/导航等)│ │
 *   │  │ (fetch)  │  │ (通用循环) │  │              │ │
 *   │  └──────────┘  └────────────┘  └──────────────┘ │
 *   └──────────────────────────────────────────────────┘
 */
import {
  executeAgentLoop,
  type AgentLoopCallbacks,
  type AgentLoopResult,
} from "../core/agent-loop/index.js";
import type { AIMessage } from "../core/types.js";
import { createAIClient } from "../core/ai-client/index.js";
import type { AIClient } from "../core/types.js";
import { ToolRegistry, type ToolDefinition } from "../core/tool-registry.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { generateSnapshot, type SnapshotOptions } from "./page-info-tool.js";
import { createDomTool, setActiveRefStore } from "./dom-tool.js";
import { createNavigateTool } from "./navigate-tool.js";
import { createPageInfoTool } from "./page-info-tool.js";
import { createWaitTool } from "./wait-tool.js";
import { createEvaluateTool } from "./evaluate-tool.js";
import { RefStore } from "./ref-store.js";

// ─── 回调类型 ───

/** WebAgent 事件回调（扩展 AgentLoopCallbacks，增加快照事件） */
export type WebAgentCallbacks = AgentLoopCallbacks & {
  /** 自动快照生成完成时触发 */
  onSnapshot?: (snapshot: string) => void;
};

// ─── 配置 ───

export type WebAgentOptions = {
  /**
   * 自定义 AI 客户端实例（可选）。
   *
   * 传入后将直接使用该实例进行对话，忽略 token / provider / model / baseURL。
   * 支持 BaseAIClient 或任何实现 AIClient 接口的对象。
   *
   * ```ts
   * const client = new BaseAIClient({ chatHandler: async (params) => { ... } });
   * const agent = new WebAgent({ client });
   * ```
   */
  client?: AIClient;
  /** API 认证 Token (GitHub PAT / OpenAI key / Anthropic key) */
  token?: string;
  /** AI 提供商: "copilot" | "openai" | "anthropic"（默认 "copilot"） */
  provider?: string;
  /** 模型名称（默认 "gpt-4o"） */
  model?: string;
  /** 自定义 API 基础 URL（可选，覆盖 provider 默认值） */
  baseURL?: string;
  /** 是否启用干运行模式 */
  dryRun?: boolean;
  /** 自定义系统提示词（不传则使用默认 Web 提示词） */
  systemPrompt?: string;
  /** 最大工具调用轮次（默认 10） */
  maxRounds?: number;
  /** 是否启用多轮对话记忆（默认 false） */
  memory?: boolean;
  /** 是否在每次对话前自动生成页面快照（默认 true） */
  autoSnapshot?: boolean;
  /** 快照选项（视口裁剪、智能剪枝等，autoSnapshot 开启时生效） */
  snapshotOptions?: SnapshotOptions;
};

// ─── WebAgent 类 ───

export class WebAgent {
  /** 用户传入的自定义 AI 客户端实例（优先级高于 token/provider） */
  private client?: AIClient;
  private token: string;
  private provider: string;
  private model: string;
  private baseURL?: string;
  private dryRun: boolean;
  private maxRounds: number;
  private customSystemPrompt?: string;

  /** 多轮对话记忆开关 */
  private memory: boolean;
  /** 对话历史（memory 开启时自动累积） */
  private history: AIMessage[] = [];
  /** 自动快照开关 */
  private autoSnapshot: boolean;
  /** 快照选项 */
  private snapshotOptions: SnapshotOptions;

  /** 工具注册表实例 — 每个 WebAgent 拥有独立的工具集 */
  private registry = new ToolRegistry();

  /** 事件回调 — 绑定后可实时获取 Agent 进度，用于 UI 展示 */
  callbacks: WebAgentCallbacks = {};

  constructor(options: WebAgentOptions) {
    this.client = options.client;
    this.token = options.token || "";
    this.provider = options.provider ?? "copilot";
    this.model = options.model ?? "gpt-4o";
    this.baseURL = options.baseURL;
    this.dryRun = options.dryRun ?? false;
    this.maxRounds = options.maxRounds ?? 10;
    this.customSystemPrompt = options.systemPrompt;
    this.memory = options.memory ?? false;
    this.autoSnapshot = options.autoSnapshot ?? true;
    this.snapshotOptions = options.snapshotOptions ?? {};
  }

  // ─── 工具管理 ───

  /** 注册所有内置 Web 工具（dom, navigate, page_info, wait, evaluate） */
  registerTools(): void {
    this.registry.register(createDomTool());
    this.registry.register(createNavigateTool());
    this.registry.register(createPageInfoTool());
    this.registry.register(createWaitTool());
    this.registry.register(createEvaluateTool());
  }

  /** 注册一个自定义工具 */
  registerTool(tool: ToolDefinition): void {
    this.registry.register(tool);
  }

  /** 获取所有已注册的工具定义列表 */
  getTools(): ToolDefinition[] {
    return this.registry.getDefinitions();
  }

  // ─── 配置修改 ───

  /** 设置 API Token */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * 设置自定义 AI 客户端实例。
   *
   * 传入后将优先使用该实例进行对话，忽略 token / provider / model / baseURL。
   * 传入 undefined 可恢复使用内置客户端。
   */
  setClient(client: AIClient | undefined): void {
    this.client = client;
  }

  /** 设置 AI 提供商 */
  setProvider(provider: string): void {
    this.provider = provider;
  }

  /** 设置模型 */
  setModel(model: string): void {
    this.model = model;
  }

  /** 切换干运行模式 */
  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  /** 设置自定义系统提示词 */
  setSystemPrompt(prompt: string): void {
    this.customSystemPrompt = prompt;
  }

  /** 开启或关闭多轮对话记忆 */
  setMemory(enabled: boolean): void {
    this.memory = enabled;
    if (!enabled) this.history = [];
  }

  /** 获取当前记忆开关状态 */
  getMemory(): boolean {
    return this.memory;
  }

  /** 开启或关闭自动快照 */
  setAutoSnapshot(enabled: boolean): void {
    this.autoSnapshot = enabled;
  }

  /** 获取当前自动快照开关状态 */
  getAutoSnapshot(): boolean {
    return this.autoSnapshot;
  }

  /** 设置快照选项（视口裁剪、智能剪枝等） */
  setSnapshotOptions(options: SnapshotOptions): void {
    this.snapshotOptions = options;
  }

  /** 获取当前快照选项 */
  getSnapshotOptions(): SnapshotOptions {
    return { ...this.snapshotOptions };
  }

  /** 清空对话历史（不影响记忆开关） */
  clearHistory(): void {
    this.history = [];
  }

  // ─── 核心能力 ───

  /**
   * 发送消息并获取 AI 回复（含完整工具调用循环）。
   *
   * 内部流程（全部复用 core）：
   * 1. createAIClient() → 创建 fetch AI 客户端
   * 2. buildSystemPrompt() → 构建系统提示词
   * 3. executeAgentLoop() → 执行决策循环
   * 4. callbacks → 实时通知 UI
   */
  async chat(message: string): Promise<AgentLoopResult> {
    // 优先使用自定义 client，否则使用内置 createAIClient
    const client = this.client ?? this.createBuiltinClient();

    // 复用 core/system-prompt 或使用自定义
    let systemPrompt =
      this.customSystemPrompt ??
      buildSystemPrompt({ tools: this.registry.getDefinitions() });

    // ─── 自动快照：注入 system prompt，不污染对话历史 ───
    // 创建本次对话的 RefStore，快照结束后保持活跃，对话结束后清空
    const refStore = new RefStore(globalThis.location?.href);
    setActiveRefStore(refStore);

    if (this.autoSnapshot) {
      try {
        const snapshot = generateSnapshot(document.body, {
          maxDepth: 8,
          ...this.snapshotOptions,
          refStore,
        });
        this.callbacks.onSnapshot?.(snapshot);

        systemPrompt += `\n\n## 当前页面 DOM 快照\n\n\`\`\`\n${snapshot}\n\`\`\``;
      } catch {
        // 快照失败不阻塞正常流程
      }
    }

    // 复用 core/agent-loop — 同一份决策循环
    const result = await executeAgentLoop({
      client,
      registry: this.registry,
      systemPrompt,
      message,
      history: this.memory ? this.history : undefined,
      dryRun: this.dryRun,
      maxRounds: this.maxRounds,
      callbacks: this.callbacks,
    });

    // 记忆模式：累积对话历史供下次 chat() 使用
    if (this.memory) {
      this.history = result.messages;
    }

    // 对话结束，清空 RefStore
    refStore.clear();
    setActiveRefStore(undefined);

    return result;
  }

  // ─── 内部方法 ───

  /**
   * 创建内置 AI 客户端（基于 token / provider / model 配置）。
   *
   * @throws 未设置 token 时抛出 Error
   */
  private createBuiltinClient(): AIClient {
    if (!this.token) {
      throw new Error("未设置 Token，请先调用 setToken() 或传入自定义 client");
    }
    return createAIClient({
      provider: this.provider,
      model: this.model,
      apiKey: this.token,
      baseURL: this.baseURL,
    });
  }
}

// ─── Re-exports ───
// 从入口文件统一导出所有公共 API，消费方只需 import from "agentpage"

export { generateSnapshot, type SnapshotOptions } from "./page-info-tool.js";
export { createDomTool } from "./dom-tool.js";
export { createNavigateTool } from "./navigate-tool.js";
export { createPageInfoTool } from "./page-info-tool.js";
export { createWaitTool } from "./wait-tool.js";
export { createEvaluateTool } from "./evaluate-tool.js";
export {
  createProxyExecutor,
  registerToolHandler,
  type ToolCallMessage,
  type ToolCallResponse,
  type ToolExecutorMap,
} from "./messaging.js";
