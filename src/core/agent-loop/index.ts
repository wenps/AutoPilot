/**
 * Agent Loop 主流程（口语版）
 *
 * 流程图（文本）：
 *
 *   轮次开始
 *      │
 *      ├─ 先看有没有最新快照
 *      │    └─ 没有就先拍一张（可带 expandChildrenRefs）
 *      │
 *      ├─ 组装本轮上下文消息
 *      │    └─ remaining + 上轮任务 + 最新快照 +（必要时）重试提示
 *      │
 *      ├─ 调用模型拿决策
 *      │    └─ 同时解析 `REMAINING` 和 `SNAPSHOT_HINT`
 *      │
 *      ├─ 有 toolCalls 吗？
 *      │    ├─ 没有：走收敛/协议修复判断（必要时等待后重试）
 *      │    └─ 有：逐个执行工具
 *      │         ├─ 冗余拦截（例如 page_info 空转）
 *      │         ├─ 失败恢复（元素未找到重试）
 *      │         ├─ 导航后更新快照
 *      │         └─ 命中断轮条件则提前结束本轮
 *      │
 *      ├─ 更新 remaining（优先协议，缺失时启发式剔除）
 *      │
 *      ├─ 防空转 / 防自转检查
 *      │    └─ 连续只读或重复批次会触发停机
 *      │
 *      ├─ 刷新快照
 *      ▼
 *   下一轮或停机
 *
 * 停机条件（任一命中）：
 * - `REMAINING: DONE`（或 remaining 为空）
 * - 协议修复后仍无推进
 * - 连续只读（空转）
 * - 重复批次（自转）
 * - 达到 maxRounds
 */
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_WAIT_MS,
  DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS,
  DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS,
  DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS,
} from "./constants.js";
import {
  buildTaskArray,
  collectMissingTask,
  deriveNextInstruction,
  extractHashSelectorRef,
  getToolAction,
  normalizeModelOutput,
  parseSnapshotExpandHints,
  reduceRemainingHeuristically,
  shouldForceRoundBreak,
  isPotentialDomMutation,
  sleep,
  toContentString,
  hasToolError,
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
 * 执行 Agent 循环。
 *
 * 你可以把这个函数理解成“任务执行调度器”：
 * - 输入：用户任务、系统提示词、工具注册表、历史消息、初始快照
 * - 过程：按轮次持续执行“看页面 -> 让模型决策 -> 跑工具 -> 更新上下文”
 * - 输出：最终回复、完整工具调用记录、可复用消息、结构化指标
 *
 * 每轮主流程（固定顺序）：
 * 1) Ensure Snapshot：确保当前有最新快照（必要时读取）
 * 2) Build Messages：构建紧凑上下文（remaining + 上轮轨迹 + 最新快照）
 * 3) Call AI：请求模型并解析协议字段（`REMAINING` / `SNAPSHOT_HINT`）
 * 4) Execute Tools：执行工具调用并应用保护机制（冗余拦截、恢复、导航刷新）
 * 5) Reduce Remaining：推进剩余任务（优先协议，缺失时启发式剔除）
 * 6) Guard & Refresh：防空转/防自转判定，并刷新快照进入下一轮
 *
 * 核心状态语义：
 * - `remainingInstruction`：当前轮还未消费完的任务文本
 * - `previousRoundTasks`：上一轮已执行动作，防止模型原样重复
 * - `previousRoundPlannedTasks`：上一轮模型计划，用于重复批次检测
 * - `protocolViolationHint`：协议修复提示（remaining 未完成却无工具调用时注入）
 *
 * 停机条件（命中任意一条即结束）：
 * - 模型无工具调用且 remaining 已收敛（`REMAINING: DONE` 或空）
 * - 协议修复后仍无推进
 * - 连续只读轮次（防空转）
 * - 连续重复计划批次（防自转）
 * - 达到 `maxRounds`
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
    roundStabilityWait,
    callbacks,
  } = params;

  // 固定依赖与运行态容器
  const tools = registry.getDefinitions();
  const allToolCalls: AgentLoopResult["toolCalls"] = [];
  const fullToolTrace: ToolTraceEntry[] = [];
  const actionRecoveryAttempts = new Map<string, number>();
  const pageContext: PageContextState = {
    latestSnapshot: initialSnapshot,
  };

  // 最终输出
  let finalReply = "";

  // 循环控制状态
  let consecutiveSnapshotCalls = 0;
  let consecutiveReadOnlyRounds = 0;
  let usedRounds = 0;

  // token 统计
  let inputTokens = 0;
  let outputTokens = 0;
  // 渐进式任务状态
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
  const snapshotExpandRefIds = new Set<string>();
  const effectiveRoundStabilityWait = {
    enabled: roundStabilityWait?.enabled ?? true,
    timeoutMs: Math.max(200, Math.floor(roundStabilityWait?.timeoutMs ?? DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS)),
    quietMs: Math.max(50, Math.floor(roundStabilityWait?.quietMs ?? DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS)),
    loadingSelectors: [
      ...new Set(
        [
          ...DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS,
          ...(roundStabilityWait?.loadingSelectors ?? []),
        ]
          .map(selector => selector.trim())
          .filter(Boolean),
      ),
    ],
  };
  // 恢复与拦截统计
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

  // 快照体积统计
  let snapshotReadCount = 0;
  let snapshotSizeTotal = 0;
  let snapshotSizeMax = 0;

  /**
   * 记录快照统计。
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
   * 刷新页面快照。
   *
   * 只做两件事：读取最新快照 + 更新快照统计。
   * Does exactly two things: read latest snapshot + update metrics.
   */
  const refreshSnapshot = async (): Promise<void> => {
    pageContext.latestSnapshot = await readPageSnapshot(
      registry,
      snapshotExpandRefIds.size > 0
        ? { expandChildrenRefs: Array.from(snapshotExpandRefIds), expandedChildrenLimit: 120 }
        : undefined,
    );
    recordSnapshotStats(pageContext.latestSnapshot);
  };

  /**
   * 轮次后稳定等待（双重等待）。
   *
   * 顺序固定为：
   * 1) 等待 loading 指示器隐藏
   * 2) 等待 DOM quiet window
   */
  const runRoundStabilityBarrier = async (): Promise<void> => {
    if (!effectiveRoundStabilityWait.enabled) return;
    if (!registry.has("wait")) return;

    const timeout = effectiveRoundStabilityWait.timeoutMs;
    const loadingSelector = effectiveRoundStabilityWait.loadingSelectors.join(", ");

    if (loadingSelector) {
      await registry.dispatch("wait", {
        action: "wait_for_selector",
        selector: loadingSelector,
        state: "hidden",
        timeout,
      });
    }

    await registry.dispatch("wait", {
      action: "wait_for_stable",
      timeout,
      quietMs: effectiveRoundStabilityWait.quietMs,
    });
  };


  if (pageContext.latestSnapshot) {
    recordSnapshotStats(pageContext.latestSnapshot);
  }

  /**
   * 追加工具轨迹。
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

  // 主循环
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

    // 计费/观测数据累计
    inputTokens += response.usage?.inputTokens ?? 0;
    outputTokens += response.usage?.outputTokens ?? 0;

    // 先解析协议，最终推进在本轮执行后统一决定。
    const parsedInstructionState = deriveNextInstruction(response.text, remainingInstruction);
    const snapshotHintRefs = parseSnapshotExpandHints(response.text);
    for (const ref of snapshotHintRefs.slice(0, 8)) {
      snapshotExpandRefIds.add(ref);
    }

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
    if (plannedBatchKey === lastPlannedBatchKey) {
      consecutiveSamePlannedBatch += 1;
    } else {
      consecutiveSamePlannedBatch = 1;
      lastPlannedBatchKey = plannedBatchKey;
    }

    // 防自转：连续两轮给出相同计划且上一轮无错误，判定任务已完成或模型卡住，直接结束。
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
    let roundHasError = false;
    let roundHasPotentialDomMutation = false;
    const executedTaskCalls: Array<{ name: string; input: unknown }> = [];
    const roundMissingTasks: MissingToolTask[] = [];
    for (const tc of response.toolCalls) {

      // 自动策略：当 AI 对 hash 列表执行 scroll 时，默认下一轮对该节点放宽 children 截断。
      // 这样即使模型未显式输出 SNAPSHOT_HINT，也能尽快拿到完整列表选项。
      if (tc.name === "dom" && getToolAction(tc.input) === "scroll") {
        const ref = extractHashSelectorRef(tc.input);
        if (ref) snapshotExpandRefIds.add(ref);
      }

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
      if (!hasToolError(result) && isPotentialDomMutation(tc.name, tc.input)) {
        roundHasPotentialDomMutation = true;
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
    const attemptedTaskCalls = response.toolCalls.map(tc => ({ name: tc.name, input: tc.input }));
    const idleResult = detectIdleLoop(attemptedTaskCalls, consecutiveReadOnlyRounds);
    if (idleResult === -1) {
      finalReply = response.text?.trim() || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      break;
    }
    consecutiveReadOnlyRounds = idleResult;

    if (roundHasPotentialDomMutation) {
      await runRoundStabilityBarrier();
    }

    // ═══ 阶段 5：刷新快照（供下一轮使用）═══
    await refreshSnapshot();
  }

  // 构建紧凑的 result.messages 供多轮记忆使用
  // Build compact result.messages for optional multi-turn memory reuse.
  const resultMessages: AIMessage[] = [...(history ?? []), { role: "user", content: message }];
  if (finalReply) {
    resultMessages.push({ role: "assistant", content: finalReply });
  }

  // 结果统计
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

  // 统一发出指标回调
  callbacks?.onMetrics?.(metrics);

  return { reply: finalReply, toolCalls: allToolCalls, messages: resultMessages, metrics };
}

// ─── Re-exports（维持外部 API 不变）───
export { wrapSnapshot } from "./snapshot.js";
export type {
  AgentLoopParams,
  AgentLoopResult,
  AgentLoopCallbacks,
  AgentLoopMetrics,
  RoundStabilityWaitOptions,
} from "./types.js";
