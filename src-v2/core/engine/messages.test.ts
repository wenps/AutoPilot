/**
 * messages.ts 单元测试 — 消息编排层的行为边界验证。
 *
 * ═══ 测试策略 ═══
 *
 * 本文件验证 engine 消息编排层的 4 个关键行为边界：
 *
 * 1. Agent UI 安全边界 — 默认禁止模型操作 AutoPilot 聊天 UI，
 *    仅当用户"明确点名 UI 组件 + 操作动词"时才放行。
 *    这是一个安全约束：防止 AI 误点自己的输入框导致任务循环。
 *
 * 2. Round 0 vs Round 1+ 消息结构差异 — Round 0 注入完整用户目标，
 *    Round 1+ 不再重复原始 userMessage（改为 "Original Goal" 标注），
 *    避免模型每轮回到起点重做已完成的动作。
 *
 * 3. 上下文注入完整性 — Round 1+ 消息中包含：
 *    - Done steps 摘要（assistant 消息，防止模型重复动作）
 *    - Previous model output（对齐上轮决策结果）
 *    - Previous planned（对齐计划 vs 实际执行）
 *    - protocolViolationHint（协议修复提示）
 *
 * ═══ 测试与源码的对照关系 ═══
 *
 * | 测试用例                              | 验证的 messages.ts 分支                |
 * |---------------------------------------|----------------------------------------|
 * | "默认不误触"                           | Round 0 + isExplicitAgentUiRequest=false |
 * | "明确指令可执行"                       | Round 0 + isExplicitAgentUiRequest=true  |
 * | "Round1+ 不再重复携带原始 userMessage" | Round 1+ 分支：trace 非空时的消息结构   |
 * | "Round1+ 注入上一轮模型输出与计划批次" | Round 1+ 分支：all optional fields 注入 |
 *
 * ═══ 依赖 ═══
 *
 * - buildCompactMessages / isExplicitAgentUiRequest from ./messages.ts
 * - ToolTraceEntry type from ../shared/types.ts
 * - 不依赖 AIClient 或 ToolRegistry（纯消息构建，无 I/O）
 */
import { describe, expect, it } from "vitest";
import { buildCompactMessages, isExplicitAgentUiRequest } from "./messages.js";
import type { ToolTraceEntry } from "../shared/types.js";

describe("behavior boundary - agent ui interaction", () => {
  /**
   * 场景：用户发送普通任务（"帮我填写表单并提交"），不涉及 Agent UI 操作。
   *
   * 期望：Round 0 消息中包含"Do NOT interact with any AI chat UI elements"约束，
   *       不包含"User explicitly asked to operate AutoPilot UI"放行标记。
   *
   * 验证的关键路径：
   * - isExplicitAgentUiRequest("帮我填写表单并提交") → false
   * - buildCompactMessages Round 0 分支注入禁止 Agent UI 交互的约束文本
   *
   * 防御的实际风险：
   * AutoPilot 自身的聊天面板也渲染在页面上。如果不加此约束，
   * 模型在执行"帮我填写表单"时可能误把聊天输入框当作目标表单，
   * 导致向自己发送消息形成死循环。
   */
  it("默认不误触：普通任务应包含禁止操作 Agent UI 的约束", () => {
    const messages = buildCompactMessages(
      "帮我填写表单并提交",
      [],           // trace 为空 → Round 0
      "[body] #abc",
      "https://example.com",
    );

    const payload = String(messages[0].content);
    expect(payload).toContain("Do NOT interact with any AI chat UI elements");
    expect(payload).not.toContain("User explicitly asked to operate AutoPilot UI");
  });

  /**
   * 场景：用户明确要求操作 Agent UI（"帮我在指令输入框输入11然后发送"）。
   *
   * 期望：
   * 1. isExplicitAgentUiRequest 识别出"输入框"(UI 关键词) + "输入/发送"(操作动词) → true
   * 2. Round 0 消息中包含"User explicitly asked to operate AutoPilot UI"放行标记
   * 3. 不包含"Do NOT interact"禁止标记
   *
   * 验证的关键路径：
   * - compact 变量去除标点/空格后匹配中文关键词（处理"输入框输入"、"指令输入框"等）
   * - 三种中文表述均能正确识别：指令输入框、消息输入框、发送按钮
   *
   * 设计意图：
   * 当用户确实需要测试/调试 AutoPilot 的聊天功能时，必须能突破默认禁止。
   * 但仅靠"输入框"一词不够（用户可能指页面上的其他输入框），
   * 必须同时出现操作动词才放行。
   */
  it("明确指令可执行：当用户点名输入框和发送按钮时放行", () => {
    // 验证三种中文表述都能触发放行
    expect(isExplicitAgentUiRequest("帮我在指令输入框输入11然后发送")).toBe(true);
    expect(isExplicitAgentUiRequest("帮我在指令输入框输入 11 ，然后发送")).toBe(true);
    expect(isExplicitAgentUiRequest("在消息输入框填入11并点击发送按钮")).toBe(true);

    // 验证放行后 Round 0 消息结构
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

  /**
   * 场景：Round 1+（trace 非空），模型已执行过一次 click 操作。
   *
   * 期望：
   * 1. 消息数组长度 = 2（assistant Done steps + user 上下文）
   * 2. 第 1 条 = assistant 角色（Done steps 摘要）
   * 3. 第 2 条 = user 角色（执行上下文 + 快照）
   * 4. user 消息中不包含"Master goal:"（v1 遗留概念已移除）
   *
   * 验证的关键路径：
   * - buildCompactMessages 在 trace.length > 0 时进入 Round 1+ 分支
   * - Round 1+ 不注入原始 userMessage 作为独立段落，仅作为 "Original Goal" 标注
   * - 防止模型看到完整原始任务后回到起点重新规划
   *
   * 对应 engine/index.ts 行为：
   * Round 0: 模型看到完整任务 + 快照 → 做首轮决策
   * Round 1: 模型看到"已完成步骤 + 当前 remaining + 新快照" → 增量推进
   */
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
      undefined,       // history
      "填写标题",       // remainingInstruction（已从原始任务推进）
      ["dom:{\"action\":\"click\",\"selector\":\"#openModal\"}"], // previousRoundTasks
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[1].role).toBe("user");
    expect(String(messages[1].content)).not.toContain("Master goal:");
  });

  /**
   * 场景：Round 1+ 完整注入所有可选上下文字段。
   *
   * 期望 user 消息中包含：
   * 1. "Previous model output:" + 上轮模型输出摘要
   * 2. "Previous planned:" + 上轮计划的工具调用列表
   * 3. protocolViolationHint（协议修复提示文本）
   *
   * 验证的关键路径：
   * - previousRoundModelOutput 注入到 "Previous model output:" 区块
   * - previousRoundPlannedTasks 注入到 "Previous planned:" 区块
   * - protocolViolationHint 追加到消息末尾
   *
   * 这些字段的实际作用（在 engine/index.ts 中）：
   * - Previous model output: 让模型看到自己上轮的决策结果，用于 task-reduction 对齐
   * - Previous planned: 让模型看到上轮计划 vs 实际执行的差异（断轮时部分未执行）
   * - protocolViolationHint: 修复模型违反 REMAINING 协议的行为
   *
   * 对应 engine 测试：
   * → index.test.ts "DOM 变更动作后强制断轮" 验证 Previous executed/planned 包含正确内容
   * → index.test.ts "未完成但无工具调用" 验证 protocolViolationHint 注入
   */
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
      undefined,                                                    // history
      "填写标题",                                                    // remainingInstruction
      ["dom:{\"action\":\"click\",\"selector\":\"#openModal\"}"],   // previousRoundTasks
      "REMAINING: 填写标题",                                         // previousRoundModelOutput
      ["dom:{\"action\":\"click\",\"selector\":\"#openModal\"}"],   // previousRoundPlannedTasks
      "Protocol violation test",                                     // protocolViolationHint
    );

    const payload = String(messages[1].content);
    expect(payload).toContain("Previous model output:");
    expect(payload).toContain("REMAINING: 填写标题");
    expect(payload).toContain("Previous planned:");
    expect(payload).toContain("Protocol violation test");
  });
});
