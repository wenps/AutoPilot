import { describe, expect, it } from "vitest";
import { buildCompactMessages, isExplicitAgentUiRequest } from "./messages.js";
import type { ToolTraceEntry } from "./types.js";

describe("behavior boundary - agent ui interaction", () => {
  it("默认不误触：普通任务应包含禁止操作 Agent UI 的约束", () => {
    const messages = buildCompactMessages(
      "帮我填写表单并提交",
      [],
      "[body] #abc",
      "https://example.com",
    );

    const payload = String(messages[0].content);
    expect(payload).toContain("Do NOT interact with any AI chat UI elements");
    expect(payload).not.toContain("User explicitly asked to operate AutoPilot UI");
  });

  it("明确指令可执行：当用户点名输入框和发送按钮时放行", () => {
    expect(isExplicitAgentUiRequest("帮我在指令输入框输入11然后发送")).toBe(true);
    expect(isExplicitAgentUiRequest("帮我在指令输入框输入 11 ，然后发送")).toBe(true);
    expect(isExplicitAgentUiRequest("在消息输入框填入11并点击发送按钮")).toBe(true);

    const messages = buildCompactMessages(
      "帮我在指令输入框输入11然后发送",
      [],
      "[body] #abc",
      "https://example.com",
    );

    const payload = String(messages[0].content);
    expect(payload).toContain("User explicitly asked to operate AutoPilot UI");
    expect(payload).not.toContain("Do NOT interact with any AI chat UI elements");
  });

  it("Round1+ 不再重复携带原始 userMessage", () => {
    const trace: ToolTraceEntry[] = [
      {
        round: 0,
        name: "dom",
        input: { action: "click", selector: "#openModal" },
        result: { content: "ok" },
      },
    ];

    const messages = buildCompactMessages(
      "打开弹窗并填写标题",
      trace,
      "[body] #abc",
      "https://example.com",
      undefined,
      "填写标题",
      ["dom:{\"action\":\"click\",\"selector\":\"#openModal\"}"],
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[1].role).toBe("user");
    expect(String(messages[1].content)).not.toContain("Master goal:");
  });

  it("Round1+ 注入上一轮模型输出与计划批次", () => {
    const trace: ToolTraceEntry[] = [
      {
        round: 0,
        name: "dom",
        input: { action: "click", selector: "#openModal" },
        result: { content: "ok" },
      },
    ];

    const messages = buildCompactMessages(
      "打开弹窗并填写标题",
      trace,
      "[body] #abc",
      "https://example.com",
      undefined,
      "填写标题",
      ["dom:{\"action\":\"click\",\"selector\":\"#openModal\"}"],
      "REMAINING: 填写标题",
      ["dom:{\"action\":\"click\",\"selector\":\"#openModal\"}"],
      "Protocol violation test",
    );

    const payload = String(messages[1].content);
    expect(payload).toContain("Previous round model output (normalized");
    expect(payload).toContain("REMAINING: 填写标题");
    expect(payload).toContain("Previous round model planned task array");
    expect(payload).toContain("Protocol violation test");
  });
});
