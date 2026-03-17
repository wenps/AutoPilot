/**
 * Evaluate Tool — JavaScript 表达式执行工具定义与分发。
 *
 * 职责：
 *   本文件负责 evaluate 工具的 schema 定义、JS 执行和结果序列化。
 *   这是 SDK 中最灵活的工具——当 dom/navigate/wait 等结构化工具无法满足需求时，
 *   AI 可通过此工具直接编写任意 JS 代码操作页面（如读取 localStorage、调用框架 API、
 *   操作 Canvas、触发自定义事件等）。
 *
 * 支持 2 种动作：
 *   evaluate        — 执行 JS 表达式并返回序列化结果（自动处理 DOM 元素、数组、循环引用）
 *   evaluate_handle — 执行 JS 并返回 DOM 元素摘要信息（tag、id、class、text、可见性、rect）
 *
 * 执行机制：
 *   - 使用 new Function() 构造器代替 eval，避免污染当前作用域
 *   - 先尝试作为表达式执行（return (expr)），失败后回退为语句块执行
 *   - 执行错误会被捕获并以 error 字段返回，不会中断 Agent Loop
 *
 * 安全约束：
 *   - 运行在 Content Script 同源上下文，受页面 CSP 策略限制
 *   - 无法访问跨域 iframe 内容
 *   - Agent Loop 将 evaluate 视为潜在 DOM 变更动作（会触发断轮等待新快照）
 *
 * 依赖结构：
 *   无外部 helper 依赖，自包含实现。
 *
 * 运行环境：浏览器 Content Script（直接访问 DOM，无 CDP）。
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/shared/tool-registry.js";

/**
 * 安全执行 JS 表达式，捕获错误并序列化结果。
 */
function safeEvaluate(expression: string): { result?: unknown; error?: string } {
  try {
    // 使用 Function 构造器代替 eval，避免污染当前作用域
    const fn = new Function(`"use strict"; return (${expression});`);
    const result = fn();
    return { result };
  } catch {
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
      "Execute JavaScript in page context.",
      "Use when other tools are insufficient; can access document and window.",
    ].join(" "),

    schema: Type.Object({
      expression: Type.String({
        description: "JavaScript expression or code block to execute.",
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
