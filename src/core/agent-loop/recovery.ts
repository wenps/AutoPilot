/**
 * 保护与恢复机制（中）/ Protection and recovery mechanisms (EN).
 *
 * 确保单次失败不打断主循环。
 * Keeps the main loop resilient to single-step failures.
 */
import type { ToolCallResult } from "../tool-registry.js";
import type { AgentLoopCallbacks } from "./types.js";
import { DEFAULT_ACTION_RECOVERY_ROUNDS } from "./constants.js";
import { readPageSnapshot } from "./snapshot.js";
import {
  getToolAction,
  hasToolError,
  isElementNotFoundResult,
  resolveRecoveryWaitMs,
  buildToolCallKey,
  sleep,
  toContentString,
} from "./helpers.js";
import { ToolRegistry } from "../tool-registry.js";
import type { PageContextState } from "./types.js";

// ─── 冗余 page_info 拦截 ───

/** 冗余 page_info 动作（中）/ Redundant page_info actions to intercept (EN). */
const REDUNDANT_PAGE_INFO_ACTIONS = new Set(["snapshot", "query_all", "get_url", "get_title", "get_viewport"]);

/**
 * 冗余 page_info 检查（中）/ Check whether page_info call is redundant (EN).
 */
export function checkRedundantSnapshot(
  toolName: string,
  toolInput: unknown,
  _latestSnapshot: string | undefined,
  round: number,
): ToolCallResult | null {
  if (toolName !== "page_info") return null;

  const action = getToolAction(toolInput);
  if (action && REDUNDANT_PAGE_INFO_ACTIONS.has(action)) {
    return {
      content:
        `page_info.${action} is blocked in loop execution. A snapshot is provided by the framework; continue with actionable tools directly.`,
      details: {
        code: "REDUNDANT_PAGE_INFO_SKIPPED",
        action,
        round,
      },
    };
  }
  return null;
}

/**
 * 快照防抖（中）/ Debounce repeated snapshot calls (EN).
 */
export function applySnapshotDebounce(
  toolName: string,
  toolInput: unknown,
  result: ToolCallResult,
  consecutiveCount: number,
): { result: ToolCallResult; consecutiveCount: number } {
  if (toolName === "page_info" && getToolAction(toolInput) === "snapshot") {
    const newCount = consecutiveCount + 1;
    if (newCount >= 2) {
      return {
        consecutiveCount: newCount,
        result: {
          content: [
            toContentString(result.content),
            "Redundant snapshot detected. Continue with remaining actionable steps using the latest snapshot; avoid additional snapshot unless navigation or uncertainty changes.",
          ].join("\n"),
          details: {
            error: true,
            code: "REDUNDANT_SNAPSHOT",
            consecutiveSnapshotCalls: newCount,
          },
        },
      };
    }
    return { result, consecutiveCount: newCount };
  }
  // 非 snapshot 调用，重置计数
  return { result, consecutiveCount: 0 };
}

// ─── 元素未找到自动恢复 ───

/**
 * 元素未找到恢复（中）/ Recover from element-not-found failures (EN).
 *
 * 前两次自动恢复，超过上限后返回终止提示。
 * Auto-recovers for initial attempts, then returns max-recovery signal.
 */
export async function handleElementRecovery(
  toolName: string,
  toolInput: unknown,
  result: ToolCallResult,
  recoveryAttempts: Map<string, number>,
  registry: ToolRegistry,
  pageContext: PageContextState,
  callbacks?: AgentLoopCallbacks,
): Promise<ToolCallResult | null> {
  if (toolName !== "dom" || !isElementNotFoundResult(result)) {
    return null;
  }

  const key = buildToolCallKey(toolName, toolInput);
  const attempts = (recoveryAttempts.get(key) ?? 0) + 1;
  recoveryAttempts.set(key, attempts);
  const recoveryWaitMs = resolveRecoveryWaitMs(toolInput);

  if (attempts <= DEFAULT_ACTION_RECOVERY_ROUNDS) {
    await sleep(recoveryWaitMs);
    callbacks?.onBeforeRecoverySnapshot?.();
    pageContext.latestSnapshot = await readPageSnapshot(registry);

    return {
      content: [
        toContentString(result.content),
        `Recovery ${attempts}/${DEFAULT_ACTION_RECOVERY_ROUNDS}: snapshot refreshed, re-locate target.`,
      ].join("\n"),
      details: {
        error: true,
        code: "ELEMENT_NOT_FOUND_RECOVERY",
        recoveryAttempt: attempts,
        recoveryMaxRounds: DEFAULT_ACTION_RECOVERY_ROUNDS,
      },
    };
  }

  return {
    content: [
      toContentString(result.content),
      `Max recovery attempts (${DEFAULT_ACTION_RECOVERY_ROUNDS}) reached. Try a different target.`,
    ].join("\n"),
    details: {
      error: true,
      code: "ELEMENT_NOT_FOUND_MAX_RECOVERY_REACHED",
      recoveryAttempt: attempts,
      recoveryMaxRounds: DEFAULT_ACTION_RECOVERY_ROUNDS,
    },
  };
}

// ─── 导航后 URL 变化检测 ───

/** 导航后快照刷新（中）/ Refresh snapshot after navigation actions (EN). */
export async function handleNavigationUrlChange(
  toolName: string,
  toolInput: unknown,
  result: ToolCallResult,
  registry: ToolRegistry,
  pageContext: PageContextState,
  callbacks?: AgentLoopCallbacks,
): Promise<void> {
  if (toolName !== "navigate") return;

  const action = getToolAction(toolInput);
  if (
    (action === "goto" || action === "back" || action === "forward" || action === "reload") &&
    !hasToolError(result)
  ) {
    callbacks?.onBeforeRecoverySnapshot?.();
    pageContext.latestSnapshot = await readPageSnapshot(registry);
  }
}

// ─── 空转检测 ───

/** 只读工具集合（中）/ Read-only tool set (EN). */
const READ_ONLY_TOOLS = new Set(["page_info"]);

/**
 * 空转检测（中）/ Detect idle loops dominated by read-only actions (EN).
 * 返回 -1 表示应终止循环。
 * Returns -1 when loop should terminate.
 */
export function detectIdleLoop(
  toolCallNames: string[],
  consecutiveReadOnlyRounds: number,
): number {
  const allReadOnly = toolCallNames.every(name => READ_ONLY_TOOLS.has(name));
  if (allReadOnly) {
    const newCount = consecutiveReadOnlyRounds + 1;
    // 连续 2 轮纯只读 → 返回 -1 表示强制终止
    return newCount >= 2 ? -1 : newCount;
  }
  return 0; // 有实际操作，重置
}
