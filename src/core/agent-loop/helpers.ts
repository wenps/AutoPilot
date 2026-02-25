/**
 * Agent Loop 辅助函数集合。
 *
 * 该文件只放“纯辅助逻辑”：格式化、判定、上下文读取、等待等，
 * 让 `agent-loop.ts` 专注于流程编排。
 */
import type { ToolCallResult } from "../tool-registry.js";
import { ToolRegistry } from "../tool-registry.js";
import {
  DEFAULT_RECOVERY_WAIT_MS,
} from "./constants.js";

/** 单次工具执行轨迹条目（用于恢复提示和调试展示）。 */
export type ToolTraceEntry = {
  round: number;
  name: string;
  input: unknown;
  result: ToolCallResult;
  marker?: string;
};

/** 异步睡眠，确保恢复重试按顺序串行执行。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将工具返回内容统一转为字符串，便于拼接进消息。 */
export function toContentString(content: ToolCallResult["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

/** 判定工具失败是否属于“元素不存在”，用于触发快照恢复。 */
export function isElementNotFoundResult(result: ToolCallResult): boolean {
  const details = result.details;
  if (details && typeof details === "object") {
    const code = (details as { code?: unknown }).code;
    if (code === "ELEMENT_NOT_FOUND") return true;
  }

  const content = toContentString(result.content);
  return content.includes("未找到") && content.includes("元素");
}

/** 为同一动作构造稳定 key，用于统计恢复重试次数。 */
export function buildToolCallKey(name: string, input: unknown): string {
  return `${name}:${JSON.stringify(input)}`;
}

/**
 * 解析恢复等待时长：
 * - 优先 `waitMs`
 * - 其次 `waitSeconds`
 * - 最后回退默认值
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

/** 将工具输入压缩成简短文本，用于轨迹展示。 */
function formatToolInputBrief(input: unknown): string {
  if (!input || typeof input !== "object") return "";

  const params = input as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ["action", "selector", "waitMs", "waitSeconds", "url", "text"]) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      parts.push(`${key}=${JSON.stringify(value).slice(0, 80)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    }
  }

  if (parts.length === 0) return "";
  return ` (${parts.join(", ")})`;
}

/**
 * 将完整轨迹格式化为可读文本。
 * 支持附加“当前步骤”用于在恢复提示中高亮失败动作。
 */
export function buildToolTrace(
  trace: ToolTraceEntry[],
  current?: {
    round: number;
    name: string;
    input: unknown;
    result?: ToolCallResult;
    marker?: string;
  },
): string {
  const lines = trace.map((entry, index) => {
    const code =
      entry.result.details && typeof entry.result.details === "object"
        ? (entry.result.details as { code?: unknown }).code
        : undefined;
    const codeText = typeof code === "string" ? ` [${code}]` : "";
    const marker = entry.marker ? ` ${entry.marker}` : "";
    return `${index + 1}. [round ${entry.round}] ${entry.name}${formatToolInputBrief(entry.input)}${codeText}${marker}`;
  });

  if (current) {
    const code =
      current.result?.details && typeof current.result.details === "object"
        ? (current.result.details as { code?: unknown }).code
        : undefined;
    const codeText = typeof code === "string" ? ` [${code}]` : "";
    const marker = current.marker ? ` ${current.marker}` : "";
    lines.push(
      `${lines.length + 1}. [round ${current.round}] ${current.name}${formatToolInputBrief(current.input)}${codeText}${marker}`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : "(暂无工具执行记录)";
}

/** 从工具参数中读取 action。 */
export function getToolAction(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const action = (input as Record<string, unknown>).action;
  return typeof action === "string" ? action : undefined;
}

/** 判定工具结果是否标记 error。 */
export function hasToolError(result: ToolCallResult): boolean {
  return result.details && typeof result.details === "object"
    ? Boolean((result.details as { error?: unknown }).error)
    : false;
}

/** 读取当前页面 URL（通过 page_info 工具）。 */
export async function readPageUrl(
  registry: ToolRegistry,
): Promise<string | undefined> {
  const result = await registry.dispatch("page_info", { action: "get_url" });
  return typeof result.content === "string" ? result.content : undefined;
}

/** 读取当前页面快照（通过 page_info 工具）。 */
export async function readPageSnapshot(
  registry: ToolRegistry,
  maxDepth = 8,
): Promise<string> {
  const result = await registry.dispatch("page_info", {
    action: "snapshot",
    maxDepth,
  });
  return toContentString(result.content);
}
