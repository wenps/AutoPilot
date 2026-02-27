/**
 * DOM Tool — 基于 Web API 的 DOM 操作工具。
 *
 * 替代 Playwright 的 click/fill/type 等操作，直接在页面上下文中执行。
 * 运行环境：浏览器 Content Script。
 *
 * 支持 12 种动作：
 *   click        — 点击元素
 *   fill         — 填写可编辑控件（input/textarea/select/contenteditable）
 *   select_option — 选择下拉框选项（value/label）
 *   type         — 逐字符模拟键入
 *   focus        — 聚焦元素
 *   hover        — 鼠标悬停（触发 mouseenter/mouseover）
 *   press        — 按下键盘按键（Enter/Escape/Tab/ArrowDown 等）
 *   get_text     — 获取元素文本内容
 *   get_attr     — 获取元素属性值
 *   set_attr     — 设置元素属性
 *   add_class    — 添加 CSS 类名
 *   remove_class — 移除 CSS 类名
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import type { RefStore } from "../ref-store.js";

const DEFAULT_WAIT_MS = 1000;

/** 当前活跃的 RefStore 实例（由 WebAgent 在 chat() 时设置） */
let activeRefStore: RefStore | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 安全地查询 DOM 元素。
 *
 * 支持两种定位方式（优先级从高到低）：
 * - hash ID（以 "#" 开头且在 RefStore 中存在）：确定性 hash 查找（最高效）
 * - CSS 选择器（其他）：传统 querySelector
 */
function queryElement(selector: string): Element | string {
  try {
    // #hashId — 优先从 RefStore 查找
    if (selector.startsWith("#") && activeRefStore) {
      const id = selector.slice(1); // 去掉 #
      if (activeRefStore.has(id)) {
        const el = activeRefStore.get(id);
        if (!el) return `未找到 ref "${selector}" 对应的元素（可能已被移除或快照已过期）`;
        return el;
      }
      // 不在 RefStore 中 → 回退到 CSS 选择器（可能是 #some-id）
    }

    // CSS 选择器
    const el = document.querySelector(selector);
    if (!el) return `未找到匹配 "${selector}" 的元素`;
    return el;
  } catch {
    return `选择器语法错误: ${selector}`;
  }
}

/**
 * 设置当前活跃的 RefStore（由 WebAgent 在 chat 开始时调用）。
 */
export function setActiveRefStore(store: RefStore | undefined): void {
  activeRefStore = store;
}

/** 获取当前活跃的 RefStore（供其他工具复用） */
export function getActiveRefStore(): RefStore | undefined {
  return activeRefStore;
}

/**
 * 在给定超时时间内轮询查找元素。
 * - 返回 Element：找到元素
 * - 返回 string：选择器语法错误
 * - 返回 null：超时未找到
 */
async function waitForElement(
  selector: string,
  timeoutMs: number,
): Promise<Element | string | null> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    const elOrError = queryElement(selector);
    if (typeof elOrError !== "string") return elOrError;

    if (elOrError.startsWith("选择器语法错误")) return elOrError;
    await sleep(100);
  }

  return null;
}

function resolveWaitMs(params: Record<string, unknown>): number {
  const waitMs = params.waitMs;
  if (typeof waitMs === "number" && Number.isFinite(waitMs)) {
    return Math.max(0, Math.floor(waitMs));
  }

  const waitSeconds = params.waitSeconds;
  if (typeof waitSeconds === "number" && Number.isFinite(waitSeconds)) {
    return Math.max(0, Math.floor(waitSeconds * 1000));
  }

  return DEFAULT_WAIT_MS;
}

/**
 * 模拟真实用户输入：触发 input、change 事件，兼容 React/Vue 等框架。
 */
function dispatchInputEvents(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

/**
 * 将常见 key 映射为更接近浏览器语义的 KeyboardEvent.code。
 */
function resolveKeyboardCode(key: string): string {
  const map: Record<string, string> = {
    Enter: "Enter",
    Escape: "Escape",
    Esc: "Escape",
    Tab: "Tab",
    Space: "Space",
    " ": "Space",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
  };
  return map[key] ?? key;
}

/**
 * 生成元素的可读描述，用于在操作结果中展示实际命中的 DOM 节点。
 * 格式：<tag#id.class> "文本" [attr=val, ...]
 */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = el.className && typeof el.className === "string"
    ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map(c => `.${c}`).join("")
    : "";
  const text = el instanceof HTMLSelectElement
    ? el.selectedOptions[0]?.textContent?.trim().slice(0, 40) ?? ""
    : el.textContent?.trim().slice(0, 40) ?? "";
  const textHint = text ? ` "${text}"` : "";

  // 关键属性
  const hints: string[] = [];
  for (const attr of ["type", "name", "placeholder", "href", "role"]) {
    const val = el.getAttribute(attr);
    if (val) hints.push(`${attr}=${val}`);
  }
  if (el instanceof HTMLSelectElement && el.value) {
    hints.push(`val=${el.value}`);
  }
  const attrHint = hints.length > 0 ? ` [${hints.join(", ")}]` : "";

  return `<${tag}${id}${cls}>${textHint}${attrHint}`;
}

export function createDomTool(): ToolDefinition {
  return {
    name: "dom",
    description: [
      "Perform DOM operations on the current page.",
      "Actions: click, fill, select_option, type, focus, hover, press, get_text, get_attr, set_attr, add_class, remove_class.",
      "Use the hash ID from DOM snapshot (e.g. #a1b2c) as selector.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description:
          "DOM action: click | fill | select_option | type | focus | hover | press | get_text | get_attr | set_attr | add_class | remove_class",
      }),
      selector: Type.String({ description: "Element ref ID from snapshot (e.g. #r0, #r5) or CSS selector" }),
      value: Type.Optional(
        Type.String({ description: "Value for fill/type/set_attr actions" }),
      ),
      key: Type.Optional(
        Type.String({ description: "Key name for press action (e.g. Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace, Delete, Space)" }),
      ),
      label: Type.Optional(
        Type.String({ description: "Label text for select_option action (fallback when value is not provided)" }),
      ),
      index: Type.Optional(
        Type.Number({ description: "0-based option index for select_option action" }),
      ),
      attribute: Type.Optional(
        Type.String({ description: "Attribute name for get_attr/set_attr actions" }),
      ),
      className: Type.Optional(
        Type.String({ description: "CSS class name for add_class/remove_class" }),
      ),
      waitMs: Type.Optional(
        Type.Number({
          description:
            "Optional wait timeout in ms before action (default: 1000). Use 0 to disable waiting.",
        }),
      ),
      waitSeconds: Type.Optional(
        Type.Number({
          description:
            "Optional wait timeout in seconds before action. Used when waitMs is not provided.",
        }),
      ),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;
      const selector = params.selector as string;
      const waitMs = resolveWaitMs(params);

      if (!selector) return { content: "缺少 selector 参数" };

      let el: Element;
      if (waitMs > 0) {
        const found = await waitForElement(selector, waitMs);

        if (typeof found === "string") {
          return {
            content: found,
            details: { error: true, code: "INVALID_SELECTOR", action, selector },
          };
        }

        if (!found) {
          return {
            content: `未找到匹配 "${selector}" 的元素`,
            details: {
              error: true,
              code: "ELEMENT_NOT_FOUND",
              action,
              selector,
              waitMs,
            },
          };
        }

        el = found;
      } else {
        const elOrError = queryElement(selector);
        if (typeof elOrError === "string") {
          const code = elOrError.startsWith("未找到")
            ? "ELEMENT_NOT_FOUND"
            : "INVALID_SELECTOR";
          return {
            content: elOrError,
            details: { error: true, code, action, selector, waitMs },
          };
        }
        el = elOrError;
      }

      try {
        switch (action) {
          // ─── 交互类 ───

          case "click": {
            // Playwright-like 兼容：若点中 option，自动写回父 select 并触发 change。
            if (el instanceof HTMLOptionElement) {
              const parent = el.parentElement;
              if (parent instanceof HTMLSelectElement) {
                parent.focus();
                parent.value = el.value;
                dispatchInputEvents(parent);
                return { content: `已选择 ${describeElement(parent)} 的选项 "${el.value}"` };
              }
            }

            // 模拟点击：先 focus 再 click，触发完整事件链
            if (el instanceof HTMLElement) {
              el.focus();
              el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
              el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
              el.click();
            } else {
              el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
            return { content: `已点击 ${describeElement(el)}` };
          }

          case "focus": {
            // 聚焦元素
            if (el instanceof HTMLElement) {
              el.focus();
            } else {
              el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
            }
            return { content: `已聚焦 ${describeElement(el)}` };
          }

          case "hover": {
            // 鼠标悬停：触发 mouseenter → mouseover 事件链
            el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
            return { content: `已悬停 ${describeElement(el)}` };
          }

          case "press": {
            // 按下指定键：先聚焦元素，再触发 keydown → keypress → keyup 完整事件链
            const key = (params.key as string) || (params.value as string);
            if (!key) return { content: "缺少 key 参数（如 Enter, Escape, Tab）" };

            if (el instanceof HTMLElement) el.focus();

            const eventInit: KeyboardEventInit = {
              key,
              code: resolveKeyboardCode(key),
              bubbles: true,
              cancelable: true,
            };
            el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
            el.dispatchEvent(new KeyboardEvent("keypress", eventInit));
            el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
            return { content: `已在 ${describeElement(el)} 上按下 ${key}` };
          }

          case "fill": {
            // 填写可编辑控件：支持 input / textarea / select / contenteditable
            const value = params.value as string;
            if (value === undefined) return { content: "缺少 value 参数" };

            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              if (el instanceof HTMLInputElement) {
                const blockedTypes = new Set(["checkbox", "radio", "file", "button", "submit", "reset"]);
                if (blockedTypes.has(el.type)) {
                  return {
                    content: `"${selector}" 为 input[type=${el.type}]，不支持 fill；请使用 click/press/select_option 等动作。`,
                    details: { error: true, code: "UNSUPPORTED_FILL_TARGET", action, selector },
                  };
                }
              }
              el.focus();
              el.value = value;
              dispatchInputEvents(el);
            } else if (el instanceof HTMLSelectElement) {
              el.focus();

              // 1) 先按 option.value 精确匹配
              let matched = false;
              for (const option of Array.from(el.options)) {
                if (option.value === value) {
                  el.value = option.value;
                  matched = true;
                  break;
                }
              }

              // 2) 再按展示文本匹配（忽略大小写与首尾空格）
              if (!matched) {
                const normalized = value.trim().toLowerCase();
                for (const option of Array.from(el.options)) {
                  if (option.text.trim().toLowerCase() === normalized) {
                    el.value = option.value;
                    matched = true;
                    break;
                  }
                }
              }

              if (!matched) {
                return { content: `"${selector}" 下拉框中不存在选项 "${value}"` };
              }

              dispatchInputEvents(el);
            } else if (el instanceof HTMLElement && el.isContentEditable) {
              el.focus();
              el.textContent = value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            } else {
              return { content: `"${selector}" 不是可编辑元素` };
            }
            return { content: `已填写 ${describeElement(el)}: "${value}"` };
          }

          case "select_option": {
            // Playwright-like selectOption：通过 value 或 label 精确选择下拉项
            const value = params.value as string | undefined;
            const label = params.label as string | undefined;
            const index = typeof params.index === "number" ? Math.floor(params.index) : undefined;
            if (value === undefined && label === undefined && index === undefined) {
              return { content: "缺少可选参数：value 或 label 或 index" };
            }

            if (!(el instanceof HTMLSelectElement)) {
              return { content: `"${selector}" 不是下拉框元素` };
            }

            el.focus();

            const options = Array.from(el.options);
            let selectedOption: HTMLOptionElement | undefined;

            if (value !== undefined) {
              selectedOption = options.find(option => option.value === value);
            }

            if (!selectedOption && label !== undefined) {
              const normalizedLabel = label.trim().toLowerCase();
              selectedOption = options.find(option => option.text.trim().toLowerCase() === normalizedLabel);
            }

            if (!selectedOption && value !== undefined) {
              const normalizedValueAsLabel = value.trim().toLowerCase();
              selectedOption = options.find(option => option.text.trim().toLowerCase() === normalizedValueAsLabel);
            }

            if (!selectedOption && index !== undefined) {
              if (index < 0 || index >= options.length) {
                return { content: `"${selector}" 下拉框不存在 index=${index} 的选项` };
              }
              selectedOption = options[index];
            }

            if (!selectedOption) {
              const wanted = value ?? label ?? `index=${index}`;
              return { content: `"${selector}" 下拉框中不存在选项 "${wanted}"` };
            }

            if (selectedOption.disabled) {
              return { content: `"${selector}" 目标选项已禁用：${selectedOption.value}` };
            }

            if (!el.multiple) {
              for (const option of options) {
                option.selected = false;
              }
            }
            selectedOption.selected = true;
            el.value = selectedOption.value;

            dispatchInputEvents(el);
            return {
              content: `已选择 ${describeElement(el)}: value="${selectedOption.value}", label="${selectedOption.text.trim()}"`,
            };
          }

          case "type": {
            // 逐字符键入：每个字符触发 keydown → keypress → input → keyup
            // 适用于有实时监听键盘事件的输入框（如搜索自动补全）
            const value = params.value as string;
            if (value === undefined) return { content: "缺少 value 参数" };

            if (el instanceof HTMLElement) el.focus();

            for (const char of value) {
              el.dispatchEvent(
                new KeyboardEvent("keydown", { key: char, bubbles: true }),
              );
              el.dispatchEvent(
                new KeyboardEvent("keypress", { key: char, bubbles: true }),
              );
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.value += char;
              }
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(
                new KeyboardEvent("keyup", { key: char, bubbles: true }),
              );
            }
            return { content: `已逐字输入到 ${describeElement(el)}: "${value}"` };
          }

          // ─── 读取类 ───

          case "get_text": {
            // 获取元素的文本内容（包括子元素）
            const text = el.textContent?.trim() ?? "";
            return { content: `${describeElement(el)} 的文本内容：${text || "(空)"}` };
          }

          case "get_attr": {
            // 获取元素的指定属性值
            const attribute = params.attribute as string;
            if (!attribute) return { content: "缺少 attribute 参数" };
            const attrValue = el.getAttribute(attribute);
            return { content: `${describeElement(el)} 的 ${attribute} = ${attrValue ?? "(不存在)"}` };
          }

          // ─── 修改类 ───

          case "set_attr": {
            // 设置元素的属性值
            const attribute = params.attribute as string;
            const value = params.value as string;
            if (!attribute || value === undefined)
              return { content: "缺少 attribute 或 value 参数" };
            el.setAttribute(attribute, value);
            return { content: `已设置 ${describeElement(el)} 的 ${attribute}="${value}"` };
          }

          case "add_class": {
            // 给元素添加 CSS 类名
            const className = params.className as string;
            if (!className) return { content: "缺少 className 参数" };
            el.classList.add(className);
            return { content: `已添加 class "${className}" 到 ${describeElement(el)}` };
          }

          case "remove_class": {
            // 移除元素的 CSS 类名
            const className = params.className as string;
            if (!className) return { content: "缺少 className 参数" };
            el.classList.remove(className);
            return { content: `已移除 ${describeElement(el)} 的 class "${className}"` };
          }

          default:
            return { content: `未知的 DOM 动作: ${action}` };
        }
      } catch (err) {
        return {
          content: `DOM 操作 "${action}" 失败: ${err instanceof Error ? err.message : String(err)}`,
          details: { error: true, action, selector },
        };
      }
    },
  };
}
