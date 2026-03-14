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
    "1. An initial page snapshot (the page state BEFORE any actions were executed)",
    "2. A current page snapshot (the page state AFTER actions were executed)",
    "3. A list of actions that were executed",
    "4. One or more task assertions to verify",
    "",
    "For each task assertion, compare the initial and current snapshots along with the executed actions to determine if the task was completed.",
    "",
    "## Rules",
    "- Compare the INITIAL snapshot with the CURRENT snapshot to detect changes caused by the executed actions.",
    "- For creation/addition tasks: if the current snapshot shows new items that were NOT in the initial snapshot, that is strong evidence of success.",
    "- For modification tasks: if the current snapshot shows changed values compared to the initial snapshot, that is evidence of success.",
    "- If initial snapshot is absent, judge based on current snapshot + action sequence coherence.",
    "- A task is PASSED if the comparison clearly shows the expected outcome.",
    "- If there is no detectable change or the expected outcome is not visible, the task is FAILED.",
    "- Be strict: partial completion = FAILED.",
    "- `is-active`, `checked`, `selected`, color values, text content, element presence — all must match the assertion description.",
    "",
    "## Output Format",
    "Return ONLY a valid JSON array. No markdown, no explanation, no code fences.",
    "Each element must be: { \"task\": \"<task name>\", \"passed\": true/false, \"reason\": \"<brief reason>\" }",
    "",
    "Example:",
    "[",
    "  { \"task\": \"Create instance\", \"passed\": true, \"reason\": \"Current snapshot shows new-instance-001 in the table which was absent in initial snapshot\" },",
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
  initialSnapshot?: string,
  postActionSnapshot?: string,
): string {
  const sections: string[] = [];

  // 初始快照（任务开始前的页面状态）
  if (initialSnapshot) {
    sections.push("## Initial Page Snapshot (BEFORE actions)");
    sections.push(initialSnapshot);
    sections.push("");
  }

  // 动作后快照（最后一个动作执行后、页面稳定/跳转前的快照，可能含成功提示等瞬态反馈）
  if (postActionSnapshot && postActionSnapshot !== snapshot) {
    sections.push("## Post-Action Snapshot (immediately after last action, before page settling/navigation)");
    sections.push(postActionSnapshot);
    sections.push("");
  }

  // 当前快照（稳定等待后的最终状态）
  sections.push("## Current Page Snapshot (settled state)");
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
