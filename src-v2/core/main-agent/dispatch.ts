/**
 * dispatch_micro_task 工具实现 — Main Agent 分派微任务的桥梁。
 *
 * ─── 在 v2 架构中的位置 ───
 *
 * ```
 * Main Agent
 *   ├── chat() 直接执行模式 → executeAgentLoop()
 *   └── chat() 编排模式
 *         ├── AI 调用 dispatch_micro_task 工具
 *         ├── → executeMicroTask()  ← 【当前文件核心函数】
 *         │     ├── buildMicroTaskPrompt()  ← 精简 prompt
 *         │     ├── executeAgentLoop()      ← 共享引擎
 *         │     └── 生成 MicroTaskResult    ← 执行记录
 *         └── TaskMonitor 管理执行记录链
 * ```
 *
 * ─── 设计决策 ───
 *
 * 1. **不注册为 ToolRegistry 工具**：dispatch 不是浏览器工具（dom/navigate 等），
 *    而是编排层行为。MainAgent 在 AI 返回 dispatch_micro_task 调用时拦截处理，
 *    不走 ToolRegistry.dispatch 路径。
 *
 * 2. **复用 executeAgentLoop**：微任务和主任务共享同一个执行引擎，
 *    区别仅在 systemPrompt（精简版）和 maxRounds（更小值）。
 *
 * 3. **执行记录生成**：从 AgentLoopResult 中提取 completedSubGoals、actions、summary，
 *    构建 MicroTaskExecutionRecord 供断言和后续微任务使用。
 *
 * 4. **快照传递**：接收上一个微任务/主循环的 latestSnapshot 作为 initialSnapshot，
 *    确保微任务从当前页面状态开始执行。
 */

import type { AIClient, AgentLoopCallbacks, RoundStabilityWaitOptions } from "../shared/types.js";
import type { ToolRegistry } from "../shared/tool-registry.js";
import type { AssertionConfig } from "../assertion/types.js";
import type { MicroTaskDescriptor, MicroTaskResult } from "../micro-task/types.js";
import type { MicroTaskExecutionRecord } from "../assertion/types.js";
import { buildMicroTaskPrompt } from "../micro-task/prompt.js";
import { executeAgentLoop } from "../engine/index.js";

/** 微任务默认最大轮次（比主任务小，聚焦执行更快收敛） */
const DEFAULT_MICRO_TASK_MAX_ROUNDS = 15;

/**
 * executeMicroTask 的参数。
 *
 * 由 MainAgent 在编排模式中组装后调用。
 */
export type ExecuteMicroTaskParams = {
  /** 微任务描述 */
  descriptor: MicroTaskDescriptor;
  /** 之前微任务的精简上下文（由 ExecutionRecordChain.buildPreviousContext() 生成） */
  previousContext: string;
  /** AI 客户端实例 */
  aiClient: AIClient;
  /** 工具注册表 */
  tools: ToolRegistry;
  /** 当前页面快照（作为微任务的初始快照） */
  currentSnapshot?: string;
  /** 轮次后稳定等待配置 */
  roundStabilityWait?: RoundStabilityWaitOptions;
  /** 事件回调 */
  callbacks?: AgentLoopCallbacks;
};

/**
 * 执行单个微任务。
 *
 * ─── 执行流程 ───
 * 1. 构建微任务专用 prompt（精简规则 + 任务描述 + previouslyCompleted）
 * 2. 如果微任务自带 assertions，构建 assertionConfig
 * 3. 调用 executeAgentLoop 执行（共享引擎，不同配置）
 * 4. 从结果中提取执行记录（MicroTaskExecutionRecord）
 * 5. 返回 MicroTaskResult
 *
 * ─── 与直接执行的差异 ───
 * | 维度 | 直接执行 | 微任务执行 |
 * |------|---------|-----------|
 * | prompt | buildSystemPrompt | buildMicroTaskPrompt (精简) |
 * | maxRounds | 40 | 15 (默认) |
 * | message | 用户原始目标 | 微任务描述 |
 * | history | 多轮累积 | 无 (每个微任务独立上下文) |
 *
 * @param params - 执行参数
 * @returns MicroTaskResult 包含执行记录、指标、最终快照
 */
export async function executeMicroTask(
  params: ExecuteMicroTaskParams,
): Promise<MicroTaskResult> {
  const { descriptor, previousContext, aiClient, tools, currentSnapshot, roundStabilityWait, callbacks } = params;

  // 1. 构建微任务专用 prompt
  const systemPrompt = buildMicroTaskPrompt({
    task: descriptor.task,
    previouslyCompleted: previousContext,
  });

  // 2. 构建断言配置（如果微任务自带 assertions）
  const assertionConfig: AssertionConfig | undefined = descriptor.assertions?.length
    ? { taskAssertions: descriptor.assertions }
    : undefined;

  // 3. 从 descriptor.focusRef 或任务描述中提取初始聚焦目标（如 #abc123）
  const focusRefMatch = descriptor.task.match(/#([a-z0-9]{4,})\b/i);
  const initialFocusRef = descriptor.focusRef
    || (focusRefMatch ? focusRefMatch[1] : undefined);

  // 4. 调用共享执行引擎（微任务启用聚焦快照模式）
  const result = await executeAgentLoop({
    client: aiClient,
    registry: tools,
    systemPrompt,
    message: descriptor.task,
    initialSnapshot: currentSnapshot,
    maxRounds: descriptor.maxRounds ?? DEFAULT_MICRO_TASK_MAX_ROUNDS,
    roundStabilityWait,
    assertionConfig,
    callbacks,
    focusedMode: true,
    initialFocusRef,
    // 不传 history — 微任务独立上下文，不累积对话历史
  });

  // 4. 判定执行成功与否
  const success =
    result.metrics.stopReason === "converged" ||
    result.metrics.stopReason === "assertion_passed";

  // 5. 从 AI 回复中提取 completedSubGoals
  //    微任务 AI 在 REMAINING: DONE 时会描述完成了什么，
  //    这里简化处理：成功时用 reply 作为 summary，
  //    completedSubGoals 从回复中提取（或用任务描述兜底）。
  const completedSubGoals = success ? [descriptor.task] : [];

  // 6. 提取工具调用摘要
  const actions = result.toolCalls.map(
    (tc) => `${tc.name}(${JSON.stringify(tc.input)})`,
  );

  // 7. 构建执行记录
  const executionRecord: MicroTaskExecutionRecord = {
    id: descriptor.id,
    task: descriptor.task,
    success,
    completedSubGoals,
    actions,
    summary: result.reply || (success ? "Task completed successfully." : "Task did not complete."),
    assertionResult: result.assertionResult,
  };

  // 8. 确定失败原因
  const failureReason = success
    ? undefined
    : `Stopped with reason: ${result.metrics.stopReason}. ${result.reply || ""}`.trim();

  return {
    descriptor,
    success,
    executionRecord,
    metrics: result.metrics,
    finalSnapshot: result.finalSnapshot ?? "",
    failureReason,
  };
}

