/**
 * Engine 消息编排层 — 将执行状态翻译成模型可消费的高密度提示上下文。
 *
 * ═══ 在 v2 多 Agent 架构中的位置 ═══
 *
 * ```
 * core/
 * ├── shared/          ← 无状态基础设施（types, helpers, snapshot, recovery, constants）
 * ├── assertion/       ← 独立判定层（断言 AI，不执行工具）
 * ├── micro-task/      ← 数据结构层（任务描述、执行链、监控器）
 * ├── engine/
 * │   ├── messages.ts  ← 【当前文件】消息编排（Round 语义、REMAINING 协议、轨迹格式化）
 * │   └── index.ts     ← 决策主循环（executeAgentLoop）
 * └── main-agent/      ← 未来：分析 + 调度 + 执行（调用 engine 执行微任务）
 * ```
 *
 * **为什么放在 engine/ 而不是 shared/?**
 * 消息编排包含 engine 专有语义——Round 0 vs 1+ 的分支逻辑、REMAINING 协议注入、
 * 轨迹摘要格式、快照 diff 注入、断言进度渲染——这些概念不被 micro-task 或
 * assertion 复用，不属于 shared 层的"无状态基础设施"。
 *
 * **统一引擎，两种模式：**
 * v2 中 main-agent 直接执行和 micro-task 执行共享同一个 executeAgentLoop，
 * 区别仅在 AgentLoopParams（systemPrompt / maxRounds / assertionConfig）。
 * 本文件的消息编排对两种模式透明——无论是主 Agent 的 40 轮长循环还是
 * 微任务的 8 轮短循环，消息结构完全一致。
 *
 * ═══ 职责边界 ═══
 *
 * 这个文件做 4 件事：
 *
 * 1) **UI 意图识别**
 *    `isExplicitAgentUiRequest` — 判断用户是否明确要求操作 AutoPilot 聊天 UI。
 *    默认在提示词中禁止模型点击聊天输入框/发送按钮；
 *    仅当文本同时出现 UI 关键词 + 操作动词时放行。
 *    → 测试覆盖：messages.test.ts "默认不误触" / "明确指令可执行"
 *
 * 2) **轨迹可读化**
 *    `formatToolInputBrief` / `formatToolResultBrief` / `buildToolTrace`
 *    把工具输入/结果压成短文本，注入上下文或调试展示。
 *    示例输出：`1. [round 2] dom (action="click", selector="#a1b2c") [ELEMENT_NOT_FOUND]`
 *
 * 3) **Round 0 消息构建**
 *    首轮注入"任务 + remaining + 最新快照 + 执行约束"，
 *    明确要求模型输出 `REMAINING: ...` 或 `REMAINING: DONE`。
 *    → 测试覆盖：messages.test.ts "默认不误触"（验证 Round 0 消息结构）
 *
 * 4) **Round 1+ 消息构建**
 *    不再重复原始 userMessage，改为：
 *    - assistant 消息：Done steps 摘要（防止模型重复已完成动作）
 *    - user 消息：Original Goal + Remaining + 快照 + 错误摘要 + 协议约束
 *    → 测试覆盖：messages.test.ts "Round1+ 不再重复携带原始 userMessage"
 *                                  "Round1+ 注入上一轮模型输出与计划批次"
 *
 * 这个文件**不做**的事：
 * - 不调用模型（模型调用在 engine/index.ts）
 * - 不执行工具（工具执行在 engine/index.ts 的阶段 4）
 * - 不维护循环状态（状态维护在 engine/index.ts 的闭包变量中）
 * - 不读取页面快照（快照读取委托 shared/snapshot/）
 *
 * ═══ 依赖关系 ═══
 *
 * ```
 * engine/messages.ts
 *   ├── shared/tool-registry  → ToolCallResult 类型
 *   ├── shared/types          → AIMessage, ToolTraceEntry 类型
 *   ├── shared/helpers        → toContentString(), hasToolError()
 *   ├── shared/snapshot       → wrapSnapshot(), SNAPSHOT_REGEX
 *   └── assertion/types       → AssertionResult（断言进度注入）
 * ```
 */
import type { ToolCallResult } from "../shared/tool-registry.js";
import type { AIMessage } from "../shared/types.js";
import { toContentString, hasToolError } from "../shared/helpers.js";
import { wrapSnapshot, SNAPSHOT_REGEX } from "../shared/snapshot/index.js";
import type { ToolTraceEntry } from "../shared/types.js";
import type { AssertionResult } from "../assertion/types.js";

/**
 * 显式 UI 意图判定。
 *
 * 用途：默认禁止模型操作 AutoPilot 自己的聊天 UI（输入框/发送按钮等），
 * 只有当用户文本里"同时出现 UI 关键词 + 操作动词"时才放行。
 *
 * 判定逻辑：
 * - `hasAgentUiKeyword`：是否提到聊天面板/输入框/发送按钮等
 * - `hasActionVerb`：是否包含点击/输入/发送等动作意图
 * - 二者都满足才返回 true
 *
 * @example 放行场景（UI 关键词 + 操作动词 同时出现）
 * ```ts
 * isExplicitAgentUiRequest("帮我在指令输入框输入11然后发送")  // true
 * isExplicitAgentUiRequest("在消息输入框填入11并点击发送按钮") // true
 * ```
 *
 * @example 拦截场景（仅包含其一或都不包含）
 * ```ts
 * isExplicitAgentUiRequest("帮我填写表单并提交") // false — "表单"不属于 Agent UI 关键词
 * isExplicitAgentUiRequest("看看聊天面板")       // false — 无操作动词
 * ```
 *
 * @see messages.test.ts — "默认不误触" / "明确指令可执行" 两个用例覆盖此函数
 */
export function isExplicitAgentUiRequest(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  const compact = lower.replace(/[\s\p{P}\p{S}]+/gu, "");

  const hasAgentUiKeyword =
    /(chat|dock|chatinput|sendbutton|shortcut|quicktest)/i.test(lower) ||
    /(聊天|对话|指令输入框|消息输入框|输入框|发送按钮|发送|快捷测试|测试按钮|聊天面板)/.test(compact);

  const hasActionVerb =
    /(press|click|type|fill|send|input|submit|enter)/i.test(lower) ||
    /(输入|点击|发送|填写|填入|操作|提交|回车|按下)/.test(compact);
  return hasAgentUiKeyword && hasActionVerb;
}

// ─── 格式化辅助 ───

/**
 * 输入摘要。
 *
 * 把工具输入压缩成一段短文本（用于轨迹展示），
 * 只保留高价值字段（action / selector / url / text 等），避免日志过长。
 * 字符串值截断到 80 字符，数值/布尔值直接转文本。
 *
 * @example
 * ```ts
 * formatToolInputBrief({ action: "click", selector: "#btn" })
 * // → ' (action="click", selector="#btn")'
 *
 * formatToolInputBrief({ action: "fill", selector: "#input", value: "hello" })
 * // → ' (action="fill", selector="#input")'  // value 不在白名单中，被过滤
 *
 * formatToolInputBrief(null)  // → ""
 * formatToolInputBrief({})    // → ""（无匹配字段）
 * ```
 *
 * 此函数在两处被调用：
 * 1. buildToolTrace — 生成可读的工具轨迹文本（如 `1. [round 2] dom (action="click", selector="#btn")`)
 * 2. executeAgentLoop — 构建断言的 actionSummaries（发给断言 AI 判定动作效果）
 */
export function formatToolInputBrief(input: unknown): string {
  if (!input || typeof input !== "object") return "";

  const params = input as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ["action", "selector", "waitMs", "waitSeconds", "url", "text"]) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      parts.push(`${key}=${JSON.stringify(value).slice(0, 80)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    }
  }

  if (parts.length === 0) return "";
  return ` (${parts.join(", ")})`;
}

/**
 * 结果摘要。
 *
 * 读取工具结果首行，拼接错误码，生成一行可读结论。
 * 仅在 buildCompactMessages 的 Round 1+ 分支中使用，
 * 为 assistant 消息中的"Done steps"列表提供每条工具的执行结论。
 *
 * 输出格式：
 * - 成功：`✓ dom ok`
 * - 失败：`✗ 未找到元素 [ELEMENT_NOT_FOUND]`
 *
 * @example 对应测试场景
 * ```
 * // index.test.ts — "弹窗跨轮" 用例
 * // 第 2 轮 assert 验证 messages 中包含 "Done steps" + "openModal"
 * // 正是 formatToolResultBrief 生成的 "✓ dom ok" 让 "Done steps" 行中出现 openModal
 * ```
 */
function formatToolResultBrief(result: ToolCallResult): string {
  const content = toContentString(result.content);
  const firstLine = content.split("\n").find(l => l.trim())?.trim().slice(0, 80) ?? "";

  if (hasToolError(result)) {
    const code = result.details && typeof result.details === "object"
      ? (result.details as { code?: string }).code
      : undefined;
    return `✗ ${firstLine}${code ? ` [${code}]` : ""}`;
  }
  return `✓ ${firstLine}`;
}

// ─── 轨迹格式化 ───

/**
 * 轨迹格式化。
 *
 * 将完整工具轨迹转为可读文本列表，供提示词注入或调试展示。
 * 支持附加 current 条目（未入库前的临时展示）。
 *
 * 输出样式示例：
 * ```
 * 1. [round 1] dom (action="click", selector="#btnCreate")
 * 2. [round 1] dom (action="fill", selector="#title") [FILL_NOT_APPLIED]
 * 3. [round 2] wait (action="wait_for_selector", selector="#dialog")
 * ```
 *
 * 每行包含：
 * - 序号（从 1 开始）
 * - 所属轮次 `[round N]`
 * - 工具名 + 输入摘要（由 formatToolInputBrief 生成）
 * - 错误码 `[CODE]`（仅失败时）
 * - 标记 `marker`（用于特殊标注，如 recovery 标记）
 *
 * @param trace   - 已入库的完整工具轨迹数组
 * @param current - 可选的当前条目（尚未入库但需临时展示，用于实时 UI 反馈）
 * @returns 格式化后的多行文本，或 "(暂无工具执行记录)" 当 trace 为空且无 current 时
 */
export function buildToolTrace(
  trace: ToolTraceEntry[],
  current?: {
    round: number;
    name: string;
    input: unknown;
    result?: ToolCallResult;
    marker?: string;
  },
): string {
  const lines = trace.map((entry, index) => {
    const code =
      entry.result.details && typeof entry.result.details === "object"
        ? (entry.result.details as { code?: unknown }).code
        : undefined;
    const codeText = typeof code === "string" ? ` [${code}]` : "";
    const marker = entry.marker ? ` ${entry.marker}` : "";
    return `${index + 1}. [round ${entry.round}] ${entry.name}${formatToolInputBrief(entry.input)}${codeText}${marker}`;
  });

  if (current) {
    const code =
      current.result?.details && typeof current.result.details === "object"
        ? (current.result.details as { code?: unknown }).code
        : undefined;
    const codeText = typeof code === "string" ? ` [${code}]` : "";
    const marker = current.marker ? ` ${current.marker}` : "";
    lines.push(
      `${lines.length + 1}. [round ${current.round}] ${current.name}${formatToolInputBrief(current.input)}${codeText}${marker}`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : "(暂无工具执行记录)";
}

// ─── 紧凑消息构建 ───

/**
 * 构建紧凑消息数组 — engine 消息编排的核心函数。
 *
 * 每轮由 executeAgentLoop 调用一次，将运行态翻译成 AIMessage[] 传给 AIClient.chat。
 * 无论 main-agent 模式（40 轮）还是 micro-task 模式（8 轮），消息结构完全一致。
 *
 * ═══ 两种轮次语义 ═══
 *
 * **Round 0**（trace 为空）：
 * 单条 user 消息，结构为 `用户目标 + Remaining + URL + 快照 + 行为约束`。
 * 注入完整的执行约束（禁 page_info、禁误触 Agent UI、REMAINING 协议要求）。
 * → 测试覆盖：messages.test.ts "默认不误触" 验证 Round 0 输出包含 Agent UI 约束
 *
 * **Round 1+**（trace 非空）：
 * 两条消息——assistant（Done steps 摘要）+ user（执行上下文 + 快照）。
 * 不再重复原始 userMessage，避免模型每轮回到起点重做。
 * → 测试覆盖：messages.test.ts "Round1+ 不再重复携带原始 userMessage"
 * → 测试覆盖：index.test.ts "弹窗跨轮" 验证第 2 轮 assistant 消息包含 Done steps
 *
 * ═══ 渐进式语义参数说明 ═══
 *
 * @param userMessage               - 用户原始目标文本（全轮不变，Round 1+ 作为 "Original Goal" 注入）
 * @param trace                     - 完整工具轨迹（ToolTraceEntry[]），Round 0 为空
 * @param latestSnapshot            - 最新页面快照（每轮由 refreshSnapshot 刷新）
 * @param currentUrl                - 当前页面 URL（导航后由 handleNavigationUrlChange 更新）
 * @param history                   - 可选的多轮历史消息（用于多轮记忆场景）
 * @param remainingInstruction      - 当前轮次仍待执行的文本（REMAINING 协议或启发式推进的结果）
 * @param previousRoundTasks        - 上一轮已执行的任务数组（`["dom:{...}"]` 格式，防重复）
 * @param previousRoundModelOutput  - 上一轮模型输出摘要（用于 task-reduction 对齐）
 * @param previousRoundPlannedTasks - 上一轮计划数组（用于 "Previous planned" 注入，对齐计划 vs 实际）
 * @param protocolViolationHint     - 协议修复提示（remaining 未完成但模型无动作时注入）
 * @param snapshotDiff              - 快照变化摘要（Round 1+ 由 computeSnapshotDiff 生成）
 * @param taskChecklist             - 结构化任务进度（多步任务拆分后的 ✅/□ checklist）
 * @param lastAssertionResult       - 上一轮断言结果（断言未全部通过时注入进度提示）
 *
 * @returns AIMessage[] — 可直接传给 AIClient.chat 的消息数组
 *
 * ═══ 消息结构示意 ═══
 *
 * Round 0:
 * ```
 * [{ role: "user", content: "用户目标\n\nRemaining: ...\n\n## Snapshot\n..." }]
 * ```
 *
 * Round 1+:
 * ```
 * [
 *   { role: "assistant", content: "Done steps (do NOT repeat):\n✅ 1. dom (action=...) → ✓ dom ok" },
 *   { role: "user", content: "Original Goal: ...\n\nRemaining: ...\n\n## Snapshot\n..." }
 * ]
 * ```
 */
export function buildCompactMessages(
  userMessage: string,
  trace: ToolTraceEntry[],
  latestSnapshot: string | undefined,
  currentUrl: string | undefined,
  history?: AIMessage[],
  remainingInstruction?: string,
  previousRoundTasks?: string[],
  previousRoundModelOutput?: string,
  previousRoundPlannedTasks?: string[],
  protocolViolationHint?: string,
  snapshotDiff?: string,
  taskChecklist?: string,
  lastAssertionResult?: AssertionResult,
  focusedModeContext?: {
    focusedSnapshot: string;
    focusTargetRef: string;
    baseDiff?: string;
  },
): AIMessage[] {
  const messages: AIMessage[] = history ? [...history] : [];
  const allowAgentUiInteraction = isExplicitAgentUiRequest(userMessage);
  const activeInstruction = (remainingInstruction && remainingInstruction.trim())
    ? remainingInstruction.trim()
    : userMessage;

  // ─── Round 0：任务描述 + 快照，一条 user 消息完成注入 ───
  if (trace.length === 0) {
    // 结构说明：
    // 1) 用户目标
    // 2) 当前 remaining
    // 3) URL（可选）
    // 4) 快照 + 行为约束（禁 page_info、禁误触 Agent UI、要求 REMAINING 输出）
    const parts: string[] = [
      userMessage,
      "",
      `Remaining: ${activeInstruction}`,
    ];
    if (taskChecklist) {
      parts.push("", "## Task Progress", taskChecklist, "Focus on the current task (marked ← current). When it is visibly done in snapshot, update REMAINING to drop it.");
    }
    if (currentUrl) {
      parts.push(`URL: ${currentUrl}`);
    }
    if (latestSnapshot) {
      const focusedInstructions = focusedModeContext
        ? "In focused mode: output `FOCUS_TARGET: #hashId` to set/change your focus target for next round.\n"
        : "";
      parts.push(
        "",
        "Use #hashID from snapshot. Do NOT call page_info (snapshot is auto-refreshed). Batch fills freely; at most ONE click (last) per round.",
        "Completion = VISIBLE OUTCOME in snapshot, not finishing every sub-step. If snapshot already shows the goal state (color is red, switch is off, value filled, etc.), output REMAINING: DONE — do NOT retry, verify, or click OK/confirm.",
        "Semantic completion: keep all unresolved user constraints in Remaining until they are visibly satisfied in the snapshot.",
        "Do NOT compress Remaining into a vague shell action that drops required entities, values, counts, filters, destinations, selections, or final outcomes from the user goal.",
        "Before any advance/finalize action, verify the prerequisite constraints are already satisfied in snapshot; otherwise continue the unsatisfied parts first.",
        "Effect check: confirm previous actions' expected effects in current snapshot before planning new actions.",
        "Click ends the round — actions after a click are discarded. Dropdown: open(click) → next round → pick(click).",
        "If a list shows `... (N children omitted)`, output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>` and wait for next snapshot.",
        allowAgentUiInteraction
          ? "User explicitly asked to operate AutoPilot UI. You may interact with chat input/send/dock only as requested."
          : "Do NOT interact with any AI chat UI elements (chat input, send button, dock). Only operate on the actual page content.",
        focusedInstructions + "Output: REMAINING: <new remaining> or REMAINING: DONE",
      );
      // 聚焦模式：注入聚焦区域 + 基准 diff；否则注入全量快照
      if (focusedModeContext) {
        parts.push(
          "",
          `## Focused Area (target: #${focusedModeContext.focusTargetRef})`,
          wrapSnapshot(focusedModeContext.focusedSnapshot),
        );
        if (focusedModeContext.baseDiff) {
          parts.push(
            "",
            "## Changes Since Task Start",
            "Lines prefixed with `-` were removed; `+` were added.",
            focusedModeContext.baseDiff,
          );
        }
      } else {
        parts.push(
          "",
          "## Snapshot",
          wrapSnapshot(latestSnapshot),
        );
      }
    }
    if (protocolViolationHint) {
      parts.push("", protocolViolationHint);
    }
    messages.push({ role: "user", content: parts.join("\n") });
    return messages;
  }

  // ─── Round 1+：注入"已完成步骤 + 执行上下文 + 最新快照" ───
  // 不再重复原始 userMessage，避免模型每轮回到起点重做。

  // 第 1 条 assistant 消息：已完成步骤摘要（从 trace 重建）
  const traceParts: string[] = [];
  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i];
    const isError = hasToolError(entry.result);
    const brief = formatToolResultBrief(entry.result);
    const status = isError ? "❌" : "✅";
    const marker = entry.marker ? ` ${entry.marker}` : "";
    traceParts.push(
      `${status} ${i + 1}. ${entry.name}${formatToolInputBrief(entry.input)} → ${brief}${marker}`,
    );
  }
  messages.push({
    role: "assistant",
    content: `Done steps (do NOT repeat):\n${traceParts.join("\n")}`,
  });

  // 第 2 条 user 消息：执行上下文 + 协议约束 + 最新快照
  const hasErrors = trace.some(e => hasToolError(e.result));
  const contextParts: string[] = [
    // 原始用户目标（对照组，防偏航）
    `Original Goal: ${userMessage}`,
    "",
    // 当前剩余任务（唯一待消费目标）
    `Remaining: ${activeInstruction}`,
  ];

  // 结构化任务进度（多步任务时注入）
  if (taskChecklist) {
    contextParts.push("", "## Task Progress", taskChecklist, "Focus on the current task (marked ← current). When it is visibly done in snapshot, update REMAINING to drop it.");
  }

  contextParts.push(
    "",
    // ── 关键行为强化 ──
    "Batch fills per round; clicks end the round — at most ONE click (last). Do NOT call page_info (snapshot is auto-refreshed).",
    "Completion = VISIBLE OUTCOME in snapshot, not finishing every sub-step. If snapshot already shows the goal state (color is red, switch is off, value filled, etc.), output REMAINING: DONE — do NOT retry, verify, or click OK/confirm.",
    "Semantic completion: preserve all unresolved user constraints in Remaining until they are visibly satisfied in the snapshot.",
    "Do NOT narrow Remaining into only a shell action if that would drop required entities, values, counts, filters, destinations, selections, or final outcomes.",
    "Before any advance/finalize action, check that all prerequisite constraints are already visible in the snapshot.",
    "Effect check: confirm previous actions' expected effects in snapshot before planning new actions.",
    "Never repeat the same tool call on the same target. If no effect, try a different element.",
    "Click ends the round — actions after a click are discarded. Dropdown: open(click) → next round → pick(click).",
    "If a list shows `... (N children omitted)`, output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>` and wait.",
    allowAgentUiInteraction
      ? "User explicitly asked to operate AutoPilot UI."
      : "Do NOT interact with AI chat UI elements.",
    "Output: REMAINING: <new remaining> or REMAINING: DONE",
  );

  if (hasErrors) {
    contextParts.push("", "Last step failed. Retry differently or skip to other targets.");
  } else {
    contextParts.push("", "If fully done, reply summary only (no tools).");
  }

  if (previousRoundTasks && previousRoundTasks.length > 0) {
    // 上轮已执行 + 简短效果提示（非阻塞，避免分析瘧痪）
    contextParts.push(
      "",
      "Previous executed:",
      ...previousRoundTasks.map((task, index) => `${index + 1}. ${task}`),
      "If any had no visible effect (snapshot unchanged), do NOT repeat — try a child <a>/<button> inside the target, or a sibling/parent with stronger click signal.",
    );
  }

  if (previousRoundPlannedTasks && previousRoundPlannedTasks.length > 0) {
    contextParts.push(
      "",
      "Previous planned:",
      ...previousRoundPlannedTasks.map((task, index) => `${index + 1}. ${task}`),
    );
  }

  if (previousRoundModelOutput) {
    contextParts.push(
      "",
      "Previous model output:",
      previousRoundModelOutput,
    );
  }

  // 最近失败摘要
  const lastEntry = trace[trace.length - 1];
  if (hasToolError(lastEntry.result)) {
    const detail = toContentString(lastEntry.result.content);
    const stripped = detail.replace(SNAPSHOT_REGEX, "").trim();
    if (stripped && stripped.length < 300) {
      contextParts.push("", "Error: " + stripped);
    }
  }

  if (currentUrl) {
    contextParts.push("", `URL: ${currentUrl}`);
  }

  // 断言进度注入：让 AI 清晰看到哪些断言已通过、哪些仍需努力
  if (lastAssertionResult && !lastAssertionResult.allPassed) {
    const progressLines: string[] = [
      `## Assertion Progress (${lastAssertionResult.passed}/${lastAssertionResult.total} passed)`,
    ];
    for (const d of lastAssertionResult.details) {
      progressLines.push(d.passed ? `✓ "${d.task}": ${d.reason}` : `✗ "${d.task}": ${d.reason}`);
    }
    progressLines.push(
      "",
      "Focus on the FAILED assertions above. Do NOT repeat actions for passed assertions.",
      "Call `assert({})` again when you believe the failed assertions should now pass.",
    );
    contextParts.push("", ...progressLines);
  }

  if (protocolViolationHint) {
    contextParts.push("", protocolViolationHint);
  }

  if (latestSnapshot) {
    // 聚焦模式：注入轮间 diff + 聚焦区域 + 基准 diff
    if (focusedModeContext) {
      if (snapshotDiff) {
        contextParts.push(
          "",
          "## Snapshot Changes (since last round)",
          "Lines prefixed with `-` were removed; `+` were added.",
          snapshotDiff,
        );
      }
      contextParts.push(
        "",
        `## Focused Area (target: #${focusedModeContext.focusTargetRef})`,
        wrapSnapshot(focusedModeContext.focusedSnapshot),
      );
      if (focusedModeContext.baseDiff) {
        contextParts.push(
          "",
          "## Changes Since Task Start",
          "Lines prefixed with `-` were removed; `+` were added.",
          focusedModeContext.baseDiff,
        );
      }
    } else {
      // 非聚焦模式：注入轮间 diff + 全量快照
      if (snapshotDiff) {
        contextParts.push(
          "",
          "## Snapshot Changes (since last round)",
          "Lines prefixed with `-` were removed; `+` were added.",
          snapshotDiff,
        );
      }
      contextParts.push(
        "",
        "## Snapshot",
        wrapSnapshot(latestSnapshot),
      );
    }
  }

  messages.push({ role: "user", content: contextParts.join("\n") });

  return messages;
}
