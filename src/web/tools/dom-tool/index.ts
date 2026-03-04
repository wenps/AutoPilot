/**
 * DOM Tool — 浏览器 DOM 操作工具入口（结合 Playwright 核心交互模式增强）。
 *
 * 关键能力：
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
import type { ToolDefinition, ToolCallResult } from "../../../core/tool-registry.js";

// ─── 子模块 re-export（公共 API） ───
export { setActiveRefStore, getActiveRefStore } from "./query.js";

// ─── 内部依赖 ───
import { INPUT_SET_VALUE_TYPES, INPUT_BLOCKED_TYPES } from "./constants.js";
import { queryElement, waitForElement, resolveWaitMs, describeElement, sleep } from "./query.js";
import {
  ensureActionable,
  checkElementStable,
  scrollIntoViewIfNeeded,
  checkHitTarget,
} from "./actionability.js";
import {
  dispatchClickEvents,
  dispatchHoverEvents,
  dispatchInputEvents,
  setNativeValue,
  selectText,
  splitKeyCombo,
  resolveKeyCode,
  executePress,
} from "./events.js";
import {
  retarget,
  getChecked,
  resolveCheckableTarget,
  resolvePointerActionTarget,
  resolveFormItemControlTarget,
  resolveClickableAncestorTarget,
  resolveEditableTarget,
} from "./resolve.js";
import { findVisibleOptionByText, waitForDropdownPopup } from "./dropdown.js";

// ─── 工具定义 ───

export function createDomTool(): ToolDefinition {
  return {
    name: "dom",
    description: [
      "Perform DOM operations on the current page.",
      "Actions: click, fill, select_option, clear, check, uncheck, type, focus, hover, scroll, press, get_text, get_attr, set_attr, add_class, remove_class.",
      "fill auto-resolves wrapper → inner input. check/uncheck toggles via click. press supports combos (Control+a). scroll supports steps for repeated scrolling.",
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
      waitMs: Type.Optional(Type.Number({ description: "Wait timeout in ms before action (default: 1200)." })),
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

      // fill/type/clear 穿透 wrapper 找到真实可编辑控件，确保 actionability 检查通过
      if (["fill", "type", "clear"].includes(action)) {
        el = resolveEditableTarget(retarget(el, "follow-label"));
      }

      const actionabilityTarget =
        action === "click" || action === "check" || action === "uncheck"
          ? resolvePointerActionTarget(resolveClickableAncestorTarget(resolveFormItemControlTarget(el)))
          : el;

      try {
        // actionability（skip for force / read-only actions）
        const checkResult = ensureActionable(actionabilityTarget, action, selector, force);
        if (checkResult) return checkResult;

        switch (action) {
          // ─── click ───
          case "click": {
            const target = resolvePointerActionTarget(
              resolveClickableAncestorTarget(
                resolveFormItemControlTarget(retarget(el, force ? "none" : "button-link")),
              ),
            );
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
              if (!force) await checkElementStable(target, 500);
              if (!force) {
                const blocker = checkHitTarget(target);
                if (blocker) {
                  scrollIntoViewIfNeeded(target, 1);
                  await sleep(100);
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
            const target = el;

            if (target instanceof HTMLInputElement) {
              const type = target.type.toLowerCase();
              if (INPUT_BLOCKED_TYPES.has(type)) {
                return { content: `"${selector}" 为 input[type=${type}]，不支持 fill；请使用 click/check 等动作。`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
              }
              if (INPUT_SET_VALUE_TYPES.has(type)) {
                const finalVal = type === "color" ? value.toLowerCase().trim() : value.trim();
                target.focus(); target.value = finalVal;
                if (target.value !== finalVal) return { content: `"${selector}" 填写格式不匹配（type=${type}）`, details: { error: true, code: "MALFORMED_VALUE", action, selector } };
                dispatchInputEvents(target);
                return { content: `已填写 ${describeElement(target)}: "${finalVal}"` };
              }
              if (type === "number" && isNaN(Number(value.trim()))) {
                return { content: `"${selector}" 为 input[type=number]，无法填写非数字 "${value}"`, details: { error: true, code: "INVALID_NUMBER", action, selector } };
              }
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
              dispatchClickEvents(target);
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
            if (selected.disabled) return { content: `"${selector}" 目标选项已禁用：${selected.value}`, details: { error: true, code: "OPTION_DISABLED", action, selector } };
            if (!target.multiple) { for (const o of options) o.selected = false; }
            selected.selected = true;
            target.value = selected.value;
            dispatchInputEvents(target);
            return { content: `已选择 ${describeElement(target)}: value="${selected.value}", label="${selected.text.trim()}"` };
          }

          // ─── clear ───
          case "clear": {
            const target = el;
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
            if (current === wantChecked) return { content: `${describeElement(el)} 已经是${wantChecked ? "选中" : "未选中"}状态` };
            if (!wantChecked && el instanceof HTMLInputElement && el.type === "radio") {
              return { content: `无法取消 radio 按钮的选中状态`, details: { error: true, code: "CANNOT_UNCHECK_RADIO", action, selector } };
            }
            const pointerTarget = resolvePointerActionTarget(el);
            scrollIntoViewIfNeeded(pointerTarget);
            if (pointerTarget instanceof HTMLElement) dispatchClickEvents(pointerTarget);
            else pointerTarget.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
            const target = el;
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

          // ─── focus ───
          case "focus": {
            const target = retarget(el, "follow-label");
            if (target instanceof HTMLElement || target instanceof SVGElement) {
              target.focus(); target.focus();
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

          // ─── scroll ───
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
                target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, deltaX }));
              }
              return { content: `已滚动 ${describeElement(target)}: deltaY=${deltaY}, deltaX=${deltaX}, steps=${steps}` };
            }

            for (let i = 0; i < steps; i++) {
              target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, deltaX }));
            }
            return { content: `已滚动 ${describeElement(target)}: deltaY=${deltaY}, deltaX=${deltaX}, steps=${steps}` };
          }

          // ─── press ───
          case "press": {
            const key = (params.key as string) || (params.value as string);
            if (!key) return { content: "缺少 key 参数（如 Enter, Escape, Tab, Control+a）" };
            const target = retarget(el, "none");
            scrollIntoViewIfNeeded(target);
            if (target instanceof HTMLElement) target.focus();
            executePress(target, key);
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
