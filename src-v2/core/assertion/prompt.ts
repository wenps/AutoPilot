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
    "You are a verification judge. Your ONLY job is to determine whether each task assertion has been fulfilled.",// 你是一个验证评判者。你的唯一职责是判断每条任务断言是否已被满足。
    "",
    "You will receive:", // 你将收到：
    "1. An initial page snapshot (the page state BEFORE any actions were executed)", // 初始快照（任务开始前的页面状态）
    "2. A current page snapshot (the page state AFTER actions were executed)", // 当前快照（稳定等待后的最终状态）
    "3. A list of actions that were executed", // 已执行操作列表
    "4. One or more task assertions to verify", // 待验证断言列表
    "", 
    "For each task assertion, compare the initial and current snapshots along with the executed actions to determine if the task was completed.", // 针对每条任务断言，对比初始快照与当前快照，并结合已执行的操作，判断任务是否完成。
    "",
    "## Rules", // 断言规则
    "- Compare the INITIAL snapshot with the CURRENT snapshot to detect changes caused by the executed actions.", // 对比初始快照与当前快照，检测已执行操作引起的变化。
    "- For creation/addition tasks: if the current snapshot shows new items that were NOT in the initial snapshot,  that is strong evidence of success.", // 针对创建/添加类任务：如果当前快照显示了初始快照中没有的新元素，那就是成功的有力证据。
    "- For modification tasks: if the current snapshot shows changed values compared to the initial snapshot, that is evidence of success.", // 针对修改类任务：如果当前快照显示了与初始快照相比发生了变化的值，那就是成功的证据。
    "- If initial snapshot is absent, judge based on current snapshot + action sequence coherence.", // 如果没有初始快照，则根据当前快照和动作序列的一致性进行判断。
    "- A task is PASSED if the comparison clearly shows the expected outcome.", // 如果对比清晰地显示了预期结果，则该任务通过。
    "- If there is no detectable change or the expected outcome is not visible, the task is FAILED.", // 如果没有可检测的变化或预期结果不可见，则该任务失败。
    "- Be strict: partial completion = FAILED.", // 严格判断：部分完成 = 失败
    "- For form-filling tasks: check EVERY mentioned field individually. A field is filled if it shows a non-placeholder, non-default value (val=\"...\", checked, is-checked, is-active, bg=\"...\"). If ANY field is still empty/default, the task is FAILED — even if other fields are correct.", // 表单专用检查规则
    "- `is-active`, `checked`, `selected`, color values, text content, element presence — all must match the assertion description.", // `is-active`、`checked`、`selected`、颜色值、文本内容、元素存在与否等都必须符合断言描述
    "",
    "## Output Format", // 输出格式
    "Return ONLY a valid JSON array. No markdown, no explanation, no code fences.", // 输出要求
    "Each element must be: { \"task\": \"<task name>\", \"passed\": true/false, \"reason\": \"<brief reason>\" }", // 每条断言结果格式
    "",
    "Example:", // 输出示例
    "[",
    "  { \"task\": \"Create instance\", \"passed\": true, \"reason\": \"Current snapshot shows new-instance-001 in the table which was absent in initial snapshot\" },", // 通过示例
    "  { \"task\": \"Fill username\", \"passed\": false, \"reason\": \"Username input shows empty value, expected admin\" }", // 失败示例
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

/**
 * 构建系统级断言的用户消息。
 *
 * 与微任务级别的区别：不注入单条操作列表，而是注入完整的执行记录链摘要（Execution Evidence），
 * 让断言 AI 基于全局视角判断整体任务是否完成。
 *
 * @param currentSnapshot - 全局最终快照
 * @param initialSnapshot - 全局初始快照
 * @param executionEvidence - ExecutionRecordChain.buildEvidenceSummary() 的输出
 * @param taskAssertions - 要验证的任务断言列表
 */
export function buildSystemAssertionUserMessage(
  currentSnapshot: string,
  initialSnapshot: string,
  executionEvidence: string,
  taskAssertions: Array<{ task: string; description: string }>,
): string {
  const sections: string[] = [];

  // 初始快照
  sections.push("## Initial Page Snapshot (BEFORE any micro-tasks)");
  sections.push(initialSnapshot);
  sections.push("");

  // 当前快照
  sections.push("## Current Page Snapshot (final settled state)");
  sections.push(currentSnapshot || "(empty snapshot)");
  sections.push("");

  // 执行记录链证据
  sections.push("## Execution Evidence (complete micro-task execution chain)");
  sections.push(executionEvidence);
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
