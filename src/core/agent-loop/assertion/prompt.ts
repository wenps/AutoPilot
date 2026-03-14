/**
 * 断言专用 prompt。
 *
 * 这个 prompt 只给断言 AI 使用，与主循环的 system prompt 完全独立。
 * 断言 AI 不带 tools，不参与页面操作，只专注判断"任务是否完成"。
 *
 * 约束（来自 AGENTS.md §11）：
 * - 发送给模型的 prompt 正文统一英文
 * - 中文仅用于源码注释
 */

/**
 * 构建断言系统提示词。
 *
 * 断言 AI 的唯一职责：根据快照 + 操作记录 + 断言描述，判定每条任务断言是否通过。
 * 输出严格的 JSON 格式，便于框架解析。
 */
export function buildAssertionSystemPrompt(): string {
  return [
    "You are a verification judge. Your ONLY job is to determine whether each task assertion has been fulfilled.",
    "",
    "You will receive:",
    "1. A page snapshot (text representation of current page state)",
    "2. A list of actions that were executed",
    "3. One or more task assertions to verify",
    "",
    "For each task assertion, examine the snapshot and actions to determine if the described condition is satisfied.",
    "",
    "## Rules",
    "- Judge ONLY based on the provided snapshot and actions. Do not assume or infer beyond what is visible.",
    "- A task is PASSED only if the snapshot clearly shows the expected outcome described in the assertion.",
    "- If the snapshot does not show clear evidence of completion, the task is FAILED.",
    "- Be strict: partial completion = FAILED.",
    "- `is-active`, `checked`, `selected`, color values, text content, element presence — all must match the assertion description.",
    "",
    "## Output Format",
    "Return ONLY a valid JSON array. No markdown, no explanation, no code fences.",
    "Each element must be: { \"task\": \"<task name>\", \"passed\": true/false, \"reason\": \"<brief reason>\" }",
    "",
    "Example:",
    "[",
    "  { \"task\": \"Select 5 stars\", \"passed\": true, \"reason\": \"All 5 star icons show is-active class\" },",
    "  { \"task\": \"Fill username\", \"passed\": false, \"reason\": \"Username input shows empty value, expected admin\" }",
    "]",
  ].join("\n");
}

/**
 * 构建断言用户消息。
 *
 * 把快照 + 操作记录 + 断言描述打包成一条 user message 发给断言 AI。
 *
 * @param snapshot - 当前页面快照文本
 * @param executedActions - 已执行操作的可读摘要列表
 * @param taskAssertions - 要验证的任务断言列表
 */
export function buildAssertionUserMessage(
  snapshot: string,
  executedActions: string[],
  taskAssertions: Array<{ task: string; description: string }>,
): string {
  const sections: string[] = [];

  // 快照
  sections.push("## Current Page Snapshot");
  sections.push(snapshot || "(empty snapshot)");
  sections.push("");

  // 已执行操作
  sections.push("## Executed Actions");
  if (executedActions.length > 0) {
    for (let i = 0; i < executedActions.length; i++) {
      sections.push(`${i + 1}. ${executedActions[i]}`);
    }
  } else {
    sections.push("(no actions executed yet)");
  }
  sections.push("");

  // 待验证断言
  sections.push("## Task Assertions to Verify");
  for (let i = 0; i < taskAssertions.length; i++) {
    const a = taskAssertions[i];
    sections.push(`${i + 1}. Task: "${a.task}"`);
    sections.push(`   Expected: ${a.description}`);
  }
  sections.push("");
  sections.push("Return the JSON result array now.");

  return sections.join("\n");
}
