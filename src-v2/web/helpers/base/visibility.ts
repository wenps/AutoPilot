/**
 * 通用可见性判定 / Generic visibility check.
 *
 * 对齐 Playwright 语义，处理：
 * - display:contents 递归、display:none
 * - checkVisibility() 原生 API
 * - <details>/<summary> 折叠检测
 * - visibility、opacity、零尺寸
 *
 * 被 dom-tool、wait-helpers、page-info 等模块统一复用。
 */

/**
 * 检查元素样式可见性（处理 checkVisibility / details 折叠 / visibility）。
 *
 * 参考 Playwright domUtils.ts。
 */
export function isStyleVisible(el: Element, style?: CSSStyleDeclaration): boolean {
  style = style ?? window.getComputedStyle(el);
  if (typeof el.checkVisibility === "function") {
    if (!el.checkVisibility()) return false;
  } else {
    const det = el.closest("details,summary");
    if (det !== el && det?.nodeName === "DETAILS" && !(det as HTMLDetailsElement).open) return false;
  }
  return style.visibility === "visible";
}

/**
 * 判断元素是否对用户可见（对齐 Playwright isElementVisible + computeBox）。
 *
 * 检查链路：
 * 1. 必须是 HTMLElement/SVGElement 且 isConnected
 * 2. display:contents → 递归检查子节点
 * 3. display:none → 不可见
 * 4. isStyleVisible（含 checkVisibility / details 折叠 / visibility）
 * 5. opacity === "0" → 不可见
 * 6. getBoundingClientRect 宽高 > 0
 */
export function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);

  if (style.display === "contents") {
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.ELEMENT_NODE && isElementVisible(child as Element)) return true;
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
  if (!isStyleVisible(el, style)) return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** wait-helpers 使用的别名，保持兼容 */
export const isVisible = isElementVisible;
