/**
 * Engine 决策主循环 — v2 多 Agent 架构的统一执行引擎。
 *
 * ═══ 在 v2 架构中的位置 ═══
 *
 * ```
 * core/
 * ├── shared/          ← 无状态基础设施（36 个 helper + snapshot + recovery + constants）
 * ├── assertion/       ← 独立判定层（断言 AI，不执行工具，只看快照判定）
 * ├── micro-task/      ← 数据结构层（MicroTaskDescriptor / ExecutionRecordChain / TaskMonitor）
 * ├── engine/
 * │   ├── messages.ts  ← 消息编排（Round 语义、REMAINING 协议）
 * │   └── index.ts     ← 【当前文件】决策主循环
 * └── main-agent/      ← 未来：分析 + 调度器（调用本模块执行微任务）
 * ```
 *
 * ═══ 统一引擎，两种执行模式 ═══
 *
 * v2 中 main-agent 直接执行和 micro-task 执行共享同一个 executeAgentLoop，
 * 区别仅在 AgentLoopParams 的配置差异：
 *
 * | 参数              | main-agent 模式          | micro-task 模式                    |
 * |-------------------|--------------------------|-------------------------------------|
 * | systemPrompt      | DOM 规则 + 调度规则       | DOM 规则 + "Previously completed"  |
 * | maxRounds         | 40（DEFAULT_MAX_ROUNDS）  | 8～12（由 MicroTaskDescriptor 指定）|
 * | assertionConfig   | 可选（用户配置）          | 必填（微任务级断言）                |
 * | message           | 用户原始目标              | 微任务描述（"填写姓名字段"）         |
 * | initialSnapshot   | 无或首次快照              | 上一微任务结束时的快照               |
 *
 * 函数体逻辑对模式透明——相同的轮次循环、保护机制、停机条件。
 *
 * ═══ 未来组合方式（main-agent → micro-task）═══
 *
 * ```ts
 * // main-agent 分析用户目标，拆解为微任务序列
 * const microTasks = mainAgent.decompose(userGoal);
 *
 * // 每个微任务调用同一个 executeAgentLoop，配置不同
 * for (const mt of microTasks) {
 *   const result = await executeAgentLoop({
 *     client,
 *     registry,
 *     systemPrompt: buildMicroTaskPrompt(mt, recordChain),
 *     message: mt.task,
 *     maxRounds: mt.maxRounds ?? 8,
 *     assertionConfig: { taskAssertions: mt.assertions },
 *     initialSnapshot: lastSnapshot,
 *   });
 *   recordChain.append(result);  // 执行链累积，供下一微任务参考
 * }
 * ```
 *
 * ═══ 依赖关系 ═══
 *
 * ```
 * engine/index.ts
 *   ├── engine/messages.ts       → buildCompactMessages(), formatToolInputBrief()
 *   ├── shared/constants         → DEFAULT_MAX_ROUNDS, 稳定等待参数, 重试参数
 *   ├── shared/helpers           → 36 个纯函数（协议解析、启发式推进、指纹计算等）
 *   ├── shared/snapshot          → readPageSnapshot(), stripSnapshotFromPrompt()
 *   ├── shared/recovery          → 4 大保护机制（元素恢复 / 导航刷新 / 空转检测 / 无效点击拦截）
 *   └── assertion/index          → evaluateAssertions()（断言 AI 判定）
 * ```
 *
 * ═══ 每轮主流程（6 阶段固定顺序）═══
 *
 * ```
 *   轮次开始
 *      │
 *      ├─ 阶段 1: Ensure Snapshot
 *      │    └─ 无快照则读取（可带 expandChildrenRefs 放宽截断）
 *      │
 *      ├─ 阶段 2: Build Messages
 *      │    └─ buildCompactMessages() 注入 remaining + 上轮轨迹 + 最新快照
 *      │
 *      ├─ 阶段 3: Call AI
 *      │    └─ 解析 REMAINING 协议 + SNAPSHOT_HINT
 *      │
 *      ├─ 阶段 4: Execute Tools（带 8 层保护）
 *      │    ├─ 保护 1: 重复无效点击拦截（checkIneffectiveClickRepeat）
 *      │    ├─ 保护 2: 元素未找到自动恢复（handleElementRecovery）
 *      │    ├─ 保护 3: scroll 自动放宽快照（snapshotExpandRefIds）
 *      │    ├─ 保护 4: 导航后 URL 变化检测（handleNavigationUrlChange）
 *      │    ├─ 保护 5: 防协议缺失空转（consecutiveNoProtocolRounds ≥ 5）
 *      │    ├─ 保护 6: 空转检测（detectIdleLoop，连续只读轮次）
 *      │    ├─ 保护 7: 快照不变时标记无效 click（ineffectiveClickSelectors）
 *      │    └─ 保护 8: 点击目标交替循环检测（A→B→A→B 滑动窗口）
 *      │
 *      ├─ 阶段 5: Reduce Remaining
 *      │    └─ 优先 REMAINING 协议 → 回退启发式剔除 → 结构化 checklist 同步
 *      │
 *      └─ 阶段 6: Guard & Refresh
 *           ├─ 防自转（连续相同批次 ≥ 3 轮 → repeated_batch 停机）
 *           ├─ 滞止检测（remaining 连续不推进 ≥ 3 轮 → stale_remaining 停机）
 *           ├─ 轮次后稳定等待（loading 指示器隐藏 + DOM quiet window）
 *           └─ 刷新快照 → 下一轮
 * ```
 *
 * ═══ 停机条件（10 种 StopReason）═══
 *
 * | StopReason           | 触发条件                                           | 对应测试用例                           |
 * |----------------------|-----------------------------------------------------|----------------------------------------|
 * | converged            | REMAINING: DONE 且无错误                            | "REMAINING: DONE 带尾随说明时收敛"      |
 * | converged            | 模型无工具调用且 remaining 为空                      | "正常完成：工具后返回总结"              |
 * | assertion_passed     | 断言全部通过                                        | （需 assertionConfig 的场景）           |
 * | assertion_loop       | 连续 2 轮仅调 assert 且都失败                        | （断言死循环保护）                      |
 * | repeated_batch       | 连续 ≥ 3 轮相同工具调用批次（上轮无错误时）          | "重复相同批次先提示后终止"              |
 * | idle_loop            | 连续 2 轮只执行只读工具（get_text 等）               | "空转终止"                              |
 * | no_protocol          | 连续 ≥ 5 轮有工具但无 REMAINING 且启发式无法推进     | "连续无 REMAINING 协议 5 轮后强制终止"  |
 * | protocol_fix_failed  | remaining 未完成但模型始终无工具调用                  | "未完成但无工具调用 → 协议修复"          |
 * | stale_remaining      | remaining 连续 ≥ 3 轮不推进且无确认性进展            | （多步任务滞止保护）                    |
 * | max_rounds           | 达到 maxRounds 上限                                  | （默认 40 轮）                          |
 * | dry_run              | dryRun=true 模式，仅展示工具调用不执行               | （调试用）                              |
 */
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_WAIT_MS,
  DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS,
  DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS,
  DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS,
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
  splitUserGoalIntoTasks,
  updateTaskCompletion,
  formatTaskChecklist,
  deriveRemainingFromTasks,
  sleep,
  toContentString,
  hasToolError,
} from "../shared/helpers.js";
import { readPageSnapshot, stripSnapshotFromPrompt } from "../shared/snapshot/index.js";
import { buildCompactMessages, formatToolInputBrief } from "./messages.js";
import {
  checkIneffectiveClickRepeat,
  handleElementRecovery,
  handleNavigationUrlChange,
  detectIdleLoop,
} from "../shared/recovery/index.js";
import { evaluateAssertions } from "../assertion/index.js";
import type {
  AgentLoopParams,
  AgentLoopResult,
  AgentLoopMetrics,
  PageContextState,
  ToolTraceEntry,
  StopReason,
  TaskItem,
} from "../shared/types.js";
import type { AIMessage } from "../shared/types.js";
import type { AssertionResult } from "../assertion/types.js";

/**
 * 执行 Agent 循环 — v2 统一执行引擎的唯一入口。
 *
 * 你可以把这个函数理解成"任务执行调度器"：
 * - 输入：用户任务、系统提示词、工具注册表、历史消息、初始快照
 * - 过程：按轮次持续执行"看页面 → 让模型决策 → 跑工具 → 更新上下文"
 * - 输出：最终回复、完整工具调用记录、可复用消息、结构化指标
 *
 * **v2 架构中的两种使用方式：**
 *
 * 1) main-agent 直接执行（单次长循环）
 *    ```ts
 *    const result = await executeAgentLoop({
 *      client, registry, systemPrompt: mainAgentPrompt,
 *      message: "把城市改成上海",
 *      maxRounds: 40,  // 默认值
 *    });
 *    ```
 *    → 测试覆盖：index.test.ts "REMAINING: DONE 带尾随说明时收敛"
 *    → 测试覆盖：index.test.ts "正常完成：工具后返回总结"
 *
 * 2) micro-task 执行（短循环，由 TaskMonitor 驱动）
 *    ```ts
 *    const mtResult = await executeAgentLoop({
 *      client, registry,
 *      systemPrompt: buildMicroTaskPrompt(mt, recordChain.buildPreviousContext()),
 *      message: mt.task,           // "填写姓名字段为张三"
 *      maxRounds: mt.maxRounds,    // 8
 *      assertionConfig: { taskAssertions: mt.assertions },
 *      initialSnapshot: lastSnapshot,
 *    });
 *    recordChain.append(mtResult);  // 累积执行记录
 *    ```
 *
 * **函数体对模式透明** — 相同的轮次循环、8 层保护机制、10 种停机条件。
 * 模式差异完全由 AgentLoopParams 表达，不影响内部逻辑。
 *
 * @param params - 完整执行配置，参见 AgentLoopParams 类型定义（shared/types.ts）
 * @returns AgentLoopResult — { reply, toolCalls[], messages[], metrics, assertionResult? }
 *
 * @see messages.ts — buildCompactMessages() 负责每轮消息编排
 * @see shared/recovery — 4 大保护机制（元素恢复 / 导航刷新 / 空转检测 / 无效点击拦截）
 * @see assertion/index — evaluateAssertions() 负责断言判定
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
    assertionConfig,
    callbacks,
  } = params;

  // ═══ 固定依赖与运行态容器 ═══
  // tools: 工具定义数组，从 registry 一次性读取后全循环复用
  // allToolCalls: 对外返回的完整工具调用记录（name + input + result）
  // fullToolTrace: 内部使用的带轮次信息的完整轨迹（供 buildCompactMessages 注入）
  // actionRecoveryAttempts: 每个 (工具名, 输入) 组合的恢复尝试次数（上限 2 次）
  // pageContext: 可变的页面上下文状态（latestSnapshot + currentUrl）
  const tools = registry.getDefinitions();
  const allToolCalls: AgentLoopResult["toolCalls"] = [];
  const fullToolTrace: ToolTraceEntry[] = [];
  const actionRecoveryAttempts = new Map<string, number>();
  const pageContext: PageContextState = {
    latestSnapshot: initialSnapshot,
  };

  // ═══ 最终输出 ═══
  let finalReply = "";
  let stopReason: StopReason = "max_rounds";
  // lastAssertionResult: 在 v2 中用 static import 替代 v1 的 dynamic import，
  // 因为 assertion/ 是 engine 的直接依赖，无需延迟加载。
  let lastAssertionResult: AssertionResult | undefined;

  // ═══ 循环控制状态 ═══
  // 每个计数器对应一种停机保护，计数器之间相互独立、互不干扰。
  let consecutiveReadOnlyRounds = 0;   // 保护 6: 空转检测（连续只读轮次 ≥ 2 → idle_loop）
  let consecutiveNoProtocolRounds = 0; // 保护 5: 协议缺失（连续无 REMAINING 协议 ≥ 5 → no_protocol）
  let usedRounds = 0;                  // 实际执行轮次数（写入 metrics.roundCount）

  // token 统计
  let inputTokens = 0;
  let outputTokens = 0;
  // ═══ 渐进式任务状态 ═══
  //
  // 这组变量构成 engine 的"任务推进状态机"，每轮结束时更新，
  // 下一轮通过 buildCompactMessages 注入到模型上下文中。
  //
  // remainingInstruction:
  //   当前轮次要继续消费的剩余文本。初始值 = 用户消息。
  //   推进优先级：REMAINING 协议 > 启发式剔除 > checklist 反推。
  //   → 测试覆盖：index.test.ts "缺失 REMAINING 协议且本轮有执行动作：启发式推进剩余任务"
  //
  // previousRoundTasks / previousRoundPlannedTasks:
  //   上轮已执行 / 已计划的任务数组，注入到下一轮 "Previous executed/planned" 区块。
  //   → 测试覆盖：index.test.ts "DOM 变更动作后强制断轮" 验证 Previous executed/planned 内容
  //
  // previousRoundModelOutput:
  //   上轮模型输出摘要，注入到下一轮 "Previous model output" 区块。
  //   → 测试覆盖：index.test.ts "未完成但无工具调用" 验证包含 REMAINING: 打开任务弹窗
  //
  // lastPlannedBatchKey + consecutiveSamePlannedBatch:
  //   防自转：检测模型是否连续给出完全相同的工具调用批次。
  //   ≥ 2 轮注入 "Repeated action warning"；≥ 3 轮直接停机（repeated_batch）。
  //   → 测试覆盖：index.test.ts "重复相同任务批次且上轮无错：先提示后终止避免自转"
  //
  // lastRoundHadError:
  //   上一轮是否有错误。有错误时不触发"重复批次停机"，避免误停。
  //   全部工具调用被框架拦截时也视为 error 轮。
  //
  // protocolViolationHint:
  //   协议修复提示，在模型违反 REMAINING 协议时注入。
  //   → 测试覆盖：index.test.ts "未完成但无工具调用：进入下一轮协议修复"
  let remainingInstruction = message.trim();
  let previousRoundTasks: string[] = [];
  let previousRoundPlannedTasks: string[] = [];
  let previousRoundModelOutput = "";

  // 结构化任务拆分：多步任务（"A，然后B，然后C"）拆成 checklist
  let taskItems: TaskItem[] | null = splitUserGoalIntoTasks(message);

  let lastPlannedBatchKey = "";
  let consecutiveSamePlannedBatch = 0;
  let lastRoundHadError = false;
  let protocolViolationHint: string | undefined;

  // ═══ 滞止检测 ═══
  // remaining 连续不推进且无确认性进展时，先发出强制收敛提示，超过上限后强制停机。
  // 仅在多步任务（taskItems 存在）时激活，单步任务由 idle_loop / no_protocol 处理。
  // → 与 consecutiveNoProtocolRounds 互补：no_protocol 检测协议缺失，stale 检测内容不变。
  let previousRoundRemaining = remainingInstruction;
  let consecutiveNoProgressRounds = 0;
  const snapshotExpandRefIds = new Set<string>();
  // ═══ 轮次后稳定等待配置 ═══
  // 合并用户自定义 loadingSelectors 与 shared/constants 中的默认值（AntD/Element Plus/BK UI/TDesign）。
  // 去重 + trim + 过滤空值，确保最终 selector 列表干净。
  // → 测试覆盖：index.test.ts "自定义 loadingSelectors 与默认值合并而非覆盖"
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
  // ═══ 恢复与拦截统计（写入 metrics 供可观测性使用）═══
  let recoveryCount = 0;          // 保护 2: 元素未找到恢复触发次数 → metrics.recoveryCount
  let redundantInterceptCount = 0; // 保护 1: 重复无效点击拦截次数 → metrics.redundantInterceptCount
  // 断言死循环检测：连续仅调 assert（无其他工具）且断言失败的轮次
  // → 连续 ≥ 2 轮 → assertion_loop 停机，避免模型反复 assert 不做实质操作
  let consecutiveAssertOnlyFailedRounds = 0;

  // ═══ 保护 7: 重复无效点击拦截 ═══
  // 记录已证实点击无效的 selector 集合（快照指纹不变时加入）。
  // 下一轮再次点击同一 selector → checkIneffectiveClickRepeat 直接拦截并推荐附近可点击元素。
  // 快照变化时仅移除本轮点击的 selector（可能是它们引发了变化），保留历史无效 selector。
  // → 测试覆盖：index.test.ts "无 REMAINING 协议但重复相同批次：先提示后停机"
  const ineffectiveClickSelectors = new Set<string>();

  // 近 N 轮点击目标滑动窗口，用于检测交替点击循环（如 A→B→A→B）。
  // 当窗口内唯一目标数 ≤ 2 且跨度 ≥ 4 轮时判定为循环，将目标全部加入 ineffectiveClickSelectors。
  const recentRoundClickTargets: string[][] = [];

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

  // 前一轮快照文本（用于计算快照变化摘要 diff）
  let previousRoundSnapshot = "";

  // 主循环
  for (let round = 0; round < maxRounds; round++) {
    callbacks?.onRound?.(round);
    usedRounds = round + 1;

    // ═══ 阶段 1：确保快照 ═══
    if (!pageContext.latestSnapshot) {
      await refreshSnapshot();
    }

    // 记录本轮行动前的快照指纹，用于轮结束时检测操作是否产生页面变化
    const roundStartFingerprint = computeSnapshotFingerprint(pageContext.latestSnapshot || "");

    // 计算快照变化摘要（Round 1+ 才有前一轮快照可对比）
    const snapshotDiff = round > 0
      ? computeSnapshotDiff(previousRoundSnapshot, pageContext.latestSnapshot || "")
      : "";
    // 保存当前快照供下一轮对比
    previousRoundSnapshot = pageContext.latestSnapshot || "";

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
      snapshotDiff,
      taskItems ? formatTaskChecklist(taskItems) : undefined,
      lastAssertionResult,
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
      consecutiveNoProtocolRounds = 0; // 非工具轮打断协议缺失计数
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

      // 模型无工具调用时，仅接受 DONE（收敛），不接受非空 REMAINING。
      // 避免模型将用户任务改写为自身问题（如 MiniMax 首轮返回"你好，请告诉我需要操作"）导致 remaining 被污染。
      if (
        parsedInstructionState.hasRemainingProtocol &&
        parsedInstructionState.nextInstruction.trim().length === 0
      ) {
        remainingInstruction = "";
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

      finalReply = stripThinking(response.text);
      if (finalReply) callbacks?.onText?.(finalReply);
      stopReason = remainingInstruction.trim().length > 0 ? "protocol_fix_failed" : "converged";
      break;
    }

    protocolViolationHint = undefined;
    const plannedTasksCurrentRound = buildTaskArray(
      response.toolCalls.map(tc => ({ name: tc.name, input: tc.input })),
    );

    const plannedBatchKey = JSON.stringify(
      response.toolCalls.map(tc => ({ name: tc.name, input: tc.input })),
    );
    // 比较"本轮计划"与"上一轮计划"是否完全一致。
    if (plannedBatchKey === lastPlannedBatchKey) {
      consecutiveSamePlannedBatch += 1;
    } else {
      consecutiveSamePlannedBatch = 1;
      lastPlannedBatchKey = plannedBatchKey;
    }

    // 防自转：连续相同计划批次检测。
    // ≥ 2 轮：注入提示，要求模型换策略或结束。
    // ≥ 3 轮：仍无变化，直接终止。
    if (consecutiveSamePlannedBatch >= 3 && !lastRoundHadError) {
      finalReply = stripThinking(response.text) || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      stopReason = "repeated_batch";
      break;
    }
    if (consecutiveSamePlannedBatch >= 2 && !lastRoundHadError) {
      protocolViolationHint = [
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

    // ─── Dry-run 模式 ───
    if (dryRun) {
      finalReply = stripThinking(response.text) ? stripThinking(response.text) + "\n\n" : "";
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
      stopReason = "dry_run";
      break;
    }

    // ═══ 阶段 4：执行工具调用（带保护机制）═══

    // 分离 assert 调用与普通工具调用：
    // assert 需要在所有操作工具执行完 + 页面稳定后再发起，
    // 以便基于最新快照做判定。
    const regularToolCalls = response.toolCalls.filter(tc => tc.name !== "assert");
    const assertToolCall = response.toolCalls.find(tc => tc.name === "assert");

    // 批量执行所有工具调用
    // roundHasError 用于控制"重复批次停机"：上一轮有错误时，不应武断终止。
    let roundHasError = false;
    let roundHasPotentialDomMutation = false;
    let roundHasConfirmedProgress = false;
    const executedTaskCalls: Array<{ name: string; input: unknown }> = [];
    const roundMissingTasks: MissingToolTask[] = [];
    // 本轮实际执行的 click selector，用于轮末无效点击判定
    const roundClickSelectors: string[] = [];
    for (const tc of regularToolCalls) {

      // 自动策略：当 AI 对 hash 列表执行 scroll 时，默认下一轮对该节点放宽 children 截断。
      // 这样即使模型未显式输出 SNAPSHOT_HINT，也能尽快拿到完整列表选项。
      if (tc.name === "dom" && getToolAction(tc.input) === "scroll") {
        const ref = extractHashSelectorRef(tc.input);
        if (ref) snapshotExpandRefIds.add(ref);
      }

      // 保护 1：重复无效点击拦截（附带快照中的附近可点击元素推荐）
      const ineffective = checkIneffectiveClickRepeat(
        tc.name, tc.input, ineffectiveClickSelectors, pageContext.latestSnapshot,
      );
      if (ineffective) {
        appendToolTrace(round, tc.name, tc.input, ineffective);
        redundantInterceptCount += 1;
        callbacks?.onToolCall?.(tc.name, tc.input);
        callbacks?.onToolResult?.(tc.name, ineffective);
        roundHasError = true;
        continue;
      }

      callbacks?.onToolCall?.(tc.name, tc.input);

      // 执行工具
      let result = await registry.dispatch(tc.name, tc.input);

      // 保护 2：元素未找到自动恢复
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

      // 记录本轮成功执行的 click selector，用于轮末无效点击判定
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

    // ═══ 断言处理：assert 工具与其他工具一起返回时，先等稳定再发起断言 ═══
    if (assertToolCall) {
      // 在稳定等待之前先拍一份"动作后快照"，捕获成功提示/弹窗等瞬态反馈（可能在稳定等待期间因页面跳转而消失）
      await refreshSnapshot();
      const postActionSnapshot = pageContext.latestSnapshot || "";

      // 先等页面稳定（若本轮有 DOM 变更动作）
      if (roundHasPotentialDomMutation) {
        await runRoundStabilityBarrier();
      }
      // 断言前清除 hover 等瞬态视觉状态，确保快照反映真实持久状态
      await callbacks?.onBeforeAssertionSnapshot?.();
      // 刷新快照确保基于最新状态判定
      await refreshSnapshot();

      // 确定断言列表：有自定义配置用配置，否则以用户原始消息作为整体断言
      const taskAssertions = (assertionConfig && assertionConfig.taskAssertions.length > 0)
        ? assertionConfig.taskAssertions
        : [{ task: "Complete user task", description: message }];

      // 构建已执行操作摘要，发给断言 AI
      const actionSummaries = fullToolTrace.map(
        entry => `${entry.name}${formatToolInputBrief(entry.input)}`,
      );

      callbacks?.onToolCall?.("assert", assertToolCall.input);

      const assertionResult = await evaluateAssertions(
        client,
        pageContext.latestSnapshot || "",
        actionSummaries,
        taskAssertions,
        initialSnapshot,
        postActionSnapshot,
      );
      lastAssertionResult = assertionResult;

      // 将断言结果作为 assert 工具的执行结果记录
      const assertResult = {
        content: assertionResult.allPassed
          ? `All ${assertionResult.total} assertions PASSED.`
          : `Assertions: ${assertionResult.passed}/${assertionResult.total} passed. Failed: ${assertionResult.details.filter(d => !d.passed).map(d => `"${d.task}": ${d.reason}`).join("; ")}`,
        details: { assertionResult },
      };
      appendToolTrace(round, "assert", assertToolCall.input, assertResult);
      executedTaskCalls.push({ name: "assert", input: assertToolCall.input });
      callbacks?.onToolResult?.("assert", assertResult);

      // 总断言通过：立即收敛
      if (assertionResult.allPassed) {
        finalReply = stripThinking(response.text) || "任务已完成（断言验证全部通过）。";
        if (finalReply) callbacks?.onText?.(finalReply);
        stopReason = "assertion_passed";
        break;
      }

      // 断言失败 + 本轮仅有 assert 调用（无其他实质工具）→ 累计断言死循环计数
      if (regularToolCalls.length === 0) {
        consecutiveAssertOnlyFailedRounds++;
        if (consecutiveAssertOnlyFailedRounds >= 2) {
          // 连续 2 轮只调 assert 且都失败：停机，避免无限循环
          finalReply = stripThinking(response.text) || "断言连续失败，停止执行。";
          if (finalReply) callbacks?.onText?.(finalReply);
          stopReason = "assertion_loop";
          break;
        }
      } else {
        // 本轮有其他工具执行：重置计数
        consecutiveAssertOnlyFailedRounds = 0;
      }
    } else {
      // 本轮无 assert 调用：重置计数
      consecutiveAssertOnlyFailedRounds = 0;
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
      consecutiveNoProtocolRounds = 0;
    } else {
      const nextByHeuristic = reduceRemainingHeuristically(remainingInstruction, executedTaskCalls.length);
      if (nextByHeuristic !== remainingInstruction) {
        remainingInstruction = nextByHeuristic;
        consecutiveNoProtocolRounds = 0;
      } else if (executedTaskCalls.length > 0) {
        // 模型执行了工具但未遵循 REMAINING 协议且启发式无法推进。
        // 有"确定性推进"（form input / press / navigate / 自定义工具）时重置计数器。
        // click 不算——因为 click 可能点了但无效果（如点击无 listener 的元素），
        // 避免模型反复点击无效目标时计数器永远被重置而导致无限循环。
        if (!roundHasConfirmedProgress || roundHasError) {
          consecutiveNoProtocolRounds += 1;
        } else {
          consecutiveNoProtocolRounds = 0;
        }
      }
    }

    // 同步结构化任务进度：根据当前 remaining 更新 checklist 完成状态
    if (taskItems) {
      taskItems = updateTaskCompletion(taskItems, remainingInstruction);
      // 当模型未遵循 REMAINING 协议时，从 checklist 反推 remaining，
      // 确保 remaining 与 checklist 状态一致
      if (!parsedInstructionState.hasRemainingProtocol) {
        const derived = deriveRemainingFromTasks(taskItems);
        if (derived) remainingInstruction = derived;
      }
    }

    previousRoundModelOutput = parsedInstructionState.hasRemainingProtocol
      ? normalizeModelOutput(response.text)
      : `REMAINING: ${remainingInstruction || "DONE"}`;

    lastRoundHadError = roundHasError;
    // 全部工具调用被框架拦截（无实际执行）时，视为非正常轮次：
    // 对重复批次检测视同"有错误"，避免因 page_info 被拦截而误判自转停机。
    if (executedTaskCalls.length === 0 && response.toolCalls.length > 0) {
      lastRoundHadError = true;
    }
    previousRoundTasks = buildTaskArray(executedTaskCalls);
    previousRoundPlannedTasks = plannedTasksCurrentRound;

    // 协议显式 DONE 且本轮已完成执行且无错误：直接收敛，避免后续重复动作。
    if (
      parsedInstructionState.hasRemainingProtocol &&
      remainingInstruction.trim().length === 0 &&
      !roundHasError
    ) {
      finalReply = stripThinking(response.text) || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      stopReason = "converged";
      break;
    }

    // 保护 6：空转检测（基于实际执行的工具，排除被框架拦截的冗余调用）
    const idleResult = detectIdleLoop(executedTaskCalls, consecutiveReadOnlyRounds);
    if (idleResult === -1) {
      finalReply = stripThinking(response.text) || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      stopReason = "idle_loop";
      break;
    }
    consecutiveReadOnlyRounds = idleResult;

    // 保护 8：滞止检测（remaining 连续不推进 + 无确认性进展）
    // 典型场景：任务已通过快照可见完成，但模型不主动输出 REMAINING: DONE，
    // 转而反复尝试 click OK、page_info 等无实质推进的动作。
    // 仅在多步任务（taskItems 存在）时激活，单步任务由 idle_loop/no_protocol 处理。
    if (taskItems && remainingInstruction === previousRoundRemaining && !roundHasConfirmedProgress) {
      consecutiveNoProgressRounds++;
    } else if (remainingInstruction !== previousRoundRemaining || roundHasConfirmedProgress) {
      consecutiveNoProgressRounds = 0;
    }
    previousRoundRemaining = remainingInstruction;

    if (consecutiveNoProgressRounds >= 3) {
      finalReply = stripThinking(response.text) || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      stopReason = "stale_remaining";
      break;
    }
    if (consecutiveNoProgressRounds >= 2) {
      const staleHint = [
        "CRITICAL — No progress detected:",
        `- Remaining has NOT advanced for ${consecutiveNoProgressRounds} consecutive rounds with no confirmed progress.`,
        "- The snapshot may ALREADY show your task is complete.",
        "CHECK the snapshot NOW: if the expected outcome is visible (color changed, switch toggled, value present, dialog closed, form submitted, etc.), output REMAINING: DONE immediately with NO tool calls.",
        "Do NOT call page_info, do NOT retry failed actions, do NOT click verify/confirm buttons if the result is already visible.",
      ].join("\n");
      protocolViolationHint = protocolViolationHint
        ? protocolViolationHint + "\n\n" + staleHint
        : staleHint;
    }

    if (roundHasPotentialDomMutation) {
      await runRoundStabilityBarrier();
    }

    // ═══ 阶段 5：刷新快照（供下一轮使用）═══
    await refreshSnapshot();

    // ═══ 快照变化检测：对比本轮行动前后快照指纹 ═══
    // 仅在本轮有潜在 DOM 变更动作时比对，避免对只读轮次误报。
    // 同时：若页面确实发生变化（指纹不同），重置 consecutiveNoProtocolRounds，
    // 因为 click 导致的导航/页面切换属于真实推进，不应因模型未输出 REMAINING 协议而被罚停。
    if (roundHasPotentialDomMutation) {
      const roundEndFingerprint = computeSnapshotFingerprint(pageContext.latestSnapshot || "");
      if (roundEndFingerprint === roundStartFingerprint && roundStartFingerprint !== "") {
        // 查找各无效点击 selector 附近的可点击元素作为具体推荐
        const nearbyHintLines: string[] = [];
        for (const sel of roundClickSelectors) {
          const nearby = findNearbyClickTargets(
            pageContext.latestSnapshot || "", sel, ineffectiveClickSelectors,
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
        protocolViolationHint = protocolViolationHint
          ? protocolViolationHint + "\n\n" + unchangedHint
          : unchangedHint;

        // 保护 7：将本轮无效 click selector 加入拦截集合，下一轮再次点击时直接拦截
        for (const sel of roundClickSelectors) {
          ineffectiveClickSelectors.add(sel);
        }
      } else if (roundEndFingerprint !== roundStartFingerprint) {
        // 页面确实发生了变化：即使模型未遵循 REMAINING 协议，click 导航也属于真实推进。
        // 重置计数器，避免多步 UI 导航（如搜索→点击仓库→选择分支→切换 Tab）
        // 因连续 click 轮次被误判为协议缺失空转。
        consecutiveNoProtocolRounds = 0;
        // 页面变化：仅移除本轮点击的 selector（可能是它们引发了变化），
        // 保留之前已标记的无效 selector，防止交替点击循环逃逸。
        // 旧页面的 hashID 不会出现在新页面快照中，因此保留不会误拦。
        for (const sel of roundClickSelectors) {
          ineffectiveClickSelectors.delete(sel);
        }
      }
    }

    // 保护 8：点击目标交替循环检测（如 A→B→A→B）。
    // 记录本轮 click 目标并检测近 N 轮是否在 ≤2 个目标间循环。
    if (roundClickSelectors.length > 0) {
      recentRoundClickTargets.push([...roundClickSelectors]);
      while (recentRoundClickTargets.length > 6) recentRoundClickTargets.shift();
    }
    if (recentRoundClickTargets.length >= 4) {
      const recentWindow = recentRoundClickTargets.slice(-4);
      const allTargets = recentWindow.flat();
      const uniqueTargets = new Set(allTargets);
      if (uniqueTargets.size <= 2 && allTargets.length >= 4) {
        // 查找循环目标周围的可点击替代元素
        const cycleNearbyLines: string[] = [];
        for (const sel of uniqueTargets) {
          const nearby = findNearbyClickTargets(
            pageContext.latestSnapshot || "", sel, new Set([...ineffectiveClickSelectors, ...uniqueTargets]),
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
        protocolViolationHint = protocolViolationHint
          ? protocolViolationHint + "\n\n" + cycleHint
          : cycleHint;
        // 将所有循环目标加入无效集合，强制下一轮换目标
        for (const sel of uniqueTargets) {
          ineffectiveClickSelectors.add(sel);
        }
        // 清空窗口，重新开始跟踪
        recentRoundClickTargets.length = 0;
      }
    }

    // 保护 5：防协议缺失空转 — 连续多轮有工具调用但无 REMAINING 协议且启发式无法推进
    // 移至快照指纹对比之后：若本轮 click 导致页面变化，已在上方重置计数器，不会误停。
    // 仅当连续多轮操作均无页面变化且无协议时，才触发停机。
    if (consecutiveNoProtocolRounds >= 5) {
      finalReply = stripThinking(response.text) || "任务已完成。";
      if (finalReply) callbacks?.onText?.(finalReply);
      stopReason = "no_protocol";
      break;
    }
    if (consecutiveNoProtocolRounds >= 3) {
      const noProtocolHint = [
        "Protocol reminder: REMAINING protocol missing for 3+ rounds with tool calls.",
        "You MUST include REMAINING: <text> or REMAINING: DONE in every response.",
        "If the task is fully complete, return REMAINING: DONE with no tool calls.",
      ].join("\n");
      protocolViolationHint = protocolViolationHint
        ? protocolViolationHint + "\n\n" + noProtocolHint
        : noProtocolHint;
    }
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
    stopReason,
  };

  // 统一发出指标回调
  callbacks?.onMetrics?.(metrics);

  return {
    reply: finalReply,
    toolCalls: allToolCalls,
    messages: resultMessages,
    metrics,
    ...(lastAssertionResult ? { assertionResult: lastAssertionResult } : {}),
    finalSnapshot: pageContext.latestSnapshot,
  };
}

// ─── Re-exports（维持外部 API 面）───
// engine 模块对外暴露的 API 除了 executeAgentLoop 本身，
// 还 re-export 了 snapshot 和 assertion 的关键接口，
// 让外部消费者（web 层、main-agent）可以从 engine/ 一站式导入。
// 注意：core/index.ts barrel export 也会聚合这些，engine re-export 是为了向后兼容。
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
