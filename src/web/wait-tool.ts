/**
 * Wait Tool — 基于 MutationObserver 的元素等待工具。
 *
 * 替代 Playwright 的 waitForSelector/waitForNavigation。
 * 运行环境：浏览器 Content Script。
 *
 * 支持 3 种动作：
 *   wait_for_selector  — 等待匹配选择器的元素出现
 *   wait_for_hidden    — 等待元素消失或隐藏
 *   wait_for_text      — 等待页面中出现指定文本
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../core/tool-registry.js";

/** 默认超时时间（毫秒） */
const DEFAULT_TIMEOUT = 10_000;

/**
 * 通过 MutationObserver 等待元素出现。
 * 先检查元素是否已存在，不存在则监听 DOM 变化直到出现或超时。
 */
function waitForSelector(selector: string, timeoutMs: number): Promise<Element> {
  return new Promise((resolve, reject) => {
    // 先检查是否已存在
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`等待 "${selector}" 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

/**
 * 等待元素消失或变为不可见。
 */
function waitForHidden(selector: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // 先检查是否已不存在或隐藏
    const existing = document.querySelector(selector);
    if (!existing) {
      resolve();
      return;
    }
    const style = window.getComputedStyle(existing);
    if (style.display === "none" || style.visibility === "hidden") {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`等待 "${selector}" 消失超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (!el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
        return;
      }
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"],
    });
  });
}

/**
 * 等待页面中出现指定文本。
 */
function waitForText(text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // 先检查是否已包含
    if (document.body.textContent?.includes(text)) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`等待文本 "${text}" 出现超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes(text)) {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

export function createWaitTool(): ToolDefinition {
  return {
    name: "wait",
    description: [
      "Wait for DOM changes on the current page.",
      "Actions: wait_for_selector (element appears), wait_for_hidden (element disappears),",
      "wait_for_text (specific text appears in page).",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Wait action: wait_for_selector | wait_for_hidden | wait_for_text",
      }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector for wait_for_selector/wait_for_hidden" }),
      ),
      text: Type.Optional(
        Type.String({ description: "Text to wait for in wait_for_text" }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in milliseconds (default: 10000)" }),
      ),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;
      const timeoutMs = (params.timeout as number) ?? DEFAULT_TIMEOUT;

      try {
        switch (action) {
          case "wait_for_selector": {
            const selector = params.selector as string;
            if (!selector) return { content: "缺少 selector 参数" };
            await waitForSelector(selector, timeoutMs);
            return { content: `元素 "${selector}" 已出现` };
          }

          case "wait_for_hidden": {
            const selector = params.selector as string;
            if (!selector) return { content: "缺少 selector 参数" };
            await waitForHidden(selector, timeoutMs);
            return { content: `元素 "${selector}" 已消失` };
          }

          case "wait_for_text": {
            const text = params.text as string;
            if (!text) return { content: "缺少 text 参数" };
            await waitForText(text, timeoutMs);
            return { content: `文本 "${text}" 已出现` };
          }

          default:
            return { content: `未知的等待动作: ${action}` };
        }
      } catch (err) {
        return {
          content: `等待操作 "${action}" 失败: ${err instanceof Error ? err.message : String(err)}`,
          details: { error: true, action },
        };
      }
    },
  };
}
