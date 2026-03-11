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
import type { ToolCallResult } from "../tool-registry.js";
import { DEFAULT_RECOVERY_WAIT_MS } from "./constants.js";

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
  // 剥离 hash ID（如 #1kry9hw、#az8y2x），保留结构和文本内容
  const normalized = snapshot.replace(/#[a-z0-9]{4,}/gi, "#_");
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
 * 规范化模型输出。
 *
 * 优先保留 REMAINING；否则保留首段摘要，避免长文本污染上下文。
 *
 * 返回字符串会被注入下一轮消息，作为“上一轮模型输出摘要”。 *
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
 * ``` */
export function reduceRemainingHeuristically(
  currentInstruction: string,
  executedCount: number,
): string {
  if (!currentInstruction.trim() || executedCount <= 0) return currentInstruction;

  const normalized = currentInstruction
    .replace(/\s+/g, " ")
    .replace(/(->|=>|→)/g, " 然后 ")
    .replace(/[，,。；;]/g, " 然后 ");

  const parts = normalized
    .split(/\s*(?:然后|再|并且|并|接着|随后|之后)\s*/g)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return currentInstruction;

  const nextParts = parts.slice(Math.min(executedCount, parts.length));
  if (nextParts.length === 0) return "";
  return nextParts.join(" -> ");
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
 * shouldForceRoundBreak("navigate", { action: "goto", url: "/home" })  // → true
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
 * isPotentialDomMutation("navigate", { action: "goto" }) // → true
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
 * isConfirmedProgressAction("navigate", { action: "goto" })      // → true
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
