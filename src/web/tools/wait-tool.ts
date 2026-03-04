/**
 * Wait Tool 等待工具 / Wait utility for DOM conditions.
 *
 * 支持动作 / Supported actions:
 * - wait_for_selector: 等待选择器达到状态 / wait selector state
 * - wait_for_hidden: 等待元素隐藏或移除 / wait element hidden or detached
 * - wait_for_text: 等待页面出现文本 / wait text appears in page
 * - wait_for_stable: 等待 DOM 进入静默窗口 / wait DOM quiet window
 *
 * 说明 / Notes:
 * - hash selector（如 #abc123）优先通过 RefStore 解析。
 * - 可见性语义与 dom-tool 保持一致（参考 Playwright 风格）。
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import { getActiveRefStore } from "./dom-tool.js";

const DEFAULT_TIMEOUT = 6_000;
const POLL_INTERVAL_MS = 80;
const STABLE_TICK_MS = 50;
const OBSERVER_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  characterData: true,
};
const TEXT_OBSERVER_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
};

type SelectorState = "attached" | "visible" | "hidden" | "detached";

/**
 * 可见性判定 / Visibility check.
 *
 * 与 dom-tool 保持一致，处理 display:contents、visibility、opacity、零尺寸等场景。
 */
function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);

  if (style.display === "contents") {
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.ELEMENT_NODE && isVisible(child as Element)) return true;
      if (child.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.selectNodeContents(child);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          if (rects[i].width > 0 && rects[i].height > 0) return true;
        }
      }
    }
    return false;
  }
  if (style.display === "none") return false;
  if (typeof el.checkVisibility === "function") {
    if (!el.checkVisibility()) return false;
  }
  if (style.visibility !== "visible") return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * 解析选择器 / Resolve selector.
 *
 * 先尝试 RefStore hash，再回退到 document.querySelector。
 */
function resolveSelector(selector: string): Element | null {
  if (selector.startsWith("#")) {
    const store = getActiveRefStore();
    if (store) {
      const id = selector.slice(1);
      if (store.has(id)) return store.get(id) ?? null;
    }
  }
  try { return document.querySelector(selector); } catch { return null; }
}

/**
 * 计算选择器状态 / Evaluate selector state.
 *
 * @returns matched 表示是否达到目标状态；element 为当前命中的元素（如果存在）。
 */
function evaluateSelectorState(selector: string, state: SelectorState): { matched: boolean; element?: Element } {
  const el = resolveSelector(selector) ?? undefined;
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
 * 等待选择器达到指定状态 / Wait selector reaches state.
 *
 * 策略：轮询 + MutationObserver 双通道，既保证及时性也降低漏检概率。
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

    const interval = setInterval(check, POLL_INTERVAL_MS);
    const observer = new MutationObserver(check);
    observer.observe(document.body, OBSERVER_OPTIONS);

    check();
  });
}

/**
 * 等待文本出现 / Wait text appears.
 *
 * 先做一次即时检查，再监听 DOM 变化。
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

    observer.observe(document.body, TEXT_OBSERVER_OPTIONS);
  });
}

/**
 * 等待 DOM 稳定 / Wait DOM stable.
 *
 * 定义：quietMs 窗口内没有任何 MutationObserver 事件。
 */
function waitForDomStable(timeoutMs: number, quietMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let lastMutationAt = Date.now();

    const finish = (ok: boolean, err?: Error): void => {
      clearInterval(tick);
      observer.disconnect();
      if (ok) resolve();
      else reject(err ?? new Error("等待页面稳定失败"));
    };

    const observer = new MutationObserver(() => {
      lastMutationAt = Date.now();
    });

    observer.observe(document.body, OBSERVER_OPTIONS);

    const tick = setInterval(() => {
      const now = Date.now();
      if (now - startedAt > timeoutMs) {
        finish(false, new Error(`等待页面稳定超时 (${timeoutMs}ms)`));
        return;
      }
      if (now - lastMutationAt >= quietMs) {
        finish(true);
      }
    }, STABLE_TICK_MS);
  });
}

export function createWaitTool(): ToolDefinition {
  return {
    name: "wait",
    description: [
      "Wait for DOM changes on the current page.",
      "Actions: wait_for_selector (element appears), wait_for_hidden (element disappears),",
      "wait_for_text (specific text appears in page), wait_for_stable (DOM stops changing).",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Wait action: wait_for_selector | wait_for_hidden | wait_for_text | wait_for_stable",
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
        Type.Number({ description: "Timeout in milliseconds (default: 6000)" }),
      ),
      quietMs: Type.Optional(
        Type.Number({ description: "Quiet window for wait_for_stable in milliseconds (default: 300)" }),
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

          case "wait_for_stable": {
            const quietMs = Math.max(50, Math.floor((params.quietMs as number) ?? 300));
            await waitForDomStable(timeoutMs, quietMs);
            return { content: `页面已稳定（静默窗口 ${quietMs}ms）` };
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
