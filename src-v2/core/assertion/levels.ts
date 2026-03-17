/**
 * 分级断言策略。
 *
 * 微任务断言：MT 完成后，用 MT 前后快照 + 执行记录评估该 MT 的断言
 * 系统断言：全部 MT 完成后，用全局初始/最终快照 + 完整执行记录链评估整体断言
 */
import type { TaskAssertion, AssertionRequest } from "./types.js";

/** 构建微任务级断言请求 */
export function buildMicroTaskAssertionRequest(params: {
  taskAssertions: TaskAssertion[];
  initialSnapshot: string;
  currentSnapshot: string;
  postActionSnapshot?: string;
  executedActions: string[];
}): AssertionRequest {
  return {
    level: "micro-task",
    taskAssertions: params.taskAssertions,
    currentSnapshot: params.currentSnapshot,
    initialSnapshot: params.initialSnapshot,
    postActionSnapshot: params.postActionSnapshot,
    executedActions: params.executedActions,
  };
}

/** 构建系统级断言请求 */
export function buildSystemAssertionRequest(params: {
  taskAssertions: TaskAssertion[];
  initialSnapshot: string;
  currentSnapshot: string;
  executionEvidence: string;
}): AssertionRequest {
  return {
    level: "system",
    taskAssertions: params.taskAssertions,
    currentSnapshot: params.currentSnapshot,
    initialSnapshot: params.initialSnapshot,
    executionEvidence: params.executionEvidence,
  };
}
