/**
 * Micro Task 模块 — 微任务数据结构与执行编排。
 *
 * 提供微任务描述、执行记录链、TaskMonitor 等核心能力，
 * 由 main-agent 调度，通过 executeFn 回调解耦 engine 依赖。
 */

// ─── 类型 ───
export type {
  MicroTaskDescriptor,
  MicroTaskResult,
  ExecutionRecordChain,
  MicroTaskExecuteFn,
  MicroTaskExecutionRecord,
  TaskAssertion,
  AssertionResult,
} from "./types.js";

// ─── 实现 ───
export { createExecutionRecordChain } from "./record.js";
export { TaskMonitor } from "./task-monitor.js";
