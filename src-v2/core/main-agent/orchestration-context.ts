/**
 * OrchestrationContext — 编排会话状态管理器。
 *
 * 当 MainAgent.chat() 以 enableOrchestration=true 调用时，
 * 创建 OrchestrationContext 实例，将 dispatch_micro_task 注册为真正的 tool，
 * 让 AI 在主循环中根据页面复杂度自主决定是否拆解微任务。
 *
 * ─── 核心职责 ───
 * 1. 管理编排会话状态（微任务计数、执行结果、异步断言）
 * 2. 提供 dispatch() 方法作为 dispatch_micro_task 工具的 execute 实现
 * 3. 维护异步断言流水线（微任务完成后发起异步断言，下次 dispatch 时检查）
 * 4. 断言失败时自动重试微任务（最多一次）
 * 5. finalize() 等待所有 pending 断言完成
 *
 * ─── 异步断言流水线 ───
 *
 * Round N: dispatch("选日期") → 执行 MT-1 → evaluateAsync() → 返回结果
 * Round N+1: dispatch("选颜色") → 检查 MT-1 断言 → 失败则重试 → 执行 MT-2 → evaluateAsync()
 * Round N+2: AI 收尾 → finalize() 等待所有断言
 *
 * ─── 防递归 ───
 *
 * 微任务 Agent 使用的 ToolRegistry 排除了 dispatch_micro_task，
 * 防止微任务内部再次调用 dispatch 导致递归。
 */

import type { AIClient, AgentLoopCallbacks, RoundStabilityWaitOptions } from "../shared/types.js";
import type { ToolRegistry, ToolCallResult } from "../shared/tool-registry.js";
import { ToolRegistry as ToolRegistryClass } from "../shared/tool-registry.js";
import type { MicroTaskResult } from "../micro-task/types.js";
import type { PendingAssertion, AssertionRequest } from "../assertion/types.js";
import { evaluateAsync, awaitAllAssertions } from "../assertion/index.js";
import { TaskMonitor } from "../micro-task/task-monitor.js";
import { executeMicroTask } from "./dispatch.js";

// ─── 类型定义 ───

/** OrchestrationContext 构造参数 */
export type OrchestrationContextDeps = {
  aiClient: AIClient;
  tools: ToolRegistry;
  roundStabilityWait?: RoundStabilityWaitOptions;
  callbacks?: AgentLoopCallbacks;
  initialSnapshot?: string;
};

// ─── 实现 ───

export class OrchestrationContext {
  private aiClient: AIClient;
  private microTaskTools: ToolRegistryClass;
  private roundStabilityWait?: RoundStabilityWaitOptions;
  private callbacks?: AgentLoopCallbacks;

  private monitor: TaskMonitor;
  private pendingAssertions: PendingAssertion[] = [];
  private microTaskResults: MicroTaskResult[] = [];
  private latestSnapshot?: string;
  private microTaskCounter = 0;
  /** 已重试过的微任务 ID 集合，防止同一微任务重复重试 */
  private retriedMicroTaskIds = new Set<string>();

  constructor(deps: OrchestrationContextDeps) {
    this.aiClient = deps.aiClient;
    this.roundStabilityWait = deps.roundStabilityWait;
    this.callbacks = deps.callbacks;
    this.latestSnapshot = deps.initialSnapshot;
    this.monitor = new TaskMonitor();

    // 克隆 ToolRegistry，排除 dispatch_micro_task 防递归
    this.microTaskTools = new ToolRegistryClass();
    for (const tool of deps.tools.getDefinitions()) {
      if (tool.name !== "dispatch_micro_task") {
        this.microTaskTools.register(tool);
      }
    }
  }

  /**
   * dispatch_micro_task 工具的执行实现。
   *
   * 流程：
   * 1. 检查 pendingAssertions，处理已 resolve 且失败的（重试一次）
   * 2. 执行新微任务 via monitor.execute() → executeMicroTask()
   * 3. 成功后发起异步断言（不阻塞）
   * 4. 返回 ToolCallResult（含成功/失败状态 + 已完成微任务汇总）
   */
  async dispatch(params: { task: string }): Promise<ToolCallResult> {
    const retryMessages: string[] = [];

    // Step 1: 检查之前的 pending assertions
    await this.checkAndRetryFailedAssertions(retryMessages);

    // Step 2: 执行新微任务
    const id = `mt-${++this.microTaskCounter}`;
    const descriptor = { id, task: params.task };

    // 保存微任务执行前的快照，用于断言对比（before vs after）
    const preTaskSnapshot = this.latestSnapshot;

    let result: MicroTaskResult;
    try {
      result = await this.monitor.execute(descriptor, async (desc, previousContext) => {
        return executeMicroTask({
          descriptor: desc,
          previousContext,
          aiClient: this.aiClient,
          tools: this.microTaskTools,
          currentSnapshot: this.latestSnapshot,
          roundStabilityWait: this.roundStabilityWait,
          callbacks: this.callbacks,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          `\u2717 ${id} FAILED: ${message}`,
          "",
          this.getCompletedSummary(),
        ].join("\n"),
      };
    }

    this.microTaskResults.push(result);

    // 更新最新快照
    if (result.finalSnapshot) {
      this.latestSnapshot = result.finalSnapshot;
    }

    // Step 3: 异步断言（成功时发起，不阻塞）
    // 传入 initialSnapshot（执行前快照）让断言 AI 可以做 before/after 对比
    if (result.success && result.executionRecord.actions.length > 0) {
      const assertionRequest: AssertionRequest = {
        level: "micro-task",
        taskAssertions: [{ task: descriptor.task, description: descriptor.task }],
        initialSnapshot: preTaskSnapshot,
        currentSnapshot: result.finalSnapshot,
        executedActions: result.executionRecord.actions,
      };
      const pending = evaluateAsync(this.aiClient, assertionRequest, id);
      this.pendingAssertions.push(pending);
    }

    // Step 4: 构建 ToolCallResult
    const statusIcon = result.success ? "\u2705" : "\u2717";
    const statusText = result.success ? "done" : `FAILED: ${result.failureReason ?? "unknown"}`;
    const pendingCount = this.pendingAssertions.filter(p => !p.resolved).length;

    const lines: string[] = [
      `${statusIcon} ${id} ${statusText}`,
    ];

    if (retryMessages.length > 0) {
      lines.push("", "Retry results:", ...retryMessages);
    }

    lines.push(
      "",
      `Completed micro-tasks (${this.microTaskResults.length}):`,
      this.getCompletedSummary(),
      "",
      `Pending assertions: ${pendingCount}`,
    );

    return { content: lines.join("\n") };
  }

  /**
   * 等待所有 pending 断言完成，返回最终结果。
   */
  async finalize(): Promise<{ results: MicroTaskResult[]; allPassed: boolean }> {
    if (this.pendingAssertions.length > 0) {
      await awaitAllAssertions(this.pendingAssertions);
    }

    const allPassed = this.pendingAssertions.every(
      p => !p.result || p.result.allPassed,
    );

    return {
      results: this.microTaskResults,
      allPassed,
    };
  }

  /**
   * 返回所有已完成微任务的描述聚合。
   */
  getCompletedSummary(): string {
    if (this.microTaskResults.length === 0) {
      return "(no micro-tasks completed yet)";
    }
    return this.microTaskResults
      .map(r => {
        const icon = r.success ? "\u2705" : "\u2717";
        return `${icon} ${r.descriptor.id}: ${r.descriptor.task}`;
      })
      .join("\n");
  }

  // ─── 内部方法 ───

  /**
   * 检查已 resolve 的 pending assertions，对失败的重试一次。
   */
  private async checkAndRetryFailedAssertions(retryMessages: string[]): Promise<void> {
    if (this.pendingAssertions.length === 0) return;

    // 等待所有未 resolve 的断言完成
    const unresolved = this.pendingAssertions.filter(p => !p.resolved);
    if (unresolved.length > 0) {
      await Promise.all(unresolved.map(p => p.promise));
    }

    // 找出失败的（排除已重试过的，每个微任务最多重试 1 次）
    const failed = this.pendingAssertions.filter(
      p => p.resolved && p.result && !p.result.allPassed
        && !this.retriedMicroTaskIds.has(p.microTaskId),
    );

    for (const failedAssertion of failed) {
      this.retriedMicroTaskIds.add(failedAssertion.microTaskId);

      const originalResult = this.microTaskResults.find(
        r => r.descriptor.id === failedAssertion.microTaskId,
      );
      if (!originalResult) continue;

      // 重试一次
      this.callbacks?.onText?.(
        `[Orchestration] Assertion failed for ${failedAssertion.microTaskId}, retrying...`,
      );

      // 保存重试前的快照，用于断言对比
      const preRetrySnapshot = this.latestSnapshot;

      try {
        const retryResult = await this.monitor.execute(
          originalResult.descriptor,
          async (desc, previousContext) => {
            return executeMicroTask({
              descriptor: desc,
              previousContext,
              aiClient: this.aiClient,
              tools: this.microTaskTools,
              currentSnapshot: this.latestSnapshot,
              roundStabilityWait: this.roundStabilityWait,
              callbacks: this.callbacks,
            });
          },
        );

        // 更新结果
        const idx = this.microTaskResults.findIndex(
          r => r.descriptor.id === failedAssertion.microTaskId,
        );
        if (idx !== -1) {
          this.microTaskResults[idx] = retryResult;
        }

        if (retryResult.finalSnapshot) {
          this.latestSnapshot = retryResult.finalSnapshot;
        }

        if (retryResult.success) {
          retryMessages.push(
            `\u2705 ${failedAssertion.microTaskId} retry succeeded`,
          );
          // 发起新的异步断言（传入重试前快照做 before/after 对比）
          const assertionRequest: AssertionRequest = {
            level: "micro-task",
            taskAssertions: [{ task: originalResult.descriptor.task, description: originalResult.descriptor.task }],
            initialSnapshot: preRetrySnapshot,
            currentSnapshot: retryResult.finalSnapshot,
            executedActions: retryResult.executionRecord.actions,
          };
          const newPending = evaluateAsync(this.aiClient, assertionRequest, failedAssertion.microTaskId);
          this.pendingAssertions.push(newPending);
        } else {
          retryMessages.push(
            `\u2717 ${failedAssertion.microTaskId} retry failed: ${retryResult.failureReason ?? "unknown"}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        retryMessages.push(
          `\u2717 ${failedAssertion.microTaskId} retry error: ${message}`,
        );
      }
    }

    // 清理已处理的失败断言（保留成功的和新添加的）
    this.pendingAssertions = this.pendingAssertions.filter(
      p => !failed.includes(p),
    );
  }
}
