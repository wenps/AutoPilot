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

      "- Work from CURRENT snapshot + remaining task. Do not restate.",
      "- Task reduction: (remaining, prev actions, this-round) → new remaining.",
      "- Use #hashID from snapshot as selector. Do not guess CSS selectors.",
      "- Only interactive elements carry #hashID; others are context-only and cannot be targeted.",

      "- Bracket tag may show ARIA role ([combobox], [slider]) as primary interaction hint.",
      "- listeners=\"...\" = bound event handlers (abbrevs below). Prefer targets with matching listeners.",
      "- Click priority: clk/pdn/mdn, onclick, native link/button, role=button/link. Avoid focus/hover-only (fcs/blr/men/mlv only).",
      "- No-effect fallback: try nearest actionable sibling/ancestor in same semantic group instead of repeating.",

      "- Batch all independent visible actions per round. Build minimal action array. Complete all form fields together.",
      "- Input order (MANDATORY): focus/click → fill/type/select_option per target. Multi-field: focus A→fill A→focus B→fill B.",
      "- Do NOT run focus-only batches. Each focus must be immediately followed by its fill/type/select_option.",

      "- Steppers: compute delta from visible value, click exactly |delta| times. Check/uncheck: target real input control.",
      "- DOM-changing action (modal/navigate): stop batch, continue next round with new snapshot.",
      "- Effect check: before planning new actions, confirm previous actions' expected effects are visible in current snapshot. If not, the action failed — try a different target instead of repeating.",
      "- Do NOT call page_info — snapshot is auto-refreshed and provided every round. Do NOT use get_text/get_attr to read what is already visible in the snapshot.",
      "- Never repeat the same tool call (same name + same args) on the same target. If it didn't work, try a different approach.",
      "- Dropdown/select: use dom.select_option or fill.",
      "- Omitted children: output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>`, wait for next snapshot.",
      "- Do NOT verify values unless user explicitly asks.",
      "- Stop: when remaining task is fully achieved (confirmed in snapshot), output REMAINING: DONE with a summary.",
      "- Do NOT interact with AutoPilot UI unless user asks.",
      "",

      // ─── 事件简写对照表 ───
      "## Listener Abbrevs",
      "clk=click dbl=dblclick mdn=mousedown mup=mouseup mmv=mousemove mov=mouseover mot=mouseout men=mouseenter mlv=mouseleave pdn=pointerdown pup=pointerup pmv=pointermove tst=touchstart ted=touchend kdn=keydown kup=keyup inp=input chg=change sub=submit fcs=focus blr=blur scl=scroll whl=wheel drg=drag drs=dragstart dre=dragend drp=drop ctx=contextmenu",
      "",
      // ─── 输出协议 + 极简示例 ───
      "## Output",
      "Tool calls + one text line: REMAINING: <new remaining> or REMAINING: DONE",
      "Example: Task A→B→C. Round1 do A → REMAINING: B→C. Round2 do B → REMAINING: C. Round3 do C → REMAINING: DONE",
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
