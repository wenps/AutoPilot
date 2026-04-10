/**
 * Engine 决策主循环 — v2 多 Agent 架构的统一执行引擎。
 *
 * 本文件是薄编排层，将执行逻辑委托给：
 * - engine-context.ts — 状态容器 + 辅助方法（EngineContext）
 * - phases.ts — 5 个 phase 函数（handleNoToolCallResponse, executeRoundTools, ...）
 *
 * ═══ 每轮主流程（6 阶段固定顺序）═══
 *
 * ```
 *   轮次开始
 *      │
 *      ├─ 阶段 1: Ensure Snapshot
 *      ├─ 阶段 2: Build Messages + Call AI  (prepareAndCallAI)
 *      ├─ 阶段 3: No-tool-call handling     (handleNoToolCallResponse)
 *      ├─ 阶段 4: Execute Tools             (executeRoundTools)
 *      ├─ 阶段 5: Assertion handling         (handleAssertionTool)
 *      ├─ 阶段 6: State update               (updateRemainingState)
 *      └─ 阶段 7: Post-round guards          (runPostRoundGuards)
 * ```
 *
 * ═══ 停机条件（10 种 StopReason）═══
 *
 * converged / assertion_passed / assertion_loop / repeated_batch /
 * idle_loop / no_protocol / protocol_fix_failed / stale_remaining /
 * max_rounds / dry_run
 */
import { computeSnapshotFingerprint } from "../shared/helpers.js";
import { EngineContext } from "./engine-context.js";
import {
  prepareAndCallAI,
  handleNoToolCallResponse,
  checkRepeatedBatch,
  handleDryRun,
  splitToolCalls,
  executeRoundTools,
  handleAssertionTool,
  updateRemainingState,
  runPostRoundGuards,
} from "./phases.js";
import type { AgentLoopParams, AgentLoopResult } from "../shared/types.js";

/**
 * 执行 Agent 循环 — v2 统一执行引擎的唯一入口。
 *
 * @param params - 完整执行配置，参见 AgentLoopParams 类型定义（shared/types.ts）
 * @returns AgentLoopResult — { reply, toolCalls[], messages[], metrics, assertionResult? }
 */
export async function executeAgentLoop(
  params: AgentLoopParams,
): Promise<AgentLoopResult> {
  const ctx = new EngineContext(params);

  // 聚焦模式：拍摄基准快照（仅一次，整个微任务期间不变）
  if (ctx.focusedMode && !ctx.microTaskBaseSnapshot) {
    // 必须调用 refreshSnapshot() 重新生成快照并填充 RefStore，
    // 不能依赖 initialSnapshot 字符串 — 那只是文本，RefStore 没有对应映射
    await ctx.refreshSnapshot();
    ctx.microTaskBaseSnapshot = ctx.pageContext.latestSnapshot;

    // 有初始聚焦目标时，立即生成聚焦快照供 Round 0 使用
    if (ctx.focusTargetRef) {
      await ctx.refreshFocusedSnapshot();
    }
  }

  for (let round = 0; round < ctx.maxRounds; round++) {
    ctx.callbacks?.onRound?.(round);
    ctx.usedRounds = round + 1;

    // 阶段 1: 确保快照
    if (!ctx.pageContext.latestSnapshot) {
      if (ctx.focusedMode && ctx.focusTargetRef) {
        await ctx.refreshFocusedSnapshot();
      } else {
        await ctx.refreshSnapshot();
      }
    }

    const roundStartFingerprint = computeSnapshotFingerprint(ctx.pageContext.latestSnapshot || "");

    // 阶段 2: 构建消息 + 调用 AI
    const { response, parsedState } = await prepareAndCallAI(ctx, round);

    // 阶段 3: 无工具调用 → 处理收敛/协议修复
    if (!response.toolCalls || response.toolCalls.length === 0) {
      const signal = await handleNoToolCallResponse(ctx, response, parsedState, round);
      if (signal.action === "continue") continue;
      if (signal.action === "break") break;
    }

    // 重复批次检测
    const batchSignal = checkRepeatedBatch(ctx, response);
    if (batchSignal?.action === "break") break;

    // Dry-run 模式
    if (ctx.dryRun) {
      handleDryRun(ctx, response);
      break;
    }

    // 阶段 4: 执行工具
    const { regularToolCalls, assertToolCall } = splitToolCalls(response.toolCalls!);
    const roundResult = await executeRoundTools(ctx, regularToolCalls, round);

    // 阶段 5: 断言处理
    if (assertToolCall) {
      const signal = await handleAssertionTool(ctx, assertToolCall, roundResult, round, response);
      if (signal.action === "break") break;
    } else {
      ctx.consecutiveAssertOnlyFailedRounds = 0;
    }

    // 阶段 6: 状态推进
    const stateSignal = updateRemainingState(ctx, parsedState, roundResult, response);
    if (stateSignal.action === "break") break;

    // 阶段 7: 轮后防护 + 快照刷新
    const guardSignal = await runPostRoundGuards(ctx, response, roundResult, round, roundStartFingerprint);
    if (guardSignal.action === "break") break;
  }

  return ctx.buildResult();
}

// ─── Re-exports（维持外部 API 面）───
export { wrapSnapshot } from "../shared/snapshot/index.js";
export { evaluateAssertions } from "../assertion/index.js";
export type {
  AgentLoopParams,
  AgentLoopResult,
  AgentLoopCallbacks,
  AgentLoopMetrics,
  StopReason,
  RoundStabilityWaitOptions,
} from "../shared/types.js";
export type {
  TaskAssertion,
  AssertionConfig,
  AssertionResult,
  TaskAssertionResult,
} from "../assertion/types.js";
