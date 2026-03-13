/**
 * 基础工具函数统一导出 / Base helper utilities barrel export.
 *
 * 包含不直接参与工具动作执行的底层能力：
 * 状态管理、选择器解析、可见性判定、元素检查、表单项检测、
 * 事件模拟原语、键盘模拟、可操作性校验。
 */
export { setActiveRefStore, getActiveRefStore } from "./active-store.js";
export { resolveSelector } from "./resolve-selector.js";
export { isStyleVisible, isElementVisible, isVisible } from "./visibility.js";
export { isElementDisabled, isEditableElement, INPUT_BLOCKED_TYPES } from "./element-checks.js";
export { isFormItemContainer, findFormItemContainer } from "./form-item.js";
export { sleep, getClickPoint, dispatchClickEvents, dispatchHoverEvents, dispatchInputEvents, setNativeValue, selectText } from "./event-dispatch.js";
export { splitKeyCombo, resolveKeyCode, executePress } from "./keyboard.js";
export { checkElementStable, scrollIntoViewIfNeeded, checkHitTarget, describeElement, ensureActionable, validateClickSignal } from "./actionability.js";
