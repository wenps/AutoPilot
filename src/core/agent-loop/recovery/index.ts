/**
 * 保护与恢复机制。
 *
 * 这个文件负责给 Agent Loop 提供“防失败、防空转、防重复”的保护链。
 * 目标是：即使某一步失败，也尽量让循环继续推进，而不是直接崩掉。
 *
 * 主要能力：
 * 1) 冗余拦截：拦住无意义的 `page_info.*` 调用
 * 2) 找不到元素恢复：自动等待 + 刷新快照 + 重试上限
 * 3) 导航后刷新：导航成功后立刻更新快照上下文
 * 4) 空转检测：连续只读轮次触发停机信号
 * 5) 重复无效点击拦截：对已证实无效的 click 目标做框架级拦截
 * 一句话：这里是主循环的“保险丝层”。
 */
import type { ToolCallResult } from "../../tool-registry.js";
import type { AgentLoopCallbacks } from "../types.js";
import { DEFAULT_ACTION_RECOVERY_ROUNDS } from "../constants.js";
import { readPageSnapshot } from "../snapshot/index.js";
import {
  getToolAction,
  hasToolError,
  isElementNotFoundResult,
  resolveRecoveryWaitMs,
  buildToolCallKey,
  sleep,
  toContentString,
  findNearbyClickTargets,
} from "../helpers.js";
import { ToolRegistry } from "../../tool-registry.js";
import type { PageContextState } from "../types.js";

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

// ─── 重复无效点击拦截 ───

/**
 * 重复无效点击拦截。
 *
 * 场景：模型反复点击同一个 selector 但页面快照从未变化。
 * 框架在每轮结束时通过快照指纹对比发现点击无效后，将 selector 加入
 * `ineffectiveClickSelectors` 集合。下一轮模型再次点击相同 selector 时，
 * 直接拦截并返回错误提示，引导模型换目标。
 *
 * 使用方式：
 * - 在工具执行前调用此函数
 * - 仅对 `dom.click` 动作生效
 * - 返回 null 表示放行，返回 ToolCallResult 表示拦截
 *
 * 集合的维护由 index.ts 负责：
 * - 轮次结束且快照未变：将本轮 click 的 selector 加入集合
 * - 快照变化：仅移除本轮点击的 selector，保留其他无效记录
 *
 * 增强：当拦截时，自动从快照中查找附近可点击元素并作为具体推荐注入响应，
 * 让模型有明确的替代目标而非盲猜。
 */
export function checkIneffectiveClickRepeat(
  toolName: string,
  toolInput: unknown,
  ineffectiveClickSelectors: Set<string>,
  latestSnapshot?: string,
): ToolCallResult | null {
  if (toolName !== "dom") return null;

  const action = getToolAction(toolInput);
  if (action !== "click") return null;

  const selector = toolInput && typeof toolInput === "object"
    ? (toolInput as { selector?: unknown }).selector
    : undefined;
  if (typeof selector !== "string" || !selector) return null;

  if (!ineffectiveClickSelectors.has(selector)) return null;

  // 从快照中查找附近的可点击替代目标
  const nearby = latestSnapshot
    ? findNearbyClickTargets(latestSnapshot, selector, ineffectiveClickSelectors)
    : [];

  const lines = [
    `Click on ${selector} was BLOCKED — this target was already clicked in a previous round with NO visible effect on the page.`,
    "You MUST try a DIFFERENT element.",
  ];

  if (nearby.length > 0) {
    lines.push("", "Nearby clickable alternatives (try these first, sorted by proximity):");
    for (const item of nearby) {
      lines.push(`  → ${item}`);
    }
    lines.push("");
  }

  lines.push(
    "Other suggestions:",
    "1) Look INSIDE the clicked container for an <a>, <button>, or child with clk/pdn/mdn listener",
    "2) Try a parent or sibling element with stronger click signal",
    "3) Use evaluate to inspect or trigger navigation programmatically",
    "4) Try a completely different approach (search, sidebar, direct URL navigation)",
  );

  return {
    content: lines.join("\n"),
    details: {
      error: true,
      code: "INEFFECTIVE_CLICK_BLOCKED",
      selector,
    },
  };
}
