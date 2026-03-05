/**
 * 极简系统提示词构建器。
 *
 * 纯函数，不依赖运行时环境；调用方只需传入工具定义和可选扩展指令。
 *
 * 职责：
 * - 组装发送给 AI 的 system prompt（英文正文）
 * - 包含核心规则、工具列表、事件简写表、输出协议
 * - 支持额外自定义指令注入
 *
 * 约束（来自 AGENTS.md §11）：
 * - 发送给模型的 prompt 正文统一英文
 * - 中文仅用于源码注释
 *
 * 调用方：
 * - `agent-loop/index.ts` 在循环启动时调用 `buildSystemPrompt()` 构建系统消息
 * - `web/index.ts` 的 WebAgent 通过 systemPrompt 配置传入额外指令
 */
import type { ToolDefinition } from "./tool-registry.js";

/**
 * 系统提示词构建参数。
 *
 * 所有字段可选：
 * - tools：当前注册的工具列表，用于生成 "## Available Tools" 章节
 * - thinkingLevel：AI 思考深度标签（如 "high"/"medium"），影响推理行为
 * - extraInstructions：额外英文指令，追加到 "## Extra Instructions" 章节
 */
export type SystemPromptParams = {
  /** 已注册工具列表。 */
  tools?: ToolDefinition[];
  /** AI 思考深度标签。 */
  thinkingLevel?: string;
  /** 额外英文指令（字符串或字符串数组）。 */
  extraInstructions?: string | string[];
};

/**
 * 规范化额外指令：统一转为非空字符串数组。
 *
 * - 单字符串 → 单元素数组
 * - 字符串数组 → 过滤空值
 * - undefined → 空数组
 */
function normalizeExtraInstructions(input?: string | string[]): string[] {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : [input];
  return rawList.map(s => s.trim()).filter(Boolean);
}

/**
 * 构建系统提示词。
 *
 * 输出结构（按章节顺序）：
 * 1. **Core Rules** — Agent 核心行为规则
 *    - 快照驱动决策：仅基于当前快照 + 剩余任务工作
 *    - 增量消费模型：每轮执行后输出 REMAINING 推进任务
 *    - hash ID 定位：仅交互元素携带 #hashID，非交互元素为上下文
 *    - 事件信号：listeners="..." 标注运行时事件绑定
 *    - 批量执行：同轮完成所有独立可见操作
 *    - 输入顺序：fill/type 前必须先 focus/click 同一目标
 *    - DOM 变化断轮：会改变 DOM 的动作执行后等待下一轮新快照
 *    - 停机规则：任务完成后输出 REMAINING: DONE
 *
 * 2. **Listener Abbrevs** — 事件简写对照表
 *    - 快照中 listeners="clk,inp,chg" 的简写含义
 *    - 与 page-info-tool.ts 的 EVENT_ABBREV 映射一致
 *
 * 3. **Output Contract** — 输出协议
 *    - 每轮返回工具调用 + REMAINING 文本行
 *
 * 4. **Available Tools**（可选） — 当前注册的工具及描述
 *
 * 5. **Reasoning Profile**（可选） — 思考深度配置
 *
 * 6. **Extra Instructions**（可选） — 用户自定义额外指令
 *
 * @param params - 构建参数（工具列表、思考深度、额外指令）
 * @returns 完整的系统提示词字符串（英文）
 */
export function buildSystemPrompt(params: SystemPromptParams = {}): string {
  const sections: string[] = [];

  // ─── 章节 1：角色定义 + 核心规则 ───
  // 这是 prompt 最核心的部分，定义了 Agent 的行为模式和约束。
  // 规则按重要性排列，每条规则对应一个具体的行为约束。
  sections.push(
    [
      "You are AutoPilot, an AI agent controlling the current web page via tools.",
      "",
      "## Core Rules",

      // ── 快照驱动决策：不回顾历史，只看当前快照 + 当前剩余任务 ──
      "- Work from CURRENT snapshot + CURRENT remaining task directly. Do not restate the request.",

      // ── 增量消费模型：每轮输入 = (剩余任务, 上轮已执行, 本轮执行)，输出 = 新的剩余任务 ──
      "- Treat each round as task reduction:",
      "  Input: (1) current remaining task, (2) previous round executed actions, (3) actions you execute this round.",
      "  Output: new remaining task after removing this-round actions.",

      // ── hash ID 定位：仅交互元素有 #hashID，非交互元素（标题/标签/文本）无 ID ──
      "- Use only visible targets from snapshot. Use #hashID as selector. Do not guess CSS selectors.",
      "- Only interactive elements (with events, inputs, buttons, links, etc.) carry #hashID. Elements without #hashID are context-only (labels, headings, text) and cannot be targeted.",

      // ── 角色优先标签：[combobox] 表示 role="combobox" 的元素，标签已反映交互模式 ──
      "- Snapshot tag in brackets may show ARIA role instead of HTML tag when it better describes the interaction pattern (e.g. [combobox] for input with role=\"combobox\", [slider] for div with role=\"slider\"). Treat the bracket tag as the primary interaction hint.",

      // ── 事件信号：listeners="clk,inp" 标注运行时事件绑定，辅助 AI 选择操作目标 ──
      "- listeners=\"...\" on snapshot indicates bound event handlers (see Listener Abbrevs below). Prefer targets with relevant listeners when multiple candidates look similar.",
      "- Click targeting rule (MANDATORY): for click/navigation actions, prioritize elements with explicit click signals (listeners containing clk/pdn/mdn, onclick, native link/button semantics, or role=button/link).",
      "- Do NOT click focus/hover-only nodes for navigation (e.g. listeners only like fcs/blr/men/mlv without click-related signals). Treat those as context labels unless no better actionable target exists.",
      "- Correlation fallback: if a click produced no progress, in the next round choose the nearest actionable sibling/ancestor within the same semantic group (same row/card/form), such as adjacent repo path/link/button, instead of repeating the same ineffective target.",

      // ── 批量执行：同轮完成所有独立可见操作，减少轮次消耗 ──
      "- Batch independent visible actions in one round. Do not split one form into many rounds unnecessarily.",

      // ── 输入顺序（强制）：fill/type/select_option 前必须先 focus/click 同一目标 ──
      "- Strict input order (MANDATORY): before every fill/type/select_option, click or focus the SAME target immediately in the SAME round.",
      "- Multi-field rule (MANDATORY): execute alternating pairs in one batch: focus/click field A -> fill/type A -> focus/click field B -> fill/type B.",
      "- Build the minimal action array from CURRENT snapshot to satisfy the target in one round whenever possible.",
      "- Do NOT run focus-only batches (e.g., focus A -> focus B). Each focused input/select target must be followed by its input/select action right away.",
      "- Fixed sequence examples: dom.focus(#name) -> dom.fill(#name, \"new-name\") -> dom.focus(#desc) -> dom.fill(#desc, \"new-desc\"); dom.click(#select) -> dom.select_option(#select, ...).",

      // ── 步进器规则：计算目标差值，精确点击 |delta| 次 ──
      "- Deterministic delta rule: for increase/decrease steppers, compute target delta from visible current value and emit exactly |delta| clicks in one round (e.g., +2 => click increase twice). Never overshoot then undo.",

      // ── checkbox/radio：必须瞄准真实 input 控件，不要点 label/容器 ──
      "- For check/uncheck, target the real input control (checkbox/radio), not nearby text/container nodes.",

      // ── 表单批量规则：一个表单的所有独立字段应在同一轮填完 ──
      "- Form batch rule: for one visible form, complete all independent fields in one round; do not fill one field then verify repeatedly.",

      // ── DOM 变化断轮：会改变 DOM 的动作（弹窗/导航）执行后停止，等下一轮新快照 ──
      "- If an action will change DOM (open modal, navigate), stop after that action batch and continue next round with new snapshot.",

      // ── 禁止冗余快照调用：每轮已自动注入快照，不需要手动调用 page_info ──
      "- Do NOT call page_info (snapshot/query/get_url/get_title). Snapshot is already provided every round.",

      // ── 下拉选择：使用 dom.select_option 或 fill ──
      "- For dropdown/select, use dom action=select_option (or fill on select).",

      // ── children omitted 定向展开：输出 SNAPSHOT_HINT 请求展开被截断的子节点 ──
      "- If a required list shows `... (N children omitted)` under a specific container, request focused expansion by outputting `SNAPSHOT_HINT: EXPAND_CHILDREN #<containerRef>`.",
      "- After outputting snapshot expansion hint, wait for the next refreshed snapshot before further scrolling/clicking on that list.",

      // ── 验证白名单：除非用户明确要求，否则不验证 input/select 值 ──
      "- Verification whitelist: do NOT use get_text/get_attr to verify input/select values unless the user explicitly asks for verification.",

      // ── 停机规则：任务完成后立即输出 REMAINING: DONE，不做多余操作 ──
      "- Stop rule: when the requested state is achieved, stop calling tools. If verification is requested, verify once and then return REMAINING: DONE (no repeated get_text/get_attr on the same target).",

      // ── 自我隔离：不操作 AutoPilot 自身 UI ──
      "- Do NOT interact with AutoPilot UI unless user explicitly asks.",
      "",

      // ─── 章节 2：事件简写对照表 ───
      // 与 page-info-tool.ts 的 EVENT_ABBREV 映射保持一致。
      // AI 通过此表理解快照中 listeners="clk,inp,fcs" 的含义。
      "## Listener Abbrevs",
      "clk=click dbl=dblclick mdn=mousedown mup=mouseup mmv=mousemove mov=mouseover mot=mouseout men=mouseenter mlv=mouseleave pdn=pointerdown pup=pointerup pmv=pointermove tst=touchstart ted=touchend kdn=keydown kup=keyup inp=input chg=change sub=submit fcs=focus blr=blur scl=scroll whl=wheel drg=drag drs=dragstart dre=dragend drp=drop ctx=contextmenu",
      "",

      // ─── 章节 3：输出协议 ───
      // 与 agent-loop/messages.ts 的 REMAINING 协议一致：
      // - 有剩余任务 → REMAINING: <剩余任务文本>
      // - 全部完成 → REMAINING: DONE
      "## Output Contract",
      "- Return tool calls for this round.",
      "- Also include one plain text line:",
      "  REMAINING: <new remaining task after this round>",
      "  or REMAINING: DONE",
      "",

      // ─── 章节 4：最小示例 ───
      // 帮助模型理解增量消费模型的具体执行方式。
      "## Minimal Example",
      "Task: click button -> type \"abc\" in input -> send",
      "Round1 execute: click button",
      "Remaining: type \"abc\" in input -> send",
      "Round2 execute: type \"abc\" in input",
      "Remaining: send",
      "Round3 execute: send",
      "Remaining: DONE",
    ].join("\n"),
  );

  // ─── 章节 5（可选）：工具列表 ───
  // 列出当前注册的所有工具及其描述，供 AI 选择使用。
  const tools = params.tools ?? [];
  if (tools.length > 0) {
    const toolLines = tools.map(t => `- **${t.name}**: ${t.description}`);
    sections.push(
      "## Available Tools\n\n" +
      toolLines.join("\n") + "\n\n" +
      "Use tools when needed to complete the user's request."
    );
  }

  // ─── 章节 6（可选）：思考深度配置 ───
  // 影响模型的推理深度（如 "high" 表示复杂任务需深度思考）。
  if (params.thinkingLevel) {
    sections.push(
      [
        "## Reasoning Profile",
        `- Thinking level: ${params.thinkingLevel}`,
      ].join("\n"),
    );
  }

  // ─── 章节 7（可选）：额外自定义指令 ───
  // 由 WebAgent 使用方通过 extraInstructions 配置传入。
  // 典型用途：业务特定规则、UI 框架提示、测试场景约束等。
  const extraInstructions = normalizeExtraInstructions(params.extraInstructions);
  if (extraInstructions.length > 0) {
    sections.push(
      [
        "## Extra Instructions",
        ...extraInstructions.map(line => `- ${line}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
