/**
 * Page Info Tool — 页面信息获取工具定义与快照生成。
 *
 * 职责：
 *   本文件是整个 SDK 中最重的工具文件，同时负责：
 *   1. 工具 schema 定义与 action 分发（get_url / snapshot / query_all 等）
 *   2. DOM 快照序列化引擎（buildSnapshot / serializeTree）
 *
 *   快照是 Agent Loop 的核心输入——每轮循环都依赖快照作为当前可执行范围的唯一事实来源。
 *   快照格式为缩进文本树，每个节点包含标签、属性、文本、交互状态和 #hashID。
 *
 * 支持 6 种动作：
 *   get_url       — 获取当前页面 URL（document.location.href）
 *   get_title     — 获取页面标题（document.title）
 *   get_selection — 获取用户选中的文本（window.getSelection）
 *   get_viewport  — 获取视口尺寸和滚动位置（innerWidth/innerHeight + scrollX/scrollY）
 *   snapshot      — 生成 AI 可读的 DOM 结构快照（核心动作，详见下方快照机制说明）
 *   query_all     — 查询所有匹配选择器的元素，返回 tag/id/text/可见性摘要列表
 *
 * 快照机制：
 *   - 仅交互节点分配 #hashID（通过 hasInteractiveTrackedEvents + 语义标签/ARIA role 判定）
 *   - 角色优先标签：ARIA role 与 HTML tag 不等价时用 role 替代 tag（如 [combobox] 替代 [input]）
 *   - 运行态增强：输出 select val、option selected、checked、disabled、readonly 等状态
 *   - 事件简写标注：listeners="clk,inp,..." 标注运行时事件绑定
 *   - 视口裁剪（viewportOnly）：跳过完全在视口外的元素，减少 token 消耗
 *   - 布局折叠（pruneLayout）：折叠无意义纯布局容器，子元素直接提升；相邻提升节点用括号分组块保留关联
 *   - 节点上限（maxNodes）：超出后停止遍历，避免超大页面 token 爆炸
 *
 * 依赖结构：
 *   helpers/base/active-store — 获取当前 RefStore 实例
 *   event-listener-tracker    — 获取元素运行时事件绑定信息
 *
 * 运行环境：浏览器 Content Script（直接访问 DOM，无 CDP）。
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import type { RefStore } from "../ref-store.js";
import { getTrackedElementEvents, hasTrackedElementEvents } from "../event-listener-tracker.js";
import { getActiveRefStore } from "../helpers/base/active-store.js";

/** 快照配置选项 */
export type SnapshotOptions = {
  /** 最大遍历深度（默认 12） */
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
  /** 最大输出节点数（默认 220），超过后停止继续遍历。 */
  maxNodes?: number;
  /** 每个父节点最多输出的子元素数（默认 25），超出部分会折叠。 */
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
  /**
   * 快照中允许输出的 listener 事件白名单（默认仅输出常用事件）。
   * 例如：['click', 'input', 'change', 'mousedown']。
   * 仅影响 `listeners="..."` 文本输出，不影响内部交互判定与 hash 分配。
   */
  listenerEvents?: string[];
  /**
   * class 名过滤正则列表（默认开启常用 UI 框架过滤）。
   * 每项为正则字符串，class 名匹配任一正则即从快照中剔除。
   * - 默认（undefined）：启用内置规则，剔除 Element Plus / AntD / BK / TDesign / Arco / Vant / Naive 等。
   * - 自定义 string[]：替换默认规则，使用自定义正则。
   * - false：禁用过滤，保留所有 class。
   */
  classNameFilter?: string[] | false;
};

/**
 * 内置 class 名过滤正则（剔除常见 UI 框架噪音类名）。
 * 通过匹配组件关键词（如 -button、-input、-dialog）统一覆盖所有框架，
 * 无需逐一枚举框架前缀。
 */
const DEFAULT_CLASSNAME_FILTERS: string[] = [
  // 通用组件关键词：匹配 class 中含 -button / -input 等的类名
  // 保留悬浮层相关类名（dialog/modal/drawer/popover/tooltip/popper/overlay/popup/dropdown）以便 AI 识别弹层结构
  "-(?:button|btn|input|select|option|tag|badge|menu|menuitem|tab|tabs|table|thead|tbody|tfoot|th|td|form|form-item|field|label|checkbox|radio|switch|slider|rate|upload|tree|collapse|breadcrumb|pagination|pager|step|steps|progress|cascader|transfer|picker|date-picker|time-picker|color-picker|auto-complete|autocomplete|card|alert|message|notification|notify|toast|spin|spinner|loading|skeleton|empty|result|avatar|icon|image|divider|space|scrollbar|affix|anchor|back-top|backtop|watermark|segmented|descriptions|statistic|countdown|row|col|grid|layout|container|header|footer|aside|main|sidebar|wrapper|inner|content|prefix|suffix|append|prepend|cell|column|group|panel|item|list|body|close|arrow|placeholder|trigger|reference|transition)",
];

/** 快照属性值最大保留长度（超出截断）。 */
const MAX_SNAPSHOT_ATTR_VALUE_LENGTH = 120;
/** 选项列表放宽时的子节点上限（仍保留硬上限，避免快照无限膨胀）。 */
const MAX_EXPANDED_LIST_CHILDREN = 120;
/** 定向放宽 children 的硬上限。 */
const MAX_EXPANDED_CHILDREN_LIMIT = 300;
/** 快照默认保留的高价值 listener 事件（控制 token 体积）。 */
const DEFAULT_SNAPSHOT_LISTENER_EVENTS = [
  "click",
  "input",
  "change",
  "mousedown",
  "pointerdown",
  "keydown",
  "submit",
  "focus",
  "blur",
];

/** 事件名 → 快照简写映射（压缩 token）。 */
const EVENT_ABBREV: Record<string, string> = {
  click: "clk", dblclick: "dbl",
  mousedown: "mdn", mouseup: "mup", mousemove: "mmv",
  mouseover: "mov", mouseout: "mot", mouseenter: "men", mouseleave: "mlv",
  pointerdown: "pdn", pointerup: "pup", pointermove: "pmv",
  touchstart: "tst", touchend: "ted",
  keydown: "kdn", keyup: "kup",
  input: "inp", change: "chg", submit: "sub",
  focus: "fcs", blur: "blr",
  scroll: "scl", wheel: "whl",
  drag: "drg", dragstart: "drs", dragend: "dre", drop: "drp",
  contextmenu: "ctx",
};

function abbrevEvent(name: string): string {
  return EVENT_ABBREV[name] ?? name.slice(0, 3);
}

function normalizeSnapshotListenerEvent(name: string): string {
  return name.trim().toLowerCase();
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

  const maxDepth = opts.maxDepth ?? 12;
  const viewportOnly = opts.viewportOnly ?? true;
  const pruneLayout = opts.pruneLayout ?? true;
  const maxNodes = opts.maxNodes ?? 220;
  const maxChildren = opts.maxChildren ?? 25;
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
  const allowedListenerEvents = new Set(
    (opts.listenerEvents && opts.listenerEvents.length > 0
      ? opts.listenerEvents
      : DEFAULT_SNAPSHOT_LISTENER_EVENTS)
      .map(normalizeSnapshotListenerEvent)
      .filter(Boolean),
  );
  const classNameFilterRegexps: RegExp[] | null = opts.classNameFilter === false
    ? null
    : (opts.classNameFilter && opts.classNameFilter.length > 0
        ? opts.classNameFilter
        : DEFAULT_CLASSNAME_FILTERS
      ).map(p => new RegExp(p));

  let emittedNodes = 0;
  let truncatedByNodeBudget = false;

  const refStore = opts.refStore;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "SVG", "NOSCRIPT", "LINK", "META", "BR", "HR",
    "COLGROUP", "COL",
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
    "src", "alt", "title", "for", "action", "method",
  ];

  const INTERACTIVE_TAGS = new Set([
    "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "OPTION", "LABEL", "SUMMARY",
  ]);

  const INTERACTIVE_EVENTS = new Set([
    "click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup",
    "touchstart", "touchend", "input", "change", "keydown", "keyup",
    "submit", "focus", "blur",
  ]);

  /** 交互性 ARIA role — 需要分配 hash ID 的角色集合 */
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "tab", "switch", "slider", "checkbox", "radio",
    "combobox", "listbox", "option", "menuitem", "textbox", "spinbutton",
    "searchbox", "treeitem", "gridcell", "scrollbar",
  ]);

  /**
   * 事件优先级（值越大越优先）：
   * 输入链路（input/change/focus/blur） > 点击链路（click/pointer） > 其他事件。
   */
  const EVENT_PRIORITY: Record<string, number> = {
    input: 140,
    change: 130,
    focus: 120,
    blur: 110,
    keydown: 100,
    keyup: 90,
    click: 80,
    dblclick: 70,
    pointerdown: 60,
    pointerup: 55,
    mousedown: 50,
    mouseup: 45,
    touchstart: 40,
    touchend: 35,
    submit: 30,
  };

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
    // 运行时追踪到事件绑定的元素有交互语义
    if (hasTrackedElementEvents(el)) return false;
    // 有直接文本内容的元素有意义
    if (directText) return false;
    return true;
  }

  function hasInteractiveTrackedEvents(el: Element): boolean {
    const tracked = getTrackedElementEvents(el);
    if (tracked.length === 0) return false;
    return tracked.some(name => INTERACTIVE_EVENTS.has(name));
  }

  function getSnapshotListenerEvents(el: Element): string[] {
    const tracked = getTrackedElementEvents(el);
    if (tracked.length === 0) return [];
    return tracked.filter(name => allowedListenerEvents.has(normalizeSnapshotListenerEvent(name)));
  }

  function getTrackedEventPriorityScore(el: Element): number {
    const tracked = getTrackedElementEvents(el);
    if (tracked.length === 0) return 0;

    let score = 0;
    for (const name of tracked) {
      score += EVENT_PRIORITY[name] ?? 8;
    }
    return score;
  }

  /**
   * 元素优先级：
   * 1) 输入控件/按钮等语义控件
   * 2) 事件追踪优先级（输入、点击、失焦等）
   * 3) inline 事件与可聚焦能力补充加分
   */
  function getElementPriorityScore(el: Element): number {
    let score = 0;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      score += 200;
    } else if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement) {
      score += 180;
    } else if (el.getAttribute("role") === "button" || el.getAttribute("role") === "switch" || el.getAttribute("role") === "slider") {
      score += 160;
    }

    score += getTrackedEventPriorityScore(el);

    if (el.hasAttribute("onclick")) score += 60;
    if (el.hasAttribute("oninput") || el.hasAttribute("onchange")) score += 80;
    if (el.hasAttribute("onfocus") || el.hasAttribute("onblur")) score += 70;
    if (el.hasAttribute("tabindex")) score += 20;

    return score;
  }

  function orderChildrenByPriority(children: Element[]): Element[] {
    return children
      .map((child, index) => ({
        child,
        index,
        interactive: isInteractiveElement(child),
        score: getElementPriorityScore(child),
      }))
      .sort((a, b) => {
        if (a.interactive !== b.interactive) return a.interactive ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
      })
      .map(entry => entry.child);
  }

  function isInteractiveElement(el: Element): boolean {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.hasAttribute("role")) return true;
    if (el.hasAttribute("tabindex")) return true;
    if (el.hasAttribute("aria-label")) return true;
    if (hasInteractiveTrackedEvents(el)) return true;
    return false;
  }

  /**
   * 判断元素是否需要分配 hash ID（仅交互节点分配，节省 token）。
   *
   * 核心依据：元素是否绑定了交互事件（INTERACTIVE_EVENTS 集合）。
   * 辅助依据：语义交互标签、内联事件、ARIA role、tabindex 等兜底。
   */
  function needsHashId(el: Element): boolean {
    // 核心判定：有追踪到的交互事件（click/input/change/focus/blur 等）
    if (hasInteractiveTrackedEvents(el)) return true;
    // 内联事件处理器（onclick/oninput 等）
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on")) return true;
    }
    // 语义交互标签兜底（即使没有事件追踪也应可操作）
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    // 交互性 ARIA role 兜底
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    // tabindex → 可聚焦
    if (el.hasAttribute("tabindex")) return true;
    // contenteditable → 可编辑
    if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== "inherit") return true;
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

  /**
   * 判断元素或其任何后代是否为交互节点（需要 hash ID）。
   * 用于文本聚合判定：子树无交互后代时可安全合并叶文本。
   */
  function hasInteractiveDescendant(el: Element): boolean {
    if (needsHashId(el)) return true;
    for (const child of Array.from(el.children)) {
      if (hasInteractiveDescendant(child)) return true;
    }
    return false;
  }

  /**
   * 深度收集元素子树中所有叶子文本节点的内容。
   * 跳过 SKIP_TAGS 和不可见元素，用于透明容器的文本聚合。
   */
  function collectLeafTexts(el: Element, maxLen: number): string[] {
    const texts: string[] = [];
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim();
        if (t) texts.push(t.slice(0, maxLen));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const child = node as Element;
        if (SKIP_TAGS.has(child.tagName.toUpperCase())) continue;
        try {
          const s = window.getComputedStyle(child);
          if (s.display === "none" || s.visibility === "hidden") continue;
        } catch { continue; }
        texts.push(...collectLeafTexts(child, maxLen));
      }
    }
    return texts;
  }

  function walk(el: Element, depth: number, parentPath: string): string {
    if (emittedNodes >= maxNodes) {
      truncatedByNodeBudget = true;
      return "";
    }

    if (depth > maxDepth) return "";
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return "";

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

    // ─── 角色优先标签 ───
    // 当元素有 INTERACTIVE_ROLES 内的 role 且与 tag 不等价时，
    // 用 role 替代 tag 作为显示标签（如 [combobox] 替代 [input] role="combobox"）。
    // 这让 AI 直接从标签判断交互模式，同时省去冗余的 role="..." 属性。
    const rawRole = el.getAttribute("role");
    const useRoleAsTag = !!(rawRole && INTERACTIVE_ROLES.has(rawRole) && rawRole !== tag);
    const displayTag = useRoleAsTag ? rawRole : tag;

    // 构建当前元素的内部路径（始终计算，子元素路径依赖它）
    // 注意：路径使用原始 tag 而非 displayTag，保证 hash 计算一致性
    const index = getSiblingIndex(el);
    const currentPath = `${parentPath}/${tag}${index}`;
    // 仅交互节点分配 hash ID 并注册到 RefStore，非交互节点不占 token
    const shouldAssignHash = refStore && needsHashId(el);
    const hashId = shouldAssignHash ? refStore.set(el, currentPath) : undefined;

    // 收集有意义的属性（精简版：只保留对 AI 操作有用的信息）
    const attrs: string[] = [];

    // 1. id — 最重要的标识信息
    const elId = el.getAttribute("id");
    if (elId) attrs.push(`id="${elId}"`);

    // 2. class — 保留第 1 个有语义的类名（不论交互与否，class 对 AI 识别元素语义有价值）
    const className = el.getAttribute("class")?.trim();
    if (className) {
      const cls = className.split(/\s+/)
        .find(c => c && !c.startsWith("data-v-") && c.length < 25 && !/^[a-z]{1,2}\d|^_|^css-/.test(c)
          && !(classNameFilterRegexps && classNameFilterRegexps.some(r => r.test(c))));
      if (cls) attrs.push(`class="${cls}"`);
    }

    // 3. 交互属性（href, type, placeholder 等）
    for (const attr of INTERACTIVE_ATTRS) {
      // 若 role 已提升为显示标签，跳过 role 属性避免重复输出
      if (attr === "role" && useRoleAsTag) continue;
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

    // 5.1 运行时事件绑定（addEventListener 追踪）
    const trackedEvents = getSnapshotListenerEvents(el);
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

    // ─── 智能剪枝（链式坍塌） ───
    // 无意义布局容器不输出自身行，子内容直接提升到当前层级。
    // 若子树无任何交互后代，则合并所有叶文本为一行（文本聚合）。
    if (isEmptyLayoutContainer(el, directText)) {
      const allChildren = Array.from(el.children);

      // 文本聚合：子树无交互后代时，合并所有叶子文本为一行
      if (!allChildren.some(c => hasInteractiveDescendant(c))) {
        const texts = collectLeafTexts(el, maxTextLength);
        if (texts.length > 0) {
          emittedNodes++;
          return `${indent}"${texts.join(" · ").slice(0, maxTextLength * 3)}"`;
        }
        return "";
      }

      // 链式穿透：有交互后代时，子内容直接提升（不输出 collapsed-group）
      const orderedChildren = orderChildrenByPriority(allChildren);
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

      let result = childBlocks.join("\n");
      if (omittedChildren > 0) {
        result += `\n${indent}... (${omittedChildren} children omitted)`;
      }
      return result;
    }

    // 构建当前元素描述：[显示标签] "文本" 属性 #hashID（仅交互节点）
    // displayTag 在有交互性 role 时为 role 值，否则为原始 HTML tag
    let line = `${indent}[${displayTag}]`;
    if (directText) line += ` "${directText.slice(0, maxTextLength)}"`;
    if (attrs.length) line += ` ${attrs.join(" ")}`;
    // 仅交互节点输出 hash ID，非交互节点不附加标识（省 token）
    if (hashId) {
      line += ` #${hashId}`;
    }

    const lines: string[] = [line];
    emittedNodes++;

    // 递归子元素（优先保留可交互元素，再保留普通元素）
    const allChildren = Array.from(el.children);
    const orderedChildren = orderChildrenByPriority(allChildren);
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

    // 纯文本布局标签简化：无 hashId、无子输出的布局标签只输出文本
    // 例如 [div] "租户" → "租户"，去掉无意义的标签外壳
    if (!hashId && LAYOUT_TAGS.has(el.tagName) && directText && lines.length === 1) {
      return `${indent}"${directText.slice(0, maxTextLength)}"`;
    }

    return lines.join("\n");
  }

  // 根元素自身的标签作为路径起点，walk 内部不再重复追加
  // 例如 root=body 时，parentPath=""，walk 中 currentPath="/body"
  const output = walk(root, 0, "") || "(空页面)";
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
      "Page information tool.",
      "Actions: get_url, get_title, get_selection, get_viewport, snapshot, query_all.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Page info action name",
      }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector for query_all" }),
      ),
      maxDepth: Type.Optional(
        Type.Number({ description: "Snapshot max depth" }),
      ),
      viewportOnly: Type.Optional(
        Type.Boolean({ description: "Snapshot only visible elements" }),
      ),
      pruneLayout: Type.Optional(
        Type.Boolean({ description: "Collapse empty layout containers" }),
      ),
      maxNodes: Type.Optional(
        Type.Number({ description: "Snapshot max nodes" }),
      ),
      maxChildren: Type.Optional(
        Type.Number({ description: "Snapshot max children per node" }),
      ),
      maxTextLength: Type.Optional(
        Type.Number({ description: "Snapshot max text length" }),
      ),
      expandOptionLists: Type.Optional(
        Type.Boolean({ description: "Expand option/list containers" }),
      ),
      expandChildrenRefs: Type.Optional(
        Type.Array(Type.String({ description: "#hashIDs to expand children for" })),
      ),
      expandedChildrenLimit: Type.Optional(
        Type.Number({ description: "Expanded child limit" }),
      ),
      listenerEvents: Type.Optional(
        Type.Array(Type.String({ description: "Snapshot listener event whitelist" })),
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
            const maxDepth = (params.maxDepth as number) ?? 12;
            const viewportOnly = (params.viewportOnly as boolean) ?? true;
            const pruneLayout = (params.pruneLayout as boolean) ?? true;
            const maxNodes = (params.maxNodes as number) ?? 220;
            const maxChildren = (params.maxChildren as number) ?? 25;
            const maxTextLength = (params.maxTextLength as number) ?? 40;
            const expandOptionLists = (params.expandOptionLists as boolean) ?? false;
            const expandChildrenRefs = Array.isArray(params.expandChildrenRefs)
              ? (params.expandChildrenRefs as unknown[]).filter((ref): ref is string => typeof ref === "string")
              : undefined;
            const expandedChildrenLimit = typeof params.expandedChildrenLimit === "number"
              ? params.expandedChildrenLimit as number
              : undefined;
            const listenerEvents = Array.isArray(params.listenerEvents)
              ? (params.listenerEvents as unknown[]).filter((event): event is string => typeof event === "string")
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
              listenerEvents,
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
