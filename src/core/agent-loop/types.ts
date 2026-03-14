/**
 * Agent Loop 共享类型定义。
 *
 * 被 index.ts、helpers.ts、messages.ts、recovery.ts、snapshot.ts 共用。
 * 集中在这里避免循环依赖。
 */
import type { AIMessage } from "../types.js";
import type { ToolCallResult } from "../tool-registry.js";
import type { AssertionConfig, AssertionResult } from "./assertion/types.js";

/**
 * 停机原因枚举 — 标识 Agent Loop 因何原因结束。
 *
 * - `converged`：任务完成（REMAINING: DONE 或 remaining 收敛为空）
 * - `assertion_passed`：所有任务断言均通过（AI 驱动的任务完成验证）
 * - `assertion_loop`：连续断言失败且执行 AI 仅调 assert 无其他动作（断言死循环）
 * - `repeated_batch`：连续相同工具调用批次 ≥ 3 轮（防自转）
 * - `idle_loop`：连续只读轮次触发空转检测
 * - `no_protocol`：连续多轮有工具调用但无 REMAINING 协议且无有效推进
 * - `protocol_fix_failed`：协议修复轮失败（无工具调用 + remaining 未收敛）
 * - `stale_remaining`：remaining 连续多轮不推进且无确认性进展（滞止收敛）
 * - `max_rounds`：达到最大轮次上限
 * - `dry_run`：dry-run 模式，仅展示不执行
 */
export type StopReason =
  | "converged"
  | "assertion_passed"
  | "assertion_loop"
  | "repeated_batch"
  | "idle_loop"
  | "no_protocol"
  | "protocol_fix_failed"
  | "stale_remaining"
  | "max_rounds"
  | "dry_run";

/** 结构化任务项（多步任务拆分后的单步） */
export type TaskItem = {
  /** 任务描述文本 */
  text: string;
  /** 是否已完成 */
  done: boolean;
};

/** 轮次后稳定等待配置（加载态 + DOM 静默） */
export type RoundStabilityWaitOptions = {
  /** 是否启用轮次后稳定等待（默认 true） */
  enabled?: boolean;
  /** 双重等待总超时（毫秒，默认 4000） */
  timeoutMs?: number;
  /** DOM 静默窗口（毫秒，默认 200） */
  quietMs?: number;
  /** 页面加载态选择器列表（会与默认列表合并去重，不会覆盖默认值） */
  loadingSelectors?: string[];
};

export type AgentLoopMetrics = {
  roundCount: number;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolSuccessRate: number;
  recoveryCount: number;
  redundantInterceptCount: number;
  snapshotReadCount: number;
  latestSnapshotSize: number;
  avgSnapshotSize: number;
  maxSnapshotSize: number;
  inputTokens: number;
  outputTokens: number;
  /** 停机原因（标识 Agent Loop 因何原因结束） */
  stopReason: StopReason;
};

// ─── 回调接口 ───

/** 工具调用事件回调 — 用于 UI 层实时展示 Agent 进度 */
export type AgentLoopCallbacks = {
  /** AI 返回文本回复时触发 */
  onText?: (text: string) => void;
  /** AI 请求调用工具时触发（执行前） */
  onToolCall?: (name: string, input: unknown) => void;
  /** 工具执行完成时触发 */
  onToolResult?: (name: string, result: ToolCallResult) => void;
  /** 每轮循环开始时触发（round 从 0 开始） */
  onRound?: (round: number) => void;
  /**
   * 恢复快照生成前触发（页面 URL 变化或元素定位失败时）。
   *
   * 用于 WebAgent 重置 RefStore（清空旧的 hash ID → Element 映射，
   * 用新 URL 重新生成确定性 hash），确保恢复快照中的 ID 有效。
   *
   * @param newUrl 当前页面 URL（URL 变化时传入；元素定位失败时为 undefined）
   */
  onBeforeRecoverySnapshot?: (newUrl?: string) => void;
  /**
   * 断言快照刷新前触发。
   *
   * 用于清除页面瞬态视觉状态（如 hover、focus 高亮），
   * 确保断言 AI 看到的快照反映真实持久状态而非鼠标悬停态。
   */
  onBeforeAssertionSnapshot?: () => void | Promise<void>;
  /** 一次 chat 结束后输出结构化运行指标 */
  onMetrics?: (metrics: AgentLoopMetrics) => void;
};

// ─── 参数与结果 ───

export type AgentLoopParams = {
  /** AI 客户端实例（基于 fetch 的客户端） */
  client: import("../types.js").AIClient;
  /** 工具注册表实例（由调用方创建并注册好工具） */
  registry: import("../tool-registry.js").ToolRegistry;
  /** 系统提示词（由调用方构建，适配各自环境） */
  systemPrompt: string;
  /** 用户消息 */
  message: string;
  /** 对话发起时前端已生成的初始快照（可选） */
  initialSnapshot?: string;
  /** 历史对话消息（用于多轮记忆，按时间顺序排列） */
  history?: AIMessage[];
  /** 干运行模式：打印工具调用但不执行 */
  dryRun?: boolean;
  /** 最大工具调用轮次（默认 40） */
  maxRounds?: number;
  /** 轮次后稳定等待（加载态 + DOM 静默）配置 */
  roundStabilityWait?: RoundStabilityWaitOptions;
  /**
   * 断言配置（可选）。
   *
   * 配置后，AI 可在合适时机主动调用 assert 工具触发断言验证。
   * 由独立的断言 AI（专用 prompt，不带 tools）根据快照 + 操作记录判定任务完成情况。
   * 所有任务断言通过时立即收敛（stopReason = 'assertion_passed'）。
   */
  assertionConfig?: AssertionConfig;
  /** 事件回调 */
  callbacks?: AgentLoopCallbacks;
};

export type AgentLoopResult = {
  /** AI 的最终文本回复 */
  reply: string;
  /** 所有工具调用记录 */
  toolCalls: Array<{ name: string; input: unknown; result: ToolCallResult }>;
  /** 本轮完整对话消息（含历史 + 本轮，用于多轮记忆累积） */
  messages: AIMessage[];
  /** 本次运行统计指标 */
  metrics: AgentLoopMetrics;
  /**
   * 断言评估结果（仅在配置了 assertionConfig 且 AI 触发了 assert 时存在）。
   *
   * 若 stopReason = 'assertion_passed'，则 assertionResult.allPassed = true。
   */
  assertionResult?: AssertionResult;
};

// ─── 内部状态类型 ───

/** 页面上下文状态（Agent Loop 内部维护） */
export type PageContextState = {
  currentUrl?: string;
  latestSnapshot?: string;
};

/** 单次工具执行轨迹条目（用于恢复提示和调试展示）。 */
export type ToolTraceEntry = {
  round: number;
  name: string;
  input: unknown;
  result: ToolCallResult;
  marker?: string;
};
