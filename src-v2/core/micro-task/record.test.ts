import { describe, it, expect } from "vitest";
import { createExecutionRecordChain } from "./record.js";
import type { MicroTaskExecutionRecord } from "../assertion/types.js";

/** 构造测试用执行记录 */
function makeRecord(
  overrides: Partial<MicroTaskExecutionRecord> = {},
): MicroTaskExecutionRecord {
  return {
    id: "mt-1",
    task: "点击登录按钮",
    success: true,
    completedSubGoals: ["按钮已点击"],
    actions: ['click("#login-btn")'],
    summary: "成功点击登录按钮",
    ...overrides,
  };
}

describe("ExecutionRecordChain", () => {
  it("空链 buildPreviousContext 返回 '(no prior micro-tasks)'", () => {
    const chain = createExecutionRecordChain();
    expect(chain.buildPreviousContext()).toBe("(no prior micro-tasks)");
  });

  it("空链 buildEvidenceSummary 返回 '(no execution records)'", () => {
    const chain = createExecutionRecordChain();
    expect(chain.buildEvidenceSummary()).toBe("(no execution records)");
  });

  it("append 后 records 正确累积", () => {
    const chain = createExecutionRecordChain();
    const r1 = makeRecord({ id: "mt-1" });
    const r2 = makeRecord({ id: "mt-2", task: "填写用户名" });
    chain.append(r1);
    chain.append(r2);
    expect(chain.records).toHaveLength(2);
    expect(chain.records[0]).toBe(r1);
    expect(chain.records[1]).toBe(r2);
  });

  it("成功记录的 buildPreviousContext 格式（✅ + completedSubGoals）", () => {
    const chain = createExecutionRecordChain();
    chain.append(
      makeRecord({
        success: true,
        task: "填写用户名",
        completedSubGoals: ["输入框已填写", "值为 admin"],
      }),
    );
    const ctx = chain.buildPreviousContext();
    expect(ctx).toBe("✅ 填写用户名: 输入框已填写, 值为 admin");
  });

  it("失败记录的 buildPreviousContext 格式（✗ + summary）", () => {
    const chain = createExecutionRecordChain();
    chain.append(
      makeRecord({
        success: false,
        task: "提交表单",
        summary: "提交按钮未找到",
      }),
    );
    const ctx = chain.buildPreviousContext();
    expect(ctx).toBe("✗ 提交表单 (failed): 提交按钮未找到");
  });

  it("混合成功/失败的 buildPreviousContext", () => {
    const chain = createExecutionRecordChain();
    chain.append(
      makeRecord({
        id: "mt-1",
        success: true,
        task: "点击登录",
        completedSubGoals: ["已点击"],
      }),
    );
    chain.append(
      makeRecord({
        id: "mt-2",
        success: false,
        task: "填写密码",
        summary: "输入框被禁用",
      }),
    );
    const ctx = chain.buildPreviousContext();
    expect(ctx).toContain("✅ 点击登录: 已点击");
    expect(ctx).toContain("✗ 填写密码 (failed): 输入框被禁用");
  });

  it("buildEvidenceSummary 包含 actions 和 completedSubGoals", () => {
    const chain = createExecutionRecordChain();
    chain.append(
      makeRecord({
        task: "选择日期",
        completedSubGoals: ["日期已选择"],
        actions: ['click("#date-picker")', 'click("#day-15")'],
      }),
    );
    const evidence = chain.buildEvidenceSummary();
    expect(evidence).toContain("选择日期");
    expect(evidence).toContain("status: success");
    expect(evidence).toContain("日期已选择");
    expect(evidence).toContain('click("#date-picker"); click("#day-15")');
  });

  it("含 assertionResult 的记录在 evidence 中展示断言详情", () => {
    const chain = createExecutionRecordChain();
    chain.append(
      makeRecord({
        task: "验证登录状态",
        assertionResult: {
          allPassed: false,
          total: 2,
          passed: 1,
          failed: 1,
          details: [
            { task: "用户名显示", passed: true, reason: "用户名已显示在顶栏" },
            { task: "头像加载", passed: false, reason: "头像区域为空" },
          ],
        },
      }),
    );
    const evidence = chain.buildEvidenceSummary();
    expect(evidence).toContain("assertion: FAILED (1/2)");
    expect(evidence).toContain("用户名显示: ✅ 用户名已显示在顶栏");
    expect(evidence).toContain("头像加载: ❌ 头像区域为空");
  });

  it("多条记录按追加顺序排列", () => {
    const chain = createExecutionRecordChain();
    chain.append(makeRecord({ id: "mt-1", task: "第一步" }));
    chain.append(makeRecord({ id: "mt-2", task: "第二步" }));
    chain.append(makeRecord({ id: "mt-3", task: "第三步" }));
    const evidence = chain.buildEvidenceSummary();
    const idx1 = evidence.indexOf("[1] 第一步");
    const idx2 = evidence.indexOf("[2] 第二步");
    const idx3 = evidence.indexOf("[3] 第三步");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });
});
