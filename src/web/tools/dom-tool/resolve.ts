/**
 * DOM Tool — 目标解析与归一化。
 *
 * 包含：retarget、checkable 目标归一化、pointer action 代理、
 *       表单项控件重定向、editable 穿透。
 */
import { isElementVisible, isEditableElement } from "./actionability.js";
import { getTrackedElementEvents } from "../../event-listener-tracker.js";

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

// ─── checkable 目标归一化 ───

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
 * 点击目标上卷：当命中文本/装饰子节点时，优先上卷到最近可点击祖先。
 *
 * 典型场景：
 * - 列表项文本本身无 click，但父级容器（如 .g-pointer）有点击语义
 * - 事件委托绑定在祖先，子节点点击命中不稳定
 */
export function resolveClickableAncestorTarget(el: Element): Element {
  const isSelfClickable = (node: Element): boolean => {
    if (node.matches("a, button, input, textarea, select, summary, [role=button], [role=link], [role=menuitem]")) {
      return true;
    }
    if (node.hasAttribute("onclick")) return true;

    const tabIndexAttr = node.getAttribute("tabindex");
    if (tabIndexAttr !== null && tabIndexAttr !== "-1") return true;

    const tracked = getTrackedElementEvents(node);
    if (tracked.some(name => name === "click" || name === "pointerdown" || name === "mousedown")) {
      return true;
    }

    return false;
  };

  if (isSelfClickable(el)) return el;

  let ancestor: Element | null = el.parentElement;
  for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
    if (!isElementVisible(ancestor)) continue;
    if (isSelfClickable(ancestor)) return ancestor;
  }

  return el;
}

/**
 * 当命中表单项说明 label（如 Element Plus el-form-item__label）时，
 * 自动重定向到同一表单项中的首个可交互控件。
 */
export function resolveFormItemControlTarget(el: Element): Element {
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

/**
 * 穿透包裹容器，查找内部可编辑子元素。
 * 覆盖 UI 框架常见模式：wrapper div 包裹真实 input/textarea。
 * 若自身已可编辑则直接返回；否则在子树中搜索第一个可编辑且可见的控件。
 * 对 role=slider/spinbutton 等 ARIA widget：向上逐级查找最近容器中的关联 input。
 */
export function resolveEditableTarget(el: Element): Element {
  if (isEditableElement(el)) return el;

  // 策略 1：子树中直接查找可编辑控件
  const inner = el.querySelector(
    'input:not([type="hidden"]), textarea, select, [contenteditable="true"]',
  );
  if (inner && isEditableElement(inner) && isElementVisible(inner)) return inner;

  // 策略 2：ARIA widget（role=slider/spinbutton 等）→ 向上逐级查找关联 input
  // 通用：不硬编码框架类名，按语义逐层向上搜索最近的 input
  const role = el.getAttribute("role");
  if (role === "slider" || role === "spinbutton") {
    let ancestor = el.parentElement;
    // 最多向上查找 5 层，在每层的子树中搜索关联 input
    for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
      const input = ancestor.querySelector(
        'input[type="number"], input[role="spinbutton"], input:not([type="hidden"])',
      );
      if (input instanceof HTMLInputElement && isEditableElement(input) && isElementVisible(input)) {
        return input;
      }
    }
  }

  return el;
}
