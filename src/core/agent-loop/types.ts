/**
 * Agent Loop 共享类型定义。
 *
 * 被 index.ts、helpers.ts、messages.ts、recovery.ts、snapshot.ts 共用。
 * 集中在这里避免循环依赖。
 */
import type { AIMessage } from "../types.js";
import type { ToolCallResult } from "../tool-registry.js";

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
