import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { executeAgentLoop } from "./index.js";
import { ToolRegistry, type ToolCallResult } from "../tool-registry.js";
import type { AIClient, AIChatResponse, AIMessage, AIToolCall } from "../types.js";

type ScriptedStep = {
  text?: string;
  toolCalls?: AIToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  assert?: (params: { systemPrompt: string; messages: AIMessage[] }) => void;
};

class ScriptedClient implements AIClient {
  private index = 0;

  constructor(private readonly steps: ScriptedStep[]) {}

  async chat(params: {
    systemPrompt: string;
    messages: AIMessage[];
  }): Promise<AIChatResponse> {
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    this.index += 1;
    step.assert?.(params);
    return {
      text: step.text,
      toolCalls: step.toolCalls,
      usage: step.usage,
    };
  }
}

function createPageInfoTool(options: {
  snapshots: string[];
  getUrl: () => string;
}) {
  let snapshotIndex = 0;

  return {
    name: "page_info",
    description: "page info",
    schema: Type.Object({ action: Type.String() }),
    execute: async (params: Record<string, unknown>): Promise<ToolCallResult> => {
      const action = params.action;
      if (action === "snapshot") {
        const current = options.snapshots[Math.min(snapshotIndex, options.snapshots.length - 1)] ?? "[body] #empty";
        snapshotIndex += 1;
        return { content: current };
      }
      if (action === "get_url") {
        return { content: options.getUrl() };
      }
      if (action === "query_all") {
        return { content: "query result" };
      }
      return { content: "ok" };
    },
  };
}

function createBaseRegistry(options?: {
  snapshots?: string[];
  getUrl?: () => string;
  domExecute?: (params: Record<string, unknown>) => Promise<ToolCallResult>;
  navigateExecute?: (params: Record<string, unknown>) => Promise<ToolCallResult>;
}): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(createPageInfoTool({
    snapshots: options?.snapshots ?? ["[body] #snap0", "[body] #snap1", "[body] #snap2"],
    getUrl: options?.getUrl ?? (() => "https://example.com"),
  }));

  registry.register({
    name: "dom",
    description: "dom tool",
    schema: Type.Object({ action: Type.String() }),
    execute: options?.domExecute ?? (async () => ({ content: "dom ok" })),
  });

  registry.register({
    name: "navigate",
    description: "navigate tool",
    schema: Type.Object({ action: Type.String() }),
    execute: options?.navigateExecute ?? (async () => ({ content: "navigate ok" })),
  });

  return registry;
}

describe("executeAgentLoop golden paths", () => {
  it("REMAINING: DONE 带尾随说明时也应收敛", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        text: "从当前快照可以看到，城市选择器已经显示\"上海\"。\n\nREMAINING: DONE - 城市选择器已成功选择上海",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "把城市改成上海",
    });

    expect(result.reply).toContain("REMAINING: DONE");
    expect(result.metrics.roundCount).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("正常完成：可执行工具后返回最终总结", async () => {
    const registry = createBaseRegistry();
    const onMetrics = vi.fn();

    const client = new ScriptedClient([
      {
        toolCalls: [{ id: "1", name: "dom", input: { action: "fill", selector: "#a", value: "11" } }],
        usage: { inputTokens: 12, outputTokens: 8 },
      },
      {
        text: "已完成\nREMAINING: DONE",
        usage: { inputTokens: 10, outputTokens: 6 },
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "输入 11 并提交",
      callbacks: { onMetrics },
    });

    expect(result.reply).toBe("已完成\nREMAINING: DONE");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.metrics.roundCount).toBe(2);
    expect(result.metrics.totalToolCalls).toBe(1);
    expect(result.metrics.successfulToolCalls).toBe(1);
    expect(result.metrics.inputTokens).toBe(22);
    expect(result.metrics.outputTokens).toBe(14);
    expect(onMetrics).toHaveBeenCalledTimes(1);
  });

  it("弹窗跨轮：第2轮消息包含 Done steps 再继续执行", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#openModal" } }],
      },
      {
        assert: ({ messages }) => {
          const assistantDone = messages.find(m => m.role === "assistant")?.content;
          expect(typeof assistantDone).toBe("string");
          expect(String(assistantDone)).toContain("Done steps");
          expect(String(assistantDone)).toContain("openModal");
        },
        toolCalls: [{ id: "2", name: "dom", input: { action: "fill", selector: "#taskTitle", value: "任务11" } }],
      },
      {
        text: "弹窗任务已提交",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "打开弹窗并填写标题后提交",
    });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.reply).toBe("弹窗任务已提交");
  });

  it("元素找不到恢复：触发 recovery 并计入指标", async () => {
    const onBeforeRecoverySnapshot = vi.fn();
    const registry = createBaseRegistry({
      domExecute: async () => ({
        content: "未找到元素",
        details: { error: true, code: "ELEMENT_NOT_FOUND" },
      }),
    });

    const client = new ScriptedClient([
      {
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#missing", waitMs: 0 } }],
      },
      {
        text: "结束",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "点击不存在元素",
      callbacks: { onBeforeRecoverySnapshot },
    });

    expect(result.toolCalls[0].result.details).toMatchObject({ code: "ELEMENT_NOT_FOUND_RECOVERY" });
    expect(result.metrics.recoveryCount).toBe(1);
    expect(onBeforeRecoverySnapshot).toHaveBeenCalled();
  });

  it("空转终止：连续只读轮次后自动退出", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        toolCalls: [{ id: "1", name: "page_info", input: { action: "query_all", selector: "button" } }],
      },
      {
        toolCalls: [{ id: "2", name: "page_info", input: { action: "query_all", selector: "a" } }],
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "请执行任务",
    });

    expect(result.reply).toBe("任务已完成。");
    expect(result.metrics.roundCount).toBe(2);
    expect(result.metrics.redundantInterceptCount).toBe(2);
  });

  it("导航后重定位：导航动作触发上下文刷新", async () => {
    const onBeforeRecoverySnapshot = vi.fn();

    const registry = createBaseRegistry({
      navigateExecute: async (_params) => {
        return { content: "navigate ok" };
      },
    });

    const client = new ScriptedClient([
      {
        toolCalls: [{ id: "1", name: "navigate", input: { action: "goto", url: "https://example.com/b" } }],
      },
      {
        text: "导航完成",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "跳转到 b 页面",
      callbacks: { onBeforeRecoverySnapshot },
    });

    expect(result.reply).toBe("导航完成");
    expect(onBeforeRecoverySnapshot).toHaveBeenCalled();
  });

  it("指标聚合：输出成功率、快照大小、token 汇总", async () => {
    const registry = createBaseRegistry({
      snapshots: ["[body] #a", "[body] #abcdef", "[body] #xyz"],
      domExecute: async () => ({ content: "dom failed", details: { error: true, code: "DOM_FAIL" } }),
    });

    const client = new ScriptedClient([
      {
        usage: { inputTokens: 100, outputTokens: 30 },
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#btn" } }],
      },
      {
        usage: { inputTokens: 90, outputTokens: 20 },
        text: "结束\nREMAINING: DONE",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "测试指标",
    });

    expect(result.metrics.inputTokens).toBe(190);
    expect(result.metrics.outputTokens).toBe(50);
    expect(result.metrics.totalToolCalls).toBe(1);
    expect(result.metrics.failedToolCalls).toBe(1);
    expect(result.metrics.toolSuccessRate).toBe(0);
    expect(result.metrics.snapshotReadCount).toBeGreaterThan(0);
    expect(result.metrics.maxSnapshotSize).toBeGreaterThan(0);
  });

  it("重复相同任务批次且上轮无错：自动终止避免自转", async () => {
    const registry = createBaseRegistry({
      domExecute: async () => ({ content: "dom ok" }),
    });

    const client = new ScriptedClient([
      {
        text: "REMAINING: 输入11并发送",
        toolCalls: [{ id: "1", name: "dom", input: { action: "fill", selector: "#input", text: "11" } }],
      },
      {
        text: "REMAINING: DONE",
        toolCalls: [{ id: "2", name: "dom", input: { action: "fill", selector: "#input", text: "11" } }],
      },
      {
        text: "不应执行到这里",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "帮我在指令输入框输入11然后发送",
      maxRounds: 5,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.reply).toContain("REMAINING: DONE");
    expect(result.metrics.roundCount).toBe(2);
  });

  it("DOM 变更动作后强制断轮：click 后不继续执行同批次后续动作", async () => {
    const domExecute = vi.fn(async (params: Record<string, unknown>) => ({
      content: `dom:${String(params.action)}`,
    }));

    const registry = createBaseRegistry({ domExecute });
    const client = new ScriptedClient([
      {
        text: "REMAINING: 填写标题并提交",
        toolCalls: [
          { id: "1", name: "dom", input: { action: "click", selector: "#openModal" } },
          { id: "2", name: "dom", input: { action: "fill", selector: "#title", value: "任务" } },
        ],
      },
      {
        assert: ({ messages }) => {
          const payload = String(messages[messages.length - 1]?.content ?? "");
          expect(payload).toContain("Previous executed:");
          expect(payload).toContain("dom:{\"action\":\"click\",\"selector\":\"#openModal\"}");
          expect(payload).toContain("Previous planned:");
          expect(payload).toContain("dom:{\"action\":\"fill\",\"selector\":\"#title\",\"value\":\"任务\"}");
        },
        text: "REMAINING: DONE",
        toolCalls: [{ id: "3", name: "dom", input: { action: "fill", selector: "#title", value: "任务" } }],
      },
      { text: "完成" },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "打开弹窗并填写标题",
      maxRounds: 5,
    });

    expect(domExecute).toHaveBeenCalled();
    const executedActions = domExecute.mock.calls.map(call => String((call[0] as Record<string, unknown>).action));
    expect(executedActions[0]).toBe("click");
    expect(result.toolCalls[0].input).toMatchObject({ action: "click" });
  });

  it("缺失 REMAINING 协议且本轮有执行动作：启发式推进剩余任务", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        text: "",
        toolCalls: [{ id: "1", name: "dom", input: { action: "fill", selector: "#input", value: "abc" } }],
      },
      {
        assert: ({ messages }) => {
          const contextPayload = String(messages[messages.length - 1]?.content ?? "");
          expect(contextPayload).toContain("Remaining:");
          expect(contextPayload).toContain("发送");
          expect(contextPayload).not.toContain("输入框输入 abc 然后发送");
          expect(contextPayload).toContain("Previous model output:");
          expect(contextPayload).toContain("REMAINING: 发送");
        },
        text: "REMAINING: DONE",
        toolCalls: [{ id: "2", name: "dom", input: { action: "press", selector: "#send", key: "Enter" } }],
      },
      { text: "完成" },
    ]);

    await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "输入框输入 abc 然后发送",
      maxRounds: 5,
    });
  });

  it("未完成但无工具调用：不直接结束，进入下一轮协议修复", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        text: "REMAINING: 打开任务弹窗",
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#openModal" } }],
      },
      {
        text: "根据当前快照，我先规划下步骤。",
      },
      {
        assert: ({ messages }) => {
          const content = String(messages[messages.length - 1]?.content ?? "");
          expect(content).toContain("Protocol violation in previous round");
          expect(content).toContain("Previous model output:");
          expect(content).toContain("REMAINING: 打开任务弹窗");
        },
        text: "REMAINING: DONE",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "打开任务弹窗",
      maxRounds: 5,
    });

    expect(result.metrics.roundCount).toBe(3);
    expect(result.reply).toContain("REMAINING: DONE");
  });

  it("AI 输出 SNAPSHOT_HINT 后：下一轮快照按指定 ref 放宽 children 截断", async () => {
    const snapshotParamsHistory: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();

    registry.register({
      name: "page_info",
      description: "page info",
      schema: Type.Object({ action: Type.String() }),
      execute: async (params: Record<string, unknown>) => {
        if (params.action === "snapshot") {
          snapshotParamsHistory.push({ ...params });
          return { content: "[body] #snap" };
        }
        if (params.action === "get_url") {
          return { content: "https://example.com" };
        }
        return { content: "ok" };
      },
    });

    registry.register({
      name: "dom",
      description: "dom tool",
      schema: Type.Object({ action: Type.String() }),
      execute: async () => ({ content: "dom ok" }),
    });

    const client = new ScriptedClient([
      {
        text: "SNAPSHOT_HINT: EXPAND_CHILDREN #1rv01x\nREMAINING: 继续选择秒",
        toolCalls: [{ id: "1", name: "dom", input: { action: "scroll", selector: "#1rv01x", deltaY: 100 } }],
      },
      {
        text: "完成\nREMAINING: DONE",
      },
    ]);

    await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "选择时间 17:20:50",
      maxRounds: 4,
    });

    expect(snapshotParamsHistory.length).toBeGreaterThanOrEqual(2);
    const expandedSnapshotCall = snapshotParamsHistory.find(p =>
      Array.isArray(p.expandChildrenRefs) && (p.expandChildrenRefs as unknown[]).includes("1rv01x"),
    );
    expect(expandedSnapshotCall).toBeTruthy();
    expect(expandedSnapshotCall?.expandedChildrenLimit).toBe(120);
  });

  it("未输出 SNAPSHOT_HINT 时：dom.scroll 也会自动触发该 ref 的快照放宽", async () => {
    const snapshotParamsHistory: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();

    registry.register({
      name: "page_info",
      description: "page info",
      schema: Type.Object({ action: Type.String() }),
      execute: async (params: Record<string, unknown>) => {
        if (params.action === "snapshot") {
          snapshotParamsHistory.push({ ...params });
          return { content: "[body] #snap" };
        }
        if (params.action === "get_url") return { content: "https://example.com" };
        return { content: "ok" };
      },
    });

    registry.register({
      name: "dom",
      description: "dom tool",
      schema: Type.Object({ action: Type.String() }),
      execute: async () => ({ content: "dom ok" }),
    });

    const client = new ScriptedClient([
      {
        text: "REMAINING: 继续",
        toolCalls: [{ id: "1", name: "dom", input: { action: "scroll", selector: "#1rv01x" } }],
      },
      { text: "完成\nREMAINING: DONE" },
    ]);

    await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "测试 scroll 自动放宽",
      maxRounds: 4,
    });

    const expandedSnapshotCall = snapshotParamsHistory.find(p =>
      Array.isArray(p.expandChildrenRefs) && (p.expandChildrenRefs as unknown[]).includes("1rv01x"),
    );
    expect(expandedSnapshotCall).toBeTruthy();
  });

  it("轮次后双重等待：同轮多个动作仅触发一次等待屏障", async () => {
    const waitExecute = vi.fn(async (params: Record<string, unknown>) => ({
      content: `wait:${String(params.action)}`,
    }));

    const registry = createBaseRegistry({
      domExecute: async () => ({ content: "dom ok" }),
    });

    registry.register({
      name: "wait",
      description: "wait tool",
      schema: Type.Object({ action: Type.String() }),
      execute: waitExecute,
    });

    const client = new ScriptedClient([
      {
        text: "REMAINING: 继续",
        toolCalls: [
          { id: "1", name: "dom", input: { action: "fill", selector: "#a", value: "1" } },
          { id: "2", name: "dom", input: { action: "click", selector: "#submit" } },
        ],
      },
      { text: "完成\nREMAINING: DONE" },
    ]);

    await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "填写并提交",
      maxRounds: 4,
    });

    const waitActions = waitExecute.mock.calls.map(call => String((call[0] as Record<string, unknown>).action));
    expect(waitActions).toEqual(["wait_for_selector", "wait_for_stable"]);
    expect(waitExecute).toHaveBeenCalledTimes(2);
  });

  it("轮次后稳定等待：自定义 loadingSelectors 与默认值合并而非覆盖", async () => {
    const waitExecute = vi.fn(async (params: Record<string, unknown>) => ({
      content: `wait:${String(params.action)}`,
    }));

    const registry = createBaseRegistry({
      domExecute: async () => ({ content: "dom ok" }),
    });

    registry.register({
      name: "wait",
      description: "wait tool",
      schema: Type.Object({ action: Type.String() }),
      execute: waitExecute,
    });

    const client = new ScriptedClient([
      {
        text: "REMAINING: 继续",
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#submit" } }],
      },
      { text: "完成\nREMAINING: DONE" },
    ]);

    await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "点击提交",
      maxRounds: 4,
      roundStabilityWait: {
        loadingSelectors: [".custom-loading", " .custom-loading "],
      },
    });

    const waitForSelectorCall = waitExecute.mock.calls.find(call =>
      String((call[0] as Record<string, unknown>).action) === "wait_for_selector"
    );
    expect(waitForSelectorCall).toBeTruthy();

    const selectorArg = String((waitForSelectorCall?.[0] as Record<string, unknown>).selector ?? "");
    expect(selectorArg).toContain(".ant-spin");
    expect(selectorArg).toContain(".custom-loading");
    expect(selectorArg.match(/\.custom-loading/g)?.length).toBe(1);
  });

  it("连续无 REMAINING 协议且启发式无法推进：3 轮后强制终止（仅失败或无 DOM 变更时计数）", async () => {
    // 当工具全部返回错误（模型卡住）且无 REMAINING 协议时，才触发协议缺失终止。
    // 若工具有成功的 DOM 变更，不计入协议缺失（模型在实质推进）。
    const registry = createBaseRegistry({
      domExecute: async () => ({
        content: "element not interactable",
        details: { error: true, code: "ELEMENT_ERROR" },
      }),
    });

    const client = new ScriptedClient([
      {
        text: "弹窗已经打开了，我来查看内容。",
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#btn1" } }],
      },
      {
        text: "让我再确认一下弹窗内容。",
        toolCalls: [{ id: "2", name: "dom", input: { action: "click", selector: "#btn2" } }],
      },
      {
        assert: ({ messages }) => {
          const payload = String(messages[messages.length - 1]?.content ?? "");
          expect(payload).toContain("Protocol reminder");
          expect(payload).toContain("REMAINING protocol missing");
        },
        text: "弹窗内容已查看完毕，任务完成。",
        toolCalls: [{ id: "3", name: "dom", input: { action: "click", selector: "#btn3" } }],
      },
      {
        text: "不应执行到这里",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "查看弹窗内容",
      maxRounds: 10,
    });

    expect(result.metrics.roundCount).toBe(3);
    expect(result.reply).toContain("任务完成");
  });

  it("无 REMAINING 协议但重复相同批次：同批检测不再被启发式失败阻断", async () => {
    const registry = createBaseRegistry({
      domExecute: async () => ({ content: "dom ok" }),
    });

    const client = new ScriptedClient([
      {
        text: "弹窗已打开。",
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#same" } }],
      },
      {
        text: "弹窗已打开。",
        toolCalls: [{ id: "2", name: "dom", input: { action: "click", selector: "#same" } }],
      },
      {
        text: "不应执行到这里",
      },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "查看弹窗",
      maxRounds: 10,
    });

    // 重复批次检测在第 2 轮触发（不再被 roundHasError 阻断）
    expect(result.metrics.roundCount).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
  });

  it("dom.click 强制断轮：click 后同批次后续动作推迟到下一轮", async () => {
    const domExecute = vi.fn(async (params: Record<string, unknown>) => ({
      content: `dom:${String(params.action)}`,
    }));

    const registry = createBaseRegistry({ domExecute });
    const client = new ScriptedClient([
      {
        text: "REMAINING: 填写并提交",
        toolCalls: [
          { id: "1", name: "dom", input: { action: "click", selector: "#openDialog" } },
          { id: "2", name: "dom", input: { action: "fill", selector: "#name", value: "test" } },
        ],
      },
      {
        text: "REMAINING: DONE",
        toolCalls: [{ id: "3", name: "dom", input: { action: "fill", selector: "#name", value: "test" } }],
      },
      { text: "完成" },
    ]);

    const result = await executeAgentLoop({
      client,
      registry,
      systemPrompt: "test prompt",
      message: "打开弹窗并填写",
      maxRounds: 5,
    });

    // 第一轮只执行 click（断轮），fill 推迟到第二轮
    const round1Executed = domExecute.mock.calls.filter(
      (_, i) => i === 0,
    );
    expect(String((round1Executed[0][0] as Record<string, unknown>).action)).toBe("click");

    // 第二轮执行 fill
    expect(result.toolCalls).toHaveLength(2);
  });
});
