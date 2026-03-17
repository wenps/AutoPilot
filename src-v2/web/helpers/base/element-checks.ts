/**
 * 元素状态判定工具函数 / Element state checks.
 *
 * 从 dom-tool 提取，方便 dom-tool、page-info 等模块复用。
 */

/** 不可 fill 的 input 类型 */
export const INPUT_BLOCKED_TYPES = new Set([
  "checkbox", "radio", "file", "button", "submit", "reset", "image",
]);

/**
 * ARIA disabled：检查元素自身 + 祖先链 aria-disabled（参考 Playwright getAriaDisabled）。
 */
export function isElementDisabled(el: Element): boolean {
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if ((el as HTMLButtonElement).disabled) return true;
  }
  let cursor: Element | null = el;
  while (cursor) {
    if (cursor.getAttribute("aria-disabled") === "true") return true;
    cursor = cursor.parentElement;
  }
  return false;
}

/**
 * 判断元素是否可编辑（textarea/input/select/contentEditable）。
 *
 * 不可 fill 的 input 类型（如 checkbox/radio/file/button）返回 false。
 */
export function isEditableElement(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !INPUT_BLOCKED_TYPES.has(el.type) && !el.readOnly;
  }
  if (el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}
