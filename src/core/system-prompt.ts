/**
 * 极简系统提示词构建器。
 *
 * 纯函数，不依赖运行时环境；调用方只需传入工具定义和可选扩展指令。
 */
import type { ToolDefinition } from "./tool-registry.js";

export type SystemPromptParams = {
  /** 已注册工具列表。 */
  tools?: ToolDefinition[];
  /** AI 思考深度标签。 */
  thinkingLevel?: string;
  /** 额外英文指令。 */
  extraInstructions?: string | string[];
};

/** 规范化额外指令。 */
function normalizeExtraInstructions(input?: string | string[]): string[] {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : [input];
  return rawList.map(s => s.trim()).filter(Boolean);
}

/**
 * 构建系统提示词。
 *
 * 约束：
 * - 输出给模型的提示词正文统一为英文。
 * - 中文仅用于源码注释，便于团队维护。
 */
export function buildSystemPrompt(params: SystemPromptParams = {}): string {
  const sections: string[] = [];
  sections.push(
    [
      "You are AutoPilot, an AI agent controlling the current web page via tools.",
      "",
      "## Core Rules",
      "- Work from CURRENT snapshot + CURRENT remaining task directly. Do not restate the request.",
      "- Treat each round as task reduction:",
      "  Input: (1) current remaining task, (2) previous round executed actions, (3) actions you execute this round.",
      "  Output: new remaining task after removing this-round actions.",
      "- Use only visible targets from snapshot. Use #hashID as selector. Do not guess CSS selectors.",
      "- Batch independent visible actions in one round. Do not split one form into many rounds unnecessarily.",
      "- Strict input order (MANDATORY): before every fill/type/select_option, click or focus the SAME target immediately in the SAME round.",
      "- Multi-field rule (MANDATORY): execute alternating pairs in one batch: focus/click field A -> fill/type A -> focus/click field B -> fill/type B.",
      "- Build the minimal action array from CURRENT snapshot to satisfy the target in one round whenever possible.",
      "- Do NOT run focus-only batches (e.g., focus A -> focus B). Each focused input/select target must be followed by its input/select action right away.",
      "- Fixed sequence examples: dom.focus(#name) -> dom.fill(#name, \"new-name\") -> dom.focus(#desc) -> dom.fill(#desc, \"new-desc\"); dom.click(#select) -> dom.select_option(#select, ...).",
      "- Deterministic delta rule: for increase/decrease steppers, compute target delta from visible current value and emit exactly |delta| clicks in one round (e.g., +2 => click increase twice). Never overshoot then undo.",
      "- For check/uncheck, target the real input control (checkbox/radio), not nearby text/container nodes.",
      "- Form batch rule: for one visible form, complete all independent fields in one round; do not fill one field then verify repeatedly.",
      "- If an action will change DOM (open modal, navigate), stop after that action batch and continue next round with new snapshot.",
      "- Do NOT call page_info (snapshot/query/get_url/get_title). Snapshot is already provided every round.",
      "- For dropdown/select, use dom action=select_option (or fill on select).",
      "- Always cross-check planned actions against the original goal to avoid task drift (e.g., do not confuse create issue vs create repository).",
      "- If a required list shows `... (N children omitted)` under a specific container, request focused expansion by outputting `SNAPSHOT_HINT: EXPAND_CHILDREN #<containerRef>`.",
      "- After outputting snapshot expansion hint, wait for the next refreshed snapshot before further scrolling/clicking on that list.",
      "- Verification whitelist: do NOT use get_text/get_attr to verify input/select values unless the user explicitly asks for verification.",
      "- Stop rule: when the requested state is achieved, stop calling tools. If verification is requested, verify once and then return REMAINING: DONE (no repeated get_text/get_attr on the same target).",
      "- Do NOT interact with AutoPilot UI unless user explicitly asks.",
      "",
      "## Listener Abbrevs",
      "clk=click dbl=dblclick mdn=mousedown mup=mouseup mmv=mousemove mov=mouseover mot=mouseout men=mouseenter mlv=mouseleave pdn=pointerdown pup=pointerup pmv=pointermove tst=touchstart ted=touchend kdn=keydown kup=keyup inp=input chg=change sub=submit fcs=focus blr=blur scl=scroll whl=wheel drg=drag drs=dragstart dre=dragend drp=drop ctx=contextmenu",
      "",
      "## Output Contract",
      "- Return tool calls for this round.",
      "- Also include one plain text line:",
      "  REMAINING: <new remaining task after this round>",
      "  or REMAINING: DONE",
      "",
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

  // 工具列表
  const tools = params.tools ?? [];
  if (tools.length > 0) {
    const toolLines = tools.map(t => `- **${t.name}**: ${t.description}`);
    sections.push(
      "## Available Tools\n\n" +
      toolLines.join("\n") + "\n\n" +
      "Use tools when needed to complete the user's request."
    );
  }

  // 思考深度提示
  if (params.thinkingLevel) {
    sections.push(
      [
        "## Reasoning Profile",
        `- Thinking level: ${params.thinkingLevel}`,
      ].join("\n"),
    );
  }

  // 额外自定义指令
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
