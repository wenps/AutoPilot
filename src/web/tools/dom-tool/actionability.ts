/**
 * DOM Tool — 可操作性检查（参考 Playwright actionability）。
 *
 * 包含：可见性、disabled、editable、稳定性、hit-target、ensureActionable 综合检查。
 */
import type { ToolCallResult } from "../../../core/tool-registry.js";
import { INPUT_BLOCKED_TYPES, SCROLL_OPTIONS } from "./constants.js";

// ─── 可见性判定（参考 Playwright domUtils.ts） ───

/** 检查元素样式可见性（处理 checkVisibility / details 折叠 / visibility） */
function isStyleVisible(el: Element, style?: CSSStyleDeclaration): boolean {
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
 * 元素可见性检查（参考 Playwright isElementVisible+computeBox）。
 * 处理 display:contents / display:none / visibility / opacity / 尺寸为 0。
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

// ─── disabled / editable 检查（参考 Playwright） ───

/** ARIA disabled：检查元素自身 + 祖先链 aria-disabled（参考 Playwright getAriaDisabled） */
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

export function isEditableElement(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !INPUT_BLOCKED_TYPES.has(el.type) && !el.readOnly;
  }
  if (el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

// ─── 稳定性检查（参考 Playwright _checkElementIsStable） ───

/** rAF 逐帧检查元素位置是否连续 3 帧不变 */
export function checkElementStable(el: Element, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let lastRect: DOMRect | undefined;
    let stableCount = 0;
    const start = performance.now();
    function check() {
      if (performance.now() - start > timeoutMs || !el.isConnected) { resolve(false); return; }
      const rect = el.getBoundingClientRect();
      if (lastRect) {
        const same = rect.x === lastRect.x && rect.y === lastRect.y &&
                     rect.width === lastRect.width && rect.height === lastRect.height;
        if (!same) { stableCount = 0; } else if (++stableCount >= 3) { resolve(true); return; }
      }
      lastRect = rect;
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  });
}

// ─── scrollIntoView（参考 Playwright 4 种策略轮换） ───

export function scrollIntoViewIfNeeded(el: Element, retry = 0): void {
  if (retry === 0 && "scrollIntoViewIfNeeded" in el) {
    (el as HTMLElement & { scrollIntoViewIfNeeded: (c?: boolean) => void }).scrollIntoViewIfNeeded(true);
    return;
  }
  const opts = SCROLL_OPTIONS[retry % SCROLL_OPTIONS.length];
  el.scrollIntoView(opts ?? { block: "center", inline: "nearest" });
}

// ─── hit-target 检查 ───

/** 检查元素中心点是否被遮挡，返回遮挡元素描述或 null */
export function checkHitTarget(el: Element): string | null {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const topEl = document.elementFromPoint(x, y);
  if (!topEl) return null;
  if (topEl === el || el.contains(topEl) || topEl.contains(el)) return null;
  const sharedLabel = topEl.closest("label");
  if (sharedLabel && sharedLabel.contains(el)) return null;
  // 直接返回简单描述，避免循环依赖 describeElement
  const tag = topEl.tagName.toLowerCase();
  const id = topEl.id ? `#${topEl.id}` : "";
  return `<${tag}${id}>`;
}

// ─── actionability 综合检查 ───

export function ensureActionable(el: Element, action: string, selector: string, force: boolean): ToolCallResult | null {
  if (force) return null;
  if (!el.isConnected) {
    return { content: `"${selector}" 元素已脱离文档，无法执行 ${action}`, details: { error: true, code: "ELEMENT_DETACHED", action, selector } };
  }
  const readOnlyActions = new Set(["get_text", "get_attr"]);
  if (!readOnlyActions.has(action) && !isElementVisible(el)) {
    return { content: `"${selector}" 元素不可见，无法执行 ${action}`, details: { error: true, code: "ELEMENT_NOT_VISIBLE", action, selector } };
  }
  const mutationActions = new Set(["click", "fill", "type", "press", "select_option", "clear", "check", "uncheck"]);
  if (mutationActions.has(action) && isElementDisabled(el)) {
    return { content: `"${selector}" 元素已禁用（disabled/aria-disabled），无法执行 ${action}`, details: { error: true, code: "ELEMENT_DISABLED", action, selector } };
  }
  if (["fill", "type", "clear"].includes(action) && !isEditableElement(el)) {
    // role=slider 允许通过 fill 设值（离散评分组件如 el-rate，无关联 input 时由 fill handler 处理）
    if (!(action === "fill" && el.getAttribute("role") === "slider")) {
      return { content: `"${selector}" 不是可编辑元素，无法执行 ${action}`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
    }
  }
  return null;
}
