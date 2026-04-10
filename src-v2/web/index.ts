/**
 * WebAgent — v2 浏览器端 AI Agent 类。
 *
 * 基于 v2 core/MainAgent，封装浏览器端完整能力：
 * - 对话（chat）   → 直接执行模式
 * - 编排（chatWithOrchestration） → 微任务编排模式（v2 新增）
 * - 工具注册       → 注册内置 Web 工具或自定义工具
 * - 决策循环       → 复用 core/engine/executeAgentLoop
 * - AI 连接        → 复用 core/shared/ai-client（基于 fetch，跨平台）
 *
 * ─── v1 → v2 主要变化 ───
 *
 * | 能力 | v1 | v2 |
 * |------|----|----|
 * | 核心入口 | WebAgent.chat() | WebAgent.chat() + chatWithOrchestration() |
 * | 架构 | 单体（WebAgent 管一切） | 分层（core + web 解耦） |
 * | 编排 | 无 | 微任务链式编排 |
 * | 断言 | 有 | 有 + 微任务级断言 + 系统级断言 |
 * | 提示词 | buildSystemPrompt | buildSystemPrompt + buildMicroTaskPrompt |
 *
 * ─── 架构位置 ───
 *
 * ```
 * ┌───────────────────────────────────────────────────┐
 * │  WebAgent（浏览器端入口）← 本文件                   │
 * │  ┌───────────────┐  ┌──────────────┐              │
 * │  │ core/         │  │ web/tools/   │              │
 * │  │ MainAgent     │  │ dom/navigate │              │
 * │  │ + engine      │  │ /page_info   │              │
 * │  │ + assertion   │  │ /wait/eval   │              │
 * │  │ + micro-task  │  │              │              │
 * │  └───────────────┘  └──────────────┘              │
 * └───────────────────────────────────────────────────┘
 * ```
 */
import { MainAgent } from "../core/main-agent/index.js";
import type {
  ChatOptions as CoreChatOptions,
  OrchestrationOptions as CoreOrchestrationOptions,
  MainAgentResult,
} from "../core/main-agent/index.js";
import type { AgentLoopCallbacks, AgentLoopResult, RoundStabilityWaitOptions } from "../core/shared/types.js";
import type { AIClient, AIChatResponse } from "../core/shared/types.js";
import type { AssertionConfig } from "../core/assertion/types.js";
import type { MicroTaskDescriptor } from "../core/micro-task/types.js";
import { ToolRegistry, type ToolDefinition, type ToolCallResult } from "../core/shared/tool-registry.js";
import { createAIClient } from "../core/shared/ai-client/index.js";
import { generateSnapshot, type SnapshotOptions } from "../core/shared/snapshot/index.js";
import { createDomTool, setActiveRefStore } from "./tools/dom-tool.js";
import { cleanupHoverStyles } from "./helpers/base/hover-force.js";
import { applyInteractiveOverlay, clearInteractiveOverlay } from "./helpers/base/interactive-overlay.js";
import { setInteractiveOverlayEnabled, getInteractiveOverlayEnabled } from "./helpers/base/interactive-overlay-store.js";
import { createNavigateTool } from "./tools/navigate-tool.js";
import { createPageInfoTool } from "./tools/page-info-tool.js";
import { createWaitTool } from "./tools/wait-tool.js";
import { createEvaluateTool } from "./tools/evaluate-tool.js";
import { RefStore } from "./ref-store.js";
import Panel, { type PanelOptions } from "./ui/index.js";
import { installEventListenerTracking } from "../core/shared/event-listener-tracker.js";
import { Type } from "@sinclair/typebox";

// 默认安装全局事件监听追踪（幂等）
installEventListenerTracking();

// ─── 回调类型 ───

/** WebAgent 事件回调（扩展 AgentLoopCallbacks，增加快照事件） */
export type WebAgentCallbacks = AgentLoopCallbacks & {
  /** 自动快照生成完成时触发 */
  onSnapshot?: (snapshot: string) => void;
};

// ─── 配置 ───

export type WebAgentOptions = {
  /** 自定义 AI 客户端实例（优先级高于 token/provider） */
  client?: AIClient;
  /** API 认证 Token */
  token?: string;
  /** AI 提供商（默认 "copilot"） */
  provider?: string;
  /** 模型名称（默认 "gpt-4o"） */
  model?: string;
  /** 自定义 API 基础 URL */
  baseURL?: string;
  /** 是否启用流式输出（默认 true） */
  stream?: boolean;
  /** 单次 AI 请求超时毫秒（默认 45000） */
  requestTimeoutMs?: number;
  /** 干运行模式 */
  dryRun?: boolean;
  /** 系统提示词注册项 */
  systemPrompt?: string | Record<string, string>;
  /** 最大工具调用轮次（默认 40） */
  maxRounds?: number;
  /** 是否启用多轮对话记忆（默认 false） */
  memory?: boolean;
  /** 是否在每次对话前自动生成页面快照（默认 true） */
  autoSnapshot?: boolean;
  /** 快照选项 */
  snapshotOptions?: SnapshotOptions;
  /** 轮次后稳定等待配置 */
  roundStabilityWait?: RoundStabilityWaitOptions;
  /** UI 面板配置 */
  panel?: boolean | PanelOptions;
  /** 是否启用交互模式高亮（默认 false） */
  interactiveOverlay?: boolean;
  /** 是否启用调试模式（默认 false），开启后每次 AI 响应会存入 debugResponses 数组 */
  debug?: boolean;
};

// ─── Chat 选项 ───

export type ChatOptions = {
  /** 断言配置 */
  assertionConfig?: AssertionConfig;
  /**
   * 是否启用编排模式（可选，默认 false）。
   *
   * 启用后 AI 可在主循环中自主决定是否通过 dispatch_micro_task
   * 将复杂任务拆解为微任务执行。
   */
  enableOrchestration?: boolean;
};

// ─── WebAgent 类 ───

export class WebAgent {
  private static readonly DEFAULT_SYSTEM_PROMPT_KEY = "default";
  private static readonly DEFAULT_TOOL_NAMES = ["dom", "navigate", "page_info", "wait", "evaluate", "assert"] as const;

  private client?: AIClient;
  private token: string;
  private provider: string;
  private model: string;
  private baseURL?: string;
  private stream: boolean;
  private requestTimeoutMs: number;
  private dryRun: boolean;
  private maxRounds: number;
  private systemPromptRegistry = new Map<string, string>();
  private protectedToolNames = new Set<string>();

  private memory: boolean;
  private autoSnapshot: boolean;
  private snapshotOptions: SnapshotOptions;
  private roundStabilityWait?: RoundStabilityWaitOptions;
  private interactiveOverlay: boolean;
  private debug: boolean;

  private registry = new ToolRegistry();

  /** 内置 UI 面板 */
  panel: Panel | null = null;

  /** 事件回调 */
  callbacks: WebAgentCallbacks = {};

  /** 调试模式下，每次 AI 响应的完整记录（debug: true 时自动收集） */
  debugResponses: AIChatResponse[] = [];

  /** v2 MainAgent 实例（懒初始化，chat 时创建） */
  private _mainAgent?: MainAgent;

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
    this.interactiveOverlay = options.interactiveOverlay ?? false;
    this.debug = options.debug ?? false;

    if (typeof options.systemPrompt === "string") {
      this.setSystemPrompt(options.systemPrompt);
    } else if (options.systemPrompt && typeof options.systemPrompt === "object") {
      this.setSystemPrompts(options.systemPrompt);
    }

    if (options.panel) {
      const panelOpts = typeof options.panel === "object" ? options.panel : {};
      this.panel = new Panel(panelOpts);
      this.wirePanel();
    }
  }

  // ─── 工具管理 ───

  /** 注册所有内置 Web 工具 */
  registerTools(): void {
    this.registry.register(createDomTool());
    this.registry.register(createNavigateTool());
    this.registry.register(createPageInfoTool());
    this.registry.register(createWaitTool());
    this.registry.register(createEvaluateTool());
    this.registry.register({
      name: "assert",
      description: "Trigger task completion verification.",
      schema: Type.Object({}),
      execute: async () => ({ content: "Assertion handled by framework." }),
    });

    for (const name of WebAgent.DEFAULT_TOOL_NAMES) {
      this.protectedToolNames.add(name);
    }
  }

  registerTool(tool: ToolDefinition): void {
    this.registry.register(tool);
  }

  removeTool(name: string): boolean {
    if (this.protectedToolNames.has(name)) return false;
    return this.registry.unregister(name);
  }

  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  getToolNames(): string[] {
    return this.registry.getDefinitions().map((t) => t.name);
  }

  getTools(): ToolDefinition[] {
    return this.registry.getDefinitions();
  }

  // ─── 配置修改 ───

  setToken(token: string): void {
    this.token = token;
    this._mainAgent = undefined; // 重建 agent
  }

  setClient(client: AIClient | undefined): void {
    this.client = client;
    this._mainAgent = undefined;
  }

  setProvider(provider: string): void {
    this.provider = provider;
    this._mainAgent = undefined;
  }

  setModel(model: string): void {
    this.model = model;
    this._mainAgent = undefined;
  }

  setStream(enabled: boolean): void {
    this.stream = enabled;
    this._mainAgent = undefined;
  }

  getStream(): boolean {
    return this.stream;
  }

  setRequestTimeoutMs(timeoutMs: number): void {
    this.requestTimeoutMs = Math.floor(timeoutMs);
    this._mainAgent = undefined;
  }

  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  setSystemPrompt(prompt: string): void;
  setSystemPrompt(key: string, prompt: string): void;
  setSystemPrompt(keyOrPrompt: string, maybePrompt?: string): void {
    const key = maybePrompt === undefined ? WebAgent.DEFAULT_SYSTEM_PROMPT_KEY : keyOrPrompt.trim();
    const prompt = maybePrompt === undefined ? keyOrPrompt : maybePrompt;
    if (!key) throw new Error("system prompt 的 key 不能为空");
    const value = prompt.trim();
    if (!value) throw new Error("system prompt 不能为空");
    this.systemPromptRegistry.set(key, value);
  }

  setSystemPrompts(prompts: Record<string, string>): void {
    for (const [key, prompt] of Object.entries(prompts)) {
      this.setSystemPrompt(key, prompt);
    }
  }

  removeSystemPrompt(key: string): boolean {
    return this.systemPromptRegistry.delete(key);
  }

  getSystemPrompts(): Record<string, string> {
    return Object.fromEntries(this.systemPromptRegistry.entries());
  }

  clearSystemPrompts(): void {
    this.systemPromptRegistry.clear();
  }

  setMemory(enabled: boolean): void {
    this.memory = enabled;
    if (!enabled) this.getMainAgent().clearHistory();
  }

  getMemory(): boolean {
    return this.memory;
  }

  setAutoSnapshot(enabled: boolean): void {
    this.autoSnapshot = enabled;
  }

  clearHistory(): void {
    this.getMainAgent().clearHistory();
  }

  // ─── UI 面板 ───

  createPanel(options: PanelOptions = {}): Panel {
    if (this.panel) return this.panel;
    this.panel = new Panel(options);
    this.wirePanel();
    return this.panel;
  }

  destroyPanel(): void {
    if (!this.panel) return;
    this.panel.unmount();
    this.panel = null;
  }

  private wirePanel(): void {
    if (!this.panel) return;
    const panel = this.panel;

    panel.onSend = async (text: string) => {
      panel.setStatus("running");
      panel.showTyping();
      try {
        const result = await this.chat(text, { enableOrchestration: true });
        panel.removeTyping();
        if (result.reply) panel.addMessage("assistant", result.reply);
        panel.setStatus("idle");
      } catch (err) {
        panel.removeTyping();
        panel.addMessage("error", `执行失败: ${err instanceof Error ? err.message : String(err)}`);
        panel.setStatus("error");
      }
    };

    const originalOnToolCall = this.callbacks.onToolCall;
    const originalOnToolResult = this.callbacks.onToolResult;

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
   * 直接执行模式 — 发送消息并获取 AI 回复。
   *
   * 内部使用 v2 MainAgent.chat()，完整保留 v1 WebAgent.chat() 的所有能力。
   */
  async chat(message: string, options?: ChatOptions): Promise<AgentLoopResult> {
    const mainAgent = this.getMainAgent();

    // 启用/禁用 interactive overlay
    setInteractiveOverlayEnabled(this.interactiveOverlay);

    // 更新 extraInstructions
    this.syncExtraInstructions(mainAgent);

    // 生成初始快照
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
      if (this.autoSnapshot) this.callbacks.onSnapshot?.(snapshot);
    } catch { /* 快照失败不阻塞 */ }

    const wrappedCallbacks = this.buildWrappedCallbacks(refStore);

    try {
      const result = await mainAgent.chat(message, {
        assertionConfig: options?.assertionConfig,
        initialSnapshot,
        callbacks: wrappedCallbacks,
        enableOrchestration: options?.enableOrchestration,
      });

      if (!this.memory) mainAgent.clearHistory();
      return result;
    } finally {
      clearInteractiveOverlay();
      setInteractiveOverlayEnabled(false);
      refStore.clear();
      setActiveRefStore(undefined);
    }
  }

  /**
   * 编排执行模式 — 将任务拆解为微任务链执行。
   *
   * v2 新增能力：适用于大表单、多步骤流程、跨页面操作。
   *
   * @example
   * ```ts
   * const result = await agent.chatWithOrchestration(
   *   "填写员工入职表单",
   *   [
   *     { id: "mt-1", task: "填写基本信息：姓名张三、性别男、年龄30" },
   *     { id: "mt-2", task: "填写联系方式：手机13800138000" },
   *     { id: "mt-3", task: "点击提交" },
   *   ],
   * );
   * ```
   */
  async chatWithOrchestration(
    message: string,
    tasks: MicroTaskDescriptor[],
    options?: ChatOptions & { maxRetries?: number },
  ): Promise<MainAgentResult> {
    const mainAgent = this.getMainAgent();
    this.syncExtraInstructions(mainAgent);

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
      if (this.autoSnapshot) this.callbacks.onSnapshot?.(snapshot);
    } catch { /* 快照失败不阻塞 */ }

    const wrappedCallbacks = this.buildWrappedCallbacks(refStore);

    try {
      return await mainAgent.chatWithOrchestration(message, tasks, {
        assertionConfig: options?.assertionConfig,
        initialSnapshot,
        callbacks: wrappedCallbacks,
        maxRetries: options?.maxRetries,
      });
    } finally {
      refStore.clear();
      setActiveRefStore(undefined);
    }
  }

  // ─── 内部方法 ───

  /** 获取或创建 MainAgent */
  private getMainAgent(): MainAgent {
    if (!this._mainAgent) {
      const aiClient = this.client ?? this.createBuiltinClient();
      this._mainAgent = new MainAgent({
        aiClient,
        tools: this.registry,
        maxRounds: this.maxRounds,
        roundStabilityWait: this.roundStabilityWait,
        callbacks: this.callbacks,
      });
    }
    return this._mainAgent;
  }

  /** 同步 systemPromptRegistry 到 MainAgent.extraInstructions */
  private syncExtraInstructions(mainAgent: MainAgent): void {
    if (this.systemPromptRegistry.size > 0) {
      const extensions = Array.from(this.systemPromptRegistry.entries())
        .map(([key, prompt]) => `[${key}] ${prompt}`)
        .join("\n");
      // 使用 addExtraInstruction 注入（MainAgent 会在 buildSystemPrompt 时合并）
      mainAgent.addExtraInstruction(extensions);
    }
  }

  /** 构建包装回调（处理断言快照清理、RefStore 重置等浏览器特有逻辑） */
  private buildWrappedCallbacks(refStore: RefStore): WebAgentCallbacks {
    return {
      ...this.callbacks,
      onBeforeAssertionSnapshot: () => {
        try {
          cleanupHoverStyles();
          const hovered = document.querySelectorAll(":hover");
          for (const el of hovered) {
            el.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
            el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
          }
          if (document.activeElement && document.activeElement !== document.body) {
            (document.activeElement as HTMLElement).blur?.();
          }
        } catch { /* 不阻塞断言流程 */ }
      },
      onAfterSnapshot: () => {
        try {
          if (getInteractiveOverlayEnabled()) applyInteractiveOverlay();
        } catch { /* 不阻塞快照流程 */ }
        this.callbacks.onAfterSnapshot?.();
      },
      onAIResponse: (response: AIChatResponse) => {
        if (this.debug) this.debugResponses.push(response);
        this.callbacks.onAIResponse?.(response);
      },
      onBeforeRecoverySnapshot: (newUrl?: string) => {
        if (newUrl !== undefined) {
          refStore.reset(newUrl);
        } else {
          refStore.clear();
        }
        this.callbacks.onBeforeRecoverySnapshot?.(newUrl);
      },
    };
  }

  /** 创建内置 AI 客户端 */
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

export {
  generateSnapshot,
  type SnapshotOptions,
} from "../core/shared/snapshot/index.js";
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
} from "../core/shared/messaging.js";
export { default as Panel, type PanelOptions } from "./ui/index.js";
export {
  evaluateAssertions
} from "../core/assertion/index.js";
export { MainAgent } from "../core/main-agent/index.js";
export type { MicroTaskDescriptor, MicroTaskResult } from "../core/micro-task/types.js";

// ─── 暴露调试工具到 window ───

import { generateFocusedSnapshot } from "../core/shared/snapshot/index.js";
import { computeSemanticDiff, computeSnapshotDiff } from "../core/shared/helpers.js";
import { getActiveRefStore } from "./helpers/base/active-store.js";

/**
 * window.__autopilot — 暴露快照和 diff 函数供控制台调试。
 *
 * 用法：
 *   __autopilot.snapshot()              — 全量快照
 *   __autopilot.snapshot({ maxNodes: 100 }) — 带选项的全量快照
 *   __autopilot.focused('#hashId')      — 聚焦快照（目标元素的关联链）
 *   __autopilot.focused('#hashId', { ancestorLevels: 5 })
 *   __autopilot.diff(base, current)     — 节点级语义 diff
 *   __autopilot.lineDiff(prev, current) — 逐行文本 diff（旧版）
 *   __autopilot.refStore()              — 当前 RefStore 实例
 */
/** 调试用临时 RefStore（无活跃会话时自动创建） */
let _debugRefStore: InstanceType<typeof RefStore> | undefined;

if (typeof globalThis !== "undefined") {
  (globalThis as Record<string, unknown>).__autopilot = {
    /** 生成全量快照（始终带 hash ID，无活跃会话时自动创建临时 RefStore） */
    snapshot(options?: SnapshotOptions) {
      let refStore = getActiveRefStore();
      if (!refStore) {
        // 无活跃 chat 会话 → 创建/复用临时 RefStore，确保快照始终有 hash ID
        if (!_debugRefStore) {
          _debugRefStore = new RefStore(globalThis.location?.href);
        } else {
          _debugRefStore.clear();
        }
        refStore = _debugRefStore;
      }
      return generateSnapshot(document.body, {
        maxDepth: 12,
        viewportOnly: false,
        pruneLayout: true,
        maxNodes: 500,
        maxChildren: 30,
        maxTextLength: 40,
        ...options,
        refStore,
      });
    },

    /** 生成聚焦快照（传入 #hashId 或纯 hashId） */
    focused(hashRef: string, options?: { ancestorLevels?: number; includeSiblings?: boolean; childDepth?: number }) {
      const ref = hashRef.replace(/^#/, "");
      const refStore = getActiveRefStore() ?? _debugRefStore;
      const el = refStore?.get(ref);
      if (!el) return `[ERROR] Element #${ref} not found in RefStore (size=${refStore?.size ?? 0})`;
      return generateFocusedSnapshot({
        targetElement: el,
        ancestorLevels: options?.ancestorLevels,
        includeSiblings: options?.includeSiblings,
        childDepth: options?.childDepth,
        refStore,
      });
    },

    /**
     * 智能 diff：逐行 diff（保留层级缩进）为主体，
     * 附加语义 diff（属性级变化：val/checked/text）补充细节。
     */
    diff(base: string, current: string, maxLines?: number) {
      const lineDiff = computeSnapshotDiff(base, current, maxLines);
      const semantic = computeSemanticDiff(base, current, maxLines);
      // 语义 diff 只保留属性变化行（~ 开头），结构增删已由 lineDiff 覆盖
      const attrChanges = semantic
        ? semantic.split("\n").filter(l => l.startsWith("~ ")).join("\n")
        : "";
      if (!lineDiff) return attrChanges;
      if (!attrChanges) return lineDiff;
      return lineDiff + "\n\n" + attrChanges;
    },

    /** 节点级语义 diff（仅基于 #hashID 匹配，无 hash 时返回空） */
    semanticDiff: computeSemanticDiff,

    /** 逐行文本 diff */
    lineDiff: computeSnapshotDiff,

    /** 获取当前 RefStore */
    refStore: getActiveRefStore,
  };
}
