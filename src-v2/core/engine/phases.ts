/**
 * Engine Phase 函数 — executeAgentLoop 主循环的 5 个阶段。
 *
 * 每个 phase 接收 EngineContext + 轮次相关参数，返回 LoopSignal：
 * - { action: "continue" } — 跳过本轮剩余，进入下一轮
 * - { action: "break" }    — 终止循环
 * - { action: "proceed" }  — 继续执行下一个 phase
 */
import {
  DEFAULT_NOT_FOUND_RETRY_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_WAIT_MS,
} from "../shared/constants.js";
import {
  buildTaskArray,
  collectMissingTask,
  deriveNextInstruction,
  extractHashSelectorRef,
  getToolAction,
  normalizeModelOutput,
  stripThinking,
  parseSnapshotExpandHints,
  reduceRemainingHeuristically,
  shouldForceRoundBreak,
  isPotentialDomMutation,
  isConfirmedProgressAction,
  computeSnapshotFingerprint,
  computeSnapshotDiff,
  findNearbyClickTargets,
  updateTaskCompletion,
  formatTaskChecklist,
  deriveRemainingFromTasks,
  sleep,
  toContentString,
  hasToolError,
} from "../shared/helpers.js";
import { stripSnapshotFromPrompt } from "../shared/snapshot/index.js";
import { buildCompactMessages, formatToolInputBrief } from "./messages.js";
import {
  checkIneffectiveClickRepeat,
  handleElementRecovery,
  handleNavigationUrlChange,
  detectIdleLoop,
} from "../shared/recovery/index.js";
import { evaluateAssertions } from "../assertion/index.js";
import type { AIChatResponse, AIToolCall } from "../shared/types.js";
import type { EngineContext, MissingToolTask } from "./engine-context.js";

export type LoopSignal =
  | { action: "continue" }
  | { action: "break" }
  | { action: "proceed" };

export type RoundToolResult = {
  roundHasError: boolean;
  roundHasPotentialDomMutation: boolean;
  roundHasConfirmedProgress: boolean;
  executedTaskCalls: Array<{ name: string; input: unknown }>;
  roundClickSelectors: string[];
  roundMissingTasks: MissingToolTask[];
};

export type ParsedState = ReturnType<typeof deriveNextInstruction>;

// ═══ 辅助：准备消息 + 调用 AI ═══

export async function prepareAndCallAI(
  ctx: EngineContext,
  round: number,
): Promise<{
  response: AIChatResponse;
  parsedState: ParsedState;
  snapshotHintRefs: string[];
}> {
  const snapshotDiff = round > 0
    ? computeSnapshotDiff(
        ctx.previousRoundSnapshot,
        ctx.pageContext.latestSnapshot || "",
        ctx.focusedMode ? 80 : 60,   // 微任务允许更多行
        ctx.focusedMode ? 4 : 2,     // 微任务展示更多兄弟
      )
    : "";
  ctx.previousRoundSnapshot = ctx.pageContext.latestSnapshot || "";

  const effectivePrompt = stripSnapshotFromPrompt(ctx.systemPrompt);

  // 构建聚焦模式上下文（仅当聚焦快照 + 目标 ref 有效时传入）
  const focusedModeContext = ctx.focusedMode && ctx.focusedSnapshot && ctx.focusTargetRef
    ? {
      focusedSnapshot: ctx.focusedSnapshot,
      focusTargetRef: ctx.focusTargetRef,
      baseDiff: ctx.baseDiff,
    }
    : undefined;

  const chatMessages = buildCompactMessages(
    ctx.message,
    ctx.fullToolTrace,
    ctx.pageContext.latestSnapshot,
    ctx.pageContext.currentUrl,
    ctx.history,
    ctx.remainingInstruction,
    ctx.previousRoundTasks,
    ctx.previousRoundModelOutput,
    ctx.previousRoundPlannedTasks,
    ctx.protocolViolationHint,
    snapshotDiff,
    ctx.taskItems ? formatTaskChecklist(ctx.taskItems) : undefined,
    ctx.lastAssertionResult,
    focusedModeContext,
  );

  if (ctx.pendingNotFoundRetry && ctx.pendingNotFoundRetry.tasks.length > 0) {
    chatMessages.push({
      role: "user",
      content: [
        "## Not-found retry context",
        `Retry attempt: ${ctx.pendingNotFoundRetry.attempt}/${DEFAULT_NOT_FOUND_RETRY_ROUNDS}`,
        "These tool targets were not found in previous execution:",
        ...ctx.pendingNotFoundRetry.tasks.map((task, i) =>
          `${i + 1}. ${task.name}(${JSON.stringify(task.input)}) -> ${task.reason}`,
        ),
        "Only retry unresolved targets that are now visible in the latest snapshot.",
        "If still not found, return no tool calls and include REMAINING with the unresolved part.",
      ].join("\n"),
    });
  }

  const response = await ctx.client.chat({
    systemPrompt: effectivePrompt,
    messages: chatMessages,
    tools: ctx.tools,
  });

  ctx.callbacks?.onAIResponse?.(response);
  ctx.inputTokens += response.usage?.inputTokens ?? 0;
  ctx.outputTokens += response.usage?.outputTokens ?? 0;

  const parsedState = deriveNextInstruction(response.text, ctx.remainingInstruction);
  const snapshotHintRefs = parseSnapshotExpandHints(response.text);
  for (const ref of snapshotHintRefs.slice(0, 8)) {
    ctx.snapshotExpandRefIds.add(ref);
  }

  // 解析 FOCUS_TARGET 协议（聚焦模式下 AI 指定聚焦目标）
  if (ctx.focusedMode && response.text) {
    const focusMatch = response.text.match(/FOCUS_TARGET\s*:\s*#?([A-Za-z0-9_-]+)/i);
    if (focusMatch) {
      ctx.focusTargetRef = focusMatch[1];
    }
  }

  return { response, parsedState, snapshotHintRefs };
}

// ═══ Phase A: 无工具调用响应处理 ═══

export async function handleNoToolCallResponse(
  ctx: EngineContext,
  response: AIChatResponse,
  parsedState: ParsedState,
  round: number,
): Promise<LoopSignal> {
  ctx.consecutiveNoProtocolRounds = 0;

  if (ctx.pendingNotFoundRetry) {
    const unresolvedHint = response.text?.toLowerCase() ?? "";
    const stillUnresolved =
      unresolvedHint.includes("找不到") ||
      unresolvedHint.includes("未找到") ||
      unresolvedHint.includes("not found") ||
      unresolvedHint.includes("cannot find") ||
      unresolvedHint.includes("unable to locate");

    if (stillUnresolved && ctx.pendingNotFoundRetry.attempt < DEFAULT_NOT_FOUND_RETRY_ROUNDS) {
      ctx.pendingNotFoundRetry = {
        ...ctx.pendingNotFoundRetry,
        attempt: ctx.pendingNotFoundRetry.attempt + 1,
      };
      ctx.callbacks?.onText?.(
        `未命中目标，准备第 ${ctx.pendingNotFoundRetry.attempt} 次重试（等待 ${DEFAULT_NOT_FOUND_RETRY_WAIT_MS}ms）...`,
      );
      await sleep(DEFAULT_NOT_FOUND_RETRY_WAIT_MS);
      await ctx.refreshSnapshot();
      return { action: "continue" };
    }
    ctx.pendingNotFoundRetry = undefined;
  }

  if (
    parsedState.hasRemainingProtocol &&
    parsedState.nextInstruction.trim().length === 0
  ) {
    ctx.remainingInstruction = "";
  }

  const unresolvedRemaining = ctx.remainingInstruction.trim().length > 0;
  if (unresolvedRemaining && round < ctx.maxRounds - 1) {
    ctx.protocolViolationHint = [
      "Protocol violation in previous round:",
      "- Remaining task is not DONE, but no tool calls were returned.",
      "This round MUST do one of:",
      "1) Return actionable tool calls for visible targets; or",
      "2) If truly complete, return a short summary and EXACTLY `REMAINING: DONE`.",
      "Do NOT output planning/explaining text.",
    ].join("\n");
    ctx.lastRoundHadError = true;
    await ctx.refreshSnapshot();
    return { action: "continue" };
  }

  ctx.finalReply = stripThinking(response.text);
  if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
  ctx.stopReason = ctx.remainingInstruction.trim().length > 0 ? "protocol_fix_failed" : "converged";
  return { action: "break" };
}

// ═══ 辅助：重复批次检测 ═══

export function checkRepeatedBatch(
  ctx: EngineContext,
  response: AIChatResponse,
): LoopSignal | undefined {
  ctx.protocolViolationHint = undefined;
  const plannedTasksCurrentRound = buildTaskArray(
    response.toolCalls!.map(tc => ({ name: tc.name, input: tc.input })),
  );

  const plannedBatchKey = JSON.stringify(
    response.toolCalls!.map(tc => ({ name: tc.name, input: tc.input })),
  );
  if (plannedBatchKey === ctx.lastPlannedBatchKey) {
    ctx.consecutiveSamePlannedBatch += 1;
  } else {
    ctx.consecutiveSamePlannedBatch = 1;
    ctx.lastPlannedBatchKey = plannedBatchKey;
  }

  // Store for later use in updateRemainingState
  ctx.previousRoundPlannedTasks = plannedTasksCurrentRound;

  if (ctx.consecutiveSamePlannedBatch >= 3 && !ctx.lastRoundHadError) {
    ctx.finalReply = stripThinking(response.text) || "任务已完成。";
    if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
    ctx.stopReason = "repeated_batch";
    return { action: "break" };
  }
  if (ctx.consecutiveSamePlannedBatch >= 2 && !ctx.lastRoundHadError) {
    ctx.protocolViolationHint = [
      "Repeated action warning:",
      "- You performed the EXACT same tool call(s) as the previous round, but NO visible change occurred in the snapshot.",
      "The clicked element did not trigger navigation or DOM change. This round you MUST do ONE of:",
      "1) Look INSIDE the clicked container for an <a> link, <button>, or child element with clk/pdn/mdn listener, and click THAT instead;",
      "2) Try a parent or sibling element with stronger click signal (clk/pdn/mdn listener);",
      "3) Try a completely different approach (e.g., search, filter, or navigate via sidebar);",
      "4) If the task is truly complete, return REMAINING: DONE with no tool calls.",
      "Do NOT repeat the same action again.",
    ].join("\n");
  }

  return undefined;
}

// ═══ 辅助：dry-run 处理 ═══

export function handleDryRun(ctx: EngineContext, response: AIChatResponse): void {
  ctx.finalReply = stripThinking(response.text) ? stripThinking(response.text) + "\n\n" : "";
  ctx.finalReply += "🔧 AI 请求调用以下工具（dry-run 模式，未执行）：\n";
  for (const tc of response.toolCalls!) {
    ctx.callbacks?.onToolCall?.(tc.name, tc.input);
    ctx.finalReply += `\n┌─ 工具: ${tc.name}\n`;
    ctx.finalReply += `│  ID:   ${tc.id}\n`;
    ctx.finalReply += `│  参数:\n`;
    const inputStr = JSON.stringify(tc.input, null, 2);
    for (const line of inputStr.split("\n")) {
      ctx.finalReply += `│    ${line}\n`;
    }
    ctx.finalReply += `└────────────────────\n`;
  }
  ctx.stopReason = "dry_run";
}

// ═══ 辅助：分离工具调用 ═══

export function splitToolCalls(toolCalls: AIToolCall[]): {
  regularToolCalls: AIToolCall[];
  assertToolCall: AIToolCall | undefined;
} {
  return {
    regularToolCalls: toolCalls.filter(tc => tc.name !== "assert"),
    assertToolCall: toolCalls.find(tc => tc.name === "assert"),
  };
}

// ═══ Phase B: 执行工具 ═══

export async function executeRoundTools(
  ctx: EngineContext,
  regularToolCalls: AIToolCall[],
  round: number,
): Promise<RoundToolResult> {
  let roundHasError = false;
  let roundHasPotentialDomMutation = false;
  let roundHasConfirmedProgress = false;
  const executedTaskCalls: Array<{ name: string; input: unknown }> = [];
  const roundMissingTasks: MissingToolTask[] = [];
  const roundClickSelectors: string[] = [];

  for (const tc of regularToolCalls) {
    // scroll 自动放宽
    if (tc.name === "dom" && getToolAction(tc.input) === "scroll") {
      const ref = extractHashSelectorRef(tc.input);
      if (ref) ctx.snapshotExpandRefIds.add(ref);
    }

    // 保护 1：重复无效点击拦截
    const ineffective = checkIneffectiveClickRepeat(
      tc.name, tc.input, ctx.ineffectiveClickSelectors, ctx.pageContext.latestSnapshot,
    );
    if (ineffective) {
      ctx.appendToolTrace(round, tc.name, tc.input, ineffective);
      ctx.redundantInterceptCount += 1;
      ctx.callbacks?.onToolCall?.(tc.name, tc.input);
      ctx.callbacks?.onToolResult?.(tc.name, ineffective);
      roundHasError = true;
      continue;
    }

    ctx.callbacks?.onToolCall?.(tc.name, tc.input);

    // 执行工具
    let result = await ctx.registry.dispatch(tc.name, tc.input);

    // 保护 2：元素未找到自动恢复
    const recovered = await handleElementRecovery(
      tc.name, tc.input, result,
      ctx.actionRecoveryAttempts, ctx.registry, ctx.pageContext, ctx.callbacks,
    );
    if (recovered) result = recovered;
    if (
      recovered?.details &&
      typeof recovered.details === "object" &&
      (recovered.details as { code?: unknown }).code === "ELEMENT_NOT_FOUND_RECOVERY"
    ) {
      ctx.recoveryCount += 1;
    }

    ctx.appendToolTrace(round, tc.name, tc.input, result);
    executedTaskCalls.push({ name: tc.name, input: tc.input });

    // 记录 click selector
    if (
      tc.name === "dom" &&
      getToolAction(tc.input) === "click" &&
      !hasToolError(result)
    ) {
      const sel = tc.input && typeof tc.input === "object"
        ? (tc.input as { selector?: unknown }).selector
        : undefined;
      if (typeof sel === "string" && sel) {
        roundClickSelectors.push(sel);
      }
    }

    const missingTask = collectMissingTask(tc.name, tc.input, result);
    if (missingTask) {
      roundMissingTasks.push(missingTask);
    }

    if (result.details && typeof result.details === "object") {
      roundHasError = roundHasError || Boolean((result.details as { error?: unknown }).error);
    }
    if (!hasToolError(result) && isPotentialDomMutation(tc.name, tc.input)) {
      roundHasPotentialDomMutation = true;
    }
    if (!hasToolError(result) && isConfirmedProgressAction(tc.name, tc.input)) {
      roundHasConfirmedProgress = true;
    }

    // 捕获显式 snapshot 结果
    if (tc.name === "page_info" && getToolAction(tc.input) === "snapshot") {
      ctx.pageContext.latestSnapshot = toContentString(result.content);
      ctx.recordSnapshotStats(ctx.pageContext.latestSnapshot);
    }

    // 保护 4：导航后 URL 变化检测
    await handleNavigationUrlChange(
      tc.name, tc.input, result, ctx.registry, ctx.pageContext, ctx.callbacks,
    );

    ctx.callbacks?.onToolResult?.(tc.name, result);

    if (shouldForceRoundBreak(tc.name, tc.input)) {
      break;
    }
  }

  return {
    roundHasError,
    roundHasPotentialDomMutation,
    roundHasConfirmedProgress,
    executedTaskCalls,
    roundClickSelectors,
    roundMissingTasks,
  };
}

// ═══ Phase C: 断言处理 ═══

export async function handleAssertionTool(
  ctx: EngineContext,
  assertToolCall: AIToolCall,
  roundResult: RoundToolResult,
  round: number,
  response: AIChatResponse,
): Promise<LoopSignal> {
  // 动作后快照（断言专用：无 hash ID、无 listeners）
  await ctx.refreshAssertionSnapshot();
  const postActionSnapshot = ctx.assertionSnapshot || "";

  if (roundResult.roundHasPotentialDomMutation) {
    await ctx.runRoundStabilityBarrier();
  }
  await ctx.callbacks?.onBeforeAssertionSnapshot?.();
  // 断言最终快照：无 hash ID、无 listeners
  await ctx.refreshAssertionSnapshot();
  // 同时刷新执行快照（供后续轮次使用）
  if (ctx.focusedMode && ctx.focusTargetRef) {
    await ctx.refreshFocusedSnapshot();
  } else {
    await ctx.refreshSnapshot();
  }

  const taskAssertions = (ctx.assertionConfig && ctx.assertionConfig.taskAssertions.length > 0)
    ? ctx.assertionConfig.taskAssertions
    : [{ task: "Complete user task", description: ctx.message }];

  const actionSummaries = ctx.fullToolTrace.map(
    entry => `${entry.name}${formatToolInputBrief(entry.input)}`,
  );

  ctx.callbacks?.onToolCall?.("assert", assertToolCall.input);

  // 断言使用无 hash/无 listeners 的纯结构快照
  const assertionCurrentSnapshot = ctx.assertionSnapshot || "";
  const assertionInitialSnapshot = ctx.initialSnapshot;

  const assertionResult = await evaluateAssertions(
    ctx.client,
    assertionCurrentSnapshot,
    actionSummaries,
    taskAssertions,
    assertionInitialSnapshot,
    postActionSnapshot,
  );
  ctx.lastAssertionResult = assertionResult;

  const assertResult = {
    content: assertionResult.allPassed
      ? `All ${assertionResult.total} assertions PASSED.`
      : `Assertions: ${assertionResult.passed}/${assertionResult.total} passed. Failed: ${assertionResult.details.filter(d => !d.passed).map(d => `"${d.task}": ${d.reason}`).join("; ")}`,
    details: { assertionResult },
  };
  ctx.appendToolTrace(round, "assert", assertToolCall.input, assertResult);
  roundResult.executedTaskCalls.push({ name: "assert", input: assertToolCall.input });
  ctx.callbacks?.onToolResult?.("assert", assertResult);

  if (assertionResult.allPassed) {
    ctx.finalReply = stripThinking(response.text) || "任务已完成（断言验证全部通过）。";
    if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
    ctx.stopReason = "assertion_passed";
    return { action: "break" };
  }

  const { regularToolCalls } = splitToolCalls(response.toolCalls || []);
  if (regularToolCalls.length === 0) {
    ctx.consecutiveAssertOnlyFailedRounds++;
    if (ctx.consecutiveAssertOnlyFailedRounds >= 3) {
      ctx.finalReply = stripThinking(response.text) || "断言连续失败，停止执行。";
      if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
      ctx.stopReason = "assertion_loop";
      return { action: "break" };
    }
    // 断言失败且本轮无实质工具调用：注入强提示，要求模型先做工作再 assert
    const assertFixHint = [
      "Assertion FAILED — do NOT call assert() again immediately.",
      "Read the failure reason above carefully. You MUST take action FIRST:",
      "1) Identify what is missing or incorrect from the assertion feedback;",
      "2) Use tool calls (dom, navigate, evaluate, etc.) to fix the issues;",
      "3) Only call assert() AFTER you have made visible changes to address the failure.",
      "Calling assert() without fixing the issues will cause the task to be terminated.",
    ].join("\n");
    ctx.protocolViolationHint = ctx.protocolViolationHint
      ? ctx.protocolViolationHint + "\n\n" + assertFixHint
      : assertFixHint;
  } else {
    ctx.consecutiveAssertOnlyFailedRounds = 0;
  }

  return { action: "proceed" };
}

// ═══ Phase D: 状态推进 ═══

export function updateRemainingState(
  ctx: EngineContext,
  parsedState: ParsedState,
  roundResult: RoundToolResult,
  response: AIChatResponse,
): LoopSignal {
  // pendingNotFoundRetry
  if (roundResult.roundMissingTasks.length > 0) {
    ctx.pendingNotFoundRetry = {
      attempt: 1,
      tasks: roundResult.roundMissingTasks,
    };
  } else {
    ctx.pendingNotFoundRetry = undefined;
  }

  // REMAINING 推进
  if (parsedState.hasRemainingProtocol) {
    ctx.remainingInstruction = parsedState.nextInstruction;
    ctx.consecutiveNoProtocolRounds = 0;
  } else {
    const nextByHeuristic = reduceRemainingHeuristically(ctx.remainingInstruction, roundResult.executedTaskCalls.length);
    if (nextByHeuristic !== ctx.remainingInstruction) {
      ctx.remainingInstruction = nextByHeuristic;
      ctx.consecutiveNoProtocolRounds = 0;
    } else if (roundResult.executedTaskCalls.length > 0) {
      if (!roundResult.roundHasConfirmedProgress || roundResult.roundHasError) {
        ctx.consecutiveNoProtocolRounds += 1;
      } else {
        ctx.consecutiveNoProtocolRounds = 0;
      }
    }
  }

  // checklist 同步
  if (ctx.taskItems) {
    ctx.taskItems = updateTaskCompletion(ctx.taskItems, ctx.remainingInstruction);
    if (!parsedState.hasRemainingProtocol) {
      const derived = deriveRemainingFromTasks(ctx.taskItems);
      if (derived) ctx.remainingInstruction = derived;
    }
  }

  ctx.previousRoundModelOutput = parsedState.hasRemainingProtocol
    ? normalizeModelOutput(response.text)
    : `REMAINING: ${ctx.remainingInstruction || "DONE"}`;

  ctx.lastRoundHadError = roundResult.roundHasError;
  if (roundResult.executedTaskCalls.length === 0 && response.toolCalls && response.toolCalls.length > 0) {
    ctx.lastRoundHadError = true;
  }
  ctx.previousRoundTasks = buildTaskArray(roundResult.executedTaskCalls);
  // previousRoundPlannedTasks already set in checkRepeatedBatch

  // DONE 收敛
  if (
    parsedState.hasRemainingProtocol &&
    ctx.remainingInstruction.trim().length === 0 &&
    !roundResult.roundHasError
  ) {
    ctx.finalReply = stripThinking(response.text) || "任务已完成。";
    if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
    ctx.stopReason = "converged";
    return { action: "break" };
  }

  return { action: "proceed" };
}

// ═══ Phase E: 轮后防护 ═══

export async function runPostRoundGuards(
  ctx: EngineContext,
  response: AIChatResponse,
  roundResult: RoundToolResult,
  round: number,
  roundStartFingerprint: string,
): Promise<LoopSignal> {
  // 保护 6：空转检测
  const idleResult = detectIdleLoop(roundResult.executedTaskCalls, ctx.consecutiveReadOnlyRounds);
  if (idleResult === -1) {
    ctx.finalReply = stripThinking(response.text) || "任务已完成。";
    if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
    ctx.stopReason = "idle_loop";
    return { action: "break" };
  }
  ctx.consecutiveReadOnlyRounds = idleResult;

  // 保护 8：滞止检测
  if (ctx.taskItems && ctx.remainingInstruction === ctx.previousRoundRemaining && !roundResult.roundHasConfirmedProgress) {
    ctx.consecutiveNoProgressRounds++;
  } else if (ctx.remainingInstruction !== ctx.previousRoundRemaining || roundResult.roundHasConfirmedProgress) {
    ctx.consecutiveNoProgressRounds = 0;
  }
  ctx.previousRoundRemaining = ctx.remainingInstruction;

  if (ctx.consecutiveNoProgressRounds >= 3) {
    ctx.finalReply = stripThinking(response.text) || "任务已完成。";
    if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
    ctx.stopReason = "stale_remaining";
    return { action: "break" };
  }
  if (ctx.consecutiveNoProgressRounds >= 2) {
    const staleHint = [
      "CRITICAL — No progress detected:",
      `- Remaining has NOT advanced for ${ctx.consecutiveNoProgressRounds} consecutive rounds with no confirmed progress.`,
      "- The snapshot may ALREADY show your task is complete.",
      "CHECK the snapshot NOW: if the expected outcome is visible (color changed, switch toggled, value present, dialog closed, form submitted, etc.), output REMAINING: DONE immediately with NO tool calls.",
      "Do NOT call page_info, do NOT retry failed actions, do NOT click verify/confirm buttons if the result is already visible.",
    ].join("\n");
    ctx.protocolViolationHint = ctx.protocolViolationHint
      ? ctx.protocolViolationHint + "\n\n" + staleHint
      : staleHint;
  }

  // 稳定等待
  if (roundResult.roundHasPotentialDomMutation) {
    await ctx.runRoundStabilityBarrier();
  }

  // 刷新快照（聚焦模式下同时刷新聚焦快照 + 内部全量）
  if (ctx.focusedMode && ctx.focusTargetRef) {
    await ctx.refreshFocusedSnapshot();
  } else {
    await ctx.refreshSnapshot();
  }

  // 快照指纹对比
  if (roundResult.roundHasPotentialDomMutation) {
    const roundEndFingerprint = computeSnapshotFingerprint(ctx.pageContext.latestSnapshot || "");
    if (roundEndFingerprint === roundStartFingerprint && roundStartFingerprint !== "") {
      const nearbyHintLines: string[] = [];
      for (const sel of roundResult.roundClickSelectors) {
        const nearby = findNearbyClickTargets(
          ctx.pageContext.latestSnapshot || "", sel, ctx.ineffectiveClickSelectors,
        );
        if (nearby.length > 0) {
          nearbyHintLines.push(`Nearby clickable alternatives for ${sel}:`);
          for (const item of nearby) nearbyHintLines.push(`  → ${item}`);
        }
      }

      const unchangedHint = [
        "Snapshot unchanged after action:",
        "- The page snapshot is IDENTICAL before and after your action(s) this round.",
        "- Your click/action had NO visible effect on the page. Do NOT repeat it.",
        ...(nearbyHintLines.length > 0
          ? ["", "Try these nearby elements instead (sorted by proximity):", ...nearbyHintLines, ""]
          : []),
        "- If no suggestion above fits, look INSIDE the target for <a>/<button>/child with clk listener, or try a parent/sibling with stronger signal, or use a completely different approach.",
      ].join("\n");
      ctx.protocolViolationHint = ctx.protocolViolationHint
        ? ctx.protocolViolationHint + "\n\n" + unchangedHint
        : unchangedHint;

      // 保护 7：无效 click selector 加入拦截集合
      for (const sel of roundResult.roundClickSelectors) {
        ctx.ineffectiveClickSelectors.add(sel);
      }
    } else if (roundEndFingerprint !== roundStartFingerprint) {
      ctx.consecutiveNoProtocolRounds = 0;
      // 页面确实发生变化：click 导致的 DOM 变更属于真实推进，
      // 即使 remaining 文本未变（如打开下拉框、弹窗等中间步骤），也不应判定为滞止。
      ctx.consecutiveNoProgressRounds = 0;
      for (const sel of roundResult.roundClickSelectors) {
        ctx.ineffectiveClickSelectors.delete(sel);
      }
    }
  }

  // 保护 8：交替循环检测
  if (roundResult.roundClickSelectors.length > 0) {
    ctx.recentRoundClickTargets.push([...roundResult.roundClickSelectors]);
    while (ctx.recentRoundClickTargets.length > 6) ctx.recentRoundClickTargets.shift();
  }
  if (ctx.recentRoundClickTargets.length >= 4) {
    const recentWindow = ctx.recentRoundClickTargets.slice(-4);
    const allTargets = recentWindow.flat();
    const uniqueTargets = new Set(allTargets);
    if (uniqueTargets.size <= 2 && allTargets.length >= 4) {
      const cycleNearbyLines: string[] = [];
      for (const sel of uniqueTargets) {
        const nearby = findNearbyClickTargets(
          ctx.pageContext.latestSnapshot || "", sel, new Set([...ctx.ineffectiveClickSelectors, ...uniqueTargets]),
        );
        if (nearby.length > 0) {
          cycleNearbyLines.push(`Alternatives near ${sel}:`);
          for (const item of nearby) cycleNearbyLines.push(`  → ${item}`);
        }
      }

      const cycleHint = [
        "Click target cycling detected:",
        `- You have been alternating between the same ${uniqueTargets.size} target(s) for ${recentWindow.length}+ rounds: ${[...uniqueTargets].join(", ")}`,
        "- NONE of these clicks achieved navigation or meaningful page change.",
        ...(cycleNearbyLines.length > 0
          ? ["", "Try these nearby clickable alternatives instead:", ...cycleNearbyLines, ""]
          : []),
        "You MUST abandon ALL these targets. If no suggestion above fits, try:",
        "  1) Look INSIDE the clicked container for <a>, <button>, or child with clk/pdn/mdn listener",
        "  2) Navigate via URL: use navigate.goto to go to the target page directly",
        "  3) Use evaluate to inspect the page and find the real navigation link",
        "  4) Use a search/filter/sidebar navigation approach instead",
      ].join("\n");
      ctx.protocolViolationHint = ctx.protocolViolationHint
        ? ctx.protocolViolationHint + "\n\n" + cycleHint
        : cycleHint;
      for (const sel of uniqueTargets) {
        ctx.ineffectiveClickSelectors.add(sel);
      }
      ctx.recentRoundClickTargets.length = 0;
    }
  }

  // 保护 5：防协议缺失空转
  if (ctx.consecutiveNoProtocolRounds >= 5) {
    ctx.finalReply = stripThinking(response.text) || "任务已完成。";
    if (ctx.finalReply) ctx.callbacks?.onText?.(ctx.finalReply);
    ctx.stopReason = "no_protocol";
    return { action: "break" };
  }
  if (ctx.consecutiveNoProtocolRounds >= 3) {
    const noProtocolHint = [
      "Protocol reminder: REMAINING protocol missing for 3+ rounds with tool calls.",
      "You MUST include REMAINING: <text> or REMAINING: DONE in every response.",
      "If the task is fully complete, return REMAINING: DONE with no tool calls.",
    ].join("\n");
    ctx.protocolViolationHint = ctx.protocolViolationHint
      ? ctx.protocolViolationHint + "\n\n" + noProtocolHint
      : noProtocolHint;
  }

  return { action: "proceed" };
}
