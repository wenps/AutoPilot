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
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统一内容为字符串。
 *
 * 工具返回 content 可能是 string 或 object；这里统一转成 string，
 * 便于日志、错误判定、摘要拼接。
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
 * 如果是复杂 CSS（如 `.x #id`）会返回 null，避免误判。
 */
export function extractHashSelectorRef(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const selector = (toolInput as { selector?: unknown }).selector;
  if (typeof selector !== "string") return null;
  const m = selector.trim().match(/^#([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

/**
 * 构建任务数组。
 *
 * 作用：把一轮工具调用规整成稳定字符串数组，
 * 用于“上一轮任务回显”和“重复批次检测”。
 */
export function buildTaskArray(toolCalls: Array<{ name: string; input: unknown }>): string[] {
  return toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input)}`);
}

/**
 * 规范化模型输出。
 *
 * 优先保留 REMAINING；否则保留首段摘要，避免长文本污染上下文。
 *
 * 返回字符串会被注入下一轮消息，作为“上一轮模型输出摘要”。
 */
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
 * 这是“保守推进”策略，不保证语义完美，但能避免 remaining 长期不变。
 */
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
 * - `dom.press` 仅 Enter 断轮
 * - `evaluate` 断轮
 * - 其他动作默认不断轮
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
 * 判定动作是否可能引发页面结构或状态变化。
 *
 * 用于“轮次后稳定等待”触发条件：
 * - 命中 true：本轮结束后执行加载态 + DOM 静默双重等待
 * - 命中 false：跳过等待，直接进入下一轮
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
 * 采集找不到元素任务。
 *
 * 返回 null 表示当前结果不属于“元素未找到”，
 * 返回对象表示可进入 not-found retry 对话流。
 */
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
 */
export function buildToolCallKey(name: string, input: unknown): string {
  return `${name}:${JSON.stringify(input)}`;
}

/**
 * 解析恢复等待时长。
 * 优先级：waitMs > waitSeconds > 默认值。
 *
 * 统一返回毫秒整数，且最小为 0。
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
 */
export function hasToolError(result: ToolCallResult): boolean {
  return result.details && typeof result.details === "object"
    ? Boolean((result.details as { error?: unknown }).error)
    : false;
}
