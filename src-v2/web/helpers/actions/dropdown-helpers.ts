/**
 * 自定义下拉交互工具函数 / Custom dropdown interaction utilities.
 *
 * 背景：
 *   现代 UI 框架（Element Plus、Ant Design 等）普遍使用自定义下拉替代原生 <select>。
 *   这些下拉通常由"触发器"（如 input/div）+ "弹出面板"（role=listbox / popper）组成，
 *   无法用原生 <select>.value 直接写入，需要：
 *     1. 点击触发器打开弹出面板
 *     2. 在弹出面板中按文本匹配目标选项
 *     3. 点击该选项完成选择
 *
 * 本模块提供步骤 1-2 的底层能力：
 *   - `waitForDropdownPopup`：等待弹出面板出现并可见（步骤 1 的后续）
 *   - `findVisibleOptionByText`：在所有可见弹出面板中按文本匹配 option（步骤 2）
 *
 * 由 dom-tool 的 select_option action 在检测到非原生 <select> 时调用。
 *
 * 从 dom-tool 提取，与 fill 逻辑解耦。
 */
import { isElementVisible } from "../base/visibility.js";
import { sleep } from "../base/event-dispatch.js";

/**
 * 覆盖的下拉选项选择器（按优先级排列）：
 * - ARIA 标准：[role="option"]、[role="listbox"] li
 * - Element Plus：.el-select-dropdown__item、.el-option、.el-cascader-node、.el-dropdown-menu__item
 * - Ant Design：.ant-select-item-option
 * - 通用兜底：[class*="option"]、li[data-value]、<option>
 */
const DROPDOWN_OPTION_SELECTORS = [
  '[role="option"]', '[role="listbox"] li',
  ".el-select-dropdown__item", ".el-option",
  ".ant-select-item-option",
  ".el-cascader-node", ".el-dropdown-menu__item",
  '[class*="option"]', "li[data-value]", "option",
].join(", ");

/**
 * 覆盖的弹出面板选择器：
 * - ARIA 标准：[role="listbox"]
 * - Element Plus：.el-select-dropdown、.el-popper
 * - Ant Design：.ant-select-dropdown
 * - 通用兜底：[class*="dropdown"]
 */
const DROPDOWN_POPUP_SELECTORS = '[role="listbox"], .el-select-dropdown, .el-popper, .ant-select-dropdown, [class*="dropdown"]';

/**
 * 在页面所有可见下拉面板中按文本匹配 option。
 *
 * 匹配策略（按优先级）：
 * 1. 精确匹配：option.textContent.trim() === target（忽略大小写）
 * 2. 包含匹配：option.textContent.trim().includes(target)（忽略大小写）
 *
 * 注意：搜索范围是整个 document，因为弹出面板通常通过 teleport 挂载到 body 下，
 * 不在触发器的 DOM 子树内。
 *
 * @param text - 要匹配的选项文本
 * @returns 匹配到的可见 option 元素，未找到返回 null
 */
export function findVisibleOptionByText(text: string): HTMLElement | null {
  const target = text.trim().toLowerCase();
  if (!target) return null;
  const nodes = Array.from(document.querySelectorAll(DROPDOWN_OPTION_SELECTORS));
  const visible = nodes.filter(n => n instanceof HTMLElement && isElementVisible(n));
  // 优先精确匹配
  for (const n of visible) { if (n.textContent?.trim().toLowerCase() === target) return n as HTMLElement; }
  // 回退到包含匹配
  for (const n of visible) { if (n.textContent?.trim().toLowerCase().includes(target)) return n as HTMLElement; }
  return null;
}

/**
 * 等待下拉弹出面板出现并可见。
 *
 * 用于点击触发器后的短暂等待——大多数框架的弹出动画在 200-500ms 内完成。
 * 每 50ms 轮询一次，超时后静默返回（不抛错，由调用方决定后续处理）。
 *
 * @param maxWait - 最大等待时间（ms），默认 500
 */
export async function waitForDropdownPopup(maxWait = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const popup = document.querySelector(DROPDOWN_POPUP_SELECTORS);
    if (popup && isElementVisible(popup)) return;
    await sleep(50);
  }
}
