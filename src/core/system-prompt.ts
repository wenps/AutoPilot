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
/**
 * 系统提示词构建参数。
 *
 * 所有字段可选：
 * - thinkingLevel：AI 思考深度标签（如 "high"/"medium"），影响推理行为
 * - listenerEvents：快照中实际会输出的 listener 事件集合，用于同步缩写说明
 * - extraInstructions：额外英文指令，追加到 "## Extra Instructions" 章节
 */
export type SystemPromptParams = {
  /** AI 思考深度标签。 */
  thinkingLevel?: string;
  /** 允许在 Listener Abbrevs 中输出的事件白名单。 */
  listenerEvents?: string[];
  /** 额外英文指令（字符串或字符串数组）。 */
  extraInstructions?: string | string[];
  /**
   * 断言任务描述列表（可选）。
   *
   * 传入后会在 system prompt 中注入断言能力说明，
   * 告知 AI 可以在合适时机调用 assert 工具触发断言验证。
   */
  assertionTasks?: Array<{ task: string; description: string }>;
};

const LISTENER_ABBREV_MAP: Record<string, string> = {
  click: "clk",
  dblclick: "dbl",
  mousedown: "mdn",
  mouseup: "mup",
  mousemove: "mmv",
  mouseover: "mov",
  mouseout: "mot",
  mouseenter: "men",
  mouseleave: "mlv",
  pointerdown: "pdn",
  pointerup: "pup",
  pointermove: "pmv",
  touchstart: "tst",
  touchend: "ted",
  keydown: "kdn",
  keyup: "kup",
  input: "inp",
  change: "chg",
  submit: "sub",
  focus: "fcs",
  blur: "blr",
  scroll: "scl",
  wheel: "whl",
  drag: "drg",
  dragstart: "drs",
  dragend: "dre",
  drop: "drp",
  contextmenu: "ctx",
};

const DEFAULT_SYSTEM_PROMPT_LISTENER_EVENTS = [
  "click",
  "input",
  "change",
  "mousedown",
  "pointerdown",
  "keydown",
  "submit",
  "focus",
  "blur",
];

function buildListenerAbbrevLine(listenerEvents?: string[]): string {
  const allowed = (listenerEvents && listenerEvents.length > 0)
    ? listenerEvents
    : DEFAULT_SYSTEM_PROMPT_LISTENER_EVENTS;

  const normalized = allowed
    .map(event => event.trim().toLowerCase())
    .filter(Boolean);

  const unique = [...new Set(normalized)];
  const pairs = unique
    .map(event => {
      const abbrev = LISTENER_ABBREV_MAP[event];
      return abbrev ? `${abbrev}=${event}` : null;
    })
    .filter((pair): pair is string => !!pair);

  return pairs.join(" ");
}

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
 * 4. **Reasoning Profile**（可选） — 思考深度配置
 *
 * 5. **Extra Instructions**（可选） — 用户自定义额外指令
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

      "- **Original Goal Anchor:** The user's original input is provided as `Original Goal` every round. Your plan and each action must NEVER deviate from it. If the current page shows a 'Create X' button but the user said 'go to X', you must navigate INTO existing X, NOT create a new one.",
      "- **Goal decomposition:** Distinguish the TARGET entity from the ACTION to perform. 'go to X and do Y' = locate X → enter X → do Y inside X. 'create X' = make a new X. 'edit X' = find existing X → modify it. Never confuse navigating to an entity with creating/deleting/modifying it. If the target entity is not visible, search or filter for it first — do not pick the nearest similarly-named button.",

      "- Work from CURRENT snapshot + remaining task. Do not restate.",
      "- Task reduction: (remaining, prev actions, this-round) → new remaining.",
      "- Use #hashID from snapshot as selector. Do not guess CSS selectors.",
      "- Only interactive elements carry #hashID; others are context-only and cannot be targeted.",

      "- Bracket tag may show ARIA role ([combobox], [slider]) as primary interaction hint.",
      "- listeners=\"...\" = bound event handlers (abbrevs below). Prefer targets with matching listeners.",
      "- Click target MUST have click signal: listeners containing clk/pdn/mdn, or onclick attr, or native <a>/<button>, or role=button/link. NEVER click elements with only blr/fcs (focus/blur) — they are not click targets.",
      "- If the text you want to click has no click signal, look at its parent row/container or nearby sibling that does have clk listener.",
      "- No-effect fallback: if a click produced no page change (snapshot unchanged), do NOT repeat the same target. Instead: (1) look for <a> links or <button> inside the clicked container; (2) try a parent or sibling with stronger click signal; (3) try a completely different approach (e.g., search, filter, sidebar navigation, or use evaluate to trigger the action programmatically).",

      "- Batch fill/type/check/select_option freely within one round. A click always ends the round — send at most ONE click as the LAST action in a batch.",
      "- fill/type/select_option auto-focus: these actions automatically click and focus the target before input — do NOT send a separate focus/click before them.",
      "- Search/filter inputs: after fill, press Enter (or click search button) to trigger the search. Do not assume fill alone submits.",

      "- Steppers: compute delta from visible value, click exactly |delta| times. Check/uncheck: target real input control.",
      "- One-shot preconditions: actions like timed waits, confirmations, navigation, or any setup step that appears in previous actions are DONE — strip them from REMAINING and move on. Never re-execute a completed precondition.",
      "- DOM-changing action (click/modal/navigate): ends the round, next snapshot follows. Actions sent after a click in the same batch are discarded.",
      "- Intermediate progress is NOT completion: if an action only opens, expands, reveals, filters, paginates, switches context, or loads the next step, keep REMAINING on the final user goal until the requested end state/value/content is visible in the snapshot.",
      "- Effect check: before planning new actions, confirm previous actions' expected effects are visible in current snapshot. If the snapshot is unchanged after a click, the click FAILED — you MUST pick a different element (e.g., an <a> or <button> child inside the row, or the link text itself).",
      "- page_info.snapshot is an INTERNAL framework action. Snapshot is auto-refreshed and provided every round, so never call it directly. Other page_info actions (get_url, get_title, get_viewport, query_all, get_selection) are allowed when needed. Do NOT use get_text/get_attr to read what is already visible in the snapshot.",
      "- Never repeat the same tool call (same name + same args) on the same target. If it didn't work, try a different approach.",
      "- Dropdown/select: prefer dom.select_option (works in one round). For custom dropdowns requiring click-to-open: click → wait for next snapshot → click option (two rounds).",
      "- Omitted children: output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>`, wait for next snapshot.",
      "- Do NOT verify values unless user explicitly asks.",
      "- Completion = visible outcome in snapshot, not every planned sub-step executed. If snapshot already shows the expected result (color changed, switch toggled, value present, dialog closed, etc.), the task IS done.",
      "- Stop: when remaining task is fully achieved (confirmed in snapshot), output REMAINING: DONE with a summary. Do NOT call page_info or retry to verify — the snapshot is authoritative.",
      "- Do NOT interact with AutoPilot UI unless user asks.",
      "",

      // ─── 事件简写对照表 ───
      "## Listener Abbrevs",
      buildListenerAbbrevLine(params.listenerEvents),
      "",
      // ─── 输出协议 + 极简示例 ───
      "## Output",
      "Tool calls + one text line: REMAINING: <new remaining> or REMAINING: DONE",
      "Example: Task A→B→C. Round1 do A → REMAINING: B→C. Round2 do B → REMAINING: C. Round3 do C → REMAINING: DONE",
    ].join("\n"),
  );

  // ─── 章节 4（可选）：思考深度配置 ───
  // 影响模型的推理深度（如 "high" 表示复杂任务需深度思考）。
  if (params.thinkingLevel) {
    sections.push(
      [
        "## Reasoning Profile",
        `- Thinking level: ${params.thinkingLevel}`,
      ].join("\n"),
    );
  }

  // ─── 章节 5（可选）：额外自定义指令 ───
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

  // ─── 章节 6：断言能力说明（始终注入） ───
  // assert 是内置工具，AI 认为任务完成时主动调用。
  {
    const lines: string[] = [
      "## Assertion Capability",
      "You have an `assert` tool to verify task completion. When called, an independent verification AI will judge whether the task has been fulfilled based on the current snapshot and your actions.",
      "",
      "### When to call assert",
      "- Call `assert` AFTER you believe the task is complete and the expected outcome should be visible in the snapshot.",
      "- You can include `assert` alongside other tool calls in the same round. The framework will execute all other tools first, wait for page stability, then run the assertion.",
      "- Do NOT call `assert` on every round — only when you expect the task to pass verification.",
      "- Avoid calling `assert` immediately after a DOM-changing action in the same round if the effect may not be visible yet; wait for the next round's snapshot.",
    ];

    if (params.assertionTasks && params.assertionTasks.length > 0) {
      const taskLines = params.assertionTasks.map(
        (a, i) => `  ${i + 1}. "${a.task}": ${a.description}`,
      );
      lines.push(
        "",
        "### Task assertions to verify",
        ...taskLines,
      );
    }

    lines.push(
      "",
      "### How to call",
      "Call the `assert` tool with no parameters: `assert({})`",
      "The framework handles all assertion logic internally.",
    );

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}
