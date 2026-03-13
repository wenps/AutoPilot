/**
 * 可操作性检查工具函数 / Actionability check utilities.
 *
 * 包含：元素稳定性检查、滚动、遮挡检测、点击信号校验、元素描述、综合 actionability。
 * 从 dom-tool 提取，供 dom-tool、fill-helpers 等模块复用。
 */
import type { ToolCallResult } from "../../../core/tool-registry.js";
import { getTrackedElementEvents } from "../../event-listener-tracker.js";
import { isElementVisible } from "./visibility.js";
import { isElementDisabled, isEditableElement } from "./element-checks.js";
import { getClickPoint } from "./event-dispatch.js";

// ─── 常量 ───

/** scrollIntoView 轮换策略（参考 Playwright dom.ts） */
const SCROLL_OPTIONS: (ScrollIntoViewOptions | undefined)[] = [
  undefined,
  { block: "end", inline: "end" },
  { block: "center", inline: "center" },
  { block: "start", inline: "start" },
];

/** 仅含焦点类事件的集合——只绑定这些事件的元素不应作为 click 目标 */
const FOCUS_ONLY_EVENTS = new Set(["blur", "focus", "focusin", "focusout"]);

/** 点击信号事件集合 */
const CLICK_SIGNAL_EVENTS = new Set(["click", "mousedown", "pointerdown", "mouseup", "pointerup"]);

/** 原生可被点击的 ARIA role */
const CLICKABLE_ROLES = new Set([
  "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "checkbox", "radio", "switch", "treeitem",
]);

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

/** 多策略滚动至可见区域 */
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
  const { x, y } = getClickPoint(el);
  const topEl = document.elementFromPoint(x, y);
  if (!topEl) return null;
  if (topEl === el || el.contains(topEl) || topEl.contains(el)) return null;
  const sharedLabel = topEl.closest("label");
  if (sharedLabel && sharedLabel.contains(el)) return null;
  return describeElement(topEl);
}

// ─── 元素描述 ───

/** 返回元素的简洁描述字符串（tag + id + class + text + attrs） */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = el.className && typeof el.className === "string"
    ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map(c => `.${c}`).join("") : "";
  const text = el instanceof HTMLSelectElement
    ? el.selectedOptions[0]?.textContent?.trim().slice(0, 40) ?? ""
    : el.textContent?.trim().slice(0, 40) ?? "";
  const textHint = text ? ` "${text}"` : "";
  const hints: string[] = [];
  for (const attr of ["type", "name", "placeholder", "href", "role"]) {
    const v = el.getAttribute(attr);
    if (v) hints.push(`${attr}=${v}`);
  }
  if (el instanceof HTMLSelectElement && el.value) hints.push(`val=${el.value}`);
  const attrHint = hints.length > 0 ? ` [${hints.join(", ")}]` : "";
  return `<${tag}${id}${cls}>${textHint}${attrHint}`;
}

// ─── actionability 综合检查 ───

/** 综合可操作性检查：连接、可见、禁用、可编辑 */
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
    // 允许 fill 作用于 role=slider（后续在 fill 分支做专门处理）
    if (action === "fill" && el.getAttribute("role") === "slider") {
      return null;
    }
    return { content: `"${selector}" 不是可编辑元素，无法执行 ${action}`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
  }
  return null;
}

// ─── 点击信号校验 ───

/**
 * 点击信号校验：检查目标元素是否具备可点击信号。
 *
 * 判定逻辑（仅在有正向证据时拦截）：
 * - 原生可点击元素（a/button/summary/input[submit|button|reset]）→ 放行
 * - 有 CLICKABLE_ROLES 中的 ARIA role → 放行
 * - 有 onclick 属性 → 放行
 * - 有 click/mousedown/pointerdown 等事件监听 → 放行
 * - 无任何事件监听 → 放行（可能有事件委托）
 * - 有事件监听但全部为 focus/blur 类 → 拦截
 */
export function validateClickSignal(
  el: Element,
  selector: string,
  action: string,
): ToolCallResult | null {
  // 原生可点击元素
  // 注意：HTMLSummaryElement 在部分浏览器/WebView 环境中未定义，
  // 使用 tagName 判定代替 instanceof 避免 ReferenceError。
  if (
    el instanceof HTMLAnchorElement ||
    el instanceof HTMLButtonElement ||
    el instanceof HTMLOptionElement ||
    el.tagName === "SUMMARY" ||
    (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type))
  ) {
    return null;
  }

  // ARIA 可点击 role
  const role = el.getAttribute("role");
  if (role && CLICKABLE_ROLES.has(role)) return null;

  // 内联 onclick
  if (el.hasAttribute("onclick")) return null;

  // 检查追踪到的事件
  const trackedEvents = getTrackedElementEvents(el);
  // 无追踪事件 → 放行（可能使用事件委托）
  if (trackedEvents.length === 0) return null;

  // 有至少一个点击信号事件 → 放行
  if (trackedEvents.some(e => CLICK_SIGNAL_EVENTS.has(e))) return null;

  // 有事件但全部为 focus/blur 类 → 拦截
  if (trackedEvents.every(e => FOCUS_ONLY_EVENTS.has(e))) {
    return {
      content: [
        `Element ${describeElement(el)} has NO click handler (listeners: ${trackedEvents.join(",")}).`,
        `This element only has focus/blur listeners — it is NOT a valid click target.`,
        `Look for a nearby <a>, <button>, or sibling/parent with clk/pdn/mdn listener instead.`,
      ].join(" "),
      details: { error: true, code: "NO_CLICK_SIGNAL", action, selector },
    };
  }

  // 有其他事件（如 input/change）但无点击信号 → 放行（可能是有意义的交互）
  return null;
}
