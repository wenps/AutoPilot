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
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";

/** 默认超时时间（毫秒） */
const DEFAULT_TIMEOUT = 10_000;

type SelectorState = "attached" | "visible" | "hidden" | "detached";

/**
 * Playwright 风格可见性判定（近似）。
 */
function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * 读取 selector 当前状态。
 */
function evaluateSelectorState(selector: string, state: SelectorState): { matched: boolean; element?: Element } {
  const el = document.querySelector(selector) ?? undefined;
  switch (state) {
    case "attached":
      return { matched: Boolean(el), element: el };
    case "visible":
      return { matched: Boolean(el && isVisible(el)), element: el };
    case "hidden":
      return { matched: !el || !isVisible(el), element: el };
    case "detached":
      return { matched: !el, element: el };
    default:
      return { matched: false };
  }
}

/**
 * 等待 selector 达到指定状态（近似 Playwright state 语义）。
 */
function waitForSelectorState(
  selector: string,
  state: SelectorState,
  timeoutMs: number,
): Promise<{ element?: Element }> {
  return new Promise((resolve, reject) => {
    let finished = false;

    const finish = (handler: () => void): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(interval);
      observer.disconnect();
      handler();
    };

    const check = (): void => {
      let result: { matched: boolean; element?: Element };
      try {
        result = evaluateSelectorState(selector, state);
      } catch {
        finish(() => reject(new Error(`选择器语法错误: ${selector}`)));
        return;
      }
      if (result.matched) {
        finish(() => resolve({ element: result.element }));
      }
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`等待 "${selector}" 达到状态 "${state}" 超时 (${timeoutMs}ms)`)));
    }, timeoutMs);

    const interval = setInterval(check, 80);
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    check();
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
      state: Type.Optional(
        Type.String({ description: "Selector state for wait_for_selector: attached | visible | hidden | detached (default: attached)" }),
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
            const state = (params.state as SelectorState | undefined) ?? "attached";
            if (!["attached", "visible", "hidden", "detached"].includes(state)) {
              return { content: `无效 state: ${state}` };
            }
            const result = await waitForSelectorState(selector, state, timeoutMs);
            if (state === "attached" || state === "visible") {
              const tag = result.element?.tagName?.toLowerCase();
              return { content: `元素 "${selector}" 已达到状态 "${state}"${tag ? ` (${tag})` : ""}` };
            }
            return { content: `元素 "${selector}" 已达到状态 "${state}"` };
          }

          case "wait_for_hidden": {
            const selector = params.selector as string;
            if (!selector) return { content: "缺少 selector 参数" };
            await waitForSelectorState(selector, "hidden", timeoutMs);
            return { content: `元素 "${selector}" 已隐藏或消失` };
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
