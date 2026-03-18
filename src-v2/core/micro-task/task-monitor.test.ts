import { describe, it, expect, vi } from "vitest";
import { TaskMonitor } from "./task-monitor.js";
import type {
  MicroTaskDescriptor,
  MicroTaskResult,
  MicroTaskExecuteFn,
} from "./types.js";
import type { MicroTaskExecutionRecord } from "../assertion/types.js";
import type { AgentLoopMetrics } from "../shared/types.js";

/** 构造测试用 descriptor */
function makeDescriptor(
  overrides: Partial<MicroTaskDescriptor> = {},
): MicroTaskDescriptor {
  return { id: "mt-1", task: "点击按钮", ...overrides };
}

/** 构造测试用 execution record */
function makeRecord(
  overrides: Partial<MicroTaskExecutionRecord> = {},
): MicroTaskExecutionRecord {
  return {
    id: "mt-1",
    task: "点击按钮",
    success: true,
    completedSubGoals: ["按钮已点击"],
    actions: ['click("#btn")'],
    summary: "成功",
    ...overrides,
  };
}

/** 构造测试用 metrics */
function makeMetrics(): AgentLoopMetrics {
  return {
    roundCount: 1,
    totalToolCalls: 1,
    successfulToolCalls: 1,
    failedToolCalls: 0,
    toolSuccessRate: 1,
    recoveryCount: 0,
    redundantInterceptCount: 0,
    snapshotReadCount: 1,
    latestSnapshotSize: 100,
    avgSnapshotSize: 100,
    maxSnapshotSize: 100,
    inputTokens: 500,
    outputTokens: 200,
    stopReason: "converged",
  };
}

/** 构造测试用 result */
function makeResult(
  overrides: Partial<MicroTaskResult> = {},
): MicroTaskResult {
  return {
    descriptor: makeDescriptor(),
    success: true,
    executionRecord: makeRecord(),
    metrics: makeMetrics(),
    finalSnapshot: "<snapshot/>",
    ...overrides,
  };
}

describe("TaskMonitor", () => {
  it("execute 调用 executeFn 并传入正确的 previousContext", async () => {
    const monitor = new TaskMonitor();
    const descriptor = makeDescriptor();
    const executeFn: MicroTaskExecuteFn = vi.fn().mockResolvedValue(makeResult());

    await monitor.execute(descriptor, executeFn);

    expect(executeFn).toHaveBeenCalledWith(descriptor, "(no prior micro-tasks)");
  });

  it("execute 将结果的 executionRecord 追加到链", async () => {
    const monitor = new TaskMonitor();
    const record = makeRecord({ id: "mt-1", task: "填写表单" });
    const executeFn: MicroTaskExecuteFn = vi
      .fn()
      .mockResolvedValue(makeResult({ executionRecord: record }));

    await monitor.execute(makeDescriptor(), executeFn);

    expect(monitor.recordChain.records).toHaveLength(1);
    expect(monitor.recordChain.records[0]).toBe(record);
  });

  it("多次 execute 后记录链累积，previousContext 包含之前所有记录", async () => {
    const monitor = new TaskMonitor();

    const record1 = makeRecord({ id: "mt-1", task: "第一步", success: true, completedSubGoals: ["完成"] });
    const record2 = makeRecord({ id: "mt-2", task: "第二步", success: true, completedSubGoals: ["完成"] });

    const executeFn1: MicroTaskExecuteFn = vi
      .fn()
      .mockResolvedValue(makeResult({ executionRecord: record1 }));
    const executeFn2: MicroTaskExecuteFn = vi
      .fn()
      .mockResolvedValue(makeResult({ executionRecord: record2 }));

    await monitor.execute(makeDescriptor({ id: "mt-1", task: "第一步" }), executeFn1);
    await monitor.execute(makeDescriptor({ id: "mt-2", task: "第二步" }), executeFn2);

    expect(monitor.recordChain.records).toHaveLength(2);
    // 第二次调用时 previousContext 应包含第一条记录
    const secondCallArgs = (executeFn2 as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(secondCallArgs[1]).toContain("✅ 第一步: 完成");
  });

  it("reset 清空记录链", async () => {
    const monitor = new TaskMonitor();
    const executeFn: MicroTaskExecuteFn = vi.fn().mockResolvedValue(makeResult());

    await monitor.execute(makeDescriptor(), executeFn);
    expect(monitor.recordChain.records).toHaveLength(1);

    monitor.reset();
    expect(monitor.recordChain.records).toHaveLength(0);
    expect(monitor.recordChain.buildPreviousContext()).toBe("(no prior micro-tasks)");
  });

  it("executeFn 返回失败结果时记录仍追加", async () => {
    const monitor = new TaskMonitor();
    const failedRecord = makeRecord({ success: false, summary: "元素未找到" });
    const executeFn: MicroTaskExecuteFn = vi
      .fn()
      .mockResolvedValue(makeResult({ success: false, executionRecord: failedRecord }));

    await monitor.execute(makeDescriptor(), executeFn);

    expect(monitor.recordChain.records).toHaveLength(1);
    expect(monitor.recordChain.records[0].success).toBe(false);
  });

  it("execute 返回 executeFn 的原始结果", async () => {
    const monitor = new TaskMonitor();
    const expected = makeResult({ finalSnapshot: "<special/>" });
    const executeFn: MicroTaskExecuteFn = vi.fn().mockResolvedValue(expected);

    const result = await monitor.execute(makeDescriptor(), executeFn);

    expect(result).toBe(expected);
  });
});
