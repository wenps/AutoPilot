/**
 * 紧凑消息构建。
 *
 * 这个文件专门负责“给模型喂什么消息”。
 *
 * 它把 Agent Loop 的运行状态压缩成模型可直接消费的消息内容，核心输入包括：
 * - 用户原始目标（userMessage）
 * - 当前剩余任务（remainingInstruction）
 * - 已执行轨迹（trace / previousRoundTasks）
 * - 上一轮模型输出摘要（previousRoundModelOutput）
 * - 最新页面快照（latestSnapshot）
 * - 协议修复提示（protocolViolationHint）
 *
 * 设计目标：
 * 1) 减少上下文噪音，避免模型复述与空转
 * 2) 强化“基于当前快照做增量决策”的行为
 * 3) 让 REMAINING 协议在每轮都可持续推进
 *
 * 这个文件主要做了 4 件事：
 * 1) UI 意图识别：
 *    - `isExplicitAgentUiRequest` 判断用户是否“明确要求操作 AutoPilot 聊天 UI”。
 *    - 默认情况下会在提示词里禁止模型点击聊天输入框/发送按钮等。
 *
 * 2) 轨迹可读化：
 *    - `formatToolInputBrief`、`formatToolResultBrief`、`buildToolTrace`
 *      把工具输入/结果压成短文本，便于注入上下文和调试展示。
 *    - 直观效果示例（最终会长这样）：
 *      1. [round 2] dom (action="click", selector="#a1b2c") [ELEMENT_NOT_FOUND]
 *      2. [round 2] wait (action="wait_for_selector", selector="#a1b2c")
 *      3. [round 3] dom (action="fill", selector="#x9k3d")
 *
 * 3) Round 0 消息构建：
 *    - 首轮注入“任务 + remaining + 最新快照 + 执行约束”。
 *    - 明确要求模型输出 `REMAINING: ...` 或 `REMAINING: DONE`。
 *
 * 4) Round 1+ 消息构建：
 *    - 不再重复整段原始任务，改为注入“已完成步骤 + 当前 remaining + 最新快照”。
 *    - 追加错误摘要、上轮计划数组、协议修复提示，帮助模型持续收敛。
 *
 * 边界说明（这个文件不做的事）：
 * - 不调用模型、不执行工具
 * - 不维护循环状态（状态维护在 index.ts）
 * - 不读取页面快照（快照读取在 snapshot.ts）
 *
 * 一句话：这里是 Agent Loop 的“消息编排层”，负责把运行态翻译成稳定、高信息密度的提示上下文。
 */
import type { ToolCallResult } from "../tool-registry.js";
import type { AIMessage } from "../types.js";
import { toContentString, hasToolError } from "./helpers.js";
import { wrapSnapshot, SNAPSHOT_REGEX } from "./snapshot/index.js";
import type { ToolTraceEntry } from "./types.js";

/**
 * 显式 UI 意图判定。
 *
 * 用途：默认禁止模型操作 AutoPilot 自己的聊天 UI（输入框/发送按钮等），
 * 只有当用户文本里“同时出现 UI 关键词 + 操作动词”时才放行。
 *
 * 判定逻辑：
 * - `hasAgentUiKeyword`：是否提到聊天面板/输入框/发送按钮等
 * - `hasActionVerb`：是否包含点击/输入/发送等动作意图
 * - 二者都满足才返回 true
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
 * 只保留高价值字段，避免日志过长。
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
 * 读取工具结果首行，拼接错误码，生成一行可读结论：
 * - 成功：`✓ ...`
 * - 失败：`✗ ... [CODE]`
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
 * 1. [round 1] dom (action="click", selector="#btnCreate")
 * 2. [round 1] dom (action="fill", selector="#title") [FILL_NOT_APPLIED]
 * 3. [round 2] wait (action="wait_for_selector", selector="#dialog")
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
 * 构建紧凑消息数组。
 *
 * 两种轮次语义：
 * - Round 0：发送“初始任务 + 当前快照 + 执行约束”
 * - Round 1+：发送“已完成步骤 + 当前 remaining + 最新快照”
 *
 * 渐进式语义：
 * - `remainingInstruction`：当前轮次仍待执行的文本。
 * - `previousRoundTasks`：上一轮已执行的任务数组，避免重复计划。
 * - `previousRoundModelOutput`：上一轮模型输出摘要，用于 task-reduction 输入。
 * - `previousRoundPlannedTasks`：上一轮计划数组，用于对齐“计划 vs 实际执行”。
 * - `protocolViolationHint`：协议修复提示（当 remaining 未完成但模型无动作时）。
 *
 * 输出：符合 AIMessage 结构的消息数组，可直接传给 AIClient.chat。
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
    if (currentUrl) {
      parts.push(`URL: ${currentUrl}`);
    }
    if (latestSnapshot) {
      parts.push(
        "",
        "Use #hashID from snapshot. Do NOT call page_info (snapshot is auto-refreshed). Batch fills freely; at most ONE click (last) per round.",
        "Semantic completion: keep all unresolved user constraints in Remaining until they are visibly satisfied in the snapshot.",
        "Do NOT compress Remaining into a vague shell action that drops required entities, values, counts, filters, destinations, selections, or final outcomes from the user goal.",
        "Before any advance/finalize action, verify the prerequisite constraints are already satisfied in snapshot; otherwise continue the unsatisfied parts first.",
        "Effect check: confirm previous actions' expected effects in current snapshot before planning new actions.",
        "Click ends the round — actions after a click are discarded. Dropdown: open(click) → next round → pick(click).",
        "If a list shows `... (N children omitted)`, output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>` and wait for next snapshot.",
        allowAgentUiInteraction
          ? "User explicitly asked to operate AutoPilot UI. You may interact with chat input/send/dock only as requested."
          : "Do NOT interact with any AI chat UI elements (chat input, send button, dock). Only operate on the actual page content.",
        "Output: REMAINING: <new remaining> or REMAINING: DONE",
        "",
        "## Snapshot",
        wrapSnapshot(latestSnapshot),
      );
    }
    if (protocolViolationHint) {
      parts.push("", protocolViolationHint);
    }
    messages.push({ role: "user", content: parts.join("\n") });
    return messages;
  }

  // ─── Round 1+：注入“已完成步骤 + 执行上下文 + 最新快照” ───
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
    "",
    // ── 关键行为强化（system prompt 已有完整规则，此处补强模型易违反的关键条） ──
    "Batch fills per round; clicks end the round — at most ONE click (last). Do NOT call page_info (snapshot is auto-refreshed).",
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
  ];

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

  if (protocolViolationHint) {
    contextParts.push("", protocolViolationHint);
  }

  if (latestSnapshot) {
    // 若有快照变化摘要，先注入即可读的 diff，再紧跟完整快照
    if (snapshotDiff) {
      contextParts.push(
        "",
        "## Snapshot Changes (since last round)",
        "Lines prefixed with `-` were removed; `+` were added.",
        snapshotDiff,
      );
    }
    // 注入最新快照
    contextParts.push(
      "",
      "## Snapshot",
      wrapSnapshot(latestSnapshot),
    );
  }

  messages.push({ role: "user", content: contextParts.join("\n") });

  return messages;
}
