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
 */
export function dispatchClickEvents(el: HTMLElement, clickCount = 1): void {
  const { x, y } = getClickPoint(el);
  const base: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };

  el.dispatchEvent(new PointerEvent("pointermove", { ...base, pointerId: 1 }));
  el.dispatchEvent(new MouseEvent("mousemove", base));

  for (let cc = 1; cc <= clickCount; cc++) {
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, detail: cc, buttons: 1, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, detail: cc, buttons: 1 }));
    if (cc === 1 && el !== document.activeElement) el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, detail: cc, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, detail: cc }));
    el.dispatchEvent(new MouseEvent("click", { ...base, detail: cc }));
  }
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
