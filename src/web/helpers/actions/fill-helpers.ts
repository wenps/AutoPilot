/**
 * 表单填写工具函数 / Form fill helper utilities.
 *
 * 背景：
 *   Agent 在执行 `dom.fill` 动作时，需要把一个字符串值写入页面上的表单控件。
 *   但模型给的 selector 不一定直接命中可编辑元素（可能命中 label、slider、外层容器），
 *   而且不同类型的 input 写入策略也不同（date → 直接赋值，text → selectAll+原生写入）。
 *
 * 本模块解决三个问题：
 *   1. **分策略写入**（`executeFillOnResolvedTarget`）：
 *      根据目标元素类型采用正确的写入方式，确保 React/Vue 受控组件能正确响应。
 *   2. **附近目标推断**（`guessNearbyFillTarget`）：
 *      当 selector 命中的不是可编辑元素时，在附近 DOM 树中启发式搜索最可能的输入控件。
 *   3. **Slider 关联**（`findAssociatedSliderInput`）：
 *      当 fill 作用于 role=slider 时，找到关联的数值输入框进行写入。
 *
 * 调用链路：
 *   dom-tool fill action → retarget → executeFillOnResolvedTarget
 *                                   ↘ (不可编辑) → guessNearbyFillTarget → executeFillOnResolvedTarget
 *   dom-tool fill action → (role=slider) → findAssociatedSliderInput → executeFillOnResolvedTarget
 *
 * 从 dom-tool 提取。
 */
import type { ToolCallResult } from "../../../core/tool-registry.js";
import { getTrackedElementEvents } from "../../../core/event-listener-tracker.js";
import { isElementVisible } from "../base/visibility.js";
import { isElementDisabled, isEditableElement, INPUT_BLOCKED_TYPES } from "../base/element-checks.js";
import { sleep, dispatchClickEvents, dispatchInputEvents, setNativeValue, selectText } from "../base/event-dispatch.js";
import { scrollIntoViewIfNeeded, describeElement } from "../base/actionability.js";
import { findFormItemContainer } from "../base/form-item.js";

// ─── 常量 ───

/**
 * fill 时直接 setValue 的 input 类型（参考 Playwright kInputTypesToSetValue）。
 *
 * 这些类型的 input 有浏览器原生 UI（颜色选择器、日期选择器等），
 * 不支持 selectAll+键入的方式写入，必须直接设置 .value 属性。
 */
export const INPUT_SET_VALUE_TYPES = new Set([
  "color", "date", "time", "datetime-local", "month", "range", "week",
]);

/**
 * 与表单填写相关的事件名集合。
 *
 * 用于 `getFillEventSupportScore` 评分：
 * 一个元素绑定了越多这些事件，越可能是真正的输入控件（而非纯展示元素）。
 */
const FILL_RELEVANT_EVENTS = new Set([
  "input", "change", "focus", "blur", "keydown",
  "click", "mousedown", "pointerdown",
]);

// ─── 评分与候选 ───

/**
 * 根据事件监听计算元素作为 fill 目标的适配度评分。
 *
 * 使用场景：`guessNearbyFillTarget` 在附近搜索到多个候选 input 时，
 * 用此评分排序，选出最可能是"真正输入框"的那个。
 *
 * 评分逻辑（累加制）：
 * - 内联属性（oninput/onchange/onfocus/onblur/onclick）：高分，说明开发者显式绑定了交互
 * - 运行时事件监听（通过 EventTarget.prototype 补丁追踪）：
 *   - input/change 事件：最高分（React/Vue 受控组件必绑）
 *   - focus/blur 事件：中等分（校验/格式化常见）
 *   - keydown 事件：较低分（搜索/快捷键）
 *   - 其他关联事件：兜底分
 *
 * @param el - 候选元素
 * @returns 评分（越高越适合作为 fill 目标）
 */
export function getFillEventSupportScore(el: Element): number {
  let score = 0;

  if (el.hasAttribute("oninput") || el.hasAttribute("onchange")) score += 80;
  if (el.hasAttribute("onfocus") || el.hasAttribute("onblur")) score += 60;
  if (el.hasAttribute("onclick")) score += 40;

  const tracked = getTrackedElementEvents(el);
  for (const eventName of tracked) {
    if (!FILL_RELEVANT_EVENTS.has(eventName)) continue;
    if (eventName === "input") score += 40;
    else if (eventName === "change") score += 35;
    else if (eventName === "focus" || eventName === "blur") score += 28;
    else if (eventName === "keydown") score += 24;
    else score += 14;
  }

  return score;
}

/**
 * 判断元素是否可作为 fill 候选目标。
 *
 * 条件：
 * - input/textarea/select 且未被 disabled
 * - 或 contentEditable 元素
 *
 * 注意：不检查 readOnly（由 `isEditableElement` 负责更严格的检查），
 * 这里只做粗筛，用于 `guessNearbyFillTarget` 的候选集过滤。
 */
export function isCandidateFillTarget(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return !isElementDisabled(el);
  }
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}

// ─── fill 执行 ───

/**
 * 在已确定的目标元素上执行 fill，根据元素类型分策略写入。
 *
 * 写入策略（参考 Playwright InputUtils）：
 *
 * | 元素类型                     | 策略                                           |
 * |------------------------------|------------------------------------------------|
 * | input[color/date/range/...]  | 直接赋值 .value（浏览器原生 UI 类型）            |
 * | input[text/email/number/...] | click → selectAll → 原生 setter 写入            |
 * | textarea                     | click → selectAll → 原生 setter 写入            |
 * | select                       | 按 value/label 匹配 option，设置 .value         |
 * | contentEditable              | click → selectAll → execCommand insertText      |
 * | input[checkbox/radio/file]   | 拒绝，返回错误提示                              |
 *
 * 关键细节：
 * - 使用原生 setter（`Object.getOwnPropertyDescriptor(proto, 'value').set`）
 *   绕过 React/Vue 的 getter/setter 拦截，确保框架能检测到值变化。
 * - click 前先 scrollIntoView，click 后让出一个事件循环（`sleep(0)`），
 *   等待框架异步 focus handler 执行完毕再写入。
 * - 写入后派发 input + change 事件，触发受控组件的状态同步。
 *
 * @param target - 目标元素（已经过 retarget/guess 确认）
 * @param value - 要写入的字符串值
 * @param selector - 原始选择器（用于错误消息）
 * @param action - 动作名（用于错误消息）
 * @param sourceHint - 来源提示（如 "heuristic-nearby-target"，用于调试）
 * @returns 成功/失败的 ToolCallResult，不支持的元素类型返回 null
 */
export async function executeFillOnResolvedTarget(
  target: Element,
  value: string,
  selector: string,
  action: string,
  sourceHint?: string,
): Promise<ToolCallResult | null> {
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    if (INPUT_BLOCKED_TYPES.has(type)) {
      return { content: `"${selector}" 为 input[type=${type}]，不支持 fill；请使用 click/check 等动作。`, details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector } };
    }
    if (INPUT_SET_VALUE_TYPES.has(type)) {
      const finalVal = type === "color" ? value.toLowerCase().trim() : value.trim();
      target.focus();
      target.value = finalVal;
      if (target.value !== finalVal) {
        return { content: `"${selector}" 填写格式不匹配（type=${type}）`, details: { error: true, code: "MALFORMED_VALUE", action, selector } };
      }
      dispatchInputEvents(target);
      const suffix = sourceHint ? `（${sourceHint}）` : "";
      return { content: `已填写 ${describeElement(target)}: "${finalVal}"${suffix}` };
    }
    if (type === "number" && Number.isNaN(Number(value.trim()))) {
      return { content: `"${selector}" 为 input[type=number]，无法填写非数字 "${value}"`, details: { error: true, code: "INVALID_NUMBER", action, selector } };
    }
    scrollIntoViewIfNeeded(target);
    // 模拟真实用户交互：先 click 再 fill（dispatchClickEvents 内含 focus）
    dispatchClickEvents(target);
    // 让出一个事件循环，等待框架异步 focus handler（如 Vue nextTick、BK-Input 后处理）执行完毕
    await sleep(0);
    selectText(target);
    setNativeValue(target, value);
    dispatchInputEvents(target);
    if (target.value !== value) {
      return { content: `"${selector}" 填写后值不一致：期望 "${value}"，实际 "${target.value}"`, details: { error: true, code: "FILL_NOT_APPLIED", action, selector } };
    }
    const suffix = sourceHint ? `（${sourceHint}）` : "";
    return { content: `已填写 ${describeElement(target)}: "${value}"${suffix}` };
  }

  if (target instanceof HTMLTextAreaElement) {
    scrollIntoViewIfNeeded(target);
    // 模拟真实用户交互：先 click 再 fill（dispatchClickEvents 内含 focus）
    dispatchClickEvents(target);
    await sleep(0);
    selectText(target);
    setNativeValue(target, value);
    dispatchInputEvents(target);
    const suffix = sourceHint ? `（${sourceHint}）` : "";
    return { content: `已填写 ${describeElement(target)}: "${value}"${suffix}` };
  }

  if (target instanceof HTMLSelectElement) {
    target.focus();
    const options = Array.from(target.options);
    let matched = options.find(o => o.value === value);
    if (!matched) {
      const normalized = value.trim().toLowerCase();
      matched = options.find(o => o.text.trim().toLowerCase() === normalized);
    }
    if (!matched) return { content: `"${selector}" 下拉框中不存在选项 "${value}"` };
    target.value = matched.value;
    dispatchInputEvents(target);
    const suffix = sourceHint ? `（${sourceHint}）` : "";
    return { content: `已填写 ${describeElement(target)}: "${value}"${suffix}` };
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    // 模拟真实用户交互：先 click 再 fill（dispatchClickEvents 内含 focus）
    dispatchClickEvents(target);
    await sleep(0);
    selectText(target);
    if (value) document.execCommand("insertText", false, value);
    else document.execCommand("delete", false, undefined);
    const suffix = sourceHint ? `（${sourceHint}）` : "";
    return { content: `已填写 ${describeElement(target)}: "${value}"${suffix}` };
  }

  return null;
}

// ─── 共享：搜索范围收集 ───

/**
 * 从锚点元素向上收集搜索范围。
 *
 * 优先取最近的表单项容器（level=0），
 * 然后逐层向上取父元素（level=1..maxDepth）。
 * 返回的 level 用于距离衰减评分。
 */
function collectSearchScopes(anchor: Element, maxDepth = 4): Array<{ scope: Element; level: number }> {
  const scopes: Array<{ scope: Element; level: number }> = [];

  const formItem = findFormItemContainer(anchor);
  if (formItem) scopes.push({ scope: formItem, level: 0 });

  let cursor: Element | null = anchor.parentElement;
  for (let level = 1; cursor && level <= maxDepth; level++, cursor = cursor.parentElement) {
    scopes.push({ scope: cursor, level });
  }

  return scopes;
}

// ─── 附近目标推断 ───

/**
 * 在 anchor 元素附近启发式搜索最佳 fill 目标。
 *
 * 使用场景：
 *   模型给的 selector 命中了一个不可编辑的元素（如 label、slider 外层容器、
 *   表单描述文本），需要自动推断附近哪个 input/textarea 是真正该被填写的。
 *
 * 搜索策略：
 * 1. 优先在 `.el-form-item` 内搜索（最可能的语义容器）
 * 2. 逐层向上扩展到 4 层父元素
 * 3. 每个候选元素综合评分：
 *    - 层级距离：越近分越高（每层 -18 分）
 *    - 事件绑定：`getFillEventSupportScore` 评分
 *    - 类型匹配：数字值偏好 input[number]，文本值偏好 input[text]
 *    - 辅助信号：有 placeholder/aria-label 加分
 * 4. 返回评分最高的候选
 *
 * @param anchor - 锚点元素（模型原始命中的元素）
 * @param value - 要填写的值（影响类型偏好评分）
 * @returns 最佳候选元素，未找到返回 null
 */
export function guessNearbyFillTarget(anchor: Element, value: string): Element | null {
  const preferNumeric = Number.isFinite(Number(value));
  const scopes = collectSearchScopes(anchor);

  const visited = new Set<Element>();
  let best: { el: Element; score: number } | null = null;

  for (const { scope, level } of scopes) {
    const candidates = Array.from(scope.querySelectorAll(
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="spinbutton"]',
    ));

    for (const candidate of candidates) {
      if (!(candidate instanceof Element)) continue;
      if (visited.has(candidate)) continue;
      visited.add(candidate);

      if (!isCandidateFillTarget(candidate)) continue;
      if (!isElementVisible(candidate)) continue;

      let score = 100 - level * 18;
      score += getFillEventSupportScore(candidate);

      if (candidate instanceof HTMLInputElement) {
        const type = candidate.type.toLowerCase();
        if (preferNumeric && (type === "number" || candidate.getAttribute("role") === "spinbutton")) score += 80;
        if (!preferNumeric && ["text", "", "search", "email", "tel", "url", "password"].includes(type)) score += 36;
      }

      if (candidate.getAttribute("placeholder")) score += 8;
      if (candidate.getAttribute("aria-label")) score += 8;

      if (!best || score > best.score) {
        best = { el: candidate, score };
      }
    }
  }

  return best?.el ?? null;
}

// ─── slider 关联输入框 ───

/**
 * 为 role=slider 查找关联的数值输入框。
 *
 * 典型场景：Element Plus 的 `<el-slider>` 与 `<el-input-number>` 同属一个 form-item，
 * 用户对 slider 执行 fill 时，实际应该写入旁边的数字输入框。
 *
 * 搜索策略：
 * 1. 优先在 `.el-form-item` 内搜索
 * 2. 向上 4 层父元素逐层搜索
 * 3. 选择器覆盖：input[type=number]、input[role=spinbutton]、.el-input-number 内的 input
 * 4. 候选必须同时满足：可编辑（`isEditableElement`）且可见（`isElementVisible`）
 *
 * @param slider - role=slider 的元素
 * @returns 关联的数值输入框，未找到返回 null
 */
export function findAssociatedSliderInput(slider: Element): HTMLInputElement | null {
  const scopes = collectSearchScopes(slider);

  for (const { scope } of scopes) {
    const input = scope.querySelector(
      'input[type="number"], input[role="spinbutton"], .el-input-number input:not([type="hidden"])',
    );
    if (input instanceof HTMLInputElement && isEditableElement(input) && isElementVisible(input)) {
      return input;
    }
  }
  return null;
}
