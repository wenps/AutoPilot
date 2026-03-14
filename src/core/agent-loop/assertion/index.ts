/**
 * 断言引擎 —— AI 驱动的任务完成验证。
 *
 * 核心流程：
 * 1. 接收当前快照 + 已执行操作 + 任务断言列表
 * 2. 构建断言专用 prompt（不含 tools、不含主循环 system prompt）
 * 3. 发起独立 AI 调用，让断言 AI 判定每条任务断言是否通过
 * 4. 解析 AI 返回的 JSON 结果，返回结构化断言结果
 *
 * 设计要点：
 * - 断言 AI 完全独立于主循环 AI，只做判定，不做操作
 * - 不注入 tools 参数——断言 AI 不需要工具调用能力
 * - 解析失败时优雅降级（全部标记为失败 + 原始文本作为 reason）
 */
import type { AIClient } from "../../types.js";
import type { TaskAssertion, TaskAssertionResult, AssertionResult } from "./types.js";
import { buildAssertionSystemPrompt, buildAssertionUserMessage } from "./prompt.js";

/**
 * 执行断言评估。
 *
 * 发起独立的 AI 调用，让断言 AI 基于快照和操作记录判定任务完成情况。
 *
 * @param client - AI 客户端（复用主循环同一个客户端实例）
 * @param snapshot - 当前页面快照文本
 * @param executedActions - 已执行操作摘要列表（如 "dom click #abc123"）
 * @param taskAssertions - 待验证的任务断言
 * @param initialSnapshot - 任务开始前的初始快照（可选，用于 before/after 对比）
 * @param postActionSnapshot - 动作执行后、稳定等待前的快照（可选，捕获成功提示等瞬态反馈）
 * @returns 结构化断言结果
 */
export async function evaluateAssertions(
  client: AIClient,
  snapshot: string,
  executedActions: string[],
  taskAssertions: TaskAssertion[],
  initialSnapshot?: string,
  postActionSnapshot?: string,
): Promise<AssertionResult> {
  if (taskAssertions.length === 0) {
    return { allPassed: true, total: 0, passed: 0, failed: 0, details: [] };
  }

  const systemPrompt = buildAssertionSystemPrompt();
  const userMessage = buildAssertionUserMessage(snapshot, executedActions, taskAssertions, initialSnapshot, postActionSnapshot);

  try {
    // 独立 AI 调用：不传 tools，让断言 AI 专注判断
    const response = await client.chat({
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      // 不传 tools —— 断言 AI 不需要工具调用能力
    });

    const rawText = response.text ?? "";
    const details = parseAssertionResponse(rawText, taskAssertions);

    const passed = details.filter(d => d.passed).length;
    return {
      allPassed: passed === details.length,
      total: details.length,
      passed,
      failed: details.length - passed,
      details,
    };
  } catch (err) {
    // AI 调用失败：全部标记为失败
    return {
      allPassed: false,
      total: taskAssertions.length,
      passed: 0,
      failed: taskAssertions.length,
      details: taskAssertions.map(a => ({
        task: a.task,
        passed: false,
        reason: `Assertion AI call failed: ${err instanceof Error ? err.message : String(err)}`,
      })),
    };
  }
}

/**
 * 解析断言 AI 返回的 JSON 响应。
 *
 * 期望格式：[{ "task": "...", "passed": true/false, "reason": "..." }, ...]
 * 解析失败时返回全部标记为失败的结果。
 */
function parseAssertionResponse(
  rawText: string,
  taskAssertions: TaskAssertion[],
): TaskAssertionResult[] {
  // 剥离 <think>...</think> 推理标签（DeepSeek / MiniMax 等模型会输出）
  const stripped = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // 尝试从文本中提取 JSON 数组（可能被 markdown code fences 包裹）
  const jsonText = stripped
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected JSON array");
    }

    // 按 taskAssertions 顺序对齐结果
    return taskAssertions.map(assertion => {
      const match = parsed.find(
        (item: unknown) =>
          item && typeof item === "object" &&
          "task" in (item as Record<string, unknown>) &&
          (item as Record<string, unknown>).task === assertion.task,
      );

      if (match && typeof match === "object") {
        const m = match as Record<string, unknown>;
        return {
          task: assertion.task,
          passed: Boolean(m.passed),
          reason: typeof m.reason === "string" ? m.reason : "No reason provided",
        };
      }

      // 找不到对应的结果项：标记为失败
      return {
        task: assertion.task,
        passed: false,
        reason: "Assertion AI did not return a result for this task",
      };
    });
  } catch {
    // JSON 解析失败：用原始文本做 reason
    return taskAssertions.map(assertion => ({
      task: assertion.task,
      passed: false,
      reason: `Failed to parse assertion response: ${rawText.slice(0, 200)}`,
    }));
  }
}
