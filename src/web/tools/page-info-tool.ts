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
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import type { RefStore } from "../ref-store.js";
import { getTrackedElementEvents, hasTrackedElementEvents } from "../event-listener-tracker.js";
import { getActiveRefStore } from "./dom-tool/index.js";

/** 快照配置选项 */
export type SnapshotOptions = {
  /** 最大遍历深度（默认 7） */
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
  /**
   * hash ID 映射表（可选）。
   * 传入 RefStore 实例后，每个元素使用确定性 hash ID 替代完整 XPath，
   * 大幅减少 token 消耗。dom-tool 通过 RefStore.get(id) 解析回 DOM 元素。
   */
  refStore?: RefStore;
  /** 最大输出节点数（默认 280），超过后停止继续遍历。 */
  maxNodes?: number;
  /** 每个父节点最多输出的子元素数（默认 32），超出部分会折叠。 */
  maxChildren?: number;
  /** 文本截断长度（默认 40）。 */
  maxTextLength?: number;
  /**
   * 是否对“选项列表”容器放宽子节点截断（默认 false）。
   * 典型场景：时间选择器/下拉选项列表，避免关键选项被 `...children omitted` 折叠。
   */
  expandOptionLists?: boolean;
  /**
   * 仅对指定 hash ref 节点放宽子节点截断（优先级高于默认 maxChildren）。
   * 例如：[#abc123, #def456]，用于 AI 在看到 children omitted 后定向请求放宽。
   */
  expandChildrenRefs?: string[];
  /** 对 expandChildrenRefs 节点生效的子节点上限（默认 120）。 */
  expandedChildrenLimit?: number;
};

/** 快照属性值最大保留长度（超出截断）。 */
const MAX_SNAPSHOT_ATTR_VALUE_LENGTH = 120;
/** 选项列表放宽时的子节点上限（仍保留硬上限，避免快照无限膨胀）。 */
const MAX_EXPANDED_LIST_CHILDREN = 120;
/** 定向放宽 children 的硬上限。 */
const MAX_EXPANDED_CHILDREN_LIMIT = 300;

/**
 * 事件名 → 快照简写映射。
 * 目的：大幅压缩 listeners="..." 占用的 token，同时保留可读性。
 * 简写规则在 system-prompt 中向模型说明。
 */
const EVENT_ABBREV: Record<string, string> = {
  click: "clk", dblclick: "dbl",
  mousedown: "mdn", mouseup: "mup", mousemove: "mmv",
  mouseover: "mov", mouseout: "mot", mouseenter: "men", mouseleave: "mlv",
  pointerdown: "pdn", pointerup: "pup", pointermove: "pmv",
  pointerenter: "pen", pointerleave: "plv",
  touchstart: "tst", touchend: "ted", touchmove: "tmv",
  keydown: "kdn", keyup: "kup", keypress: "kpr",
  input: "inp", change: "chg", submit: "sub",
  focus: "fcs", blur: "blr",
  scroll: "scl", wheel: "whl",
  drag: "drg", dragstart: "drs", dragend: "dre", drop: "drp",
  contextmenu: "ctx", resize: "rsz",
};

/** 将完整事件名转为快照简写（未收录的取前 3 字符）。 */
function abbrevEvent(name: string): string {
  return EVENT_ABBREV[name] ?? name.slice(0, 3);
}

/**
 * 规整快照属性值，避免把长 base64/data URL 原样注入快照。
 */
function sanitizeSnapshotAttrValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const dataUrlMatch = trimmed.match(/^data:([^,]*?),(.*)$/i);
  if (dataUrlMatch) {
    const meta = dataUrlMatch[1] || "";
    const payload = dataUrlMatch[2] || "";
    const isBase64 = /;base64/i.test(meta);
    const payloadLength = payload.length;
    const previewMeta = meta.slice(0, 48);
    if (isBase64 || payloadLength > 64) {
      return `data:${previewMeta},<omitted:${payloadLength}>`;
    }
  }

  const base64ChunkMatch = trimmed.match(/^[A-Za-z0-9+/]{80,}={0,2}$/);
  if (base64ChunkMatch) {
    return `<base64:${trimmed.length}>`;
  }

  if (trimmed.length > MAX_SNAPSHOT_ATTR_VALUE_LENGTH) {
    return `${trimmed.slice(0, MAX_SNAPSHOT_ATTR_VALUE_LENGTH)}...`;
  }
  return trimmed;
}

/**
 * 生成页面 DOM 快照 — 将 DOM 树转为 AI 可理解的文本描述。
 *
 * 基于 Web API 实现，只遍历可见元素，跳过 script/style/svg 等无意义节点。
 * 传入 RefStore 时，每个元素生成确定性 hash ID（如 #a1b2c），
 * AI 通过 hash ID 精确定位元素，无需猜测 CSS 选择器。
 *
 * 输出格式示例：
 *   [header] #k9f2a
 *     [nav] #m3d7e
 *       [a] "首页" href="/" #p1c4b
 *       [a] "关于" href="/about" #q8e5f
 *   [main] #r2a6d
 *     [h1] "欢迎" #s7g3h
 *     [input] type="text" placeholder="搜索..." #t4j8k
 *     [button] "搜索" id="search-btn" onclick #u5n2m
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

  const maxDepth = opts.maxDepth ?? 7;
  const viewportOnly = opts.viewportOnly ?? true;
  const pruneLayout = opts.pruneLayout ?? true;
  const maxNodes = opts.maxNodes ?? 280;
  const maxChildren = opts.maxChildren ?? 32;
  const maxTextLength = opts.maxTextLength ?? 40;
  const expandOptionLists = opts.expandOptionLists ?? false;
  const expandedChildrenLimit = Math.min(
    MAX_EXPANDED_CHILDREN_LIMIT,
    Math.max(1, opts.expandedChildrenLimit ?? MAX_EXPANDED_LIST_CHILDREN),
  );
  const expandChildrenRefSet = new Set(
    (opts.expandChildrenRefs ?? [])
      .map(ref => ref.trim().replace(/^#/, ""))
      .filter(Boolean),
  );

  let emittedNodes = 0;
  let truncatedByNodeBudget = false;
  const emittedRefIds = new Set<string>();

  const refStore = opts.refStore;

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
    "href", "type", "placeholder", "value", "name", "role", "tabindex", "aria-label",
    "aria-valuenow", "aria-valuemin", "aria-valuemax",
    "src", "alt", "title", "for", "action", "method",
  ];

  const INTERACTIVE_TAGS = new Set([
    "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "OPTION", "LABEL", "SUMMARY",
  ]);

  /** 常见可交互事件（用于提升元素交互优先级）。 */
  const INTERACTIVE_EVENTS = new Set([
    "click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup",
    "touchstart", "touchend", "input", "change", "keydown", "keyup", "keypress",
    "submit", "focus", "blur",
  ]);

  /** 布尔状态属性 — 只在存在时输出（无值），如 disabled、checked */
  const BOOLEAN_ATTRS = [
    "disabled", "checked", "readonly", "required", "selected",
    "hidden",
  ];

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

  /** 统一标签名键值（HTML/SVG 在不同环境可能大小写不一致）。 */
  function getTagKey(el: Element): string {
    return (el.tagName || "").toUpperCase();
  }

  /** 判断元素是否存在绑定事件（inline 或 addEventListener 追踪）。 */
  function hasBoundEvents(el: Element): boolean {
    if (hasTrackedElementEvents(el)) return true;
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on")) return true;
    }
    return false;
  }

  /**
   * 轻量检测：当前容器浅层子树里是否出现事件绑定节点。
   * 仅用于是否保留布局容器，预算受控避免再次吞掉整页层级。
   */
  function hasBoundEventsInShallowSubtree(el: Element, scanBudget = 48, maxTreeDepth = 2): boolean {
    const queue: Array<{ node: Element; depth: number }> = Array.from(el.children).map(node => ({ node, depth: 1 }));
    let scanned = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      if (hasBoundEvents(current.node)) return true;

      scanned += 1;
      if (scanned >= scanBudget) return false;

      if (current.depth >= maxTreeDepth) continue;
      for (const child of Array.from(current.node.children)) {
        queue.push({ node: child, depth: current.depth + 1 });
      }
    }

    return false;
  }

  /** 判断文本是否具有语义信息（过滤纯符号/超短噪音）。 */
  function isSemanticText(text: string): boolean {
    const normalized = text.replace(/\s+/g, "").trim();
    if (!normalized) return false;
    if (normalized.length < 2) return false;
    return /[\p{Script=Han}A-Za-z0-9]/u.test(normalized);
  }

  /** 在子树内查找语义文本（浅层限流，避免额外大开销）。 */
  function hasSemanticTextInSubtree(el: Element, scanBudget = 180): boolean {
    const stack: Element[] = Array.from(el.children);
    let scanned = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;

      let directText = "";
      for (let i = 0; i < current.childNodes.length; i++) {
        const node = current.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent?.trim();
          if (t) directText += t + " ";
        }
      }

      if (isSemanticText(directText.trim())) return true;

      scanned += 1;
      if (scanned >= scanBudget) return false;

      const children = Array.from(current.children);
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }

    return false;
  }

  /**
   * 判断元素是否为「无意义布局容器」（智能剪枝候选）。
   * 满足所有条件时返回 true：
   * 1. 标签是常见布局容器（div/span/section 等）
   * 2. 没有 id
   * 3. 没有交互属性（href/role/aria-label/onclick 等）
   * 4. 没有直接文本内容
   */
  function isEmptyLayoutContainer(el: Element, directText: string, depth: number): boolean {
    if (!pruneLayout) return false;
    // 保留布局主干：浅层结构不做折叠，避免业务区域被压扁到看不见。
    if (depth <= 2) return false;
    if (!LAYOUT_TAGS.has(getTagKey(el))) return false;
    // 有 id 的元素可能是重要锚点
    if (el.getAttribute("id")) return false;
    // 有 role/aria-label 的元素有语义
    if (el.getAttribute("role") || el.getAttribute("aria-label")) return false;
    // 自身有事件绑定：优先保留（事件绑定本身就是高价值可操作信号）。
    if (hasBoundEvents(el)) return false;

    // 浅层子树出现事件绑定：在中浅层结构中尽量保留，避免点击链路被折叠断裂。
    if (depth <= 4 && hasBoundEventsInShallowSubtree(el)) return false;

    // 兼顾语义文本：含语义文本的容器也应保留。
    if (isSemanticText(directText) || hasSemanticTextInSubtree(el)) return false;
    // 有直接文本内容的元素有意义
    if (directText) return false;
    return true;
  }

  function hasInteractiveTrackedEvents(el: Element): boolean {
    const trackedEvents = getTrackedElementEvents(el);
    if (trackedEvents.length === 0) return false;
    return trackedEvents.some(eventName => INTERACTIVE_EVENTS.has(eventName));
  }

  function isInteractiveElement(el: Element): boolean {
    if (INTERACTIVE_TAGS.has(getTagKey(el))) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.hasAttribute("role")) return true;
    if (el.hasAttribute("tabindex")) return true;
    if (el.hasAttribute("aria-label")) return true;
    if (hasInteractiveTrackedEvents(el)) return true;
    return false;
  }

  /** 判断是否为“选项列表”容器（时间/下拉/listbox 等）。 */
  function isOptionListContainer(el: Element): boolean {
    if (el.getAttribute("role") === "listbox") return true;
    const cls = (el.getAttribute("class") || "").toLowerCase();
    if (
      cls.includes("time-spinner__list") ||
      cls.includes("select-dropdown") ||
      cls.includes("virtual-list") ||
      cls.includes("option")
    ) {
      return true;
    }

    if (el.tagName === "UL") {
      const children = Array.from(el.children);
      if (children.length >= 20) {
        const liCount = children.filter(child => child.tagName === "LI").length;
        if (liCount / children.length >= 0.8) return true;
      }
    }
    return false;
  }

  /** 针对子节点截断计算动态上限。 */
  function resolveChildLimit(el: Element, defaultLimit: number, hashId?: string): number {
    let nextLimit = defaultLimit;
    if (expandOptionLists && isOptionListContainer(el)) {
      nextLimit = Math.max(nextLimit, MAX_EXPANDED_LIST_CHILDREN);
    }
    if (hashId && expandChildrenRefSet.has(hashId)) {
      nextLimit = Math.max(nextLimit, expandedChildrenLimit);
    }
    return nextLimit;
  }

  function walk(el: Element, depth: number, parentPath: string): string {
    if (emittedNodes >= maxNodes) {
      truncatedByNodeBudget = true;
      return "";
    }

    if (depth > maxDepth) return "";

    const tagKey = getTagKey(el);
    if (SKIP_TAGS.has(tagKey)) return "";

    // 跳过常见 SVG sprite 容器，避免装饰图标定义吞噬节点预算。
    if (el.getAttribute("id") === "__SVG_SPRITE_NODE__") return "";

    // 跳过标记为 autopilot 内部 UI 的元素（避免 AI 操作自身界面）
    if (el.hasAttribute("data-autopilot-ignore")) return "";

    // 跳过不可见元素
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return "";

    // ─── 视口裁剪 ───
    // 检查元素是否在视口内（viewportOnly 关闭时始终通过）
    if (!isInViewport(el, depth)) return "";

    const indent = "  ".repeat(depth);
    const tag = el.tagName.toLowerCase();

    // 构建当前元素的内部路径（用于 hash 计算，不输出到快照）
    const index = getSiblingIndex(el);
    const currentPath = `${parentPath}/${tag}${index}`;
    const hashId = refStore ? refStore.set(el, currentPath) : undefined;

    // 收集有意义的属性（精简版：只保留对 AI 操作有用的信息）
    const attrs: string[] = [];

    // 1. id — 最重要的标识信息
    const elId = el.getAttribute("id");
    if (elId) attrs.push(`id="${elId}"`);

    // 2. class — 只保留第 1 个有语义的类名（大幅减少 token）
    const className = el.getAttribute("class")?.trim();
    if (className) {
      const cls = className.split(/\s+/)
        .find(c => c && !c.startsWith("data-v-") && c.length < 25 && !/^[a-z]{1,2}\d|^_|^css-/.test(c));
      if (cls) attrs.push(`class="${cls}"`);
    }

    // 3. 交互属性（href, type, placeholder 等）
    for (const attr of INTERACTIVE_ATTRS) {
      const val = el.getAttribute(attr);
      if (val) {
        const safeVal = sanitizeSnapshotAttrValue(val);
        if (safeVal) attrs.push(`${attr}="${safeVal}"`);
      }
    }

    // 4. 布尔状态属性（disabled, checked 等）
    for (const attr of BOOLEAN_ATTRS) {
      if (el.hasAttribute(attr)) attrs.push(attr);
    }

    // 4.1 运行时布尔状态（property 级别），避免仅靠 attribute 导致状态丢失
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) {
      if (el.disabled && !attrs.includes("disabled")) attrs.push("disabled");
    }
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly) {
      if (!attrs.includes("readonly")) attrs.push("readonly");
    }

    // 5. 事件绑定 — 只标记有 onclick（最重要的交互信号）
    if (el.hasAttribute("onclick")) attrs.push("onclick");

    // 5.1 addEventListener 追踪到的事件绑定（使用简写压缩 token）
    const trackedEvents = getTrackedElementEvents(el);
    if (trackedEvents.length > 0) {
      const preview = trackedEvents.slice(0, 6).map(abbrevEvent).join(",");
      const suffix = trackedEvents.length > 6 ? ",..." : "";
      attrs.push(`listeners="${preview}${suffix}"`);
    }

    // 6. data-* 属性 — 只保留 data-testid（自动化测试定位用）
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
    if (testId) {
      const safeTestId = sanitizeSnapshotAttrValue(testId).slice(0, 25);
      if (safeTestId) attrs.push(`data-testid="${safeTestId}"`);
    }

    // 7. 对于 input/textarea，补充当前实际 value（截短到 40 字符）
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) {
      const currentVal = sanitizeSnapshotAttrValue(el.value).slice(0, 40);
      const attrVal = el.getAttribute("value");
      if (attrVal !== currentVal) {
        attrs.push(`val="${currentVal}"`);
      }
    }

    // 7.1 对于 checkbox/radio，补充运行时 checked 状态（property 级别）
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.checked) {
      if (!attrs.includes("checked")) attrs.push("checked");
    }

    // 8. 对于 select，补充当前选中 value；对于 option，按运行时 selected 状态输出
    if (el instanceof HTMLSelectElement && el.value) {
      attrs.push(`val="${sanitizeSnapshotAttrValue(el.value).slice(0, 40)}"`);
    }
    if (el instanceof HTMLOptionElement && el.selected) {
      if (!attrs.includes("selected")) attrs.push("selected");
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
    // 无意义布局容器：默认不输出自身行，直接将子元素提升到当前层级。
    // 若提升后同层出现多个孩子（如 a 与 b(c) 折叠成 a 与 c），
    // 则输出括号分组块，显式保留这些节点的关联来源。
    if (isEmptyLayoutContainer(el, directText, depth)) {
      const allChildren = Array.from(el.children);
      const interactiveChildren = allChildren.filter(isInteractiveElement);
      const nonInteractiveChildren = allChildren.filter((child) => !isInteractiveElement(child));
      const orderedChildren = [...interactiveChildren, ...nonInteractiveChildren];
      const childLimit = resolveChildLimit(el, maxChildren, hashId);
      const selectedChildren = orderedChildren.slice(0, childLimit);
      const omittedChildren = orderedChildren.length - selectedChildren.length;

      const childBlocks: string[] = [];
      for (let i = 0; i < selectedChildren.length; i++) {
        // 子元素继承当前路径（保证 hash 计算正确），但不增加缩进
        const childResult = walk(selectedChildren[i], depth, currentPath);
        if (childResult) childBlocks.push(childResult);
      }

      // 如果子树也全部为空，整个容器就被剪掉
      if (childBlocks.length === 0 && omittedChildren <= 0) {
        return "";
      }

      const shouldGroupCollapsedChildren = childBlocks.length >= 2 || omittedChildren > 0;
      if (!shouldGroupCollapsedChildren) {
        return childBlocks.join("\n");
      }

      const groupLines: string[] = [
        `${"  ".repeat(depth)}([${tag}] collapsed-group`,
      ];
      for (const block of childBlocks) {
        groupLines.push(indentMultiline(block, 1));
      }

      if (omittedChildren > 0) {
        groupLines.push(`${"  ".repeat(depth + 1)}... (${omittedChildren} children omitted)`);
      }

      groupLines.push(`${"  ".repeat(depth)})`);
      return groupLines.join("\n");
    }

    // 构建当前元素描述：[标签] "文本" 属性 #ID
    let line = `${indent}[${tag}]`;
    if (directText) line += ` "${directText.slice(0, maxTextLength)}"`;
    if (attrs.length) line += ` ${attrs.join(" ")}`;
    // 使用 hash ID（如 #a1b2c）或回退到完整 XPath
    if (hashId) {
      line += ` #${hashId}`;
      emittedRefIds.add(hashId);
    } else {
      line += ` ref="${currentPath}"`;
    }

    const lines: string[] = [line];
    emittedNodes++;

    // 递归子元素（优先保留可交互元素，再保留普通元素）
    const allChildren = Array.from(el.children);
    const interactiveChildren = allChildren.filter(isInteractiveElement);
    const nonInteractiveChildren = allChildren.filter((child) => !isInteractiveElement(child));
    const orderedChildren = [...interactiveChildren, ...nonInteractiveChildren];
    const childLimit = resolveChildLimit(el, maxChildren, hashId);
    const selectedChildren = orderedChildren.slice(0, childLimit);
    const omittedChildren = orderedChildren.length - selectedChildren.length;

    for (let i = 0; i < selectedChildren.length; i++) {
      const childResult = walk(selectedChildren[i], depth + 1, currentPath);
      if (childResult) lines.push(childResult);
    }

    if (omittedChildren > 0) {
      lines.push(`${indent}  ... (${omittedChildren} children omitted)`);
    }

    return lines.join("\n");
  }

  // 根元素自身的标签作为路径起点，walk 内部不再重复追加
  // 例如 root=body 时，parentPath=""，walk 中 currentPath="/body"
  const output = walk(root, 0, "") || "(空页面)";
  // 快照完成后清理无效引用：移除本轮未输出和已失联元素
  refStore?.prune(emittedRefIds);
  if (!truncatedByNodeBudget) return output;
  return `${output}\n... (snapshot truncated: maxNodes=${maxNodes})`;
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
  } catch {
    return `选择器语法错误: ${selector}`;
  }
}

/**
 * 多行文本块缩进（中）/ Indent each line of a multiline block (EN).
 */
function indentMultiline(block: string, indentLevel: number): string {
  const prefix = "  ".repeat(indentLevel);
  return block
    .split("\n")
    .map(line => `${prefix}${line}`)
    .join("\n");
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
        Type.Number({ description: "Max depth for snapshot (default: 7)" }),
      ),
      viewportOnly: Type.Optional(
        Type.Boolean({ description: "Only snapshot elements visible in viewport (default: true)" }),
      ),
      pruneLayout: Type.Optional(
        Type.Boolean({ description: "Collapse empty layout containers like div/span (default: true)" }),
      ),
      maxNodes: Type.Optional(
        Type.Number({ description: "Maximum nodes to include in snapshot (default: 280)" }),
      ),
      maxChildren: Type.Optional(
        Type.Number({ description: "Maximum children per element (default: 32)" }),
      ),
      maxTextLength: Type.Optional(
        Type.Number({ description: "Maximum text length per node (default: 40)" }),
      ),
      expandOptionLists: Type.Optional(
        Type.Boolean({ description: "Expand option-list containers to avoid child truncation (default: false)" }),
      ),
      expandChildrenRefs: Type.Optional(
        Type.Array(Type.String({ description: "Hash refs to expand child truncation for (e.g. #abc123)" })),
      ),
      expandedChildrenLimit: Type.Optional(
        Type.Number({ description: "Child limit for expandChildrenRefs nodes (default: 120, max: 300)" }),
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
            const maxDepth = (params.maxDepth as number) ?? 7;
            const viewportOnly = (params.viewportOnly as boolean) ?? true;
            const pruneLayout = (params.pruneLayout as boolean) ?? true;
            const maxNodes = (params.maxNodes as number) ?? 280;
            const maxChildren = (params.maxChildren as number) ?? 32;
            const maxTextLength = (params.maxTextLength as number) ?? 40;
            const expandOptionLists = (params.expandOptionLists as boolean) ?? false;
            const expandChildrenRefs = Array.isArray(params.expandChildrenRefs)
              ? (params.expandChildrenRefs as unknown[]).filter((ref): ref is string => typeof ref === "string")
              : undefined;
            const expandedChildrenLimit = typeof params.expandedChildrenLimit === "number"
              ? params.expandedChildrenLimit as number
              : undefined;
            const snapshot = generateSnapshot(document.body, {
              maxDepth,
              viewportOnly,
              pruneLayout,
              maxNodes,
              maxChildren,
              maxTextLength,
              expandOptionLists,
              expandChildrenRefs,
              expandedChildrenLimit,
              refStore: getActiveRefStore(),
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
