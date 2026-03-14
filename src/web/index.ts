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
  type RoundStabilityWaitOptions,
  type AssertionConfig,
  type AssertionResult,
} from "../core/agent-loop/index.js";
import type { AIMessage } from "../core/types.js";
import { createAIClient } from "../core/ai-client/index.js";
import type { AIClient } from "../core/types.js";
import { ToolRegistry, type ToolDefinition, type ToolCallResult } from "../core/tool-registry.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { Type } from "@sinclair/typebox";
import { generateSnapshot, type SnapshotOptions } from "../core/agent-loop/snapshot/index.js";
import { createDomTool, setActiveRefStore } from "./tools/dom-tool.js";
import { createNavigateTool } from "./tools/navigate-tool.js";
import { createPageInfoTool } from "./tools/page-info-tool.js";
import { createWaitTool } from "./tools/wait-tool.js";
import { createEvaluateTool } from "./tools/evaluate-tool.js";
import { RefStore } from "./ref-store.js";
import Panel, { type PanelOptions } from "./ui/index.js";
import { installEventListenerTracking } from "../core/event-listener-tracker.js";

// 默认安装全局事件监听追踪（幂等），用于快照输出 listeners 信号。
installEventListenerTracking();

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
  /** AI 提供商: "copilot" | "openai" | "anthropic" | "deepseek" | "doubao" | "qwen"（默认 "copilot"） */
  provider?: string;
  /** 模型名称（默认 "gpt-4o"） */
  model?: string;
  /** 自定义 API 基础 URL（可选，覆盖 provider 默认值） */
  baseURL?: string;
  /** 是否启用流式输出（SSE）。默认 true；false 时使用 JSON 非流式响应。 */
  stream?: boolean;
  /** 单次 AI 请求超时（毫秒，默认 45000；<=0 表示不设置超时）。 */
  requestTimeoutMs?: number;
  /** 是否启用干运行模式 */
  dryRun?: boolean;
  /**
   * 系统提示词注册项。
   * - string：按默认 key 注册一条
   * - Record<string, string>：按 key 批量注册多条
   */
  systemPrompt?: string | Record<string, string>;
  /** 最大工具调用轮次（默认 10） */
  maxRounds?: number;
  /** 是否启用多轮对话记忆（默认 false） */
  memory?: boolean;
  /** 是否在每次对话前自动生成页面快照（默认 true） */
  autoSnapshot?: boolean;
  /** 快照选项（视口裁剪、智能剪枝等，autoSnapshot 开启时生效） */
  snapshotOptions?: SnapshotOptions;
  /** 轮次后稳定等待（加载态 + DOM 静默）配置 */
  roundStabilityWait?: RoundStabilityWaitOptions;
  /**
   * UI 面板配置。
   * - true：使用默认配置创建面板
   * - PanelOptions：使用自定义配置创建面板
   * - false / undefined：不创建面板
   */
  panel?: boolean | PanelOptions;
};

// ─── Chat 选项 ───

/**
 * chat() 方法的可选配置。
 *
 * 支持配置断言，用于 AI 驱动的任务完成验证。
 */
export type ChatOptions = {
  /**
   * 断言配置。
   *
   * 配置后，AI 可在合适时机调用 assert 工具触发断言验证。
   * 由独立的断言 AI（专用 prompt，不带 tools）根据快照 + 操作记录判定任务完成情况。
   * 所有任务断言通过时立即收敛（stopReason = 'assertion_passed'）。
   *
   * @example
   * ```ts
   * await agent.chat("满意度选五星，然后填写用户名为 admin", {
   *   assertionConfig: {
   *     taskAssertions: [
   *       { task: "满意度选五星", description: "满意度评分组件应显示 5 个激活状态的星星" },
   *       { task: "填写用户名", description: "用户名输入框的值应为 admin" },
   *     ]
   *   }
   * });
   * ```
   */
  assertionConfig?: AssertionConfig;
};

// ─── WebAgent 类 ───

export class WebAgent {
  /** 默认系统提示词 key（兼容旧版 setSystemPrompt(prompt)）。 */
  private static readonly DEFAULT_SYSTEM_PROMPT_KEY = "default";
  /** 默认内置工具名（注册后受保护，不允许删除）。 */
  private static readonly DEFAULT_TOOL_NAMES = ["dom", "navigate", "page_info", "wait", "evaluate", "assert"] as const;

  /** 用户传入的自定义 AI 客户端实例（优先级高于 token/provider） */
  private client?: AIClient;
  private token: string;
  private provider: string;
  private model: string;
  private baseURL?: string;
  private stream: boolean;
  private requestTimeoutMs: number;
  private dryRun: boolean;
  private maxRounds: number;
  /** system prompt 注册表（key -> prompt 文本）。 */
  private systemPromptRegistry = new Map<string, string>();
  /** 受保护工具集合（默认工具）。 */
  private protectedToolNames = new Set<string>();

  /** 多轮对话记忆开关 */
  private memory: boolean;
  /** 对话历史（memory 开启时自动累积） */
  private history: AIMessage[] = [];
  /** 自动快照开关 */
  private autoSnapshot: boolean;
  /** 快照选项 */
  private snapshotOptions: SnapshotOptions;
  /** 轮次后稳定等待配置 */
  private roundStabilityWait?: RoundStabilityWaitOptions;

  /** 工具注册表实例 — 每个 WebAgent 拥有独立的工具集 */
  private registry = new ToolRegistry();

  /** 内置 UI 面板（通过 options.panel 配置启用） */
  panel: Panel | null = null;

  /** 事件回调 — 绑定后可实时获取 Agent 进度，用于 UI 展示 */
  callbacks: WebAgentCallbacks = {};

  constructor(options: WebAgentOptions) {
    this.client = options.client;
    this.token = options.token || "";
    this.provider = options.provider ?? "copilot";
    this.model = options.model ?? "gpt-4o";
    this.baseURL = options.baseURL;
    this.stream = options.stream ?? true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 45000;
    this.dryRun = options.dryRun ?? false;
    this.maxRounds = options.maxRounds ?? 40;
    this.memory = options.memory ?? false;
    this.autoSnapshot = options.autoSnapshot ?? true;
    this.snapshotOptions = options.snapshotOptions ?? {};
    this.roundStabilityWait = options.roundStabilityWait;

    if (typeof options.systemPrompt === "string") {
      this.setSystemPrompt(options.systemPrompt);
    } else if (options.systemPrompt && typeof options.systemPrompt === "object") {
      this.setSystemPrompts(options.systemPrompt);
    }

    // ─── UI 面板 ───
    if (options.panel) {
      const panelOpts = typeof options.panel === "object" ? options.panel : {};
      this.panel = new Panel(panelOpts);
      this.wirePanel();
    }
  }

  // ─── 工具管理 ───

  /** 注册所有内置 Web 工具（dom, navigate, page_info, wait, evaluate） */
  registerTools(): void {
    this.registry.register(createDomTool());
    this.registry.register(createNavigateTool());
    this.registry.register(createPageInfoTool());
    this.registry.register(createWaitTool());
    this.registry.register(createEvaluateTool());
    // assert 是内置工具——AI 认为任务完成时主动调用，
    // 实际逻辑在 agent-loop 层拦截处理（独立 AI 判定）。
    this.registry.register({
      name: "assert",
      description: "Trigger task completion verification. Call when you believe the task is complete. The framework will use an independent AI to verify completion based on current snapshot and executed actions.",
      schema: Type.Object({}),
      execute: async () => ({
        content: "Assertion handled by framework.",
      }),
    });

    for (const name of WebAgent.DEFAULT_TOOL_NAMES) {
      this.protectedToolNames.add(name);
    }
  }

  /** 注册一个自定义工具 */
  registerTool(tool: ToolDefinition): void {
    this.registry.register(tool);
  }

  /**
   * 删除一个已注册工具。
   * - 默认内置工具（registerTools 注册）不允许删除
   * - 返回 true 表示删除成功，false 表示不存在或受保护
   */
  removeTool(name: string): boolean {
    if (this.protectedToolNames.has(name)) return false;
    return this.registry.unregister(name);
  }

  /** 检查工具是否已注册。 */
  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  /** 获取当前所有已注册工具名。 */
  getToolNames(): string[] {
    return this.registry.getDefinitions().map(tool => tool.name);
  }

  /**
   * 删除所有“非默认”工具。
   * 返回值为本次被删除的工具名数组。
   */
  clearCustomTools(): string[] {
    const removed: string[] = [];
    for (const tool of this.registry.getDefinitions()) {
      if (this.protectedToolNames.has(tool.name)) continue;
      if (this.registry.unregister(tool.name)) {
        removed.push(tool.name);
      }
    }
    return removed;
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

  /** 设置是否启用流式输出（SSE） */
  setStream(enabled: boolean): void {
    this.stream = enabled;
  }

  /** 获取当前流式输出开关状态 */
  getStream(): boolean {
    return this.stream;
  }

  /** 设置单次 AI 请求超时（毫秒） */
  setRequestTimeoutMs(timeoutMs: number): void {
    this.requestTimeoutMs = Math.floor(timeoutMs);
  }

  /** 获取当前 AI 请求超时（毫秒） */
  getRequestTimeoutMs(): number {
    return this.requestTimeoutMs;
  }

  /** 切换干运行模式 */
  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  /**
   * 注册系统提示词。
   * - setSystemPrompt(prompt)：使用默认 key 注册
   * - setSystemPrompt(key, prompt)：按指定 key 注册
   */
  setSystemPrompt(prompt: string): void;
  setSystemPrompt(key: string, prompt: string): void;
  setSystemPrompt(keyOrPrompt: string, maybePrompt?: string): void {
    const key = maybePrompt === undefined
      ? WebAgent.DEFAULT_SYSTEM_PROMPT_KEY
      : keyOrPrompt.trim();
    const prompt = maybePrompt === undefined ? keyOrPrompt : maybePrompt;

    if (!key) throw new Error("system prompt 的 key 不能为空");
    const value = prompt.trim();
    if (!value) throw new Error("system prompt 不能为空");

    this.systemPromptRegistry.set(key, value);
  }

  /** 批量注册系统提示词（key -> prompt）。 */
  setSystemPrompts(prompts: Record<string, string>): void {
    for (const [key, prompt] of Object.entries(prompts)) {
      this.setSystemPrompt(key, prompt);
    }
  }

  /** 注销指定 key 的系统提示词。 */
  removeSystemPrompt(key: string): boolean {
    return this.systemPromptRegistry.delete(key);
  }

  /** 只保留指定 key 的系统提示词，其余全部删除。 */
  keepOnlySystemPrompt(key: string): boolean {
    if (!this.systemPromptRegistry.has(key)) return false;
    const value = this.systemPromptRegistry.get(key)!;
    this.systemPromptRegistry.clear();
    this.systemPromptRegistry.set(key, value);
    return true;
  }

  /** 获取当前已注册的全部系统提示词（浅拷贝）。 */
  getSystemPrompts(): Record<string, string> {
    return Object.fromEntries(this.systemPromptRegistry.entries());
  }

  /** 删除全部系统提示词。 */
  clearSystemPrompts(): void {
    this.systemPromptRegistry.clear();
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

  // ─── UI 面板 ───

  /**
   * 手动创建并挂载 UI 面板（构造时未传 panel 选项时可后续调用）。
   * 若面板已存在则跳过。
   */
  createPanel(options: PanelOptions = {}): Panel {
    if (this.panel) return this.panel;
    this.panel = new Panel(options);
    this.wirePanel();
    return this.panel;
  }

  /**
   * 销毁 UI 面板。
   */
  destroyPanel(): void {
    if (!this.panel) return;
    this.panel.unmount();
    this.panel = null;
  }

  /**
   * 建立面板到 WebAgent 的双向绑定。
   *
   * - panel.onSend → agent.chat()
   * - agent.callbacks → panel 消息流 & 状态
   */
  private wirePanel(): void {
    if (!this.panel) return;
    const panel = this.panel;

    // 用户消息 → agent.chat
    panel.onSend = async (text: string) => {
      panel.setStatus("running");
      panel.showTyping();
      try {
        const result = await this.chat(text);
        panel.removeTyping();
        if (result.reply) {
          panel.addMessage("assistant", result.reply);
        }
        panel.setStatus("idle");
      } catch (err) {
        panel.removeTyping();
        panel.addMessage("error", `执行失败: ${err instanceof Error ? err.message : String(err)}`);
        panel.setStatus("error");
      }
    };

    // 包裹 callbacks：转发到面板
    const originalOnText = this.callbacks.onText;
    const originalOnToolCall = this.callbacks.onToolCall;
    const originalOnToolResult = this.callbacks.onToolResult;

    this.callbacks.onText = (text: string) => {
      originalOnText?.(text);
      // 实时文本由 wirePanel.onSend 的 result.reply 处理，此处不重复添加
    };

    this.callbacks.onToolCall = (name: string, input: unknown) => {
      originalOnToolCall?.(name, input);
      const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 0);
      const summary = inputStr.length > 80 ? inputStr.slice(0, 80) + "…" : inputStr;
      panel.addMessage("tool", `🔧 ${name}(${summary})`);
    };

    this.callbacks.onToolResult = (name: string, result: ToolCallResult) => {
      originalOnToolResult?.(name, result);
      const resultStr = typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 0);
      const summary = resultStr.length > 100 ? resultStr.slice(0, 100) + "…" : resultStr;
      panel.addMessage("tool", `✅ ${name} → ${summary}`);
    };
  }

  // ─── 核心能力 ───

  /**
   * 发送消息并获取 AI 回复（含完整工具调用循环）。
   *
   * 内部流程（全部复用 core）：
   * 1. createAIClient() → 创建 fetch AI 客户端
   * 2. buildSystemPrompt() → 构建系统提示词（含断言能力说明）
   * 3. executeAgentLoop() → 执行决策循环
   * 4. callbacks → 实时通知 UI
   *
   * @param message - 用户任务消息
   * @param options - 可选配置（断言配置等）
   */
  async chat(message: string, options?: ChatOptions): Promise<AgentLoopResult> {
    // 优先使用自定义 client，否则使用内置 createAIClient
    const client = this.client ?? this.createBuiltinClient();

    const assertionConfig = options?.assertionConfig;

    // 先构建基础系统提示词，再追加已注册的 system prompt 扩展。
    let systemPrompt = buildSystemPrompt({
      listenerEvents: this.snapshotOptions.listenerEvents,
      // 传入用户自定义断言任务（可选），system prompt 始终包含断言能力说明
      assertionTasks: assertionConfig?.taskAssertions,
    });
    if (this.systemPromptRegistry.size > 0) {
      const extensionText = Array.from(this.systemPromptRegistry.entries())
        .map(([key, prompt]) => `- [${key}]\n${prompt}`)
        .join("\n\n");
      systemPrompt += `\n\n## Registered System Prompt Extensions\n${extensionText}`;
    }

    // ─── 自动快照：注入 system prompt，不污染对话历史 ───
    // 创建本次对话的 RefStore，快照结束后保持活跃，对话结束后清空
    const refStore = new RefStore(globalThis.location?.href);
    setActiveRefStore(refStore);
    let initialSnapshot: string | undefined;

    try {
      const snapshot = generateSnapshot(document.body, {
        maxDepth: 12,
        viewportOnly: false,
        maxNodes: 500,
        maxChildren: 30,
        ...this.snapshotOptions,
        refStore,
      });
      initialSnapshot = snapshot;
      if (this.autoSnapshot) {
        this.callbacks.onSnapshot?.(snapshot);
      }
    } catch {
      // 快照失败不阻塞正常流程
    }

    // 包装回调
    const wrappedCallbacks: WebAgentCallbacks = {
      ...this.callbacks,
      // 断言前清除 hover/focus 等瞬态视觉状态，确保快照反映持久状态
      onBeforeAssertionSnapshot: () => {
        try {
          // 对所有正处于 hover 态的元素派发 mouseleave/pointerleave，
          // 覆盖 Element Plus Rate 等依赖 mouseleave 清除 hover 的组件
          const hovered = document.querySelectorAll(":hover");
          for (const el of hovered) {
            el.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
            el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
          }
          // 将焦点移到 body，清除 focus 高亮
          if (document.activeElement && document.activeElement !== document.body) {
            (document.activeElement as HTMLElement).blur?.();
          }
        } catch { /* 忽略：不阻塞断言流程 */ }
      },
      // 恢复快照前重置 RefStore，确保新快照的 hash ID 有效
      onBeforeRecoverySnapshot: (newUrl?: string) => {
        // URL 变化 → 清空映射 + 更新 URL 命名空间
        // 元素定位失败 → 仅清空可能失效的映射（URL 不变）
        if (newUrl !== undefined) {
          refStore.reset(newUrl);
        } else {
          refStore.clear();
        }
        // 转发到用户回调（如有设置）
        this.callbacks.onBeforeRecoverySnapshot?.(newUrl);
      },
    };

    // 复用 core/agent-loop — 同一份决策循环
    const result = await executeAgentLoop({
      client,
      registry: this.registry,
      systemPrompt,
      message,
      initialSnapshot,
      history: this.memory ? this.history : undefined,
      dryRun: this.dryRun,
      maxRounds: this.maxRounds,
      roundStabilityWait: this.roundStabilityWait,
      assertionConfig,
      callbacks: wrappedCallbacks,
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
      stream: this.stream,
      requestTimeoutMs: this.requestTimeoutMs,
    });
  }
}

// ─── Re-exports ───
// 从入口文件统一导出所有公共 API，消费方只需 import from "agentpage"

export {
  generateSnapshot,
  type SnapshotOptions,
} from "../core/agent-loop/snapshot/index.js";
export { createDomTool } from "./tools/dom-tool.js";
export { createNavigateTool } from "./tools/navigate-tool.js";
export { createPageInfoTool } from "./tools/page-info-tool.js";
export { createWaitTool } from "./tools/wait-tool.js";
export { createEvaluateTool } from "./tools/evaluate-tool.js";
export {
  createProxyExecutor,
  registerToolHandler,
  type ToolCallMessage,
  type ToolCallResponse,
  type ToolExecutorMap,
} from "../core/messaging.js";
export { default as Panel, type PanelOptions } from "./ui/index.js";
export {
  evaluateAssertions,
  type TaskAssertion,
  type AssertionConfig,
  type AssertionResult,
  type TaskAssertionResult,
} from "../core/agent-loop/index.js";
