/**
 * Agent Loop 辅助函数。
 *
 * 这个文件只放“纯函数”：
 * - 不访问外部可变状态
 * - 不做网络/DOM/I/O
 * - 输入相同，输出稳定
 *
 * 目的：把 index.ts 里的协议解析、文本规整、判定逻辑拆出来，
 * 让主循环只负责编排流程，方便阅读、测试和后续扩展。
 *
 * 函数能力速览：
 * - 基础工具：
 *   - `sleep`：异步等待
 *   - `toContentString`：统一工具结果内容为字符串
 * - 快照相关：
 *   - `parseSnapshotExpandHints`：解析 `SNAPSHOT_HINT: EXPAND_CHILDREN`
 *   - `extractHashSelectorRef`：从 `#ref` 选择器提取 ref id
 *   - `computeSnapshotFingerprint`：剥离 hashID 后计算快照指纹，用于轮次间变化检测
 *   - `findNearbyClickTargets`：从快照中查找指定 selector 附近的可点击元素，用于无效点击后的替代目标推荐
 * - 任务推进与协议：
 *   - `buildTaskArray`：将工具调用规整成稳定任务数组
 *   - `normalizeModelOutput`：压缩模型输出供下一轮上下文使用
 *   - `parseRemainingInstruction`：解析 `REMAINING` 协议
 *   - `deriveNextInstruction`：推导下一轮 remaining（有协议优先）
 *   - `reduceRemainingHeuristically`：协议缺失时做启发式推进
 * - 执行控制：
 *   - `shouldForceRoundBreak`：判断动作后是否应断轮
 *   - `collectMissingTask`：提取“元素未找到”任务用于重试流
 * - 错误与参数判定：
 *   - `isElementNotFoundResult`：识别元素未找到错误
 *   - `buildToolCallKey`：生成稳定调用键
 *   - `resolveRecoveryWaitMs`：解析恢复等待时长
 *   - `getToolAction`：读取工具输入里的 action
 *   - `hasToolError`：判断结果是否标记为错误
 */
import type { ToolCallResult } from "./tool-registry.js";
import { DEFAULT_RECOVERY_WAIT_MS } from "./constants.js";
import type { TaskItem } from "./types.js";

/**
 * 异步睡眠。
 *
 * 用于重试等待、节流等待等场景。
 *
 * @example
 * ```ts
 * await sleep(1000); // 等待 1 秒
 * await sleep(100);  // 元素恢复前等待 100ms
 * ```
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统一内容为字符串。
 *
 * 工具返回 content 可能是 string 或 object；这里统一转成 string，
 * 便于日志、错误判定、摘要拼接。
 *
 * @example
 * ```ts
 * toContentString("已点击按钮")          // → "已点击按钮"
 * toContentString({ code: "OK", n: 1 }) // → '{\n  "code": "OK",\n  "n": 1\n}'
 * ```
 */
export function toContentString(content: ToolCallResult["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

/**
 * 解析快照放宽提示。
 *
 * 约定格式：`SNAPSHOT_HINT: EXPAND_CHILDREN #ref1 #ref2`
 *
 * 返回：去掉 `#` 前缀后的 ref id 列表。
 *
 * @example
 * ```ts
 * parseSnapshotExpandHints("SNAPSHOT_HINT: EXPAND_CHILDREN #a1b2c #x9k3d")
 * // → ["a1b2c", "x9k3d"]
 *
 * parseSnapshotExpandHints("REMAINING: DONE")
 * // → []（无匹配）
 * ```
 */
export function parseSnapshotExpandHints(text: string | undefined): string[] {
  if (!text) return [];
  const refs: string[] = [];
  const regex = /^\s*SNAPSHOT_HINT\s*:\s*EXPAND_CHILDREN\s+(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const tail = match[1] ?? "";
    const tokens = tail.match(/#[A-Za-z0-9_-]+/g) ?? [];
    for (const token of tokens) refs.push(token.replace(/^#/, ""));
  }
  return refs;
}

/**
 * 提取 hash selector 的 ref。
 *
 * 仅处理“纯 hash 选择器”，例如 `#1rv01x`。
 * 如果是复杂 CSS（如 `.x #id`）会返回 null，避免误判。 *
 * @example
 * ```ts
 * extractHashSelectorRef({ selector: "#1rv01x" })   // → "1rv01x"
 * extractHashSelectorRef({ selector: ".btn #id" })  // → null（复杂选择器）
 * extractHashSelectorRef({ selector: "div" })        // → null（非 hash）
 * extractHashSelectorRef({})                          // → null
 * ``` */
export function extractHashSelectorRef(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const selector = (toolInput as { selector?: unknown }).selector;
  if (typeof selector !== "string") return null;
  const m = selector.trim().match(/^#([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}
/**
 * 快照指纹计算 — 用于轮次间快照变化检测。
 *
 * 元素的 #hashID（如 `#1kry9hw`）可能因 DOM 重新渲染而变化，
 * 但页面实际内容并未改变。因此先将 hashID 替换为占位符 `#_`，
 * 再计算 djb2 哈希，确保指纹只反映真实页面结构和文本差异。
 *
 * 用途：轮次行动前后各算一次指纹，若一致说明操作未产生任何可见效果。
 *
 * @example
 * ```ts
 * const before = computeSnapshotFingerprint('[button] "提交" #a1b2c');
 * const after  = computeSnapshotFingerprint('[button] "提交" #x9y8z');
 * before === after  // → true（内容相同，仅 hashID 变化）
 *
 * const changed = computeSnapshotFingerprint('[button] "已提交" #a1b2c');
 * before === changed  // → false（文本变化 → 指纹不同）
 * ```
 */
export function computeSnapshotFingerprint(snapshot: string): string {
  if (!snapshot) return "";
  const normalized = _normalizeHashIds(snapshot);
  return _djb2(normalized);
}

/**
 * djb2 字符串哈希（非加密）。
 *
 * 纯粹用于快照指纹比对，不用于安全场景。
 */
function _djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** hashID 归一化（与 computeSnapshotFingerprint 相同） */
function _normalizeHashIds(text: string): string {
  return text.replace(/#[a-z0-9]{4,}/gi, "#_");
}

/** 获取行的缩进级别（前导空格数），用于从快照文本推导 DOM 树层级。 */
function _getIndent(text: string): number {
  const m = text.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * 对比前后两份快照，输出带树感知上下文的 diff。
 *
 * 核心设计：以 currRaw（当前快照）作为有效 DOM 树骨架计算上下文，
 * 避免在混合的 edits 序列上推导树结构导致祖先链断裂。
 *
 * 树感知上下文策略：
 * - **祖先链**：从变化位置在 currRaw 中向上收集严格递减缩进的行
 * - **子节点**：新增节点的全部子节点展开（最多 50 行）
 * - **兄弟节点**：同缩进级别上下各取 contextLines 个（默认 3），遇父边界则停
 * - 删除行映射到 currRaw 的对应位置后插入，上下文从 currRaw 取
 * - 多处变化（hunk）之间用 `---` 分隔
 * - 匹配时归一化 hashID（`#abc → #_`），但输出保留原始 hash 供 AI 引用
 *
 * 若无差异或前一份快照为空，返回空字符串。
 */
export function computeSnapshotDiff(
  prevSnapshot: string,
  currSnapshot: string,
  maxLines = 60,
  contextLines = 2,
): string {
  if (!prevSnapshot || !currSnapshot) return "";

  const prevRaw = prevSnapshot.split("\n");
  const currRaw = currSnapshot.split("\n");

  // 归一化 hash 用于匹配（但输出保留原始行）
  const prevNorm = prevRaw.map(l => _normalizeHashIds(l.trimEnd()));
  const currNorm = currRaw.map(l => _normalizeHashIds(l.trimEnd()));

  // ── Step 1: 贪心位置匹配 ──
  // 为 prev 的每个归一化行建立索引
  const prevIndex = new Map<string, number[]>();
  for (let i = 0; i < prevNorm.length; i++) {
    if (!prevNorm[i]) continue;
    const arr = prevIndex.get(prevNorm[i]);
    if (arr) arr.push(i);
    else prevIndex.set(prevNorm[i], [i]);
  }

  // curr 的每行在 prev 中找最近未用位置匹配
  const usedPrev = new Set<number>();
  const currMatch: (number | -1)[] = new Array(currNorm.length).fill(-1);
  let lastMatchedPrev = -1;

  for (let ci = 0; ci < currNorm.length; ci++) {
    if (!currNorm[ci]) continue;
    const candidates = prevIndex.get(currNorm[ci]);
    if (!candidates) continue;

    // 找 >= lastMatchedPrev+1 的最小未用候选（保持顺序单调）
    let best = -1;
    for (const pi of candidates) {
      if (pi > lastMatchedPrev && !usedPrev.has(pi)) {
        best = pi;
        break;
      }
    }
    // 如果单调搜索失败，退而求其次找任意未用候选
    if (best === -1) {
      for (const pi of candidates) {
        if (!usedPrev.has(pi)) {
          best = pi;
          break;
        }
      }
    }
    if (best !== -1) {
      currMatch[ci] = best;
      usedPrev.add(best);
      lastMatchedPrev = best;
    }
  }

  // ── Step 2: 标记变化行 ──
  const addInCurr = new Set<number>();
  for (let ci = 0; ci < currRaw.length; ci++) {
    if (currMatch[ci] === -1 && currNorm[ci]) addInCurr.add(ci);
  }
  const removeInPrev: number[] = [];
  for (let pi = 0; pi < prevRaw.length; pi++) {
    if (!usedPrev.has(pi) && prevNorm[pi]) removeInPrev.push(pi);
  }
  if (addInCurr.size === 0 && removeInPrev.length === 0) return "";

  // ── Step 3: 将删除行映射到 currRaw 插入位置 ──
  // prevRaw index → currRaw index 反向映射
  const prevToCurr = new Map<number, number>();
  for (let ci = 0; ci < currMatch.length; ci++) {
    if (currMatch[ci] !== -1) prevToCurr.set(currMatch[ci], ci);
  }
  // 每个删除行找到它在 currRaw 中应插入的位置（afterCi = 上方最近匹配行的 currRaw 索引）
  const removesAtCurr = new Map<number, string[]>(); // afterCi → 删除行原始文本
  for (const pi of removeInPrev) {
    let afterCi = -1;
    for (let j = pi - 1; j >= 0; j--) {
      if (prevToCurr.has(j)) { afterCi = prevToCurr.get(j)!; break; }
    }
    if (!removesAtCurr.has(afterCi)) removesAtCurr.set(afterCi, []);
    removesAtCurr.get(afterCi)!.push(prevRaw[pi]);
  }

  // ── Step 4: 在 currRaw 上计算树感知上下文 ──
  // 关键：上下文始终基于 currRaw（有效 DOM 树），而非混合的 edits 序列
  const SIBLING_CTX = Math.max(contextLines, 3);
  const MAX_CHILD_LINES = 50;
  const inCtx = new Set<number>(); // currRaw 行索引

  /** 为 currRaw 中的某个位置添加树上下文（祖先链 + 兄弟） */
  function _addTreeCtx(ci: number, overrideIndent?: number) {
    const myInd = overrideIndent ?? _getIndent(currRaw[ci]);
    // 祖先链：向上找严格递减缩进
    let need = myInd;
    for (let j = ci - 1; j >= 0 && need > 0; j--) {
      const ind = _getIndent(currRaw[j]);
      if (ind < need) { inCtx.add(j); need = ind; }
    }
    // 兄弟上
    let su = 0;
    for (let j = ci - 1; j >= 0 && su < SIBLING_CTX; j--) {
      const ind = _getIndent(currRaw[j]);
      if (ind < myInd) break;
      if (ind === myInd) { inCtx.add(j); su++; }
    }
    // 兄弟下
    let sd = 0;
    for (let j = ci + 1; j < currRaw.length && sd < SIBLING_CTX; j++) {
      const ind = _getIndent(currRaw[j]);
      if (ind < myInd) break;
      if (ind === myInd) { inCtx.add(j); sd++; }
    }
  }

  // 为新增行添加上下文（含子节点全展开）
  for (const ci of addInCurr) {
    inCtx.add(ci);
    _addTreeCtx(ci);
    const myInd = _getIndent(currRaw[ci]);
    let cc = 0;
    for (let j = ci + 1; j < currRaw.length; j++) {
      if (_getIndent(currRaw[j]) <= myInd) break;
      inCtx.add(j);
      if (++cc >= MAX_CHILD_LINES) break;
    }
  }

  // 为删除行的插入点添加上下文（用删除行的缩进找祖先/兄弟）
  for (const [afterCi, texts] of removesAtCurr) {
    if (afterCi >= 0) {
      inCtx.add(afterCi);
      _addTreeCtx(afterCi, _getIndent(texts[0]));
    }
  }

  // ── Step 5: 以 currRaw 为骨架输出，在插入点嵌入删除行 ──
  const hunks: string[] = [];
  let lineCount = 0;
  let inHunk = false;

  // 处理插在 currRaw 最前面的删除行（afterCi = -1）
  const beforeAll = removesAtCurr.get(-1);
  if (beforeAll) {
    inHunk = true;
    for (const t of beforeAll) {
      hunks.push("- " + t.trimEnd());
      lineCount++;
    }
  }

  for (let ci = 0; ci < currRaw.length; ci++) {
    const isAdd = addInCurr.has(ci);
    const isContext = inCtx.has(ci);
    const removes = removesAtCurr.get(ci);

    if (!isAdd && !isContext && !removes) {
      if (inHunk) inHunk = false;
      continue;
    }

    if (!inHunk) {
      if (hunks.length > 0) hunks.push("---");
      inHunk = true;
    }

    // 输出 currRaw 行（新增或上下文）
    if (isAdd || isContext) {
      hunks.push((isAdd ? "+ " : "  ") + currRaw[ci].trimEnd());
      lineCount++;
    }

    // 在此位置之后插入删除行
    if (removes) {
      for (const t of removes) {
        hunks.push("- " + t.trimEnd());
        lineCount++;
      }
    }

    if (lineCount >= maxLines) {
      let rem = 0;
      for (let j = ci + 1; j < currRaw.length; j++) {
        if (addInCurr.has(j)) rem++;
      }
      for (const [aci, ts] of removesAtCurr) {
        if (aci > ci) rem += ts.length;
      }
      if (rem > 0) hunks.push(`... (${rem} more changes)`);
      break;
    }
  }

  return hunks.join("\n");
}

/**
 * 计算语义化 diff（基准快照 vs 当前快照）— 基于节点级结构化对比。
 *
 * 与逐行文本 diff（computeSnapshotDiff）不同，本函数：
 * 1. 以 #hashID 为锚点匹配前后元素（交互节点）
 * 2. 匹配成功的节点只报语义属性变化（val、checked、selected、disabled、文本）
 * 3. 无法匹配的节点报为新增/删除（含标签和文本摘要）
 * 4. 无 hashID 的非交互节点直接忽略（不影响操作）
 *
 * 输出格式示例：
 * ```
 * ~ #abc123 val: "" → "test-instance-prod"
 * ~ #def456 +checked
 * ~ #ghi789 text: "提交" → "已提交"
 * + [dialog] "确认开通" #xyz789
 * - [listbox] #old123
 * ```
 *
 * @param baseSnapshot    微任务开始时拍摄的基准快照
 * @param currentSnapshot 当前全量快照
 * @param maxLines        输出最大行数（默认 30）
 */
export function computeSemanticDiff(
  baseSnapshot: string,
  currentSnapshot: string,
  maxLines = 30,
): string {
  if (!baseSnapshot || !currentSnapshot) return "";

  const baseNodes = _parseSnapshotNodes(baseSnapshot);
  const currNodes = _parseSnapshotNodes(currentSnapshot);

  const baseMap = new Map<string, SnapshotNode>();
  for (const node of baseNodes) baseMap.set(node.hashId, node);

  const currMap = new Map<string, SnapshotNode>();
  for (const node of currNodes) currMap.set(node.hashId, node);

  const changes: string[] = [];

  // 1. 匹配到的节点 — 只报语义变化
  for (const [id, curr] of currMap) {
    const base = baseMap.get(id);
    if (!base) continue; // 新增节点，下面处理

    const diffs = _diffNodeSemantics(base, curr);
    if (diffs.length > 0) {
      changes.push(`~ #${id} ${diffs.join(", ")}`);
    }
  }

  // 2. 新增节点（current 有，base 没有）
  for (const [id, curr] of currMap) {
    if (baseMap.has(id)) continue;
    const text = curr.text ? ` "${curr.text.slice(0, 30)}"` : "";
    changes.push(`+ [${curr.tag}]${text} #${id}`);
  }

  // 3. 删除节点（base 有，current 没有）
  for (const [id, base] of baseMap) {
    if (currMap.has(id)) continue;
    const text = base.text ? ` "${base.text.slice(0, 30)}"` : "";
    changes.push(`- [${base.tag}]${text} #${id}`);
  }

  if (changes.length === 0) return "";

  const truncated = changes.slice(0, maxLines);
  const result = truncated.join("\n");
  if (changes.length > maxLines) {
    return result + `\n... (${changes.length - maxLines} more changes)`;
  }
  return result;
}

/** 快照节点解析结果（仅交互节点，带 #hashID） */
type SnapshotNode = {
  hashId: string;
  tag: string;
  text: string;
  val: string;
  boolAttrs: Set<string>; // checked, selected, disabled, readonly, required, hidden
  ariaExpanded: string;
};

/** 从快照行提取语义字段的正则集合 */
const _NODE_HASH_RE = /#([a-z0-9]{4,})\s*$/i;
const _NODE_TAG_RE = /\[([a-z0-9-]+)\]/i;
const _NODE_TEXT_RE = /\]\s*"([^"]*)"/;
const _NODE_VAL_RE = /\bval="([^"]*)"/;
const _NODE_ARIA_EXPANDED_RE = /\baria-expanded="([^"]*)"/;
const _BOOL_ATTRS = ["checked", "selected", "disabled", "readonly", "required", "hidden"];

/**
 * 从快照文本解析出所有带 hashID 的交互节点。
 * 只提取语义相关字段，忽略 class/listeners/type/placeholder 等。
 */
function _parseSnapshotNodes(snapshot: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  for (const line of snapshot.split("\n")) {
    const hashMatch = _NODE_HASH_RE.exec(line);
    if (!hashMatch) continue; // 无 hashID → 非交互节点，跳过

    const tagMatch = _NODE_TAG_RE.exec(line);
    const textMatch = _NODE_TEXT_RE.exec(line);
    const valMatch = _NODE_VAL_RE.exec(line);
    const ariaMatch = _NODE_ARIA_EXPANDED_RE.exec(line);

    const boolAttrs = new Set<string>();
    for (const attr of _BOOL_ATTRS) {
      // 匹配独立单词（避免 "unchecked" 误匹配 "checked"）
      if (new RegExp(`\\b${attr}\\b`).test(line)) {
        boolAttrs.add(attr);
      }
    }

    nodes.push({
      hashId: hashMatch[1],
      tag: tagMatch?.[1] ?? "?",
      text: textMatch?.[1] ?? "",
      val: valMatch?.[1] ?? "",
      boolAttrs,
      ariaExpanded: ariaMatch?.[1] ?? "",
    });
  }
  return nodes;
}

/**
 * 对比两个同 hashID 节点的语义差异。
 * 只关注值、文本、布尔状态的变化，输出简短描述数组。
 */
function _diffNodeSemantics(base: SnapshotNode, curr: SnapshotNode): string[] {
  const diffs: string[] = [];

  // val 变化
  if (base.val !== curr.val) {
    diffs.push(`val: "${base.val}" → "${curr.val}"`);
  }

  // 文本变化
  if (base.text !== curr.text) {
    diffs.push(`text: "${base.text.slice(0, 25)}" → "${curr.text.slice(0, 25)}"`);
  }

  // 布尔属性变化
  for (const attr of _BOOL_ATTRS) {
    const had = base.boolAttrs.has(attr);
    const has = curr.boolAttrs.has(attr);
    if (had && !has) diffs.push(`-${attr}`);
    if (!had && has) diffs.push(`+${attr}`);
  }

  // aria-expanded 变化（下拉展开/收起）
  if (base.ariaExpanded !== curr.ariaExpanded && curr.ariaExpanded) {
    diffs.push(`aria-expanded: ${base.ariaExpanded || "unset"} → ${curr.ariaExpanded}`);
  }

  return diffs;
}

/**
 * 从快照文本中查找指定 selector 附近的可点击元素。
 *
 * 当点击某个元素无效果时，框架需要推荐具体的替代目标而非泛泛的建议。
 * 此函数在快照中定位目标 selector 所在行，然后在上下 windowSize 行内
 * 扫描带有点击信号的元素，返回按距离排序的推荐列表。
 *
 * 点击信号判定：
 * - listeners 属性含 clk / pdn / mdn
 * - 有 onclick 属性
 * - 标签为 [a] 或 [button]
 * - role="button" 或 role="link"
 *
 * 返回：描述字符串数组（`#hashID ([tag] "text" listeners="...")`），最多 5 个。
 *
 * 用途：
 * - `INEFFECTIVE_CLICK_BLOCKED` 拦截消息中附带推荐
 * - "Snapshot unchanged" 提示中附带推荐
 * - 交替循环检测提示中附带推荐
 *
 * @example
 * ```ts
 * // 假设快照片段：
 * //  [tr] listeners="clk" #14d1zek
 * //    [td]
 * //      [span] "forkCte" listeners="blr,fcs" #fkbidm
 * //    [td]
 * //      [a] "admin/forkCte" href="/repo/1" listeners="clk" #c3hyqd
 *
 * findNearbyClickTargets(snapshot, "#fkbidm")
 * // → [
 * //   '#c3hyqd ([a] "admin/forkCte" listeners="clk")',   // 距离近
 * //   '#14d1zek ([tr] "" listeners="clk")',                // 距离稍远
 * // ]
 *
 * findNearbyClickTargets(snapshot, "#fkbidm", new Set(["#14d1zek"]))
 * // → ['#c3hyqd ([a] "admin/forkCte" listeners="clk")']  // 排除 #14d1zek
 * ```
 */
export function findNearbyClickTargets(
  snapshot: string,
  selector: string,
  excludeSelectors?: Set<string>,
  windowSize = 15,
): string[] {
  if (!snapshot || !selector) return [];

  const lines = snapshot.split("\n");
  const selectorRef = selector.startsWith("#") ? selector : `#${selector}`;

  // 定位 selector 所在行
  let targetLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(selectorRef)) {
      targetLineIdx = i;
      break;
    }
  }
  if (targetLineIdx === -1) return [];

  const start = Math.max(0, targetLineIdx - windowSize);
  const end = Math.min(lines.length - 1, targetLineIdx + windowSize);

  // 点击信号正则：listeners 中含 clk/pdn/mdn、onclick、[a]/[button] 标签、role=button/link
  const CLICK_SIGNAL_RE =
    /(?:listeners="[^"]*\b(?:clk|pdn|mdn)\b[^"]*")|(?:\bonclick\b)|(?:\[a\])|(?:\[button\])|(?:role="(?:button|link)")/i;
  const HASH_RE = /#([a-z0-9]{4,})\b/gi;
  const TAG_RE = /\[([a-z0-9-]+)\]/i;
  const TEXT_RE = /"([^"]{1,40})"/;

  const candidates: Array<{ ref: string; distance: number; brief: string }> = [];

  for (let i = start; i <= end; i++) {
    if (i === targetLineIdx) continue;
    const line = lines[i];
    if (!CLICK_SIGNAL_RE.test(line)) continue;

    HASH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HASH_RE.exec(line)) !== null) {
      const ref = `#${match[1]}`;
      if (ref === selectorRef) continue;
      if (excludeSelectors?.has(ref)) continue;

      const tag = TAG_RE.exec(line)?.[1] ?? "?";
      const text = TEXT_RE.exec(line)?.[1] ?? "";
      const listenerMatch = line.match(/listeners="([^"]*)"/);
      const listeners = listenerMatch?.[1] ?? "";

      const brief = text
        ? `[${tag}] "${text}" listeners="${listeners}"`
        : `[${tag}] listeners="${listeners}"`;

      candidates.push({ ref, distance: Math.abs(i - targetLineIdx), brief });
    }
  }

  // 按距离去重排序
  candidates.sort((a, b) => a.distance - b.distance);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of candidates) {
    if (seen.has(c.ref)) continue;
    seen.add(c.ref);
    result.push(`${c.ref} (${c.brief})`);
    if (result.length >= 5) break;
  }

  return result;
}

/**
 * 构建任务数组。
 *
 * 作用：把一轮工具调用规整成稳定字符串数组，
 * 用于“上一轮任务回显”和“重复批次检测”。 *
 * @example
 * ```ts
 * buildTaskArray([
 *   { name: "dom", input: { action: "click", selector: "#a1b2c" } },
 *   { name: "dom", input: { action: "fill", selector: "#x9k3d", value: "hello" } },
 * ])
 * // → [
 * //   'dom:{"action":"click","selector":"#a1b2c"}',
 * //   'dom:{"action":"fill","selector":"#x9k3d","value":"hello"}',
 * // ]
 * ``` */
export function buildTaskArray(toolCalls: Array<{ name: string; input: unknown }>): string[] {
  return toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input)}`);
}

/**
 * 过滤模型输出中的思考/推理部分，只保留面向用户的内容。
 *
 * 策略：
 * 1. 如果包含 REMAINING 协议行，只保留最后一个 REMAINING 行及其后续摘要
 * 2. 如果包含 **Summary** 或 “REMAINING: DONE” 后的摘要，保留摘要部分
 * 3. 否则返回空字符串（纯思考内容不展示）
 *
 * @example
 * ```ts
 * stripThinking(“Looking at the snapshot...\n\nREMAINING: DONE\n\n**Summary:** All done.”)
 * // → “REMAINING: DONE\n\n**Summary:** All done.”
 *
 * stripThinking(“Let me analyze...\nI need to click #x...”)
 * // → ""
 * ``` */
export function stripThinking(text: string | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";

  // 找最后一个 REMAINING: 行的位置
  const lines = trimmed.split("\n");
  let remainingLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/REMAINING\s*:/i.test(lines[i])) {
      remainingLineIdx = i;
      break;
    }
  }

  // 有 REMAINING 协议：保留 REMAINING 行及之后的内容（通常含摘要）
  if (remainingLineIdx >= 0) {
    return lines.slice(remainingLineIdx).join("\n").trim();
  }

  // 无 REMAINING：返回空（纯思考内容）
  return "";
}

/**
 * 规范化模型输出。
 *
 * 优先保留 REMAINING；否则保留首段摘要，避免长文本污染上下文。
 *
 * 返回字符串会被注入下一轮消息，作为”上一轮模型输出摘要”。 *
 * @example
 * ```ts
 * normalizeModelOutput("操作完成\nREMAINING: 填写表单")
 * // → "REMAINING: 填写表单"
 *
 * normalizeModelOutput("已点击按钮，等待页面跳转...")
 * // → "已点击按钮，等待页面跳转..."（首段摘要，最多 220 字符）
 *
 * normalizeModelOutput(undefined)  // → ""
 * ``` */
export function normalizeModelOutput(text: string | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  const remainingMatch = trimmed.match(/REMAINING\s*:\s*([\s\S]*)$/i);
  if (remainingMatch) return `REMAINING: ${remainingMatch[1].trim()}`;
  const firstBlock = trimmed.split(/\n\s*\n/)[0]?.trim() ?? trimmed;
  return firstBlock.slice(0, 220);
}

/**
 * 解析 REMAINING。
 *
 * 返回值：
 * - `""` 表示 DONE
 * - 非空字符串表示新的 remaining
 * - `null` 表示协议缺失
 *
 * 注意：这里只负责解析，不负责 fallback 策略。
 *
 * 解析策略：
 * - 匹配最后一个 `REMAINING:` 后到行尾的内容（单行匹配，不跨行）
 * - `REMAINING: DONE` → 返回 `""`（任务完成）
 * - `REMAINING: <text>` → 返回 `<text>`
 * - DONE 后面尾随的摘要文本会被忽略（模型常在 DONE 后附加总结）
 *
 * @example
 * ```ts
 * parseRemainingInstruction("REMAINING: 填写表单并提交")
 * // → "填写表单并提交"
 *
 * parseRemainingInstruction("REMAINING: DONE")
 * // → ""（任务完成）
 *
 * parseRemainingInstruction("REMAINING: DONE - 已完成所有操作")
 * // → ""（DONE 后的摘要被忽略）
 *
 * parseRemainingInstruction("我已经点击了按钮")
 * // → null（无 REMAINING 协议）
 * ```
 */
export function parseRemainingInstruction(text: string | undefined): string | null {
  if (!text) return null;
  // 按行从后往前找最后一个 REMAINING: 行（模型可能在 DONE 后输出总结文本）
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineMatch = lines[i].match(/REMAINING\s*:\s*(.*)$/i);
    if (lineMatch) {
      const value = lineMatch[1].trim();
      // 兼容 `REMAINING: DONE - xxx` / `REMAINING: DONE: xxx` 等写法
      if (/^done(?:\s*(?:[-—:：]|\b).*)?$/i.test(value)) return "";
      return value;
    }
  }
  return null;
}

/**
 * 推导下一轮 remaining。
 *
 * 策略：
 * - 有 REMAINING 协议 -> 使用模型给出的 nextInstruction
 * - 无协议 -> 保持 currentInstruction 不变（由上层决定是否启发式推进）
 *
 * @example
 * ```ts
 * deriveNextInstruction("REMAINING: 提交表单", "填写表单并提交")
 * // → { nextInstruction: "提交表单", hasRemainingProtocol: true }
 *
 * deriveNextInstruction("REMAINING: DONE", "提交表单")
 * // → { nextInstruction: "", hasRemainingProtocol: true }
 *
 * deriveNextInstruction("已点击按钮", "填写表单并提交")
 * // → { nextInstruction: "填写表单并提交", hasRemainingProtocol: false }
 * ```
 */
export function deriveNextInstruction(
  text: string | undefined,
  currentInstruction: string,
): { nextInstruction: string; hasRemainingProtocol: boolean } {
  const parsed = parseRemainingInstruction(text);
  if (parsed !== null) {
    return { nextInstruction: parsed, hasRemainingProtocol: true };
  }
  return { nextInstruction: currentInstruction, hasRemainingProtocol: false };
}

/**
 * 启发式剔除 remaining。
 *
 * 用于协议缺失但本轮有执行动作时，按线性步骤剔除已执行数量。
 *
 * 这是“保守推进”策略，不保证语义完美，但能避免 remaining 长期不变。 *
 * @example
 * ```ts
 * reduceRemainingHeuristically("点击按钮 然后 填写表单 然后 提交", 1)
 * // → "填写表单 -> 提交"（剔除第 1 步）
 *
 * reduceRemainingHeuristically("点击按钮 然后 填写表单 然后 提交", 2)
 * // → "提交"（剔除前 2 步）
 *
 * reduceRemainingHeuristically("点击按钮 然后 填写表单 然后 提交", 5)
 * // → ""（所有步骤已完成）
 *
 * reduceRemainingHeuristically("完成任务", 1)
 * // → "完成任务"（无法拆分，原样返回）
 * ```
 */
export function reduceRemainingHeuristically(
  currentInstruction: string,
  executedCount: number,
): string {
  if (!currentInstruction.trim() || executedCount <= 0) return currentInstruction;

  const normalized = currentInstruction
    .replace(/\s+/g, " ")
    .replace(/(->|=>|→)/g, " 然后 ");

  const parts = normalized
    .split(/\s*(?:然后|再|并且|并|接着|随后|之后)\s*/g)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return currentInstruction;

  const nextParts = parts.slice(Math.min(executedCount, parts.length));
  if (nextParts.length === 0) return "";
  return nextParts.join(" -> ");
}

// ─── 结构化任务拆分与追踪 ───

/** 多步任务拆分正则（复用 reduceRemainingHeuristically 的分隔符） */
const TASK_SPLIT_RE = /\s*(?:然后|再|并且|并|接着|随后|之后)\s*/g;

/**
 * 标准化分隔符（箭头统一为"然后"），然后按显式步骤词拆分。
 *
 * 注意：不再将中文标点（逗号、句号、分号）替换为"然后"。
 * 中文逗号绝大多数是句内停顿（"创建一个实例，选择华东零售"），
 * 不是步骤分隔。用户真正需要多步时会用显式词（然后/再/接着）。
 */
function _normAndSplit(text: string): string[] {
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/(->|=>|→)/g, " 然后 ");
  return normalized.split(TASK_SPLIT_RE).map(s => s.trim()).filter(Boolean);
}

/**
 * 将用户输入拆分为结构化任务列表。
 *
 * 仅当文本包含步骤分隔符（然后/再/接着/箭头等）且可拆出 **≥ 2 步** 时才返回 TaskItem 数组。
 * checklist 的作用是让 AI 看到完整的任务全貌，AI 根据当前页面状态判断哪些任务可以完成。
 * 任务完成由 AI 通过 REMAINING 协议驱动 — AI 看页面，能做就做，做完就消费。
 *
 * @example
 * ```ts
 * splitUserGoalIntoTasks("主题色选红色，然后关闭开关，然后满意度五星")
 * // → [{ text: "主题色选红色", done: false }, { text: "关闭开关", done: false }, { text: "满意度五星", done: false }]
 *
 * splitUserGoalIntoTasks("创建一个实例，然后要选择华东零售")
 * // → [{ text: "创建一个实例", done: false }, { text: "要选择华东零售", done: false }]
 *
 * splitUserGoalIntoTasks("提交表单")
 * // → null（单步，不拆分）
 * ```
 */
export function splitUserGoalIntoTasks(userMessage: string): TaskItem[] | null {
  const parts = _normAndSplit(userMessage);
  if (parts.length < 2) return null;
  return parts.map(text => ({ text, done: false }));
}

/**
 * 根据当前 remaining 字符串更新任务完成状态。
 *
 * 策略（AI 驱动的任务消费）：
 * 1. remaining 为空或 "DONE" 时，全部标记完成。
 * 2. 否则，检查每个任务的关键词是否仍在 remaining 中：
 *    - 关键词全部不在 remaining → 标记 done（AI 已消费该任务）
 *    - 关键词仍在 remaining → 保持未完成
 *
 * 不使用严格顺序 — AI 根据当前页面状态决定哪些任务可以完成。
 * 例如 "创建实例，然后选择华东零售"，如果页面上已经可以选择华东零售，
 * AI 就选它并通过 REMAINING 协议消费掉，不需要等"创建"先完成。
 *
 * 返回更新后的 TaskItem 数组（不修改原数组）。
 */
export function updateTaskCompletion(tasks: TaskItem[], remaining: string): TaskItem[] {
  const trimmed = remaining.trim();
  if (!trimmed || /^done$/i.test(trimmed)) {
    return tasks.map(t => ({ ...t, done: true }));
  }

  const lowerRemaining = trimmed.toLowerCase();
  const result: TaskItem[] = [];

  for (const t of tasks) {
    if (t.done) {
      result.push(t);
      continue;
    }
    // 提取 task 中 ≥ 2 字的中文词或 ≥ 3 字的英文词作为关键词
    const keywords = t.text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/g);
    if (!keywords || keywords.length === 0) {
      result.push(t);
      continue;
    }
    // 所有关键词都不在 remaining 中 → AI 已消费该任务
    const allAbsent = keywords.every(kw => !lowerRemaining.includes(kw.toLowerCase()));
    if (allAbsent) {
      result.push({ ...t, done: true });
    } else {
      result.push(t);
    }
  }
  return result;
}

/**
 * 将 TaskItem 数组格式化为 checklist 字符串。
 *
 * 用于注入到用户消息中，让模型清楚看到每一步的完成状态。
 *
 * @example
 * ```ts
 * formatTaskChecklist([
 *   { text: "主题色选红色", done: true },
 *   { text: "关闭开关", done: false },
 *   { text: "满意度五星", done: false },
 * ])
 * // → "✅ 1. 主题色选红色\n□ 2. 关闭开关  ← current\n□ 3. 满意度五星"
 * ```
 */
export function formatTaskChecklist(tasks: TaskItem[]): string {
  let firstPending = true;
  return tasks.map((t, i) => {
    const num = i + 1;
    if (t.done) return `✅ ${num}. ${t.text}`;
    const marker = firstPending ? "  ← current" : "";
    firstPending = false;
    return `□ ${num}. ${t.text}${marker}`;
  }).join("\n");
}

/**
 * 从 TaskItem 数组生成当前 remaining 文本（所有未完成任务拼接）。
 *
 * 用于同步 remainingInstruction，保持与 checklist 一致。
 */
export function deriveRemainingFromTasks(tasks: TaskItem[]): string {
  const pending = tasks.filter(t => !t.done).map(t => t.text);
  if (pending.length === 0) return "";
  return pending.join(" -> ");
}

/**
 * 判定是否强制断轮。
 *
 * 语义：潜在 DOM 结构变化动作后，等待下一轮新快照。
 *
 * 当前规则：
 * - `navigate.*` 一律断轮
 * - `dom.click` 断轮
 * - `dom.press` 仅 Enter 断轮
 * - `evaluate` 断轮
 * - 其他动作默认不断轮
 *
 * @example
 * ```ts
 * shouldForceRoundBreak("dom", { action: "click", selector: "#btn" })  // → true
 * shouldForceRoundBreak("dom", { action: "fill", selector: "#in" })    // → false
 * shouldForceRoundBreak("dom", { action: "press", key: "Enter" })      // → true
 * shouldForceRoundBreak("dom", { action: "press", key: "Tab" })        // → false
 * shouldForceRoundBreak("navigate", { action: "back" })                // → true
 * shouldForceRoundBreak("evaluate", { expression: "alert(1)" })        // → true
 * ```
 */
export function shouldForceRoundBreak(toolName: string, toolInput: unknown): boolean {
  const action = getToolAction(toolInput);

  if (toolName === "navigate") {
    return action === "goto" || action === "back" || action === "forward" || action === "reload";
  }

  if (toolName === "dom") {
    if (action === "click") return true;
    if (action === "press") {
      const key = typeof toolInput === "object" && toolInput !== null
        ? String((toolInput as { key?: unknown; value?: unknown }).key ?? (toolInput as { value?: unknown }).value ?? "")
        : "";
      return key === "Enter";
    }
    return false;
  }

  return toolName === "evaluate";
}

/**
 * 判定动作是否可能引发页面结构或状态变化（宽泛判定）。
 *
 * 用于"轮次后稳定等待"触发条件：
 * - 命中 true：本轮结束后执行加载态 + DOM 静默双重等待
 * - 命中 false：跳过等待，直接进入下一轮
 *
 * @example
 * ```ts
 * isPotentialDomMutation("dom", { action: "click" })    // → true
 * isPotentialDomMutation("dom", { action: "fill" })     // → true
 * isPotentialDomMutation("dom", { action: "get_text" }) // → false（只读）
 * isPotentialDomMutation("navigate", { action: "back" }) // → true
 * isPotentialDomMutation("page_info", { action: "snapshot" }) // → false
 * ```
 */
export function isPotentialDomMutation(toolName: string, toolInput: unknown): boolean {
  const action = getToolAction(toolInput);

  if (toolName === "navigate") return true;
  if (toolName === "evaluate") return true;
  if (toolName !== "dom") return false;

  if (!action) return false;
  return [
    "click",
    "fill",
    "select_option",
    "clear",
    "check",
    "uncheck",
    "type",
    "focus",
    "hover",
    "scroll",
    "press",
    "set_attr",
    "add_class",
    "remove_class",
  ].includes(action);
}

/**
 * 判定动作是否为"确定性推进"——比 isPotentialDomMutation 更窄。
 *
 * 包含以下必定产生可见状态变化或属于显式用户意图的动作：
 * - 表单输入类：fill / type / select_option / clear / check / uncheck
 * - 键盘动作类：press（Enter 提交、Tab 切焦等均属用户显式操作）
 * - 导航类：navigate.*
 * - 自定义工具：非 SDK 内置工具（dom/navigate/page_info/wait/evaluate）
 *   均由开发者注册、模型有意调用，视为确定性推进
 *
 * click 不在此列——因为 click 可能点了但完全没效果（如点击无 click listener 的元素）。
 *
 * 用途：协议缺失计数重置与豁免。仅当本轮有"确定性推进"时才重置协议缺失计数器，
 * 避免模型反复点击无效目标导致死循环。
 *
 * @example
 * ```ts
 * isConfirmedProgressAction("dom", { action: "fill" })           // → true
 * isConfirmedProgressAction("dom", { action: "type" })           // → true
 * isConfirmedProgressAction("dom", { action: "select_option" })  // → true
 * isConfirmedProgressAction("dom", { action: "press" })          // → true
 * isConfirmedProgressAction("dom", { action: "click" })          // → false（不确定是否有效）
 * isConfirmedProgressAction("navigate", { action: "back" })       // → true
 * isConfirmedProgressAction("my_custom_tool", { query: "..." })  // → true（自定义工具）
 * isConfirmedProgressAction("page_info", { action: "snapshot" }) // → false（只读）
 * ```
 */
export function isConfirmedProgressAction(toolName: string, toolInput: unknown): boolean {
  if (toolName === "navigate") return true;

  // 自定义工具（非 SDK 内置）——开发者注册的领域工具，视为确定性推进
  const sdkBuiltinTools = ["dom", "navigate", "page_info", "wait", "evaluate"];
  if (!sdkBuiltinTools.includes(toolName)) return true;

  if (toolName !== "dom") return false;

  const action = getToolAction(toolInput);
  if (!action) return false;
  return [
    "fill",
    "type",
    "select_option",
    "clear",
    "check",
    "uncheck",
    "press",
  ].includes(action);
}

/**
 * 采集找不到元素任务。
 *
 * 返回 null 表示当前结果不属于“元素未找到”，
 * 返回对象表示可进入 not-found retry 对话流。 *
 * @example
 * ```ts
 * collectMissingTask("dom", { action: "click", selector: "#xyz" }, {
 *   content: "未找到 #xyz 对应的元素",
 *   details: { error: true, code: "ELEMENT_NOT_FOUND" },
 * })
 * // → { name: "dom", input: {...}, reason: "未找到 #xyz 对应的元素" }
 *
 * collectMissingTask("dom", { action: "click", selector: "#btn" }, {
 *   content: "已点击按钮",
 * })
 * // → null（操作成功，非元素未找到）
 * ``` */
export function collectMissingTask(
  name: string,
  input: unknown,
  result: ToolCallResult,
): { name: string; input: unknown; reason: string } | null {
  if (!isElementNotFoundResult(result)) return null;
  return {
    name,
    input,
    reason: toContentString(result.content).slice(0, 240),
  };
}

/**
 * 元素不存在判定。
 *
 * 判定顺序：
 * 1) 优先看结构化错误码 `ELEMENT_NOT_FOUND`
 * 2) 回退看中文错误文本关键词（兼容历史结果格式）
 *
 * @example
 * ```ts
 * isElementNotFoundResult({ content: "...", details: { code: "ELEMENT_NOT_FOUND" } })
 * // → true（结构化错误码命中）
 *
 * isElementNotFoundResult({ content: "未找到 #abc 对应的元素" })
 * // → true（中文关键词回退命中）
 *
 * isElementNotFoundResult({ content: "已点击按钮" })
 * // → false
 * ```
 */
export function isElementNotFoundResult(result: ToolCallResult): boolean {
  const details = result.details;
  if (details && typeof details === "object") {
    const code = (details as { code?: unknown }).code;
    if (code === "ELEMENT_NOT_FOUND") return true;
  }

  const content = toContentString(result.content);
  return content.includes("未找到") && content.includes("元素");
}

/**
 * 生成稳定调用键。
 *
 * 用于 recoveryAttempts 的 map key（同名 + 同参数视为同一调用）。
 *
 * @example
 * ```ts
 * buildToolCallKey("dom", { action: "click", selector: "#a1b2c" })
 * // → 'dom:{"action":"click","selector":"#a1b2c"}'
 * ```
 */
export function buildToolCallKey(name: string, input: unknown): string {
  return `${name}:${JSON.stringify(input)}`;
}

/**
 * 解析恢复等待时长。
 * 优先级：waitMs > waitSeconds > 默认值（100ms）。
 *
 * 统一返回毫秒整数，且最小为 0。
 *
 * @example
 * ```ts
 * resolveRecoveryWaitMs({ waitMs: 500 })      // → 500
 * resolveRecoveryWaitMs({ waitSeconds: 2 })    // → 2000
 * resolveRecoveryWaitMs({})                     // → 100（DEFAULT_RECOVERY_WAIT_MS）
 * resolveRecoveryWaitMs(null)                   // → 100
 * ```
 */
export function resolveRecoveryWaitMs(input: unknown): number {
  if (!input || typeof input !== "object") return DEFAULT_RECOVERY_WAIT_MS;

  const params = input as Record<string, unknown>;
  const waitMs = params.waitMs;
  if (typeof waitMs === "number" && Number.isFinite(waitMs)) {
    return Math.max(0, Math.floor(waitMs));
  }

  const waitSeconds = params.waitSeconds;
  if (typeof waitSeconds === "number" && Number.isFinite(waitSeconds)) {
    return Math.max(0, Math.floor(waitSeconds * 1000));
  }

  return DEFAULT_RECOVERY_WAIT_MS;
}

/**
 * 读取工具 action。
 *
 * 仅在 input 是对象且 action 为字符串时返回值，否则返回 undefined。
 *
 * @example
 * ```ts
 * getToolAction({ action: "click", selector: "#btn" }) // → "click"
 * getToolAction({ selector: "#btn" })                   // → undefined（无 action）
 * getToolAction(null)                                    // → undefined
 * ```
 */
export function getToolAction(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === "string" ? action : undefined;
}

/**
 * 判定错误标记。
 *
 * 约定：`result.details.error === true` 视为错误结果。
 *
 * @example
 * ```ts
 * hasToolError({ content: "...", details: { error: true, code: "ELEMENT_NOT_FOUND" } })
 * // → true
 *
 * hasToolError({ content: "已点击按钮" })
 * // → false（无 details 或 error 不为 true）
 * ```
 */
export function hasToolError(result: ToolCallResult): boolean {
  return result.details && typeof result.details === "object"
    ? Boolean((result.details as { error?: unknown }).error)
    : false;
}
