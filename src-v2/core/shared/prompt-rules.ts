/**
 * 公共提示词规则模块 — Main Agent 和 Micro-task Agent 共享的 DOM 操作规则。
 *
 * ─── 设计目的 ───
 *
 * 1. 消除 system-prompt.ts 和 micro-task/prompt.ts 之间的规则重复
 * 2. 确保两种 Agent 对 DOM 操作、快照驱动、轮次管理的理解一致
 * 3. 新增/修改操作规则时只需改一处
 *
 * ─── 导出内容 ───
 *
 * - LISTENER_ABBREV_MAP：事件名 → 缩写映射
 * - DEFAULT_LISTENER_EVENTS：默认监听事件白名单
 * - buildListenerAbbrevLine()：构建事件简写行
 * - buildCoreOperationRules()：核心 DOM 操作规则数组（两种 Agent 共用）
 */

// ─── 事件缩写映射（与 page-info-tool EVENT_ABBREV 一致） ───

export const LISTENER_ABBREV_MAP: Record<string, string> = {
  click: "clk",
  dblclick: "dbl",
  mousedown: "mdn",
  mouseup: "mup",
  mousemove: "mmv",
  mouseover: "mov",
  mouseout: "mot",
  mouseenter: "men",
  mouseleave: "mlv",
  pointerdown: "pdn",
  pointerup: "pup",
  pointermove: "pmv",
  touchstart: "tst",
  touchend: "ted",
  keydown: "kdn",
  keyup: "kup",
  input: "inp",
  change: "chg",
  submit: "sub",
  focus: "fcs",
  blur: "blr",
  scroll: "scl",
  wheel: "whl",
  drag: "drg",
  dragstart: "drs",
  dragend: "dre",
  drop: "drp",
  contextmenu: "ctx",
};

export const DEFAULT_LISTENER_EVENTS = [
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

/**
 * 根据事件白名单构建 "clk=click inp=input ..." 缩写行。
 */
export function buildListenerAbbrevLine(listenerEvents?: string[]): string {
  const allowed =
    listenerEvents && listenerEvents.length > 0
      ? listenerEvents
      : DEFAULT_LISTENER_EVENTS;

  const normalized = allowed
    .map((event) => event.trim().toLowerCase())
    .filter(Boolean);

  const unique = [...new Set(normalized)];
  return unique
    .map((event) => {
      const abbrev = LISTENER_ABBREV_MAP[event];
      return abbrev ? `${abbrev}=${event}` : null;
    })
    .filter((pair): pair is string => !!pair)
    .join(" ");
}

/**
 * 核心 DOM 操作规则 — Main Agent 和 Micro-task Agent 共用。
 *
 * 返回字符串数组，调用方用 join("\n") 拼接。
 * 规则按主题分组：快照驱动 → 点击 → 批量操作 → 控件 → 轮次管理 → 通用约束。
 */
export function buildCoreOperationRules(): string[] {
  return [
    // ── 快照驱动 ──
    "- Work from CURRENT snapshot + remaining task. Do not restate.", // 基于当前快照+剩余任务工作
    "- Task reduction: (remaining, prev actions, this-round) → new remaining.", // 任务推进模式
    "- Use #hashID from snapshot as selector. Do not guess CSS selectors.", // 用快照中的 #hashID，不要猜选择器
    "- Only interactive elements carry #hashID; others are context-only.", // 只有交互元素有 #hashID

    // ── 点击规则 ──
    "- Bracket tag may show ARIA role ([combobox], [slider]) as interaction hint. listeners=\"...\" = bound events (abbrevs below). Prefer targets with matching listeners.", // ARIA 角色提示 + listeners 绑定事件，优先选有匹配 listener 的目标
    "- Click target MUST have click signal: clk/pdn/mdn in listeners, onclick attr, native <a>/<button>, or role=button/link. NEVER click elements with only blr/fcs. If text has no click signal, look at its parent/container or nearby sibling that does.", // 点击目标必须有点击信号。没有的话看父元素/兄弟元素
    "- Effect check: before planning new actions, confirm previous actions' effects are visible in snapshot. Click failed (snapshot unchanged)? Do NOT repeat. Try: (1) <a>/<button> child inside container; (2) parent/sibling with clk; (3) different approach (search, filter, evaluate programmatically).", // 规划新动作前先确认上轮效果。点击无效不要重复，换方法

    // ── 批量操作 ──
    "- Batch fill/type/check/select_option freely in one round. Click ends the round — at most ONE click as LAST action.", // 同轮可批量填写，点击必须是最后一个动作
    "- fill/type/select_option auto-focus: these actions automatically click and focus the target before input — do NOT send a separate focus/click before them.", // 自动聚焦，不用额外 click/focus
    "- Search inputs: after fill, press Enter or click search button. fill alone does not submit.", // 搜索输入填完要按回车

    // ── 控件操作 ──
    "- Dropdown/select: prefer dom.select_option. Custom dropdowns: click → next snapshot → click option (two rounds).", // 下拉选择优先 select_option，自定义下拉两轮完成
    "- Steppers: compute delta, click |delta| times. Check/uncheck: target real input control.", // 步进器算增量，勾选框操作真实 input
    "- Confirm-to-apply principle: any multi-step interaction that opens a secondary UI (picker, popover, dropdown panel, modal, dialog, drawer, editor overlay, cascader, transfer box, etc.) is NOT complete after just entering/selecting a value — you MUST click the confirm/OK/apply/save button (or equivalent) to commit the change. The task is only done when the secondary UI is dismissed AND the final value is reflected on the original page/form field in the snapshot.", // 确认生效原则：所有打开二级 UI 的交互（选择器、弹出面板、弹窗、抽屉、编辑浮层等），选值/输入后必须点确认按钮提交，二级 UI 关闭且原始页面/表单字段显示最终值才算完成

    // ── 轮次管理 ──
    "- DOM-changing action (click/modal/navigate) ends the round. Actions after a click in same batch are discarded.", // DOM 变化动作结束当前轮
    "- One-shot preconditions (waits, confirmations, navigation in prev actions) are DONE — strip from REMAINING.", // 已完成的前置条件不要重复执行
    "- Intermediate progress ≠ completion. Keep REMAINING on final goal until end state is visible in snapshot.", // 中间进展不等于完成（打开下拉≠选好了）
    "- Never repeat same tool call (same name + args) on same target.", // 不要重复相同调用
    "- page_info.snapshot is internal — auto-refreshed every round, never call directly. Other page_info actions (get_url, get_title, get_viewport, query_all, get_selection) allowed. Do NOT use get_text/get_attr to read what is already visible in snapshot.", // snapshot 自动刷新不要手动调
    "- Omitted children: output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>`, wait for next snapshot.", // 省略的子元素用 HINT 展开

    // ── 通用约束 ──
    "- Do NOT verify values unless user explicitly asks.", // 不要验证已填的值
    "- Do NOT interact with AutoPilot UI unless user asks.", // 不要操作面板自身
    "- Completion = visible outcome in snapshot. If snapshot already shows the expected result (color changed, switch toggled, value present, dialog closed, etc.), the task IS done.", // 快照已显示预期结果就是完成
  ];
}
