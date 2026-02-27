/**
 * Agent Loop 主流程（中）/ Core environment-agnostic agent loop (EN).
 *
 * 负责消息构建、AI 决策、工具执行、恢复保护与指标汇总。
 * Orchestrates message build, AI decisions, tool execution, recovery, and metrics.
 *
 * 流程图（文本）：
 *
 *   轮次开始
 *      │
 *      ├─ 确保快照可用
 *      ├─ 构建紧凑消息（目标 + 剩余任务 + 执行轨迹 + 快照）
 *      ├─ 调用模型
 *      ├─ 无 toolCalls ? 结束 : 执行工具
 *      ├─ 应用保护机制（冗余拦截/恢复/导航检测/空转/防自转）
 *      ├─ 刷新快照
 *      ▼
 *   下一轮或停机
 */
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_WAIT_MS,
} from "./constants.js";
import {
  getToolAction,
  isElementNotFoundResult,
  sleep,
  toContentString,
} from "./helpers.js";
import { readPageSnapshot, stripSnapshotFromPrompt } from "./snapshot.js";
import { buildCompactMessages } from "./messages.js";
import {
  checkRedundantSnapshot,
  applySnapshotDebounce,
  handleElementRecovery,
  handleNavigationUrlChange,
  detectIdleLoop,
} from "./recovery.js";
import type {
  AgentLoopParams,
  AgentLoopResult,
  AgentLoopMetrics,
  PageContextState,
  ToolTraceEntry,
} from "./types.js";
import type { AIMessage } from "../types.js";

/**
 * 执行 Agent 循环（中）/ Execute the agent loop (EN).
 *
 * 每轮：确保快照 → 构建消息 → 调用 AI → 执行工具 → 保护处理 → 刷新快照。
 * Per round: ensure snapshot -> build messages -> call AI -> execute tools -> apply protections -> refresh snapshot.
 */
export async function executeAgentLoop(
  params: AgentLoopParams,
): Promise<AgentLoopResult> {
  const {
    client,
    registry,
    systemPrompt,
    message,
    initialSnapshot,
    history,
    dryRun = false,
    maxRounds = DEFAULT_MAX_ROUNDS,
    callbacks,
  } = params;

  // 固定依赖与运行态容器（中）/ Static dependencies and runtime containers (EN).
  const tools = registry.getDefinitions();
  const allToolCalls: AgentLoopResult["toolCalls"] = [];
  const fullToolTrace: ToolTraceEntry[] = [];
  const actionRecoveryAttempts = new Map<string, number>();
  const pageContext: PageContextState = {
    latestSnapshot: initialSnapshot,
  };

  // 最终输出（中）/ Final output state (EN).
  let finalReply = "";

  // 循环控制状态（中）/ Loop control state (EN).
  let consecutiveSnapshotCalls = 0;
  let consecutiveReadOnlyRounds = 0;
  let usedRounds = 0;

  // token 统计（中）/ Token accounting (EN).
  let inputTokens = 0;
  let outputTokens = 0;
  // 渐进式任务状态（中）/ Progressive task state (EN).
  // remainingInstruction: 当前轮次要继续消费的剩余文本。
  // previousRoundTasks: 上一轮已经执行过的任务数组，用于提醒 AI 不要原样重复。
  // lastPlannedBatchKey + consecutiveSamePlannedBatch: 防止 AI 连续给出相同任务批次导致自转。
  // lastRoundHadError: 如果上一轮有错误，不触发“重复批次即停机”，避免误停。
  let remainingInstruction = message.trim();
  let previousRoundTasks: string[] = [];
  let previousRoundPlannedTasks: string[] = [];
  let previousRoundModelOutput = "";
  let lastPlannedBatchKey = "";
  let consecutiveSamePlannedBatch = 0;
  let lastRoundHadError = false;
  let protocolViolationHint: string | undefined;
  // 恢复与拦截统计（中）/ Recovery/interception counters (EN).
  let recoveryCount = 0;
  let redundantInterceptCount = 0;

  type MissingToolTask = {
    name: string;
    input: unknown;
    reason: string;
  };

  let pendingNotFoundRetry:
    | {
      attempt: number;
      tasks: MissingToolTask[];
    }
    | undefined;

  // 快照体积统计（中）/ Snapshot size metrics (EN).
  let snapshotReadCount = 0;
  let snapshotSizeTotal = 0;
  let snapshotSizeMax = 0;

  /**
   * 记录快照统计（中）/ Record snapshot metrics (EN).
   *
   * 用于输出可观测指标：读取次数、平均长度、最大长度。
   * Used for observability metrics: read count, avg size, max size.
   */
  const recordSnapshotStats = (snapshot: string | undefined): void => {
    if (typeof snapshot !== "string") return;
    snapshotReadCount += 1;
    snapshotSizeTotal += snapshot.length;
    if (snapshot.length > snapshotSizeMax) snapshotSizeMax = snapshot.length;
  };

  /**
   * 刷新页面快照（中）/ Refresh page snapshot (EN).
   *
   * 只做两件事：读取最新快照 + 更新快照统计。
   * Does exactly two things: read latest snapshot + update metrics.
   */
  const refreshSnapshot = async (): Promise<void> => {
    pageContext.latestSnapshot = await readPageSnapshot(registry);
    recordSnapshotStats(pageContext.latestSnapshot);
  };

  if (pageContext.latestSnapshot) {
    recordSnapshotStats(pageContext.latestSnapshot);
  }

  /**
   * 追加工具轨迹（中）/ Append tool trace entry (EN).
   *
   * 同时写入：
   * - allToolCalls：对外返回结果
   * - fullToolTrace：下一轮消息上下文
   */
  const appendToolTrace = (
    round: number,
    name: string,
    input: unknown,
    result: AgentLoopResult["toolCalls"][number]["result"],
  ): void => {
    allToolCalls.push({ name, input, result });
    fullToolTrace.push({ round, name, input, result });
  };

  /**
   * 生成任务数组（中）/ Build normalized task array (EN).
   *
   * 将本轮 toolCalls 归一化成稳定字符串数组，便于：
   * - 回传到下一轮消息上下文（提醒已执行计划）
   * - 进行“是否与上一轮完全相同”的比较
   */
  const buildTaskArray = (toolCalls: Array<{ name: string; input: unknown }>): string[] =>
    toolCalls.map(tc => {
      const inputText = JSON.stringify(tc.input);
      return `${tc.name}:${inputText}`;
    });

  /**
   * 规范化模型文本输出（中）/ Normalize model text for next-round input (EN).
   *
   * 优先保留 REMAINING 行；否则截断首段文本，避免长篇规划污染下一轮输入。
   * Prefer REMAINING line; otherwise keep a short excerpt to avoid long planning spillover.
   */
  const normalizeModelOutput = (text: string | undefined): string => {
    if (!text) return "";
    const trimmed = text.trim();
    if (!trimmed) return "";
    const remainingMatch = trimmed.match(/REMAINING\s*:\s*([\s\S]*)$/i);
    if (remainingMatch) {
      return `REMAINING: ${remainingMatch[1].trim()}`;
    }
    const firstBlock = trimmed.split(/\n\s*\n/)[0]?.trim() ?? trimmed;
    return firstBlock.slice(0, 220);
  };

  /**
   * 判定动作是否会触发 DOM 结构变化（中）/ Whether action may cause DOM-shape change (EN).
   *
   * 触发后应强制断轮，等待下一轮新快照继续。
   * Force round break after such action and continue with refreshed snapshot next round.
   */
  const shouldForceRoundBreak = (toolName: string, toolInput: unknown): boolean => {
    const action = getToolAction(toolInput);
    if (toolName === "navigate") {
      return action === "goto" || action === "back" || action === "forward" || action === "reload";
    }
    if (toolName === "dom") {
      return action === "click" || action === "press";
    }
    if (toolName === "evaluate") {
      return true;
    }
    return false;
  };

  /**
   * 将“找不到元素”的失败任务整理成可重试清单（中）/ Build retry task list for not-found failures (EN).
   */
  const collectMissingTask = (
    name: string,
    input: unknown,
    result: AgentLoopResult["toolCalls"][number]["result"],
  ): MissingToolTask | null => {
    if (!isElementNotFoundResult(result)) return null;
    return {
      name,
      input,
      reason: toContentString(result.content).slice(0, 240),
    };
  };

  /**
   * 解析 REMAINING 协议（中）/ Parse REMAINING protocol from model text (EN).
   *
   * 支持：
   * - `REMAINING: <text>` → 继续下一轮消费该剩余文本
   * - `REMAINING: DONE`   → 剩余任务为空
   * 返回 null 表示本轮没有提供 REMAINING 标记。
   */
  const parseRemainingInstruction = (text: string | undefined): string | null => {
    if (!text) return null;
    const match = text.match(/REMAINING\s*:\s*([\s\S]*)$/i);
    if (!match) return null;
    const value = match[1].trim();
    return /^done$/i.test(value) ? "" : value;
  };

  /**
   * 推进下一轮描述（中）/ Derive next-round instruction from model text (EN).
   *
    * 优先 REMAINING 协议；若未提供，则保持当前 remaining 不变。
    * Priority: REMAINING protocol first; otherwise keep current remaining instruction unchanged.
   */
  const deriveNextInstruction = (
    text: string | undefined,
    currentInstruction: string,
  ): { nextInstruction: string; hasRemainingProtocol: boolean } => {
    const parsed = parseRemainingInstruction(text);
    if (parsed !== null) {
      return { nextInstruction: parsed, hasRemainingProtocol: true };
    }
    // 协议缺失时按规则回退：保持当前剩余任务不变。
    // Fallback when protocol is missing: keep current remaining instruction unchanged.
    return { nextInstruction: currentInstruction, hasRemainingProtocol: false };
  };

  /**
   * 启发式任务剔除（中）/ Heuristic remaining reduction for linear instructions (EN).
   *
   * 在 REMAINING 缺失但本轮有执行动作时，按“线性片段”剔除已执行步数，避免下一轮继续携带整段原任务。
   * When REMAINING is missing but actions were executed, drop executed step count from a linearized instruction.
   */
  const reduceRemainingHeuristically = (
    currentInstruction: string,
    executedCount: number,
  ): string => {
    if (!currentInstruction.trim() || executedCount <= 0) return currentInstruction;
    const normalized = currentInstruction
      .replace(/\s+/g, " ")
      .replace(/(->|=>|→)/g, " 然后 ")
      .replace(/[，,。；;]/g, " 然后 ");

    const parts = normalized
      .split(/\s*(?:然后|再|并且|并|接着|随后|之后)\s*/g)
      .map(part => part.trim())
      .filter(Boolean);

    if (parts.length <= 1) return currentInstruction;

    const nextParts = parts.slice(Math.min(executedCount, parts.length));
    if (nextParts.length === 0) return "";
    return nextParts.join(" -> ");
  };

  // 主循环（中）/ Main round loop (EN).
  for (let round = 0; round < maxRounds; round++) {
    callbacks?.onRound?.(round);
    usedRounds = round + 1;

    // ═══ 阶段 1：确保快照 ═══
    if (!pageContext.latestSnapshot) {
      await refreshSnapshot();
    }

    // ═══ 阶段 2：构建紧凑消息 ═══
    // 每轮消息都自带快照（buildCompactMessages 注入），因此始终剥离
    // system prompt 中的旧快照，避免重复。
    const effectivePrompt = stripSnapshotFromPrompt(systemPrompt);

    const chatMessages = buildCompactMessages(
      message,
      fullToolTrace,
      pageContext.latestSnapshot,
      pageContext.currentUrl,
      history,
      remainingInstruction,
      previousRoundTasks,
      previousRoundModelOutput,
      previousRoundPlannedTasks,
      protocolViolationHint,
    );

    if (pendingNotFoundRetry && pendingNotFoundRetry.tasks.length > 0) {
      chatMessages.push({
        role: "user",
        content: [
          "## Not-found retry context",
          `Retry attempt: ${pendingNotFoundRetry.attempt}/${DEFAULT_NOT_FOUND_RETRY_ROUNDS}`,
          "These tool targets were not found in previous execution:",
          ...pendingNotFoundRetry.tasks.map((task, i) =>
            `${i + 1}. ${task.name}(${JSON.stringify(task.input)}) -> ${task.reason}`,
          ),
          "Only retry unresolved targets that are now visible in the latest snapshot.",
          "If still not found, return no tool calls and include REMAINING with the unresolved part.",
        ].join("\n"),
      });
    }

    // ═══ 阶段 3：调用 AI ═══
    const response = await client.chat({
      systemPrompt: effectivePrompt,
      messages: chatMessages,
      tools,
    });

    // 计费/观测数据累计（中）/ Aggregate usage for observability (EN).
    inputTokens += response.usage?.inputTokens ?? 0;
    outputTokens += response.usage?.outputTokens ?? 0;

    // 先解析协议，最终推进在本轮执行后统一决定。
    // Parse protocol first; final remaining update is decided after execution.
    const parsedInstructionState = deriveNextInstruction(response.text, remainingInstruction);

    // 没有工具调用：若处于找不到重试流程，先等待再重试；否则正常结束
    if (!response.toolCalls || response.toolCalls.length === 0) {
      if (pendingNotFoundRetry) {
        const unresolvedHint = response.text?.toLowerCase() ?? "";
        const stillUnresolved =
          unresolvedHint.includes("找不到") ||
          unresolvedHint.includes("未找到") ||
          unresolvedHint.includes("not found") ||
          unresolvedHint.includes("cannot find") ||
          unresolvedHint.includes("unable to locate");

        if (stillUnresolved && pendingNotFoundRetry.attempt < DEFAULT_NOT_FOUND_RETRY_ROUNDS) {
          pendingNotFoundRetry = {
            ...pendingNotFoundRetry,
            attempt: pendingNotFoundRetry.attempt + 1,
          };
          callbacks?.onText?.(
            `未命中目标，准备第 ${pendingNotFoundRetry.attempt} 次重试（等待 ${DEFAULT_NOT_FOUND_RETRY_WAIT_MS}ms）...`,
          );
          await sleep(DEFAULT_NOT_FOUND_RETRY_WAIT_MS);
          await refreshSnapshot();
          continue;
        }
        pendingNotFoundRetry = undefined;
      }

      if (parsedInstructionState.hasRemainingProtocol) {
        remainingInstruction = parsedInstructionState.nextInstruction;
      }

      const unresolvedRemaining = remainingInstruction.trim().length > 0;
      if (unresolvedRemaining && round < maxRounds - 1) {
        protocolViolationHint = [
          "Protocol violation in previous round:",
          "- Remaining task is not DONE, but no tool calls were returned.",
          "This round MUST do one of:",
          "1) Return actionable tool calls for visible targets; or",
          "2) If truly complete, return a short summary and EXACTLY `REMAINING: DONE`.",
          "Do NOT output planning/explaining text.",
        ].join("\n");
        lastRoundHadError = true;
        await refreshSnapshot();
        continue;
      }

      finalReply = response.text ?? "";
      if (finalReply) callbacks?.onText?.(finalReply);
      break;
    }

    protocolViolationHint = undefined;
    const plannedTasksCurrentRound = buildTaskArray(
      response.toolCalls.map(tc => ({ name: tc.name, input: tc.input })),
    );

    const plannedBatchKey = JSON.stringify(
      response.toolCalls.map(tc => ({ name: tc.name, input: tc.input })),
    );
    // 比较“本轮计划”与“上一轮计划”是否完全一致。
    // Compare whether current planned batch is identical to the previous one.
    if (plannedBatchKey === lastPlannedBatchKey) {
      consecutiveSamePlannedBatch += 1;
    } else {
      consecutiveSamePlannedBatch = 1;
      lastPlannedBatchKey = plannedBatchKey;
    }

    // 防自转：连续两轮给出相同计划且上一轮无错误，判定任务已完成或模型卡住，直接结束。
    // Anti-spin: if same planned batch appears twice and previous round had no error, stop the request.
    if (consecutiveSamePlannedBatch >= 2 && !lastRoundHadError) {
      finalReply = response.text?.trim() || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      break;
    }

    // ─── Dry-run 模式 ───
    if (dryRun) {
      finalReply = response.text ? response.text + "\n\n" : "";
      finalReply += "🔧 AI 请求调用以下工具（dry-run 模式，未执行）：\n";
      for (const tc of response.toolCalls) {
        callbacks?.onToolCall?.(tc.name, tc.input);
        finalReply += `\n┌─ 工具: ${tc.name}\n`;
        finalReply += `│  ID:   ${tc.id}\n`;
        finalReply += `│  参数:\n`;
        const inputStr = JSON.stringify(tc.input, null, 2);
        for (const line of inputStr.split("\n")) {
          finalReply += `│    ${line}\n`;
        }
        finalReply += `└────────────────────\n`;
      }
      break;
    }

    // ═══ 阶段 4：执行工具调用（带保护机制）═══

    // 批量执行所有工具调用
    // roundHasError 用于控制“重复批次停机”：上一轮有错误时，不应武断终止。
    // roundHasError guards anti-spin stop: do not hard-stop if previous round had errors.
    let roundHasError = false;
    const executedTaskCalls: Array<{ name: string; input: unknown }> = [];
    const roundMissingTasks: MissingToolTask[] = [];
    for (const tc of response.toolCalls) {

      // 保护 1：冗余快照拦截
      const redundant = checkRedundantSnapshot(
        tc.name, tc.input, pageContext.latestSnapshot, round,
      );
      if (redundant) {
        appendToolTrace(round, tc.name, tc.input, redundant);
        redundantInterceptCount += 1;
        callbacks?.onToolResult?.(tc.name, redundant);
        continue;
      }

      callbacks?.onToolCall?.(tc.name, tc.input);

      // 执行工具
      let result = await registry.dispatch(tc.name, tc.input);

      // 保护 2：连续快照防抖
      const debounced = applySnapshotDebounce(
        tc.name, tc.input, result, consecutiveSnapshotCalls,
      );
      result = debounced.result;
      consecutiveSnapshotCalls = debounced.consecutiveCount;

      // 保护 3：元素未找到自动恢复
      const recovered = await handleElementRecovery(
        tc.name, tc.input, result,
        actionRecoveryAttempts, registry, pageContext, callbacks,
      );
      if (recovered) result = recovered;
      if (
        recovered?.details &&
        typeof recovered.details === "object" &&
        (recovered.details as { code?: unknown }).code === "ELEMENT_NOT_FOUND_RECOVERY"
      ) {
        recoveryCount += 1;
      }

      appendToolTrace(round, tc.name, tc.input, result);
      executedTaskCalls.push({ name: tc.name, input: tc.input });

      const missingTask = collectMissingTask(tc.name, tc.input, result);
      if (missingTask) {
        roundMissingTasks.push(missingTask);
      }

      if (result.details && typeof result.details === "object") {
        roundHasError = roundHasError || Boolean((result.details as { error?: unknown }).error);
      }

      // 捕获显式 snapshot 结果
      if (tc.name === "page_info" && getToolAction(tc.input) === "snapshot") {
        pageContext.latestSnapshot = toContentString(result.content);
        recordSnapshotStats(pageContext.latestSnapshot);
      }

      // 保护 4：导航后 URL 变化检测
      await handleNavigationUrlChange(
        tc.name, tc.input, result, registry, pageContext, callbacks,
      );

      callbacks?.onToolResult?.(tc.name, result);

      if (shouldForceRoundBreak(tc.name, tc.input)) {
        break;
      }
    }

    if (roundMissingTasks.length > 0) {
      pendingNotFoundRetry = {
        attempt: 1,
        tasks: roundMissingTasks,
      };
    } else {
      pendingNotFoundRetry = undefined;
    }

    // 将本轮执行状态传给下一轮上下文。
    // Carry current execution state into next round context.
    if (parsedInstructionState.hasRemainingProtocol) {
      remainingInstruction = parsedInstructionState.nextInstruction;
    } else {
      const nextByHeuristic = reduceRemainingHeuristically(remainingInstruction, executedTaskCalls.length);
      if (nextByHeuristic !== remainingInstruction) {
        remainingInstruction = nextByHeuristic;
      } else {
        roundHasError = true;
      }
    }

    previousRoundModelOutput = parsedInstructionState.hasRemainingProtocol
      ? normalizeModelOutput(response.text)
      : `REMAINING: ${remainingInstruction || "DONE"}`;

    lastRoundHadError = roundHasError;
    previousRoundTasks = buildTaskArray(executedTaskCalls);
    previousRoundPlannedTasks = plannedTasksCurrentRound;

    // 保护 5：空转检测
    const toolCallNames = executedTaskCalls.map(tc => tc.name);
    const idleResult = detectIdleLoop(toolCallNames, consecutiveReadOnlyRounds);
    if (idleResult === -1) {
      finalReply = response.text || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      break;
    }
    consecutiveReadOnlyRounds = idleResult;

    // ═══ 阶段 5：刷新快照（供下一轮使用）═══
    await refreshSnapshot();
  }

  // 构建紧凑的 result.messages 供多轮记忆使用
  // Build compact result.messages for optional multi-turn memory reuse.
  const resultMessages: AIMessage[] = [...(history ?? []), { role: "user", content: message }];
  if (finalReply) {
    resultMessages.push({ role: "assistant", content: finalReply });
  }

  // 结果统计（中）/ Compute success/failure metrics (EN).
  const successfulToolCalls = allToolCalls.filter(tc => {
    const details = tc.result.details;
    return !(details && typeof details === "object" && Boolean((details as { error?: unknown }).error));
  }).length;
  const failedToolCalls = allToolCalls.length - successfulToolCalls;

  const metrics: AgentLoopMetrics = {
    roundCount: usedRounds,
    totalToolCalls: allToolCalls.length,
    successfulToolCalls,
    failedToolCalls,
    toolSuccessRate: allToolCalls.length > 0
      ? Number((successfulToolCalls / allToolCalls.length).toFixed(4))
      : 1,
    recoveryCount,
    redundantInterceptCount,
    snapshotReadCount,
    latestSnapshotSize: pageContext.latestSnapshot?.length ?? 0,
    avgSnapshotSize: snapshotReadCount > 0 ? Math.round(snapshotSizeTotal / snapshotReadCount) : 0,
    maxSnapshotSize: snapshotSizeMax,
    inputTokens,
    outputTokens,
  };

  // 统一发出指标回调（中）/ Emit metrics callback once per chat (EN).
  callbacks?.onMetrics?.(metrics);

  return { reply: finalReply, toolCalls: allToolCalls, messages: resultMessages, metrics };
}

// ─── Re-exports（维持外部 API 不变）───
export { wrapSnapshot } from "./snapshot.js";
export type { AgentLoopParams, AgentLoopResult, AgentLoopCallbacks, AgentLoopMetrics } from "./types.js";
