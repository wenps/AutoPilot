/**
 * DOM Tool — 浏览器 DOM 操作工具（结合 Playwright 核心交互模式增强）。
 *
 * 关键改进（参考 Playwright）：
 * 1. retarget — 点击时自动重定向到 button/link/label.control
 * 2. scrollIntoView 多策略 — 4 种 block 对齐轮换，解决 sticky 遮挡
 * 3. stable 检查 — rAF 逐帧检测元素位置稳定后再操作
 * 4. hit-target 验证 — elementsFromPoint 检查是否被遮挡
 * 5. 完整点击事件链 — pointermove→pointerdown→mousedown→pointerup→mouseup→click
 * 6. check/uncheck 通过 click — 先检查→click 切换→验证状态
 * 7. press 组合键 — 支持 Control+a, Shift+Enter 等修饰键
 * 8. fill 分类型 — date/color/range 走 setValue，text 类走 selectAll+原生写入
 * 9. 自定义下拉增强 — 更广泛的 option 选择器 + 等待弹出
 * 10. ARIA disabled — 检查祖先链 aria-disabled
 *
 * 运行环境：浏览器 Content Script（直接访问 DOM，无 CDP）。
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import type { RefStore } from "../ref-store.js";

// ─── 常量 ───

const DEFAULT_WAIT_MS = 2000;

/** scrollIntoView 轮换策略（参考 Playwright dom.ts） */
const SCROLL_OPTIONS: (ScrollIntoViewOptions | undefined)[] = [
  undefined,
  { block: "end", inline: "end" },
  { block: "center", inline: "center" },
  { block: "start", inline: "start" },
];

/** fill 时直接 setValue 的 input 类型（参考 Playwright kInputTypesToSetValue） */
const INPUT_SET_VALUE_TYPES = new Set([
  "color", "date", "time", "datetime-local", "month", "range", "week",
]);

/** fill 时走 selectText+写入 的 input 类型 */
const INPUT_TYPE_INTO_TYPES = new Set([
  "", "email", "number", "password", "search", "tel", "text", "url",
]);

/** 不可 fill 的 input 类型 */
const INPUT_BLOCKED_TYPES = new Set([
  "checkbox", "radio", "file", "button", "submit", "reset", "image",
]);

/** 修饰键集合 */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** 键名→code 映射 */
const KEY_CODE_MAP: Record<string, string> = {
  Enter: "Enter", Escape: "Escape", Esc: "Escape",
  Tab: "Tab", Space: "Space", " ": "Space",
  Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Control: "ControlLeft", Shift: "ShiftLeft", Alt: "AltLeft", Meta: "MetaLeft",
};

// ─── 模块状态 ───

let activeRefStore: RefStore | undefined;

export function setActiveRefStore(store: RefStore | undefined): void {
  activeRefStore = store;
}

export function getActiveRefStore(): RefStore | undefined {
  return activeRefStore;
}

// ─── 基础工具 ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 查询元素：优先 RefStore hash，回退 CSS 选择器 */
function queryElement(selector: string): Element | string {
  try {
    if (selector.startsWith("#") && activeRefStore) {
      const id = selector.slice(1);
      if (activeRefStore.has(id)) {
        const el = activeRefStore.get(id);
        if (!el) return `未找到 ref "${selector}" 对应的元素（可能已被移除或快照已过期）`;
        return el;
      }
    }
    const el = document.querySelector(selector);
    if (!el) return `未找到匹配 "${selector}" 的元素`;
    return el;
  } catch {
    return `选择器语法错误: ${selector}`;
  }
}

/** 轮询等待元素出现 */
async function waitForElement(selector: string, timeoutMs: number): Promise<Element | string | null> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const r = queryElement(selector);
    if (typeof r !== "string") return r;
    if (r.startsWith("选择器语法错误")) return r;
    await sleep(100);
  }
  return null;
}

function resolveWaitMs(params: Record<string, unknown>): number {
  const waitMs = params.waitMs;
  if (typeof waitMs === "number" && Number.isFinite(waitMs)) return Math.max(0, Math.floor(waitMs));
  const waitSeconds = params.waitSeconds;
  if (typeof waitSeconds === "number" && Number.isFinite(waitSeconds)) return Math.max(0, Math.floor(waitSeconds * 1000));
  return DEFAULT_WAIT_MS;
}

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
function isElementVisible(el: Element): boolean {
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
function isElementDisabled(el: Element): boolean {
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

function isEditableElement(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !INPUT_BLOCKED_TYPES.has(el.type) && !el.readOnly;
  }
  if (el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

// ─── 稳定性检查（参考 Playwright _checkElementIsStable） ───

/** rAF 逐帧检查元素位置是否连续 3 帧不变 */
function checkElementStable(el: Element, timeoutMs = 800): Promise<boolean> {
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

// ─── retarget（参考 Playwright injectedScript.retarget） ───

type RetargetMode = "none" | "follow-label" | "button-link";

/**
 * 将目标重定向到关联的交互控件。
 * - button-link：非交互元素→最近 button/[role=button]/a/[role=link]
 * - follow-label：label→control + 非交互→button/[role=button]/[role=checkbox]/[role=radio]
 */
function retarget(el: Element, mode: RetargetMode): Element {
  if (mode === "none") return el;
  if (!el.matches("input, textarea, select") && !(el as HTMLElement).isContentEditable) {
    if (mode === "button-link") {
      el = el.closest("button, [role=button], a, [role=link]") || el;
    } else {
      el = el.closest("button, [role=button], [role=checkbox], [role=radio]") || el;
    }
  }
  if (mode === "follow-label") {
    if (!el.matches("a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]") &&
        !(el as HTMLElement).isContentEditable) {
      const label = el.closest("label") as HTMLLabelElement | null;
      if (label?.control) el = label.control;
    }
  }
  return el;
}

// ─── scrollIntoView（参考 Playwright 4 种策略轮换） ───

function scrollIntoViewIfNeeded(el: Element, retry = 0): void {
  if (retry === 0 && "scrollIntoViewIfNeeded" in el) {
    (el as HTMLElement & { scrollIntoViewIfNeeded: (c?: boolean) => void }).scrollIntoViewIfNeeded(true);
    return;
  }
  const opts = SCROLL_OPTIONS[retry % SCROLL_OPTIONS.length];
  el.scrollIntoView(opts ?? { block: "center", inline: "nearest" });
}

// ─── hit-target 检查 ───

/** 检查元素中心点是否被遮挡，返回遮挡元素描述或 null */
function checkHitTarget(el: Element): string | null {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const topEl = document.elementFromPoint(x, y);
  if (!topEl) return null;
  if (topEl === el || el.contains(topEl) || topEl.contains(el)) return null;
  const sharedLabel = topEl.closest("label");
  if (sharedLabel && sharedLabel.contains(el)) return null;
  return describeElement(topEl);
}

// ─── actionability 综合检查 ───

function ensureActionable(el: Element, action: string, selector: string, force: boolean): ToolCallResult | null {
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
    return { content: `"${selector}" 不是可编辑元素，无法执行 ${action}`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
  }
  return null;
}

// ─── 事件派发（参考 Playwright input.ts 事件链） ───

function getClickPoint(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 完整点击事件链（参考 Playwright Mouse.click）：
 * pointermove → mousemove → (per clickCount) pointerdown → mousedown → focus → pointerup → mouseup → click
 */
function dispatchClickEvents(el: HTMLElement, clickCount = 1): void {
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
function dispatchHoverEvents(el: HTMLElement): void {
  const { x, y } = getClickPoint(el);
  const base: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent("pointerenter", { ...base, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...base, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointermove", { ...base, pointerId: 1 }));
  el.dispatchEvent(new MouseEvent("mousemove", base));
  el.dispatchEvent(new MouseEvent("mouseover", base));
}

/** 派发 input + change 事件（兼容 React/Vue 受控组件） */
function dispatchInputEvents(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 原生 setter 写入表单值（绕过 React/Vue getter/setter 拦截） */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
}

// ─── selectText（参考 Playwright：input/textarea/contenteditable 三种策略） ───

function selectText(el: Element): void {
  if (el instanceof HTMLInputElement) { el.select(); el.focus(); return; }
  if (el instanceof HTMLTextAreaElement) { el.selectionStart = 0; el.selectionEnd = el.value.length; el.focus(); return; }
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  if (el instanceof HTMLElement) el.focus();
}

// ─── 键盘：组合键支持（参考 Playwright Keyboard.press） ───

function splitKeyCombo(key: string): string[] {
  const tokens = key.split("+");
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "" && i + 1 < tokens.length) { tokens[i + 1] = "+" + tokens[i + 1]; tokens.splice(i, 1); }
  }
  return tokens.filter(Boolean);
}

function resolveKeyCode(key: string): string {
  return KEY_CODE_MAP[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
}

/**
 * 执行 press：修饰键按正序 down → 主键 down/up → 修饰键逆序 up（参考 Playwright）。
 * 修饰键按下时抑制文本输入（只发 keydown/keyup，不发 keypress）。
 */
function executePress(el: Element, key: string): void {
  const tokens = splitKeyCombo(key);
  const mainKey = tokens[tokens.length - 1];
  const mods = tokens.slice(0, -1);
  const modState = {
    ctrlKey: mods.includes("Control"),
    shiftKey: mods.includes("Shift"),
    altKey: mods.includes("Alt"),
    metaKey: mods.includes("Meta"),
  };
  const hasNonShiftMod = modState.ctrlKey || modState.altKey || modState.metaKey;

  for (const m of mods) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: m, code: resolveKeyCode(m), bubbles: true, cancelable: true, ...modState }));
  }
  const allowed = el.dispatchEvent(new KeyboardEvent("keydown", { key: mainKey, code: resolveKeyCode(mainKey), bubbles: true, cancelable: true, ...modState }));
  // 只有无非 Shift 修饰键且是单字符时才发 keypress（参考 Playwright 文本抑制逻辑）
  if (allowed && mainKey.length === 1 && !hasNonShiftMod) {
    el.dispatchEvent(new KeyboardEvent("keypress", { key: mainKey, code: resolveKeyCode(mainKey), bubbles: true, cancelable: true, ...modState }));
  }
  el.dispatchEvent(new KeyboardEvent("keyup", { key: mainKey, code: resolveKeyCode(mainKey), bubbles: true, cancelable: true, ...modState }));
  for (let i = mods.length - 1; i >= 0; i--) {
    el.dispatchEvent(new KeyboardEvent("keyup", { key: mods[i], code: resolveKeyCode(mods[i]), bubbles: true, cancelable: true, ...modState }));
  }
}

// ─── 元素描述 ───

function describeElement(el: Element): string {
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

// ─── checkable 目标归一化 ───

function isCheckableInput(el: Element | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
}

function getChecked(el: Element): boolean | "error" {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;
  const role = el.getAttribute("role");
  if (role === "checkbox" || role === "radio" || role === "switch") return el.getAttribute("aria-checked") === "true";
  return "error";
}

/**
 * 归一化 check/uncheck 目标：允许命中文本容器/label/div，回溯到关联 checkbox/radio。
 */
function resolveCheckableTarget(el: Element): Element {
  if (getChecked(el) !== "error") return el;
  if (el instanceof HTMLLabelElement && el.control && getChecked(el.control) !== "error") return el.control;
  const ownerLabel = el.closest("label") as HTMLLabelElement | null;
  if (ownerLabel?.control && getChecked(ownerLabel.control) !== "error") return ownerLabel.control;
  const inner = el.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]');
  if (inner && getChecked(inner) !== "error") return inner;
  const prev = el.previousElementSibling;
  if (prev && getChecked(prev) !== "error") return prev;
  const next = el.nextElementSibling;
  if (next && getChecked(next) !== "error") return next;
  const parent = el.parentElement;
  if (parent) {
    const inP = parent.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]');
    if (inP && getChecked(inP) !== "error") return inP;
  }
  return el;
}

/**
 * 为 pointer 类动作（click/check/uncheck）解析可点击代理目标：
 * 当命中隐藏的原生 checkbox/radio/switch input 时，优先改点其可见 label/容器。
 */
function resolvePointerActionTarget(el: Element): Element {
  if (!(el instanceof HTMLInputElement)) return el;

  const inputType = el.type?.toLowerCase() ?? "";
  const isCheckable = inputType === "checkbox" || inputType === "radio";
  if (!isCheckable && el.getAttribute("role") !== "switch") return el;
  if (isElementVisible(el)) return el;

  const label = el.labels?.[0] ?? (el.closest("label") as HTMLLabelElement | null);
  if (label && isElementVisible(label)) return label;

  const proxy = el.closest(".el-switch, .el-checkbox, .el-radio, [role='switch'], [role='checkbox'], [role='radio']");
  if (proxy && isElementVisible(proxy)) return proxy;

  const siblingProxy = el.parentElement?.querySelector(
    ".el-switch__core, .el-checkbox__inner, .el-radio__inner, [role='switch'], [role='checkbox'], [role='radio']",
  );
  if (siblingProxy && isElementVisible(siblingProxy)) return siblingProxy;

  return el;
}

/**
 * 当命中表单项说明 label（如 Element Plus el-form-item__label）时，
 * 自动重定向到同一表单项中的首个可交互控件。
 */
function resolveFormItemControlTarget(el: Element): Element {
  if (!(el instanceof HTMLElement)) return el;
  const isLabelLike = el.tagName === "LABEL" || el.classList.contains("el-form-item__label");
  if (!isLabelLike) return el;

  const htmlLabel = el as HTMLLabelElement;
  if (htmlLabel.control && isElementVisible(htmlLabel.control)) return htmlLabel.control;

  const formItem = el.closest(".el-form-item");
  if (!formItem) return el;
  const content = formItem.querySelector(".el-form-item__content") ?? formItem;
  const control = content.querySelector(
    "input:not([type='hidden']), textarea, select, button, [role='switch'], [role='checkbox'], [role='radio'], [role='button'], .el-switch, .el-checkbox, .el-radio, [tabindex]:not([tabindex='-1'])",
  );
  if (control && isElementVisible(control)) return control;
  return el;
}

// ─── 自定义下拉增强 ───

function findVisibleOptionByText(text: string): HTMLElement | null {
  const target = text.trim().toLowerCase();
  if (!target) return null;
  const selectors = [
    '[role="option"]', '[role="listbox"] li',
    ".el-select-dropdown__item", ".el-option",     // Element Plus
    ".ant-select-item-option",                     // Ant Design
    ".el-cascader-node", ".el-dropdown-menu__item",
    '[class*="option"]', "li[data-value]", "option",
  ].join(", ");
  const nodes = Array.from(document.querySelectorAll(selectors));
  const visible = nodes.filter(n => n instanceof HTMLElement && isElementVisible(n));
  for (const n of visible) { if (n.textContent?.trim().toLowerCase() === target) return n as HTMLElement; }
  for (const n of visible) { if (n.textContent?.trim().toLowerCase().includes(target)) return n as HTMLElement; }
  return null;
}

async function waitForDropdownPopup(maxWait = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const popup = document.querySelector('[role="listbox"], .el-select-dropdown, .el-popper, .ant-select-dropdown, [class*="dropdown"]');
    if (popup && isElementVisible(popup)) return;
    await sleep(50);
  }
}

// ─── 工具定义 ───

export function createDomTool(): ToolDefinition {
  return {
    name: "dom",
    description: [
      "Perform DOM operations on the current page.",
      "Actions: click, fill, select_option, clear, check, uncheck, type, focus, hover, scroll, press, get_text, get_attr, set_attr, add_class, remove_class.",
      "Input/Select rule: before each fill/type/select_option, click or focus the same target immediately in the same round.",
      "For multiple fields, use alternating pairs in one batch: focus/click A -> fill/type A -> focus/click B -> fill/type B.",
      "Use the hash ID from DOM snapshot (e.g. #a1b2c) as selector.",
      "press supports combo keys like 'Control+a', 'Shift+Enter'.",
      "check/uncheck is done via click — state change is verified after action.",
      "Ordinal/index rule: treat visual order as 1-based when the instruction says 'the Nth item' (e.g. 4th star = 4th visible icon from left to right), and avoid off-by-one mistakes.",
      "Disambiguation rule: distinguish descriptive text/labels from actionable options. Do not click nearby label/help text; click the actual interactive option/control item (icon/button/option) that changes state.",
      "Unknown/complex components: if a container element (e.g. role=slider, rating, custom widget) has multiple child icons/items in the snapshot but you don't know how to operate it directly, try clicking the appropriate child element instead. For example, a rating component with 5 star icon children — click the 4th icon child to set 4 stars. A slider with a runway — clicking the runway at the right position may work. Always prefer interacting with visible children when the parent container doesn't respond to fill/click as expected.",
      "fill supports role=slider elements: use fill with a numeric value on a role=slider container (rating/slider) to set its value programmatically.",
      "For wheel/virtualized pickers where target option is not visible yet, use scroll on the picker column first, then click/select the newly visible option. scroll supports steps for repeated scrolling in one call.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "DOM action: click | fill | select_option | clear | check | uncheck | type | focus | hover | scroll | press | get_text | get_attr | set_attr | add_class | remove_class.",
      }),
      selector: Type.String({ description: "Element ref ID from snapshot (e.g. #r0, #r5) or CSS selector" }),
      value: Type.Optional(Type.String({ description: "Value for fill/type/set_attr actions." })),
      key: Type.Optional(Type.String({ description: "Key for press action. Supports combo: 'Enter', 'Control+a', 'Shift+Enter', 'Meta+c'" })),
      label: Type.Optional(Type.String({ description: "Label text for select_option action." })),
      index: Type.Optional(Type.Number({ description: "0-based option index for select_option action" })),
      attribute: Type.Optional(Type.String({ description: "Attribute name for get_attr/set_attr" })),
      className: Type.Optional(Type.String({ description: "CSS class name for add_class/remove_class" })),
      clickCount: Type.Optional(Type.Number({ description: "Click count (default 1). 2 = double-click, 3 = triple-click." })),
      deltaY: Type.Optional(Type.Number({ description: "Vertical scroll delta for scroll action. Positive = down, negative = up." })),
      deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll delta for scroll action." })),
      steps: Type.Optional(Type.Number({ description: "Repeat count for scroll action (default 1, max 20)." })),
      waitMs: Type.Optional(Type.Number({ description: "Wait timeout in ms before action (default: 2000)." })),
      waitSeconds: Type.Optional(Type.Number({ description: "Wait timeout in seconds (fallback for waitMs)." })),
      force: Type.Optional(Type.Boolean({ description: "Skip actionability checks (default false)." })),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;
      const selector = params.selector as string;
      const waitMs = resolveWaitMs(params);
      const force = params.force === true;

      if (!selector) return { content: "缺少 selector 参数" };

      // ── 元素查找 ──
      let el: Element;
      if (waitMs > 0) {
        const found = await waitForElement(selector, waitMs);
        if (typeof found === "string") return { content: found, details: { error: true, code: "INVALID_SELECTOR", action, selector } };
        if (!found) return { content: `未找到匹配 "${selector}" 的元素`, details: { error: true, code: "ELEMENT_NOT_FOUND", action, selector, waitMs } };
        el = found;
      } else {
        const r = queryElement(selector);
        if (typeof r === "string") return { content: r, details: { error: true, code: r.startsWith("未找到") ? "ELEMENT_NOT_FOUND" : "INVALID_SELECTOR", action, selector, waitMs } };
        el = r;
      }

      // check/uncheck 归一化
      if (action === "check" || action === "uncheck") {
        el = resolveCheckableTarget(el);
      }

      const actionabilityTarget =
        action === "click" || action === "check" || action === "uncheck"
          ? resolvePointerActionTarget(resolveFormItemControlTarget(el))
          : el;

      try {
        // actionability（skip for force / read-only actions）
        const checkResult = ensureActionable(actionabilityTarget, action, selector, force);
        if (checkResult) return checkResult;

        switch (action) {
          // ─── click ───
          case "click": {
            const target = resolvePointerActionTarget(resolveFormItemControlTarget(retarget(el, force ? "none" : "button-link")));
            const clickCount = typeof params.clickCount === "number" ? params.clickCount : 1;

            // option 元素自动写回 select
            if (target instanceof HTMLOptionElement) {
              const parent = target.parentElement;
              if (parent instanceof HTMLSelectElement) {
                parent.focus(); parent.value = target.value;
                dispatchInputEvents(parent);
                return { content: `已选择 ${describeElement(parent)} 的选项 "${target.value}"` };
              }
            }

            if (target instanceof HTMLElement) {
              scrollIntoViewIfNeeded(target);
              // stable 检查（参考 Playwright）
              if (!force) await checkElementStable(target, 500);
              // hit-target 检查
              if (!force) {
                const blocker = checkHitTarget(target);
                if (blocker) {
                  scrollIntoViewIfNeeded(target, 1);
                  await sleep(100);
                  // 第二次检查仍被遮挡时 warn 但不阻断
                }
              }
              dispatchClickEvents(target, clickCount);
            } else {
              target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
            return { content: `已点击 ${describeElement(target)}` };
          }

          // ─── fill（参考 Playwright 分类型策略） ───
          case "fill": {
            const value = params.value as string;
            if (value === undefined) return { content: "缺少 value 参数" };
            const target = retarget(el, "follow-label");

            if (target instanceof HTMLInputElement) {
              const type = target.type.toLowerCase();
              if (INPUT_BLOCKED_TYPES.has(type)) {
                return { content: `"${selector}" 为 input[type=${type}]，不支持 fill；请使用 click/check 等动作。`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
              }
              // date/color/range 等：直接 setValue（参考 Playwright kInputTypesToSetValue）
              if (INPUT_SET_VALUE_TYPES.has(type)) {
                const finalVal = type === "color" ? value.toLowerCase().trim() : value.trim();
                target.focus(); target.value = finalVal;
                if (target.value !== finalVal) return { content: `"${selector}" 填写格式不匹配（type=${type}）`, details: { error: true, code: "MALFORMED_VALUE", action, selector } };
                dispatchInputEvents(target);
                return { content: `已填写 ${describeElement(target)}: "${finalVal}"` };
              }
              // number 验证
              if (type === "number" && isNaN(Number(value.trim()))) {
                return { content: `"${selector}" 为 input[type=number]，无法填写非数字 "${value}"`, details: { error: true, code: "INVALID_NUMBER", action, selector } };
              }
              // text 类：focus → selectAll → 写入（参考 Playwright selectText+insertText）
              scrollIntoViewIfNeeded(target);
              target.focus();
              selectText(target);
              setNativeValue(target, value);
              dispatchInputEvents(target);
              if (target.value !== value) {
                return { content: `"${selector}" 填写后值不一致：期望 "${value}"，实际 "${target.value}"`, details: { error: true, code: "FILL_NOT_APPLIED", action, selector } };
              }
              return { content: `已填写 ${describeElement(target)}: "${value}"` };
            }

            if (target instanceof HTMLTextAreaElement) {
              scrollIntoViewIfNeeded(target);
              target.focus(); selectText(target);
              setNativeValue(target, value);
              dispatchInputEvents(target);
              return { content: `已填写 ${describeElement(target)}: "${value}"` };
            }

            if (target instanceof HTMLSelectElement) {
              target.focus();
              const options = Array.from(target.options);
              let matched = options.find(o => o.value === value);
              if (!matched) { const n = value.trim().toLowerCase(); matched = options.find(o => o.text.trim().toLowerCase() === n); }
              if (!matched) return { content: `"${selector}" 下拉框中不存在选项 "${value}"` };
              target.value = matched.value;
              dispatchInputEvents(target);
              return { content: `已填写 ${describeElement(target)}: "${value}"` };
            }

            if (target instanceof HTMLElement && target.isContentEditable) {
              target.focus(); selectText(target);
              if (value) document.execCommand("insertText", false, value);
              else document.execCommand("delete", false, undefined);
              return { content: `已填写 ${describeElement(target)}: "${value}"` };
            }

            return { content: `"${selector}" 不是可编辑元素` };
          }

          // ─── select_option（参考 Playwright selectOptions 多策略匹配） ───
          case "select_option": {
            const value = params.value as string | undefined;
            const label = params.label as string | undefined;
            const index = typeof params.index === "number" ? Math.floor(params.index) : undefined;
            if (value === undefined && label === undefined && index === undefined) {
              return { content: "缺少可选参数：value 或 label 或 index" };
            }

            const target = retarget(el, "follow-label");

            // 非原生 <select>：自定义下拉
            if (!(target instanceof HTMLSelectElement)) {
              if (!(target instanceof HTMLElement)) return { content: `"${selector}" 不是下拉框元素` };
              scrollIntoViewIfNeeded(target);
              const wanted = (label ?? value ?? "").trim();
              if (!wanted) return { content: `"${selector}" 为自定义下拉时，需提供 value 或 label` };
              dispatchClickEvents(target); // 点击触发器打开
              await waitForDropdownPopup(800);
              const option = findVisibleOptionByText(wanted);
              if (!option) return { content: `未找到与 "${wanted}" 匹配的可见下拉选项（自定义下拉）`, details: { error: true, code: "OPTION_NOT_FOUND", action, selector, wanted } };
              dispatchClickEvents(option);
              return { content: `已在自定义下拉中选择 "${wanted}"` };
            }

            // 原生 <select>
            target.focus();
            const options = Array.from(target.options);
            let selected: HTMLOptionElement | undefined;
            if (value !== undefined) selected = options.find(o => o.value === value);
            if (!selected && label !== undefined) { const nl = label.trim().toLowerCase(); selected = options.find(o => o.text.trim().toLowerCase() === nl); }
            if (!selected && value !== undefined) { const nv = value.trim().toLowerCase(); selected = options.find(o => o.text.trim().toLowerCase() === nv); }
            if (!selected && index !== undefined) {
              if (index < 0 || index >= options.length) return { content: `"${selector}" 下拉框不存在 index=${index} 的选项` };
              selected = options[index];
            }
            if (!selected) return { content: `"${selector}" 下拉框中不存在选项 "${value ?? label ?? `index=${index}`}"` };
            // option disabled 检查（参考 Playwright）
            if (selected.disabled) return { content: `"${selector}" 目标选项已禁用：${selected.value}`, details: { error: true, code: "OPTION_DISABLED", action, selector } };
            if (!target.multiple) { for (const o of options) o.selected = false; }
            selected.selected = true;
            target.value = selected.value;
            dispatchInputEvents(target);
            return { content: `已选择 ${describeElement(target)}: value="${selected.value}", label="${selected.text.trim()}"` };
          }

          // ─── clear ───
          case "clear": {
            const target = retarget(el, "follow-label");
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              scrollIntoViewIfNeeded(target);
              target.focus(); selectText(target);
              setNativeValue(target as HTMLInputElement, "");
              dispatchInputEvents(target);
              return { content: `已清空 ${describeElement(target)}` };
            }
            if (target instanceof HTMLSelectElement) {
              target.focus(); target.value = "";
              dispatchInputEvents(target);
              return { content: `已清空 ${describeElement(target)}` };
            }
            if (target instanceof HTMLElement && target.isContentEditable) {
              target.focus(); selectText(target);
              document.execCommand("delete", false, undefined);
              return { content: `已清空 ${describeElement(target)}` };
            }
            return { content: `"${selector}" 不是可清空元素` };
          }

          // ─── check / uncheck（参考 Playwright：通过 click 切换 + 验证状态） ───
          case "check":
          case "uncheck": {
            const wantChecked = action === "check";
            const current = getChecked(el);
            if (current === "error") {
              return { content: `"${selector}" 不是 checkbox/radio/[role=checkbox]/[role=radio]，无法 ${action}`, details: { error: true, code: "NOT_CHECKABLE", action, selector } };
            }
            // 已是目标状态（幂等，参考 Playwright）
            if (current === wantChecked) return { content: `${describeElement(el)} 已经是${wantChecked ? "选中" : "未选中"}状态` };
            // radio 不能 uncheck
            if (!wantChecked && el instanceof HTMLInputElement && el.type === "radio") {
              return { content: `无法取消 radio 按钮的选中状态`, details: { error: true, code: "CANNOT_UNCHECK_RADIO", action, selector } };
            }
            // 通过 click 切换（参考 Playwright _setChecked）
            const pointerTarget = resolvePointerActionTarget(el);
            scrollIntoViewIfNeeded(pointerTarget);
            if (pointerTarget instanceof HTMLElement) dispatchClickEvents(pointerTarget);
            else pointerTarget.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            // 验证状态变更
            await sleep(50);
            const finalState = getChecked(el);
            if (finalState !== wantChecked && el instanceof HTMLInputElement) {
              el.checked = wantChecked;
              dispatchInputEvents(el);
            }
            return { content: `已${wantChecked ? "勾选" : "取消勾选"} ${describeElement(el)}` };
          }

          // ─── type（逐字符键入） ───
          case "type": {
            const value = params.value as string;
            if (value === undefined) return { content: "缺少 value 参数" };
            const target = retarget(el, "follow-label");
            scrollIntoViewIfNeeded(target);
            if (target instanceof HTMLElement) target.focus();

            for (const char of value) {
              const init: KeyboardEventInit = { key: char, code: resolveKeyCode(char), bubbles: true, cancelable: true };
              target.dispatchEvent(new KeyboardEvent("keydown", init));
              target.dispatchEvent(new KeyboardEvent("keypress", init));
              if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
                const nativeSet = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                if (nativeSet) nativeSet.call(target, target.value + char); else target.value += char;
              } else if (target instanceof HTMLElement && target.isContentEditable) {
                document.execCommand("insertText", false, char);
              }
              target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
              target.dispatchEvent(new KeyboardEvent("keyup", init));
            }
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              target.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return { content: `已逐字输入到 ${describeElement(target)}: "${value}"` };
          }

          // ─── focus（参考 Playwright：双次 focus） ───
          case "focus": {
            const target = retarget(el, "follow-label");
            if (target instanceof HTMLElement || target instanceof SVGElement) {
              target.focus(); target.focus(); // Playwright workaround: 双次 focus
            }
            return { content: `已聚焦 ${describeElement(target)}` };
          }

          // ─── hover ───
          case "hover": {
            const target = retarget(el, "none");
            scrollIntoViewIfNeeded(target);
            if (!force) await checkElementStable(target, 500);
            if (target instanceof HTMLElement) dispatchHoverEvents(target);
            return { content: `已悬停 ${describeElement(target)}` };
          }

          // ─── scroll（组件内滚动，适配时间滚轮/虚拟列表） ───
          case "scroll": {
            const target = retarget(el, "none");
            const deltaY = typeof params.deltaY === "number"
              ? params.deltaY
              : (typeof params.value === "string" && !Number.isNaN(Number(params.value)) ? Number(params.value) : 180);
            const deltaX = typeof params.deltaX === "number" ? params.deltaX : 0;
            const rawSteps = typeof params.steps === "number" ? Math.floor(params.steps) : 1;
            const steps = Math.min(20, Math.max(1, rawSteps));

            if (target instanceof HTMLElement) {
              scrollIntoViewIfNeeded(target);
              for (let i = 0; i < steps; i++) {
                target.scrollBy({ top: deltaY, left: deltaX, behavior: "auto" });
                target.dispatchEvent(new WheelEvent("wheel", {
                  bubbles: true,
                  cancelable: true,
                  deltaY,
                  deltaX,
                }));
              }
              return { content: `已滚动 ${describeElement(target)}: deltaY=${deltaY}, deltaX=${deltaX}, steps=${steps}` };
            }

            for (let i = 0; i < steps; i++) {
              target.dispatchEvent(new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                deltaY,
                deltaX,
              }));
            }
            return { content: `已滚动 ${describeElement(target)}: deltaY=${deltaY}, deltaX=${deltaX}, steps=${steps}` };
          }

          // ─── press（支持组合键） ───
          case "press": {
            const key = (params.key as string) || (params.value as string);
            if (!key) return { content: "缺少 key 参数（如 Enter, Escape, Tab, Control+a）" };
            const target = retarget(el, "none");
            scrollIntoViewIfNeeded(target);
            if (target instanceof HTMLElement) target.focus();
            executePress(target, key);
            // Enter 特殊：触发 form submit
            const mainKey = splitKeyCombo(key).pop();
            if (mainKey === "Enter") {
              const form = (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) ? (target.form ?? target.closest("form")) : target.closest("form");
              form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            }
            return { content: `已在 ${describeElement(target)} 上按下 ${key}` };
          }

          // ─── 读取类 ───
          case "get_text": {
            const text = el.textContent?.trim() ?? "";
            return { content: `${describeElement(el)} 的文本内容：${text || "(空)"}` };
          }
          case "get_attr": {
            const attribute = params.attribute as string;
            if (!attribute) return { content: "缺少 attribute 参数" };
            const attrName = attribute.toLowerCase();
            if (attrName === "checked") {
              if (el instanceof HTMLInputElement) return { content: `${describeElement(el)} 的 checked = ${String(el.checked)}` };
              return { content: `${describeElement(el)} 的 checked = ${el.getAttribute("aria-checked") ?? "(不存在)"}` };
            }
            if (attrName === "selected") {
              if (el instanceof HTMLOptionElement) return { content: `${describeElement(el)} 的 selected = ${String(el.selected)}` };
              return { content: `${describeElement(el)} 的 selected = ${el.getAttribute("aria-selected") ?? "(不存在)"}` };
            }
            if (attrName === "disabled") {
              if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
                return { content: `${describeElement(el)} 的 disabled = ${String(el.disabled)}` };
              }
            }
            if (attrName === "readonly" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
              return { content: `${describeElement(el)} 的 readonly = ${String(el.readOnly)}` };
            }
            if (attrName === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
              return { content: `${describeElement(el)} 的 value = ${el.value || "(空)"}` };
            }
            return { content: `${describeElement(el)} 的 ${attribute} = ${el.getAttribute(attribute) ?? "(不存在)"}` };
          }

          // ─── 修改类 ───
          case "set_attr": {
            const attribute = params.attribute as string;
            const value = params.value as string;
            if (!attribute || value === undefined) return { content: "缺少 attribute 或 value 参数" };
            el.setAttribute(attribute, value);
            return { content: `已设置 ${describeElement(el)} 的 ${attribute}="${value}"` };
          }
          case "add_class": {
            const className = params.className as string;
            if (!className) return { content: "缺少 className 参数" };
            el.classList.add(className);
            return { content: `已添加 class "${className}" 到 ${describeElement(el)}` };
          }
          case "remove_class": {
            const className = params.className as string;
            if (!className) return { content: "缺少 className 参数" };
            el.classList.remove(className);
            return { content: `已移除 ${describeElement(el)} 的 class "${className}"` };
          }

          default:
            return { content: `未知的 DOM 动作: ${action}` };
        }
      } catch (err) {
        return { content: `DOM 操作 "${action}" 失败: ${err instanceof Error ? err.message : String(err)}`, details: { error: true, action, selector } };
      }
    },
  };
}