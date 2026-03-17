/**
 * Wait 辅助函数 / Wait helper utilities.
 *
 * 提供等待工具所需的状态判定与异步等待能力：
 * - evaluateSelectorState: 选择器状态匹配
 * - waitForSelectorState: 轮询 + MutationObserver 双通道等待
 * - waitForText: 等待文本出现
 * - waitForDomStable: 等待 DOM 进入静默窗口
 */
import { isVisible } from "../base/visibility.js";
import { resolveSelector } from "../base/resolve-selector.js";

// ─── 常量 ───

export const DEFAULT_TIMEOUT = 6_000;
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

// ─── 类型 ───

export type SelectorState = "attached" | "visible" | "hidden" | "detached";

// ─── 状态判定 ───

/**
 * 计算选择器状态 / Evaluate selector state.
 *
 * @returns matched 表示是否达到目标状态；element 为当前命中的元素（如果存在）。
 */
export function evaluateSelectorState(selector: string, state: SelectorState): { matched: boolean; element?: Element } {
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

// ─── 异步等待 ───

/**
 * 等待选择器达到指定状态 / Wait selector reaches state.
 *
 * 策略：轮询 + MutationObserver 双通道，既保证及时性也降低漏检概率。
 */
export function waitForSelectorState(
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
export function waitForText(text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
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
export function waitForDomStable(timeoutMs: number, quietMs: number): Promise<void> {
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
