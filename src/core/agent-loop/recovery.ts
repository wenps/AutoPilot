/**
 * 保护与恢复机制。
 *
 * 这个文件负责给 Agent Loop 提供“防失败、防空转、防重复”的保护链。
 * 目标是：即使某一步失败，也尽量让循环继续推进，而不是直接崩掉。
 *
 * 主要能力：
 * 1) 冗余拦截：拦住无意义的 `page_info.*` 调用
 * 2) 快照防抖：连续 snapshot 触发时给出警告并限制空转
 * 3) 找不到元素恢复：自动等待 + 刷新快照 + 重试上限
 * 4) 导航后刷新：导航成功后立刻更新快照上下文
 * 5) 空转检测：连续只读轮次触发停机信号
 *
 * 一句话：这里是主循环的“保险丝层”。
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

/** 冗余 page_info 动作集合。 */
const REDUNDANT_PAGE_INFO_ACTIONS = new Set(["snapshot", "query_all", "get_url", "get_title", "get_viewport"]);

/**
 * 冗余 page_info 检查。
 *
 * 场景：模型在 loop 中频繁请求 page_info，导致“只看不做”。
 * 处理：命中白名单动作时直接返回拦截结果，不真正执行工具。
 *
 * 示例：
 * - 输入：`page_info.snapshot`
 * - 输出：`REDUNDANT_PAGE_INFO_SKIPPED`
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
 * 快照防抖。
 *
 * 规则：连续触发 `page_info.snapshot` 时，第 2 次起标记为冗余，
 * 返回 `REDUNDANT_SNAPSHOT`，提醒模型直接使用已有快照继续执行。
 *
 * 返回值：
 * - `result`：可能被替换成防抖后的结果
 * - `consecutiveCount`：更新后的连续 snapshot 计数
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
 * 元素未找到恢复。
 *
 * 触发条件：
 * - 工具是 `dom`
 * - 结果被识别为“元素未找到”
 *
 * 处理流程：
 * 1) 按调用键统计恢复次数（同 name + input 视为同一调用）
 * 2) 在上限内：等待 -> 刷新快照 -> 返回 `ELEMENT_NOT_FOUND_RECOVERY`
 * 3) 超过上限：返回 `ELEMENT_NOT_FOUND_MAX_RECOVERY_REACHED`
 *
 * 说明：函数只返回“恢复后的结果描述”，是否继续下一轮由主循环决定。
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

/**
 * 导航后快照刷新。
 *
 * 当 `navigate.goto/back/forward/reload` 成功后，立即刷新快照，
 * 防止后续动作还在旧页面上下文里决策。
 */
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

/** 只读工具集合。 */
const READ_ONLY_TOOLS = new Set(["page_info"]);

/** DOM 只读动作集合。 */
const READ_ONLY_DOM_ACTIONS = new Set(["get_text", "get_attr"]);

/**
 * 空转检测：识别连续只读轮次并终止。
 *
 * 判定口径：
 * - `page_info.*` 视为只读
 * - `dom.get_text/get_attr` 视为只读
 *
 * 返回值语义：
 * - `-1`：触发停机（连续 2 轮纯只读）
 * - `0`：本轮有实质操作，计数清零
 * - `>0`：当前连续只读轮次
 */
export function detectIdleLoop(
  toolCalls: Array<{ name: string; input: unknown }>,
  consecutiveReadOnlyRounds: number,
): number {
  const allReadOnly = toolCalls.length > 0 && toolCalls.every(({ name, input }) => {
    if (READ_ONLY_TOOLS.has(name)) return true;
    if (name !== "dom") return false;
    const action = getToolAction(input);
    return Boolean(action && READ_ONLY_DOM_ACTIONS.has(action));
  });
  if (allReadOnly) {
    const newCount = consecutiveReadOnlyRounds + 1;
    // 连续 2 轮纯只读 → 返回 -1 表示强制终止
    return newCount >= 2 ? -1 : newCount;
  }
  return 0; // 有实际操作，重置
}
