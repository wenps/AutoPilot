/**
 * Page Info Tool — 基于 Web API 的页面信息获取工具。
 *
 * 替代 Playwright 的 getTitle/getUrl/snapshot 等。
 * 运行环境：浏览器 Content Script。
 *
 * 支持 6 种动作：
 *   get_url       — 获取当前页面 URL
 *   get_title     — 获取页面标题
 *   get_selection — 获取用户选中的文本
 *   get_viewport  — 获取视口尺寸和滚动位置
 *   snapshot      — 获取页面 DOM 结构快照（AI 可读的文本描述）
 *   query_all     — 查询所有匹配选择器的元素，返回摘要信息
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../core/tool-registry.js";

/** 快照配置选项 */
export type SnapshotOptions = {
  /** 最大遍历深度（默认 6） */
  maxDepth?: number;
  /**
   * 视口裁剪：只保留与视口相交的元素（默认 true）。
   * 开启后，完全在视口外的元素会被跳过，大幅减少 token 消耗。
   * 注意：祖先容器即使自身不在视口内，只要有子元素在视口内就会保留。
   */
  viewportOnly?: boolean;
  /**
   * 智能剪枝：折叠无意义的纯布局容器（默认 true）。
   * 开启后，没有文本、没有 id、没有交互属性的纯布局元素（div/span/section 等）
   * 如果自身无意义，会被折叠——子元素直接提升到父级输出，减少嵌套噪音。
   */
  pruneLayout?: boolean;
};

/**
 * 生成页面 DOM 快照 — 将 DOM 树转为 AI 可理解的文本描述。
 *
 * 类似 Playwright 的 ariaSnapshot()，但基于 Web API 实现。
 * 只遍历可见元素，跳过 script/style/svg 等无意义节点。
 *
 * 每个元素自动生成基于层级位置的 XPath 引用（ref），
 * AI 可以通过 ref 精确定位元素，无需猜测 CSS 选择器。
 *
 * 输出格式示例：
 *   [header] ref="/body/header"
 *     [nav] ref="/body/header/nav"
 *       [a] "首页" href="/" ref="/body/header/nav/a[1]"
 *       [a] "关于" href="/about" ref="/body/header/nav/a[2]"
 *   [main] ref="/body/main"
 *     [h1] "欢迎来到示例网站" ref="/body/main/h1"
 *     [input] type="text" placeholder="搜索..." ref="/body/main/input"
 *     [button] "搜索" id="search-btn" onclick ref="/body/main/button"
 *
 * 增强信息：
 * - id：元素的 id 属性
 * - placeholder：输入框的占位文本
 * - 事件绑定：onclick/onchange 等内联事件处理器
 * - 状态属性：disabled/checked/readonly/required 等
 *
 * @param root - 快照根元素（默认 document.body）
 * @param options - 快照选项对象，或传入数字作为 maxDepth（向后兼容）
 */
export function generateSnapshot(
  root: Element = document.body,
  options: SnapshotOptions | number = {},
): string {
  // 向后兼容：数字参数视为 maxDepth
  const opts: SnapshotOptions = typeof options === "number"
    ? { maxDepth: options }
    : options;

  const maxDepth = opts.maxDepth ?? 6;
  const viewportOnly = opts.viewportOnly ?? true;
  const pruneLayout = opts.pruneLayout ?? true;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "SVG", "NOSCRIPT", "LINK", "META", "BR", "HR",
  ]);

  /** 纯布局容器标签 — 智能剪枝时可能被折叠 */
  const LAYOUT_TAGS = new Set([
    "DIV", "SPAN", "SECTION", "ARTICLE", "ASIDE", "MAIN",
    "HEADER", "FOOTER", "NAV", "FIGURE", "FIGCAPTION",
  ]);

  /** 视口尺寸（viewportOnly 开启时使用） */
  const vpWidth = viewportOnly ? window.innerWidth : 0;
  const vpHeight = viewportOnly ? window.innerHeight : 0;

  const INTERACTIVE_ATTRS = [
    "href", "type", "placeholder", "value", "name", "role", "aria-label",
    "src", "alt", "title", "for", "action", "method", "target", "min", "max",
    "pattern", "maxlength", "tabindex",
  ];

  /** 布尔状态属性 — 只在存在时输出（无值），如 disabled、checked */
  const BOOLEAN_ATTRS = [
    "disabled", "checked", "readonly", "required", "selected",
    "hidden", "multiple", "autofocus", "open",
  ];

  /** 内联事件属性前缀 */
  const EVENT_PREFIX = "on";

  /**
   * 计算元素在父节点中同标签兄弟里的序号（1-based，XPath 规范）。
   * 如果同标签兄弟只有一个，返回空字符串（无需索引消歧）。
   */
  function getSiblingIndex(el: Element): string {
    const parent = el.parentElement;
    if (!parent) return "";
    const tag = el.tagName;
    const siblings = Array.from(parent.children).filter((c) => c.tagName === tag);
    if (siblings.length <= 1) return "";
    return `[${siblings.indexOf(el) + 1}]`;
  }

  /**
   * 判断元素是否与视口相交（部分可见也算）。
   * 对根级容器（depth <= 1）始终返回 true，确保不丢失顶层结构。
   */
  function isInViewport(el: Element, depth: number): boolean {
    if (!viewportOnly) return true;
    // 根级容器始终保留（body/html 等），否则整棵树会被跳过
    if (depth <= 1) return true;
    const rect = el.getBoundingClientRect();
    // 元素完全在视口外则跳过
    if (rect.bottom < 0 || rect.top > vpHeight) return false;
    if (rect.right < 0 || rect.left > vpWidth) return false;
    // 零尺寸元素（如隐藏的 position:absolute 元素）也跳过
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  /**
   * 判断元素是否为「无意义布局容器」（智能剪枝候选）。
   * 满足所有条件时返回 true：
   * 1. 标签是常见布局容器（div/span/section 等）
   * 2. 没有 id
   * 3. 没有交互属性（href/role/aria-label/onclick 等）
   * 4. 没有直接文本内容
   */
  function isEmptyLayoutContainer(el: Element, directText: string): boolean {
    if (!pruneLayout) return false;
    if (!LAYOUT_TAGS.has(el.tagName)) return false;
    // 有 id 的元素可能是重要锚点
    if (el.getAttribute("id")) return false;
    // 有 role/aria-label 的元素有语义
    if (el.getAttribute("role") || el.getAttribute("aria-label")) return false;
    // 有内联事件（onclick 等）的元素有交互
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on")) return false;
    }
    // 有直接文本内容的元素有意义
    if (directText) return false;
    return true;
  }

  function walk(el: Element, depth: number, parentPath: string): string {
    if (depth > maxDepth) return "";
    if (SKIP_TAGS.has(el.tagName)) return "";

    // 跳过不可见元素
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return "";

    // ─── 视口裁剪 ───
    // 检查元素是否在视口内（viewportOnly 关闭时始终通过）
    if (!isInViewport(el, depth)) return "";

    const indent = "  ".repeat(depth);
    const tag = el.tagName.toLowerCase();

    // 构建当前元素的 XPath
    const index = getSiblingIndex(el);
    const currentPath = `${parentPath}/${tag}${index}`;

    // 收集有意义的属性
    const attrs: string[] = [];

    // 1. id — 最重要的标识信息，优先展示
    const elId = el.getAttribute("id");
    if (elId) attrs.push(`id="${elId}"`);

    // 2. class — 关键 CSS 类名（最多 3 个）
    const className = el.getAttribute("class")?.trim();
    if (className) {
      const classes = className.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
      if (classes) attrs.push(`class="${classes}"`);
    }

    // 3. 交互属性（href, type, placeholder 等）
    for (const attr of INTERACTIVE_ATTRS) {
      const val = el.getAttribute(attr);
      if (val) attrs.push(`${attr}="${val}"`);
    }

    // 4. 布尔状态属性（disabled, checked 等）
    for (const attr of BOOLEAN_ATTRS) {
      if (el.hasAttribute(attr)) attrs.push(attr);
    }

    // 5. 事件绑定 — 检测内联事件处理器（onclick, onchange 等）
    const events: string[] = [];
    for (const attrObj of Array.from(el.attributes)) {
      if (attrObj.name.startsWith(EVENT_PREFIX)) {
        events.push(attrObj.name);
      }
    }
    if (events.length > 0) attrs.push(`events=[${events.join(",")}]`);

    // 6. data-* 属性（常用于框架绑定，最多 3 个）
    const dataAttrs: string[] = [];
    for (const attrObj of Array.from(el.attributes)) {
      if (attrObj.name.startsWith("data-") && dataAttrs.length < 3) {
        dataAttrs.push(`${attrObj.name}="${attrObj.value.slice(0, 30)}"`);
      }
    }
    if (dataAttrs.length > 0) attrs.push(...dataAttrs);

    // 7. 对于 input/textarea，补充当前实际 value（与 attribute 值可能不同）
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) {
      const currentVal = el.value.slice(0, 60);
      // 只在 attribute 中没有 value 或 value 不同时补充
      const attrVal = el.getAttribute("value");
      if (attrVal !== currentVal) {
        attrs.push(`current-value="${currentVal}"`);
      }
    }

    // 获取直接文本（不含子元素文本）
    let directText = "";
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim();
        if (t) directText += t + " ";
      }
    }
    directText = directText.trim();

    // ─── 智能剪枝 ───
    // 无意义布局容器：不输出自身行，直接将子元素提升到当前层级
    if (isEmptyLayoutContainer(el, directText)) {
      const childLines: string[] = [];
      for (let i = 0; i < el.children.length; i++) {
        // 子元素使用当前元素的完整路径（保证 ref 路径正确），但不增加缩进
        const childResult = walk(el.children[i], depth, currentPath);
        if (childResult) childLines.push(childResult);
      }
      // 如果子树也全部为空，整个容器就被剪掉
      return childLines.join("\n");
    }

    // 构建当前元素描述：[标签] "文本" 属性 ref="XPath"
    let line = `${indent}[${tag}]`;
    if (directText) line += ` "${directText.slice(0, 80)}"`;
    if (attrs.length) line += ` ${attrs.join(" ")}`;
    line += ` ref="${currentPath}"`;

    const lines: string[] = [line];

    // 递归子元素
    for (let i = 0; i < el.children.length; i++) {
      const childResult = walk(el.children[i], depth + 1, currentPath);
      if (childResult) lines.push(childResult);
    }

    return lines.join("\n");
  }

  // 根元素自身的标签作为路径起点，walk 内部不再重复追加
  // 例如 root=body 时，parentPath=""，walk 中 currentPath="/body"
  return walk(root, 0, "") || "(空页面)";
}

/**
 * 查询所有匹配元素并返回摘要信息（标签、文本、关键属性）。
 */
function queryAllElements(selector: string, limit = 20): string {
  try {
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) return `未找到匹配 "${selector}" 的元素`;

    const results: string[] = [`找到 ${elements.length} 个元素：`];
    const count = Math.min(elements.length, limit);

    for (let i = 0; i < count; i++) {
      const el = elements[i];
      const tag = el.tagName.toLowerCase();
      const text = el.textContent?.trim().slice(0, 60) ?? "";
      const id = el.id ? `#${el.id}` : "";
      const cls = el.className && typeof el.className === "string"
        ? `.${el.className.split(" ").filter(Boolean).join(".")}`
        : "";
      results.push(`  ${i + 1}. <${tag}${id}${cls}> "${text}"`);
    }

    if (elements.length > limit) {
      results.push(`  ...还有 ${elements.length - limit} 个元素`);
    }

    return results.join("\n");
  } catch (e) {
    return `选择器语法错误: ${selector}`;
  }
}

export function createPageInfoTool(): ToolDefinition {
  return {
    name: "page_info",
    description: [
      "Get information about the current page.",
      "Actions: get_url, get_title, get_selection (selected text),",
      "get_viewport (size & scroll), snapshot (DOM structure), query_all (find all matching elements).",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description:
          "Info action: get_url | get_title | get_selection | get_viewport | snapshot | query_all",
      }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector for query_all action" }),
      ),
      maxDepth: Type.Optional(
        Type.Number({ description: "Max depth for snapshot (default: 6)" }),
      ),
      viewportOnly: Type.Optional(
        Type.Boolean({ description: "Only snapshot elements visible in viewport (default: true)" }),
      ),
      pruneLayout: Type.Optional(
        Type.Boolean({ description: "Collapse empty layout containers like div/span (default: true)" }),
      ),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;

      try {
        switch (action) {
          case "get_url":
            return { content: window.location.href };

          case "get_title":
            return { content: document.title || "(无标题)" };

          case "get_selection": {
            // 获取用户当前选中的文本
            const selection = window.getSelection();
            const text = selection?.toString().trim() ?? "";
            return { content: text || "(未选中任何文本)" };
          }

          case "get_viewport": {
            // 获取视口和滚动信息
            const info = {
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              pageWidth: document.documentElement.scrollWidth,
              pageHeight: document.documentElement.scrollHeight,
            };
            return { content: JSON.stringify(info, null, 2) };
          }

          case "snapshot": {
            // 生成 DOM 快照 — AI 理解当前页面结构的主要方式
            const maxDepth = (params.maxDepth as number) ?? 6;
            const viewportOnly = (params.viewportOnly as boolean) ?? true;
            const pruneLayout = (params.pruneLayout as boolean) ?? true;
            const snapshot = generateSnapshot(document.body, {
              maxDepth,
              viewportOnly,
              pruneLayout,
            });
            return { content: snapshot };
          }

          case "query_all": {
            // 查询所有匹配元素
            const selector = params.selector as string;
            if (!selector) return { content: "缺少 selector 参数" };
            return { content: queryAllElements(selector) };
          }

          default:
            return { content: `未知的页面信息动作: ${action}` };
        }
      } catch (err) {
        return {
          content: `页面信息操作 "${action}" 失败: ${err instanceof Error ? err.message : String(err)}`,
          details: { error: true, action },
        };
      }
    },
  };
}
