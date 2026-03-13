/**
 * DOM Tool — 浏览器 DOM 操作工具定义与分发。
 *
 * 职责：
 *   本文件只负责工具的 schema 定义、参数解析和 action 分发，
 *   所有底层能力（事件模拟、可操作性检查、目标重定向、填充策略等）
 *   均委托至 helpers/base/ 和 helpers/actions/ 子模块。
 *
 * 支持 16 种动作：
 *   click          — Playwright 风格完整事件链点击（含 retarget、stable、hit-target、click-signal 校验）
 *   fill           — 表单填充（date/color/range 走 setValue；text 类走 selectAll+原生写入；slider 自动关联数值输入）
 *   select_option  — 下拉选择（原生 <select> + 自定义下拉弹窗，支持 value/label/index 三种策略）
 *   clear          — 清空输入框（selectAll + Delete）
 *   check/uncheck  — 复选框/单选框/开关切换（通过 click 切换 + 状态验证）
 *   type           — 逐字符输入（不清空已有内容，适用于搜索建议等需触发 input 事件的场景）
 *   focus          — 聚焦元素（触发 focus 事件）
 *   hover          — 悬停（完整 pointerenter/mouseover/pointermove/mousemove 事件链）
 *   scroll         — 元素级滚动（deltaY/deltaX + steps 配合虚拟列表加载）
 *   press          — 键盘按键（支持 Control+a、Shift+Enter 等修饰键组合）
 *   get_text       — 获取元素 textContent
 *   get_attr       — 获取元素属性值
 *   set_attr       — 设置元素属性
 *   add_class      — 添加 CSS 类名
 *   remove_class   — 移除 CSS 类名
 *
 * 关键机制（参考 Playwright injectedScript）：
 *   - retarget：点击前自动重定向到 button/link/label.control（helpers/actions/retarget）
 *   - scrollIntoView 多策略：4 种 block 对齐轮换，解决 sticky/fixed 遮挡
 *   - stable 检查：rAF 逐帧检测元素位置稳定后再操作
 *   - hit-target 验证：elementsFromPoint 检测遮挡
 *   - ARIA disabled：检查祖先链 aria-disabled="true"
 *   - click-signal 校验：validateClickSignal 验证目标是否具有点击语义
 *   - fill 重定向：目标不可编辑时尝试 formItem→control / nearby 推断
 *
 * 依赖结构：
 *   helpers/base/   → resolve-selector, event-dispatch, keyboard, actionability
 *   helpers/actions/ → retarget, fill-helpers, dropdown-helpers
 *
 * 运行环境：浏览器 Content Script（直接访问 DOM，无 CDP）。
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import { resolveSelector } from "../helpers/base/resolve-selector.js";
import { sleep, dispatchClickEvents, dispatchHoverEvents, dispatchInputEvents, setNativeValue, selectText } from "../helpers/base/event-dispatch.js";
import { splitKeyCombo, resolveKeyCode, executePress } from "../helpers/base/keyboard.js";
import { checkElementStable, scrollIntoViewIfNeeded, checkHitTarget, describeElement, ensureActionable, validateClickSignal } from "../helpers/base/actionability.js";
import { retarget, getChecked, resolveCheckableTarget, resolvePointerActionTarget, resolveFormItemControlTarget } from "../helpers/actions/retarget.js";
import { executeFillOnResolvedTarget, guessNearbyFillTarget, findAssociatedSliderInput } from "../helpers/actions/fill-helpers.js";
import { findVisibleOptionByText, waitForDropdownPopup } from "../helpers/actions/dropdown-helpers.js";

// Re-export activeRefStore 管理函数，保持外部导入路径兼容
export { setActiveRefStore, getActiveRefStore } from "../helpers/base/active-store.js";

// ─── 常量 ───

const DEFAULT_WAIT_MS = 1200;

// ─── 基础工具 ───

/** 查询元素：基于共享 resolveSelector，包装错误消息 */
function queryElement(selector: string): Element | string {
  try {
    const el = resolveSelector(selector);
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

// ─── 工具定义 ───

export function createDomTool(): ToolDefinition {
  return {
    name: "dom",
    description: [
      "DOM actions on the current page.",
      "Actions: click, fill, select_option, clear, check, uncheck, type, focus, hover, scroll, press, get_text, get_attr, set_attr, add_class, remove_class.",
      "Prefer #hashID from snapshot as selector; use CSS only as compatibility fallback, not as the default strategy.",
      "Before fill/type/select_option, click or focus the same target in the same round.",
      "For multi-field forms, pair focus/click and fill/type per field in one batch.",
      "press supports combos like Enter or Control+a.",
      "Visual ordinal instructions use 1-based order.",
      "check/uncheck toggles via click and verifies the final state.",
      "Do not click nearby descriptive text, labels, or help text when a separate actionable control is visible; target the real interactive option that changes state.",
      "For custom widgets such as rating, slider, or composite pickers, prefer visible actionable child items; use fill for slider-like controls when appropriate.",
      "For virtualized lists, wheel pickers, or not-yet-visible options, scroll first and then click or select the newly visible target.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "DOM action name.",
      }),
      selector: Type.String({ description: "Prefer #hashID from snapshot; CSS selector is fallback only" }),
      value: Type.Optional(Type.String({ description: "Value for fill/type/set_attr" })),
      key: Type.Optional(Type.String({ description: "Key for press, supports combos" })),
      label: Type.Optional(Type.String({ description: "Label for select_option" })),
      index: Type.Optional(Type.Number({ description: "0-based option index" })),
      attribute: Type.Optional(Type.String({ description: "Attribute name" })),
      className: Type.Optional(Type.String({ description: "CSS class name" })),
      clickCount: Type.Optional(Type.Number({ description: "Click count" })),
      deltaY: Type.Optional(Type.Number({ description: "Vertical scroll delta" })),
      deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll delta" })),
      steps: Type.Optional(Type.Number({ description: "Scroll repeat count" })),
      waitMs: Type.Optional(Type.Number({ description: "Wait timeout in ms" })),
      waitSeconds: Type.Optional(Type.Number({ description: "Wait timeout in seconds" })),
      force: Type.Optional(Type.Boolean({ description: "Skip actionability checks" })),
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

            // 点击信号校验：阻止点击仅有 blur/focus 监听器的元素
            if (!force) {
              const noSignal = validateClickSignal(target, selector, action);
              if (noSignal) return noSignal;
            }

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

            // role=slider 特化：优先写关联数字输入框，其次点击离散子项（评分星级）
            if (target instanceof HTMLElement && target.getAttribute("role") === "slider") {
              const numericValue = Number(value);
              if (!Number.isFinite(numericValue)) {
                const guessed = guessNearbyFillTarget(target, value);
                if (guessed) {
                  const guessedResult = await executeFillOnResolvedTarget(guessed, value, selector, action, "heuristic-nearby-target");
                  if (guessedResult) return guessedResult;
                }
                return { content: `"${selector}" 为 role=slider，未找到可推断填写目标`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
              }

              const linkedInput = findAssociatedSliderInput(target);
              if (linkedInput) {
                const filled = await executeFillOnResolvedTarget(linkedInput, String(numericValue), selector, action, `from ${describeElement(target)}`);
                if (filled) return filled;
              }

              const min = Number(target.getAttribute("aria-valuemin") ?? "1");
              const max = Number(target.getAttribute("aria-valuemax") ?? String(target.children.length || 5));
              const discreteCount = Number.isFinite(max - min + 1) ? Math.max(1, Math.round(max - min + 1)) : target.children.length;
              const desiredIndex = Math.round(numericValue - min);
              const children = Array.from(target.children).filter((node): node is HTMLElement => node instanceof HTMLElement);

              if (children.length >= discreteCount && desiredIndex >= 0 && desiredIndex < children.length) {
                const item = children[desiredIndex];
                scrollIntoViewIfNeeded(item);
                dispatchClickEvents(item);
                return { content: `已点击 ${describeElement(item)}，设置 ${describeElement(target)} 值为 ${numericValue}` };
              }

              const guessed = guessNearbyFillTarget(target, String(numericValue));
              if (guessed) {
                const guessedResult = await executeFillOnResolvedTarget(guessed, String(numericValue), selector, action, "heuristic-nearby-target");
                if (guessedResult) return guessedResult;
              }

              return { content: `"${selector}" 为 role=slider，但未找到可写入输入框或可点击离散子项`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
            }

            const directFilled = await executeFillOnResolvedTarget(target, value, selector, action);
            if (directFilled) return directFilled;

            const guessed = guessNearbyFillTarget(target, value);
            if (guessed) {
              const guessedResult = await executeFillOnResolvedTarget(guessed, value, selector, action, "heuristic-nearby-target");
              if (guessedResult) return guessedResult;
            }

            return { content: `"${selector}" 不是可编辑元素，且未在附近找到可推断填写目标`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
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

            // 原生 <select>：模拟真实用户交互，先 click 再选择
            scrollIntoViewIfNeeded(target);
            dispatchClickEvents(target);
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
            // 模拟真实用户交互：先 click 再逐字输入（dispatchClickEvents 内含 focus）
            if (target instanceof HTMLElement) dispatchClickEvents(target);
            else if (target instanceof SVGElement) target.focus();

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