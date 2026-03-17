/**
 * 事件模拟工具函数 / Event dispatch utilities.
 *
 * 提供 Playwright 风格的完整事件链：click、hover、input、文本选择。
 * 从 dom-tool 提取，供 dom-tool、fill-helpers 等模块复用。
 */

/** 通用 sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 获取元素中心坐标 */
export function getClickPoint(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 完整点击事件链（参考 Playwright Mouse.click）：
 * pointermove → mousemove → (per clickCount) pointerdown → mousedown → focus → pointerup → mouseup → click
 *
 * 与真实浏览器一致：先用 elementFromPoint 定位元素中心最内层可见目标，
 * 在该目标上 dispatch 事件（事件冒泡到外层）。
 * 避免直接在外层容器 dispatch 导致内层 handler 无法触发的问题
 * （如 el-color-picker 的 handleTrigger 绑在内层 div 上）。
 */
export function dispatchClickEvents(el: HTMLElement, clickCount = 1): void {
  const { x, y } = getClickPoint(el);
  // 与真实浏览器行为一致：找到点击坐标下的最内层元素（含 SVG 等非 HTML 元素）
  const innermost = document.elementFromPoint(x, y);
  let hitTarget: Element = (innermost && el.contains(innermost) && innermost !== el) ? innermost : el;
  // 当 elementFromPoint 未穿透（命中 el 自身）时，尝试递归查找 el 内部在同一坐标下的子元素。
  // 这覆盖了 elementFromPoint 受 pointer-events/z-index 影响无法穿透的边界情况。
  if (hitTarget === el) {
    hitTarget = deepestChildAtPoint(el, x, y);
  }
  const base: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };

  hitTarget.dispatchEvent(new PointerEvent("pointermove", { ...base, pointerId: 1 }));
  hitTarget.dispatchEvent(new MouseEvent("mousemove", base));

  for (let cc = 1; cc <= clickCount; cc++) {
    hitTarget.dispatchEvent(new PointerEvent("pointerdown", { ...base, detail: cc, buttons: 1, pointerId: 1 }));
    hitTarget.dispatchEvent(new MouseEvent("mousedown", { ...base, detail: cc, buttons: 1 }));
    // focus 调用在原始目标上（SVG 等非 focusable 元素无需 focus）
    if (cc === 1 && el !== document.activeElement) el.focus({ preventScroll: true });
    hitTarget.dispatchEvent(new PointerEvent("pointerup", { ...base, detail: cc, pointerId: 1 }));
    hitTarget.dispatchEvent(new MouseEvent("mouseup", { ...base, detail: cc }));
    hitTarget.dispatchEvent(new MouseEvent("click", { ...base, detail: cc }));
  }
}

/**
 * 递归查找指定坐标下最深的子元素。
 *
 * 当 elementFromPoint 返回 el 自身时，通过 getBoundingClientRect 手动检查子元素覆盖范围，
 * 找到包含 (x,y) 的最深后代。
 */
function deepestChildAtPoint(el: Element, x: number, y: number): Element {
  for (const child of el.children) {
    const rect = child.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return deepestChildAtPoint(child, x, y);
    }
  }
  return el;
}

/** hover 事件链 */
export function dispatchHoverEvents(el: HTMLElement): void {
  const { x, y } = getClickPoint(el);
  const base: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent("pointerenter", { ...base, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...base, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointermove", { ...base, pointerId: 1 }));
  el.dispatchEvent(new MouseEvent("mousemove", base));
  el.dispatchEvent(new MouseEvent("mouseover", base));
}

/** 派发 input + change 事件（兼容 React/Vue 受控组件） */
export function dispatchInputEvents(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 原生 setter 写入表单值（绕过 React/Vue getter/setter 拦截） */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
}

/**
 * 选中元素全部文本（参考 Playwright：input/textarea/contenteditable 三种策略）。
 * 先 focus 再选中，确保框架 focus handler 先执行。
 */
export function selectText(el: Element): void {
  if (el instanceof HTMLInputElement) { el.focus(); el.select(); return; }
  if (el instanceof HTMLTextAreaElement) { el.focus(); el.selectionStart = 0; el.selectionEnd = el.value.length; return; }
  if (el instanceof HTMLElement) el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
}
