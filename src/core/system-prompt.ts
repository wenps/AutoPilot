/**
 * 极简系统提示词构建器（中）/ Minimal system prompt builder (EN).
 *
 * 纯函数，不依赖运行时环境；调用方只需传入工具定义和可选扩展指令。
 * Pure function with no runtime coupling; callers pass tools and optional extra instructions.
 */
import type { ToolDefinition } from "./tool-registry.js";

export type SystemPromptParams = {
  /** 已注册工具列表（中）/ Registered tool definitions (EN). */
  tools?: ToolDefinition[];
  /** AI 思考深度标签（中）/ Optional thinking-level label (EN). */
  thinkingLevel?: string;
  /** 额外英文指令（中）/ Additional English instructions (EN). */
  extraInstructions?: string | string[];
};

/**
 * 规范化额外指令（中）/ Normalize additional instructions (EN).
 */
function normalizeExtraInstructions(input?: string | string[]): string[] {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : [input];
  return rawList.map(s => s.trim()).filter(Boolean);
}

/**
 * 构建系统提示词（中）/ Build system prompt (EN).
 *
 * 约束：
 * - 输出给模型的提示词正文统一为英文。
 * - 中文仅用于代码注释，便于团队维护。
 *
 * Constraints:
 * - Prompt text sent to model stays English-only.
 * - Chinese content is used in code comments only for maintainability.
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
      "- If an action will change DOM (open modal, navigate), stop after that action batch and continue next round with new snapshot.",
      "- Do NOT call page_info (snapshot/query/get_url/get_title). Snapshot is already provided every round.",
      "- For dropdown/select, use dom action=select_option (or fill on select).",
      "- Do NOT interact with AutoPilot UI unless user explicitly asks.",
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

  // 工具列表（中）/ Available tool list (EN).
  const tools = params.tools ?? [];
  if (tools.length > 0) {
    const toolLines = tools.map(t => `- **${t.name}**: ${t.description}`);
    sections.push(
      "## Available Tools\n\n" +
      toolLines.join("\n") + "\n\n" +
      "Use tools when needed to complete the user's request."
    );
  }

  // 思考深度（中）/ Thinking-level hint (EN).
  if (params.thinkingLevel) {
    sections.push(
      [
        "## Reasoning Profile",
        `- Thinking level: ${params.thinkingLevel}`,
      ].join("\n"),
    );
  }

  // 额外指令（中）/ Additional custom instructions (EN).
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
