/**
 * micro-task 模块类型定义。
 *
 * 定义微任务描述、执行结果、执行记录链等核心接口。
 * MicroTaskExecutionRecord 复用 assertion/types.ts 已有定义（re-export）。
 */
import type {
  MicroTaskExecutionRecord,
  TaskAssertion,
  AssertionResult,
} from "../assertion/types.js";
import type { AgentLoopMetrics } from "../shared/types.js";

// ─── re-export ───
export type { MicroTaskExecutionRecord, TaskAssertion, AssertionResult };

// ─── 微任务描述 ───

/** Main Agent 分派微任务的输入描述 */
export type MicroTaskDescriptor = {
  /** 微任务唯一标识 */
  id: string;
  /** 微任务目标描述 */
  task: string;
  /** 微任务级断言列表（可选） */
  assertions?: TaskAssertion[];
  /** 最大执行轮次（可选，默认由 engine 决定） */
  maxRounds?: number;
};

// ─── 微任务执行结果 ───

/** 微任务执行结果 */
export type MicroTaskResult = {
  /** 原始任务描述 */
  descriptor: MicroTaskDescriptor;
  /** 是否成功 */
  success: boolean;
  /** 执行记录（包含 actions, completedSubGoals 等） */
  executionRecord: MicroTaskExecutionRecord;
  /** 运行指标 */
  metrics: AgentLoopMetrics;
  /** 最终页面快照 */
  finalSnapshot: string;
  /** 失败原因（仅失败时存在） */
  failureReason?: string;
};

// ─── 执行记录链接口 ───

/** 执行记录链 — 管理微任务执行记录的有序集合 */
export type ExecutionRecordChain = {
  /** 当前所有记录（只读） */
  readonly records: readonly MicroTaskExecutionRecord[];
  /** 追加一条执行记录 */
  append(record: MicroTaskExecutionRecord): void;
  /** 格式化为下一个微任务的 "Previously completed" prompt 段 */
  buildPreviousContext(): string;
  /** 格式化为系统断言的完整证据摘要 */
  buildEvidenceSummary(): string;
};

// ─── 执行回调类型 ───

/** 微任务执行回调 — 解耦 engine 依赖 */
export type MicroTaskExecuteFn = (
  descriptor: MicroTaskDescriptor,
  previousContext: string,
) => Promise<MicroTaskResult>;
