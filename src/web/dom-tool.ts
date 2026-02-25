/**
 * DOM Tool — 基于 Web API 的 DOM 操作工具。
 *
 * 替代 Playwright 的 click/fill/type 等操作，直接在页面上下文中执行。
 * 运行环境：浏览器 Content Script。
 *
 * 支持 8 种动作：
 *   click        — 点击元素
 *   fill         — 填写输入框（清空后设值）
 *   type         — 逐字符模拟键入
 *   get_text     — 获取元素文本内容
 *   get_attr     — 获取元素属性值
 *   set_attr     — 设置元素属性
 *   add_class    — 添加 CSS 类名
 *   remove_class — 移除 CSS 类名
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../core/tool-registry.js";

const DEFAULT_WAIT_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 通过快照 ref（XPath 路径）解析到 DOM 元素。
 *
 * ref 格式示例：/body/div[1]/main/form/input[2]
 * 每段为 tagName，可选 [n] 表示同标签兄弟中第 n 个（1-based）。
 */
function resolveRef(ref: string): Element | null {
  const segments = ref.split("/").filter(Boolean);
  let current: Element | null = document.documentElement; // <html>

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!current) return null;

    // 解析 "tag" 或 "tag[n]"
    const match = seg.match(/^([a-z0-9-]+)(?:\[(\d+)\])?$/i);
    if (!match) return null;

    const tag = match[1].toUpperCase();
    const index = match[2] ? parseInt(match[2], 10) : 1; // 默认第 1 个

    // 仅允许“首段即根节点”时命中当前节点（兼容 /html/...）
    // 其他情况必须向下进入子节点，避免 /div[2]/div 这类连续同标签路径被错误跳过。
    if (i === 0 && current.tagName === tag) {
      continue;
    }

    // 在子元素中按标签名过滤并取第 index 个
    const children: Element[] = Array.from(current.children).filter((c) => c.tagName === tag);
    const sameTagCount = children.length;

    if (sameTagCount === 0) return null;

    // 如果同标签只有一个，无论 index 是什么都取它
    if (sameTagCount === 1) {
      current = children[0];
    } else {
      // 多个同标签兄弟，index 是 1-based
      if (index < 1 || index > sameTagCount) return null;
      current = children[index - 1];
    }
  }

  return current;
}

/**
 * 安全地查询 DOM 元素。
 *
 * 支持两种定位方式：
 * - ref 路径（以 "/" 开头）：使用快照生成的 XPath 精确定位
 * - CSS 选择器（其他）：传统 querySelector
 */
function queryElement(selector: string): Element | string {
  try {
    // 以 "/" 开头视为快照 ref（XPath 路径）
    if (selector.startsWith("/")) {
      const el = resolveRef(selector);
      if (!el) return `未找到 ref "${selector}" 对应的元素`;
      return el;
    }

    // 否则走 CSS 选择器
    const el = document.querySelector(selector);
    if (!el) return `未找到匹配 "${selector}" 的元素`;
    return el;
  } catch (e) {
    return `选择器语法错误: ${selector}`;
  }
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
function dispatchInputEvents(el: HTMLInputElement | HTMLTextAreaElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
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
  const text = el.textContent?.trim().slice(0, 40) ?? "";
  const textHint = text ? ` "${text}"` : "";

  // 关键属性
  const hints: string[] = [];
  for (const attr of ["type", "name", "placeholder", "href", "role"]) {
    const val = el.getAttribute(attr);
    if (val) hints.push(`${attr}=${val}`);
  }
  const attrHint = hints.length > 0 ? ` [${hints.join(", ")}]` : "";

  return `<${tag}${id}${cls}>${textHint}${attrHint}`;
}

export function createDomTool(): ToolDefinition {
  return {
    name: "dom",
    description: [
      "Perform DOM operations on the current page.",
      "Actions: click, fill, type, get_text, get_attr, set_attr, add_class, remove_class.",
      "Use the ref path from the DOM snapshot (e.g. /body/main/button) as selector to precisely target elements.",
      "CSS selectors are also supported but ref paths are preferred for accuracy.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description:
          "DOM action: click | fill | type | get_text | get_attr | set_attr | add_class | remove_class",
      }),
      selector: Type.String({ description: "Element ref path from snapshot (e.g. /body/main/button[2]) or CSS selector" }),
      value: Type.Optional(
        Type.String({ description: "Value for fill/type/set_attr actions" }),
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
            // 模拟点击：先 focus 再 click，触发完整事件链
            if (el instanceof HTMLElement) {
              el.focus();
              el.click();
            } else {
              el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
            return { content: `已点击 ${describeElement(el)}` };
          }

          case "fill": {
            // 填写输入框：清空原有值 → 设置新值 → 触发 input/change 事件
            const value = params.value as string;
            if (value === undefined) return { content: "缺少 value 参数" };

            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              el.focus();
              el.value = value;
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
