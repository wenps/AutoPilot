/**
 * 通用选择器解析 / Generic selector resolver.
 *
 * 先尝试 RefStore hash，再回退到 document.querySelector。
 * 被 wait-tool、navigate-tool 等模块共享，消除重复实现。
 */
import { getActiveRefStore } from "./active-store.js";

/**
 * 解析选择器（支持 RefStore hash ID 和 CSS 选择器）。
 *
 * @param selector - `#hashID` 或标准 CSS 选择器
 * @returns 匹配到的元素，或 null
 */
export function resolveSelector(selector: string): Element | null {
  if (selector.startsWith("#")) {
    const store = getActiveRefStore();
    if (store) {
      const id = selector.slice(1);
      if (store.has(id)) return store.get(id) ?? null;
    }
  }
  try { return document.querySelector(selector); } catch { return null; }
}
