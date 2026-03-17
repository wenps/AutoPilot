/**
 * 动作相关工具函数统一导出 / Action helper utilities barrel export.
 *
 * 包含与真实工具动作执行直接相关的高层能力：
 * 目标重定向、表单填充、下拉交互、等待策略。
 */
export type { RetargetMode } from "./retarget.js";
export { retarget, getChecked, resolveCheckableTarget, resolvePointerActionTarget, resolveFormItemControlTarget } from "./retarget.js";
export { INPUT_SET_VALUE_TYPES, getFillEventSupportScore, isCandidateFillTarget, executeFillOnResolvedTarget, guessNearbyFillTarget, findAssociatedSliderInput } from "./fill-helpers.js";
export { findVisibleOptionByText, waitForDropdownPopup } from "./dropdown-helpers.js";
export type { SelectorState } from "./wait-helpers.js";
export { DEFAULT_TIMEOUT, evaluateSelectorState, waitForSelectorState, waitForText, waitForDomStable } from "./wait-helpers.js";
