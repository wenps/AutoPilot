/**
 * 目标重定向与归一化 / Target retargeting & normalization.
 *
 * 参考 Playwright injectedScript.retarget，处理：
 * - 非交互元素→button/link 回溯
 * - label→control 关联
 * - checkbox/radio/switch 归一化
 * - 隐藏 input→可见代理目标
 * - 表单项 label→控件重定向
 *
 * 从 dom-tool 提取。
 */
import { isElementVisible } from "../base/visibility.js";
import { findFormItemContainer } from "../base/form-item.js";
import { getTrackedElementEvents } from "../../../core/event-listener-tracker.js";

// ─── retarget（参考 Playwright injectedScript.retarget） ───

export type RetargetMode = "none" | "follow-label" | "button-link";

/**
 * 将目标重定向到关联的交互控件。
 * - button-link：非交互元素→最近 button/[role=button]/a/[role=link]
 * - follow-label：label→control + 非交互→button/[role=button]/[role=checkbox]/[role=radio]
 */
export function retarget(el: Element, mode: RetargetMode): Element {
  if (mode === "none") return el;
  if (!el.matches("input, textarea, select") && !(el as HTMLElement).isContentEditable) {
    // 如果元素本身有 click/pointerdown/mousedown 追踪事件，
    // 说明它是独立的交互目标，不应被回溯到祖先 button/link。
    // 典型场景：el-color-picker 内层 div 有 @click="handleTrigger"，
    // 若回溯到外层 button 则永远无法触发面板打开。
    const tracked = getTrackedElementEvents(el);
    const hasSelfClickSignal = tracked.includes("click") || tracked.includes("mousedown") || tracked.includes("pointerdown");
    if (!hasSelfClickSignal) {
      if (mode === "button-link") {
        el = el.closest("button, [role=button], a, [role=link]") || el;
      } else {
        el = el.closest("button, [role=button], [role=checkbox], [role=radio]") || el;
      }
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

// ─── checkable 状态 ───

/** 获取 checked 状态：checkbox/radio → boolean，ARIA role → boolean，其他 → "error" */
export function getChecked(el: Element): boolean | "error" {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;
  const role = el.getAttribute("role");
  if (role === "checkbox" || role === "radio" || role === "switch") return el.getAttribute("aria-checked") === "true";
  return "error";
}

/**
 * 归一化 check/uncheck 目标：允许命中文本容器/label/div，回溯到关联 checkbox/radio。
 */
export function resolveCheckableTarget(el: Element): Element {
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
export function resolvePointerActionTarget(el: Element): Element {
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
 * 判断元素是否为表单项 label（原生 <label> 或类名含 `form` + `label`）。
 */
function isFormItemLabel(el: HTMLElement): boolean {
  if (el.tagName === "LABEL") return true;
  const classes = el.classList;
  for (let i = 0; i < classes.length; i++) {
    if (classes[i].includes("form") && classes[i].includes("label")) return true;
  }
  return false;
}

/**
 * 在表单项容器内查找内容区（排除 label 区）。
 *
 * 通过类名含 `content`/`control`/`wrapper`/`blank` 的子元素启发式匹配，
 * 覆盖 Element Plus、Ant Design、TDesign、BK-UI、Naive UI、Arco Design 等。
 */
function findFormItemContent(formItem: Element): Element {
  for (const child of formItem.children) {
    const classes = child.classList;
    for (let i = 0; i < classes.length; i++) {
      const cls = classes[i];
      if (cls.includes("content") || cls.includes("control") || cls.includes("wrapper") || cls.includes("blank")) {
        return child;
      }
    }
  }
  return formItem;
}

/**
 * 当命中表单项说明 label 时，自动重定向到同一表单项中的首个可交互控件。
 *
 * 通过通配模式自动覆盖所有主流 UI 框架，无需逐个列举。
 */
export function resolveFormItemControlTarget(el: Element): Element {
  if (!(el instanceof HTMLElement)) return el;
  if (!isFormItemLabel(el)) return el;

  const htmlLabel = el as HTMLLabelElement;
  if (htmlLabel.control && isElementVisible(htmlLabel.control)) return htmlLabel.control;

  const formItem = findFormItemContainer(el);
  if (!formItem) return el;
  const content = findFormItemContent(formItem);
  const control = content.querySelector(
    "input:not([type='hidden']), textarea, select, button, [role='switch'], [role='checkbox'], [role='radio'], [role='button'], [tabindex]:not([tabindex='-1'])",
  );
  if (control && isElementVisible(control)) return control;
  return el;
}
