/**
 * Evaluate Tool — 在页面上下文中执行任意 JavaScript 表达式。
 *
 * 替代 Playwright 的 page.evaluate()。
 * 运行环境：浏览器 Content Script。
 *
 * 这是最灵活的工具 — 当其他 tools 无法满足需求时，
 * AI 可以直接编写 JS 代码来操作页面。
 *
 * 支持 2 种动作：
 *   evaluate        — 执行 JS 表达式并返回结果
 *   evaluate_handle — 执行 JS 并返回序列化的 DOM 信息
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../core/tool-registry.js";

/**
 * 安全执行 JS 表达式，捕获错误并序列化结果。
 */
function safeEvaluate(expression: string): { result?: unknown; error?: string } {
  try {
    // 使用 Function 构造器代替 eval，避免污染当前作用域
    const fn = new Function(`"use strict"; return (${expression});`);
    const result = fn();
    return { result };
  } catch (err) {
    // 如果作为表达式失败，尝试作为语句块执行
    try {
      const fn = new Function(`"use strict"; ${expression}`);
      const result = fn();
      return { result };
    } catch (err2) {
      return { error: err2 instanceof Error ? err2.message : String(err2) };
    }
  }
}

/**
 * 将执行结果序列化为字符串（处理 DOM 元素、循环引用等）。
 */
function serializeResult(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  // DOM 元素 → 返回 outerHTML 片段
  if (value instanceof Element) {
    const tag = value.tagName.toLowerCase();
    const id = value.id ? `#${value.id}` : "";
    const text = value.textContent?.trim().slice(0, 100) ?? "";
    return `<${tag}${id}> "${text}"`;
  }

  // NodeList / HTMLCollection → 逐个序列化
  if (value instanceof NodeList || value instanceof HTMLCollection) {
    const items = Array.from(value).map((el, i) => `  ${i}: ${serializeResult(el)}`);
    return `[${value.length} elements]\n${items.join("\n")}`;
  }

  // 普通值 → JSON 序列化
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function createEvaluateTool(): ToolDefinition {
  return {
    name: "evaluate",
    description: [
      "Execute JavaScript code in the current page context.",
      "Use this when other tools cannot accomplish the task.",
      "Can access document, window, and all page APIs.",
    ].join(" "),

    schema: Type.Object({
      expression: Type.String({
        description:
          "JavaScript expression or code block to execute. Has access to document, window, etc.",
      }),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const expression = params.expression as string;
      if (!expression) return { content: "缺少 expression 参数" };

      const { result, error } = safeEvaluate(expression);

      if (error) {
        return {
          content: `JS 执行错误: ${error}`,
          details: { error: true, expression },
        };
      }

      return { content: serializeResult(result) };
    },
  };
}
