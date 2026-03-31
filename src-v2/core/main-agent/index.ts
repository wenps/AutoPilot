/**
 * Main Agent 模块 — 直接执行 + 微任务编排双模式。
 *
 * 封装 buildSystemPrompt → executeAgentLoop → history 管理的完整流程，
 * 提供多轮对话能力。支持两种执行策略：
 *
 * 1. **直接执行模式**（chat）：等价 v1 WebAgent.chat，单次 AgentLoop 执行。
 * 2. **编排执行模式**（chatWithOrchestration）：将复杂任务拆解为微任务链，
 *    通过 TaskMonitor 逐个分派到 engine 执行，累积执行记录，最终系统断言。
 *
 * ─── 在 v2 架构中的位置 ───
 *
 * ```
 * 用户 / Web 层
 *     ↓
 *  MainAgent          ← 本模块（当前文件）
 *     ├── chat()                    → 直接执行模式
 *     └── chatWithOrchestration()   → 编排执行模式
 *           ├── TaskMonitor         ← 管理执行记录链
 *           ├── executeMicroTask()  ← dispatch.ts（串联 prompt + engine）
 *           └── evaluateAssertions  ← 系统级断言
 *     ↓
 *  engine/executeAgentLoop  ← 决策主循环 + 8 层保护 + 10 种停机条件
 *     ↓
 *  AI Client + ToolRegistry
 * ```
 *
 * ```
 * core/
 * ├── shared/          ← 无状态基础设施（helpers / snapshot / recovery / constants）
 * ├── assertion/       ← 独立判定层（断言 AI，无 tools，只看快照判定完成情况）
 * ├── micro-task/      ← 数据结构层（MicroTaskDescriptor / ExecutionRecordChain / TaskMonitor）
 * ├── engine/          ← 决策主循环（executeAgentLoop）
 * └── main-agent/      ← 【当前模块】对话管理 + 模式调度
 *     ├── index.ts     ← MainAgent 类（本文件）
 *     ├── dispatch.ts  ← executeMicroTask() 函数
 *     └── ARCHITECTURE.md
 * ```
 *
 * ─── 保护机制（全部由 executeAgentLoop 实现，MainAgent 透传参数）───
 *
 * MainAgent.chat() 通过委托 executeAgentLoop 获得以下完整保护能力，
 * 这些机制与 v1 WebAgent.chat 保持一致：
 *
 * 1. 元素恢复机制（handleElementRecovery）
 *    工具返回"元素未找到"时触发重试对话流：聚合失败工具 + 最新快照 + 尝试次数
 *    注入 retry context，等待 DEFAULT_NOT_FOUND_RETRY_WAIT_MS 后刷新快照重试。
 *    超过 DEFAULT_NOT_FOUND_RETRY_ROUNDS 上限后交由 REMAINING 协议收敛。
 *
 * 2. 导航上下文更新（handleNavigationUrlChange）
 *    navigate.* / evaluate 等动作执行后检测 URL 变化，自动刷新快照，
 *    避免旧 DOM 引用污染下一轮决策。同时记录 currentUrl 供消息注入。
 *
 * 3. 空转检测（detectIdleLoop）
 *    连续 2 轮只执行只读工具（page_info、get_text 等无副作用工具），
 *    判定为 idle_loop 停机，避免无限只读循环。
 *
 * 4. 重复批次防自转
 *    连续 ≥ 2 轮返回完全相同的工具调用批次（上一轮无错误时）：
 *    注入 "Repeated action warning" 提示，要求模型换策略；
 *    连续 ≥ 3 轮仍相同 → repeated_batch 停机。
 *
 * 5. 无效点击拦截（checkIneffectiveClickRepeat）
 *    快照指纹不变时，将本轮 click selector 加入拦截集合；
 *    下一轮再次点击同一目标直接拦截并注入附近可点击元素推荐。
 *    快照变化时仅移除本轮点击（可能是它引发了变化），保留其他历史无效 selector。
 *
 * 6. 交替循环检测（recentRoundClickTargets 滑动窗口）
 *    近 6 轮点击目标滑动窗口：唯一目标 ≤ 2 个且总点击 ≥ 4 次时，
 *    判定为 A→B→A→B 交替循环，将目标全部加入拦截集并注入警告。
 *
 * 7. 协议修复回合（protocolViolationHint）
 *    "remaining 未完成 + 无工具调用"出现时不直接停机，
 *    下一轮注入 protocol violation 提示，要求模型要么行动要么 REMAINING: DONE。
 *    若下一轮仍无改善 → protocol_fix_failed 停机。
 *
 * 8. 滞止收敛检测（consecutiveNoProgressRounds）
 *    remaining 连续 ≥ 2 轮不推进且无确认性进展（fill/type/press/navigate）：
 *    注入 CRITICAL 提示要求检查是否已完成；
 *    连续 ≥ 3 轮 → stale_remaining 停机。
 *    仅对多步任务（taskItems 存在）激活；单步任务由 idle_loop / no_protocol 处理。
 *
 * 9. 断言能力（evaluateAssertions）
 *    AI 主动调用 assert 工具时，通过独立 AI（专用 prompt，无 tools）
 *    结合初始快照 + 动作后快照 + 当前快照判定任务完成情况。
 *    全部通过 → assertion_passed 停机；失败原因写入下一轮 ## Assertion Progress。
 *
 * ─── 停机原因可观测（result.metrics.stopReason）───
 *
 * | StopReason         | 含义                                             |
 * |--------------------|--------------------------------------------------|
 * | converged          | 任务正常完成（REMAINING: DONE 或 remaining 为空） |
 * | assertion_passed   | 所有断言通过（AI 驱动的完成验证）                 |
 * | assertion_loop     | 断言死循环（连续 2 轮仅 assert 且失败）           |
 * | repeated_batch     | 重复相同批次 ≥ 3 轮（防自转保护）                |
 * | idle_loop          | 连续只读轮次（空转检测）                          |
 * | no_protocol        | 持续无 REMAINING 协议且无有效推进                 |
 * | protocol_fix_failed| 协议修复失败（remaining 未完成 + 无工具调用）     |
 * | stale_remaining    | remaining 长期不推进（滞止收敛）                  |
 * | max_rounds         | 达到 maxRounds 上限                               |
 * | dry_run            | 干运行模式（dryRun=true，只展示不执行）           |
 *
 * ─── v1 → v2 迁移对照 ───
 *
 * | v1 WebAgent                          | v2 MainAgent                            |
 * |--------------------------------------|-----------------------------------------|
 * | new WebAgent({ token, provider })    | new MainAgent({ aiClient, tools })      |
 * | agent.registerTools()                | 外部组装 ToolRegistry 后传入              |
 * | agent.chat(msg, { assertionConfig }) | agent.chat(msg, { assertionConfig })    |
 * | agent.callbacks.onText = fn          | new MainAgent({ callbacks: { onText } })|
 * | agent.chat(msg, { initialSnapshot }) | agent.chat(msg, { initialSnapshot })    |
 * | agent.clearMemory()                  | agent.clearHistory()                    |
 * | （无）                                | agent.chatWithOrchestration(msg, tasks) |
 */

import type {
  AIClient,
  AIMessage,
  AgentLoopCallbacks,
  AgentLoopResult,
  RoundStabilityWaitOptions,
} from "../shared/types.js";
import type { ToolRegistry } from "../shared/tool-registry.js";
import type { AssertionConfig, AssertionResult } from "../assertion/types.js";
import type { MicroTaskDescriptor, MicroTaskResult } from "../micro-task/types.js";
import { buildSystemPrompt } from "../shared/system-prompt.js";
import { executeAgentLoop } from "../engine/index.js";
import { executeMicroTask } from "./dispatch.js";
import { TaskMonitor } from "../micro-task/task-monitor.js";
import { OrchestrationContext } from "./orchestration-context.js";
import { Type } from "@sinclair/typebox";

// ─── 类型定义 ───

/** MainAgent 构造参数。 */
export interface MainAgentOptions {
  /** AI 客户端实例（由调用方创建后传入，可通过 createAIClient() 工厂函数生成） */
  aiClient: AIClient;
  /**
   * 工具注册表（由外部组装后传入）。
   *
   * 注册表中应包含 web 层提供的工具（dom/navigate/page_info/wait/evaluate），
   * 以及任何自定义工具。engine 的轮次后稳定等待依赖注册表中的 "wait" 工具。
   */
  tools: ToolRegistry;
  /**
   * 额外指令（注入 system prompt 的 Extra Instructions 章节）。
   *
   * 每条字符串作为独立的行为规则补充注入，换行追加在内置规则之后。
   * 可在实例化后通过 addExtraInstruction() 动态追加。
   */
  extraInstructions?: string[];
  /**
   * 断言配置（实例级默认值，可在 chat() 时通过 options.assertionConfig 覆盖）。
   *
   * 配置后 AI 可主动调用 assert 工具触发独立断言 AI 判定，
   * 全部通过时 stopReason = "assertion_passed"。
   */
  assertionConfig?: AssertionConfig;
  /**
   * 最大轮次上限（默认 DEFAULT_MAX_ROUNDS = 40）。
   *
   * 每轮 = 一次 AI 调用 + 工具执行。建议根据任务复杂度调整：
   * - 简单单步任务：8~12
   * - 多步骤表单任务：20~40
   */
  maxRounds?: number;
  /**
   * 轮次后稳定等待配置。
   *
   * 每轮有潜在 DOM 变更动作（click/navigate/evaluate）后执行双重等待：
   * 1) loading 指示器隐藏（默认覆盖 AntD/Element Plus/BK UI/TDesign 常见 selector）
   * 2) DOM quiet window（MutationObserver + 轮询双通道）
   *
   * 用户自定义 loadingSelectors 采用"追加合并 + 去重"，不覆盖默认值。
   */
  roundStabilityWait?: RoundStabilityWaitOptions;
  /** 事件回调（实例级默认值，chat() 时可通过 options.callbacks 覆盖） */
  callbacks?: AgentLoopCallbacks;
}

/** chat() 的可选参数。 */
export interface ChatOptions {
  /**
   * 覆盖实例级断言配置（仅本次 chat 生效）。
   *
   * 配置后 system prompt 中注入断言任务描述，AI 可在合适时机调用 assert 工具。
   * 断言由独立 AI（专用 prompt，不带 tools）根据：
   * - 任务开始前的初始快照（before）
   * - 操作后快照（post-action，捕获瞬态成功提示）
   * - 当前最新快照（after）
   * 三者对比判定任务是否完成。
   */
  assertionConfig?: AssertionConfig;
  /**
   * 页面初始快照（对话发起时前端已生成）。
   *
   * 传入后作为 Round 0 的快照直接使用，跳过 engine 首轮自动读取；
   * 同时作为断言 AI 的 "before" 基准快照。
   * 建议在 chat() 调用前通过 generateSnapshot() 生成。
   */
  initialSnapshot?: string;
  /** 覆盖实例级回调（仅本次 chat 生效）。 */
  callbacks?: AgentLoopCallbacks;
  /**
   * 是否启用编排模式（可选，默认 false）。
   *
   * 启用后 AI 可在主循环中通过 dispatch_micro_task 工具自主决定
   * 是否将复杂任务拆解为微任务执行。dispatch_micro_task 仅在本次
   * chat 期间注册，chat 结束后自动清理。
   */
  enableOrchestration?: boolean;
}

/** chatWithOrchestration() 的可选参数。 */
export interface OrchestrationOptions extends ChatOptions {
  /**
   * 微任务失败时的最大重试次数（默认 1）。
   *
   * 每个微任务最多重试 maxRetries 次，重试时传入上次的失败原因。
   * 超过重试次数后，记录为失败并继续执行下一个微任务。
   */
  maxRetries?: number;
}

/** 直接执行模式返回值（与 AgentLoopResult 一致）。 */
export interface MainAgentResult extends AgentLoopResult {
  /** 微任务执行结果（仅编排模式） */
  microTaskResults?: MicroTaskResult[];
  /** 系统级断言结果（仅编排模式，覆盖 assertionResult） */
  systemAssertionResult?: AssertionResult;
}

/** 对话历史条目（从 AIMessage[] 提取的 user/assistant 对）。 */
export type ConversationEntry = {
  role: "user" | "assistant";
  content: string;
};

// ─── MainAgent 实现 ───

/**
 * 主 Agent — 管理多轮对话，支持直接执行和微任务编排双模式。
 *
 * ─── 职责 ───
 * 1. 构建 system prompt（合并 extraInstructions + assertionTasks + orchestration）
 * 2. 调用 executeAgentLoop 执行决策循环（含 9 大保护机制 + 10 种停机条件）
 * 3. 累积对话历史（支持多轮记忆，history 在多次 chat 调用间持久化）
 * 4. 编排微任务执行链（chatWithOrchestration 模式）
 *
 * ─── 不负责 ───
 * - AI client 创建（由调用方通过 aiClient 传入）
 * - Tool 注册（ToolRegistry 由外部组装后通过 tools 传入）
 * - 页面快照管理（通过 ChatOptions.initialSnapshot 传入）
 * - 工具执行（由 engine 内部 ToolRegistry.dispatch 驱动）
 *
 * ─── 基础用法（直接执行模式） ───
 * ```ts
 * const agent = new MainAgent({
 *   aiClient: createAIClient({ provider: "openai", token: "sk-..." }),
 *   tools: registry,               // 已注册 dom/navigate/wait/... 工具
 *   maxRounds: 30,
 *   callbacks: { onText: (t) => console.log(t) },
 * });
 *
 * const result = await agent.chat("把城市改成上海", {
 *   initialSnapshot: await generateSnapshot(),
 * });
 * console.log(result.metrics.stopReason); // "converged" | "assertion_passed" | ...
 * ```
 *
 * ─── 编排模式用法 ───
 * ```ts
 * const result = await agent.chatWithOrchestration(
 *   "填写员工入职表单",
 *   [
 *     { id: "mt-1", task: "填写基本信息：姓名张三、性别男、年龄30" },
 *     { id: "mt-2", task: "填写联系方式：手机13800138000、邮箱xxx@xx.com" },
 *     { id: "mt-3", task: "填写地址：北京朝阳区xxx路" },
 *     { id: "mt-4", task: "点击提交按钮" },
 *   ],
 *   { initialSnapshot: await generateSnapshot() },
 * );
 * console.log(result.microTaskResults); // 每个微任务的执行详情
 * ```
 */
export class MainAgent {
  private aiClient: AIClient;
  private tools: ToolRegistry;
  private extraInstructions: string[];
  private assertionConfig?: AssertionConfig;
  private maxRounds?: number;
  private roundStabilityWait?: RoundStabilityWaitOptions;
  private callbacks?: AgentLoopCallbacks;

  /** 累积的对话消息（跨多轮 chat 调用） */
  private history: AIMessage[] = [];

  constructor(options: MainAgentOptions) {
    this.aiClient = options.aiClient;
    this.tools = options.tools;
    this.extraInstructions = options.extraInstructions ? [...options.extraInstructions] : [];
    this.assertionConfig = options.assertionConfig;
    this.maxRounds = options.maxRounds;
    this.roundStabilityWait = options.roundStabilityWait;
    this.callbacks = options.callbacks;
  }

  /**
   * 直接执行模式 — 发送用户消息并执行完整的 Agent Loop。
   *
   * ─── 执行流程 ───
   * 1. buildSystemPrompt()：合并 extraInstructions + assertionTasks → system prompt 字符串
   * 2. executeAgentLoop()：执行决策主循环，内含 9 大保护机制（见类注释）
   * 3. this.history = result.messages：累积历史（engine 返回完整消息链）
   * 4. 返回 MainAgentResult（= AgentLoopResult）
   *
   * ─── 配置优先级 ───
   * - assertionConfig：options.assertionConfig > this.assertionConfig（实例级）
   * - callbacks：options.callbacks > this.callbacks（实例级）
   * - roundStabilityWait / maxRounds：仅使用实例级，chat 级不覆盖
   *
   * ─── 多轮记忆 ───
   * 每次 chat() 后 this.history 被更新为 result.messages（完整消息链）。
   * 下次 chat() 传入 history 参数，engine 构建消息时会将其作为"先前对话"注入，
   * 使模型能感知完整对话上下文。调用 clearHistory() 可重置。
   *
   * ─── 初始快照 ───
   * 建议由 web 层在调用 chat 前生成，通过 options.initialSnapshot 传入：
   * ```ts
   * const snapshot = await generateSnapshot();
   * await agent.chat("点击提交按钮", { initialSnapshot: snapshot });
   * ```
   * 未传入时 engine 会在第一轮自动读取（需 registry 中有 page_info 工具）。
   *
   * @param message - 用户自然语言指令
   * @param options - 可选配置（断言、初始快照、回调覆盖）
   * @returns MainAgentResult 包含：reply / toolCalls[] / messages[] / metrics / assertionResult?
   */
  async chat(message: string, options?: ChatOptions): Promise<MainAgentResult> {
    // 合并断言配置：chat 级 > 实例级
    const assertionConfig = options?.assertionConfig ?? this.assertionConfig;

    // 构建断言任务描述（用于 system prompt 注入）
    const assertionTasks = assertionConfig?.taskAssertions?.map((a) => ({
      task: a.task,
      description: a.description,
    }));

    // 合并回调：chat 级 > 实例级
    const callbacks = options?.callbacks ?? this.callbacks;

    // === 编排模式处理 ===
    let orchestrationCtx: OrchestrationContext | undefined;

    if (options?.enableOrchestration) {
      orchestrationCtx = new OrchestrationContext({
        aiClient: this.aiClient,
        tools: this.tools,
        roundStabilityWait: this.roundStabilityWait,
        callbacks,
        initialSnapshot: options?.initialSnapshot,
      });

      this.tools.register({
        name: "dispatch_micro_task",
        description:
          "Delegate a focused sub-task to a micro-task agent. " +
          "The micro-task agent executes independently with its own Agent Loop, " +
          "using a simplified prompt focused on the given task. " +
          "Use this for complex forms (>5 fields), multi-step workflows, or repetitive operations.",
        schema: Type.Object({
          task: Type.String({ description: "Clear, specific task description for the micro-task agent" }),
        }),
        execute: (params) => orchestrationCtx!.dispatch(params as { task: string }),
      });
    }

    // 构建系统提示词
    const systemPrompt = buildSystemPrompt({
      extraInstructions: this.extraInstructions,
      assertionTasks,
      enableOrchestration: options?.enableOrchestration,
    });

    try {
      // 执行 Agent Loop
      const result = await executeAgentLoop({
        client: this.aiClient,
        registry: this.tools,
        systemPrompt,
        message,
        initialSnapshot: options?.initialSnapshot,
        history: this.history.length > 0 ? this.history : undefined,
        maxRounds: this.maxRounds,
        roundStabilityWait: this.roundStabilityWait,
        assertionConfig,
        callbacks,
      });

      // 累积对话历史（engine 返回的 messages 包含历史 + 本轮）
      this.history = result.messages;

      // === finalize 编排上下文 ===
      if (orchestrationCtx) {
        const { results, allPassed } = await orchestrationCtx.finalize();
        return {
          ...result,
          microTaskResults: results,
        };
      }

      return result;
    } finally {
      // === 清理 dispatch tool ===
      if (orchestrationCtx) {
        this.tools.unregister("dispatch_micro_task");
      }
    }
  }

  /**
   * 编排执行模式 — 将任务拆解为微任务链逐个执行。
   *
   * ─── 执行流程 ───
   * 1. 重置 TaskMonitor（清空上一次的执行记录链）
   * 2. 逐个执行微任务（TaskMonitor.execute → executeMicroTask → executeAgentLoop）
   * 3. 每个微任务独立上下文：精简 prompt + previouslyCompleted 注入
   * 4. 失败的微任务尝试重试（最多 maxRetries 次）
   * 5. 全部完成后，执行记录链沉淀供系统断言使用
   * 6. 返回 MainAgentResult（含 microTaskResults + 汇总指标）
   *
   * ─── 微任务 vs 直接执行 ───
   * | 维度 | chat() | chatWithOrchestration() |
   * |------|--------|--------------------------|
   * | 适用场景 | 简单、单步操作 | 大表单、多步骤、跨页面流程 |
   * | prompt | 完整 32 条规则 | 每个微任务精简规则 + 前置记录 |
   * | 上下文 | 多轮累积 | 每个微任务独立 + 记录链传递 |
   * | 对话历史 | 累积到 this.history | 不累积（编排模式独立于对话） |
   *
   * ─── 使用示例 ───
   * ```ts
   * const result = await agent.chatWithOrchestration(
   *   "填写员工入职表单",
   *   [
   *     { id: "mt-1", task: "填写基本信息区域：姓名张三、性别男、年龄30" },
   *     { id: "mt-2", task: "填写联系方式区域：手机13800138000、邮箱xxx@xx.com" },
   *     { id: "mt-3", task: "填写地址区域：北京朝阳区xxx路" },
   *     { id: "mt-4", task: "点击提交按钮" },
   *   ],
   *   {
   *     initialSnapshot: await generateSnapshot(),
   *     assertionConfig: {
   *       taskAssertions: [
   *         { task: "表单提交", description: "页面显示提交成功提示" },
   *       ],
   *     },
   *   },
   * );
   *
   * // 查看每个微任务结果
   * for (const mt of result.microTaskResults!) {
   *   console.log(`${mt.descriptor.id}: ${mt.success ? "✅" : "✗"} ${mt.executionRecord.summary}`);
   * }
   * ```
   *
   * @param message - 用户原始指令（用于系统断言时的上下文参考）
   * @param tasks - 已拆解的微任务描述列表（按执行顺序排列）
   * @param options - 可选配置（断言、初始快照、回调覆盖、重试次数）
   * @returns MainAgentResult 包含 microTaskResults[] + 汇总指标
   */
  async chatWithOrchestration(
    message: string,
    tasks: MicroTaskDescriptor[],
    options?: OrchestrationOptions,
  ): Promise<MainAgentResult> {
    const maxRetries = options?.maxRetries ?? 1;
    const callbacks = options?.callbacks ?? this.callbacks;

    // 1. 初始化 TaskMonitor
    const monitor = new TaskMonitor();

    // 2. 逐个执行微任务
    const microTaskResults: MicroTaskResult[] = [];
    let latestSnapshot = options?.initialSnapshot;

    for (const task of tasks) {
      let result: MicroTaskResult | undefined;
      let retries = 0;

      // 重试循环
      while (retries <= maxRetries) {
        result = await monitor.execute(task, async (descriptor, previousContext) => {
          return executeMicroTask({
            descriptor,
            previousContext,
            aiClient: this.aiClient,
            tools: this.tools,
            currentSnapshot: latestSnapshot,
            roundStabilityWait: this.roundStabilityWait,
            callbacks,
          });
        });

        if (result.success) break;

        retries++;
        if (retries > maxRetries) break;

        // 通知回调：微任务重试
        callbacks?.onText?.(
          `[Orchestration] Retrying micro-task "${task.id}" (attempt ${retries + 1}/${maxRetries + 1}): ${result.failureReason}`,
        );
      }

      if (result) {
        microTaskResults.push(result);
        // 更新最新快照供下一个微任务使用
        if (result.finalSnapshot) {
          latestSnapshot = result.finalSnapshot;
        }
      }
    }

    // 3. 汇总指标
    const totalRounds = microTaskResults.reduce((sum, r) => sum + r.metrics.roundCount, 0);
    const totalToolCalls = microTaskResults.reduce((sum, r) => sum + r.metrics.totalToolCalls, 0);
    const successfulToolCalls = microTaskResults.reduce((sum, r) => sum + r.metrics.successfulToolCalls, 0);
    const failedToolCalls = microTaskResults.reduce((sum, r) => sum + r.metrics.failedToolCalls, 0);
    const inputTokens = microTaskResults.reduce((sum, r) => sum + r.metrics.inputTokens, 0);
    const outputTokens = microTaskResults.reduce((sum, r) => sum + r.metrics.outputTokens, 0);
    const allSucceeded = microTaskResults.every((r) => r.success);

    // 4. 构建最终回复
    const evidence = monitor.recordChain.buildEvidenceSummary();
    const reply = allSucceeded
      ? `All ${tasks.length} micro-tasks completed successfully.\n\n${evidence}`
      : `${microTaskResults.filter((r) => r.success).length}/${tasks.length} micro-tasks succeeded.\n\n${evidence}`;

    // 5. 确定停机原因
    const stopReason = allSucceeded ? "converged" as const : "max_rounds" as const;

    return {
      reply,
      toolCalls: microTaskResults.flatMap((r) =>
        r.executionRecord.actions.map((a) => ({
          name: "micro-task",
          input: { action: a },
          result: { content: r.success ? "success" : "failed" },
        })),
      ),
      messages: [],
      metrics: {
        roundCount: totalRounds,
        totalToolCalls,
        successfulToolCalls,
        failedToolCalls,
        toolSuccessRate: totalToolCalls > 0 ? successfulToolCalls / totalToolCalls : 1,
        recoveryCount: 0,
        redundantInterceptCount: 0,
        snapshotReadCount: microTaskResults.reduce((sum, r) => sum + r.metrics.snapshotReadCount, 0),
        latestSnapshotSize: microTaskResults.at(-1)?.metrics.latestSnapshotSize ?? 0,
        avgSnapshotSize: 0,
        maxSnapshotSize: Math.max(0, ...microTaskResults.map((r) => r.metrics.maxSnapshotSize)),
        inputTokens,
        outputTokens,
        stopReason,
      },
      microTaskResults,
    };
  }

  /** 追加额外指令（下次 chat() 时重新构建 system prompt 后生效）。 */
  addExtraInstruction(instruction: string): void {
    this.extraInstructions.push(instruction);
  }

  /**
   * 获取对话历史（仅 user/assistant 条目）。
   *
   * 从内部 AIMessage[] 提取 role 为 user 或 assistant 的条目，
   * 将 content 转为纯文本字符串（数组型 content 序列化为 JSON）。
   *
   * 注：tool/system 消息不包含在返回结果中，仅反映"人机对话"部分。
   */
  getHistory(): ConversationEntry[] {
    return this.history
      .filter((m): m is AIMessage & { role: "user" | "assistant" } =>
        m.role === "user" || m.role === "assistant",
      )
      .map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));
  }

  /** 清空对话历史（下次 chat() 将作为全新会话执行）。 */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * 运行时更新断言配置（影响后续所有 chat() 调用，直到下次修改）。
   *
   * 与 chat(msg, { assertionConfig }) 的区别：
   * - 此方法持久修改实例级配置，影响之后所有 chat 调用
   * - chat options 仅影响单次调用
   */
  setAssertionConfig(config: AssertionConfig): void {
    this.assertionConfig = config;
  }
}
