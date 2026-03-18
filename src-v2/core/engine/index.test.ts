/**
 * executeAgentLoop 集成测试 — v2 统一执行引擎的行为验证。
 *
 * ═══ 测试架构设计 ═══
 *
 * 本文件使用两个核心测试工具模拟 engine 的完整执行环境：
 *
 * 1. **ScriptedClient** — 可编程 AI 客户端
 *    按预定义的 steps 序列返回模型响应，每调用一次 chat() 消费一个 step。
 *    支持 assert 回调在运行时验证传入的 messages 内容。
 *    用法：`new ScriptedClient([{ text, toolCalls, usage, assert }])`
 *
 * 2. **createBaseRegistry** — 最小工具注册表
 *    注册 page_info / dom / navigate 三个核心工具，模拟浏览器环境。
 *    page_info 按预设快照序列返回（模拟页面变化），dom/navigate 可自定义执行函数。
 *    用法：`createBaseRegistry({ snapshots, domExecute, navigateExecute })`
 *
 * ═══ 测试覆盖的 engine 能力矩阵 ═══
 *
 * | 分类              | 测试用例                                                | 验证的 engine 能力                                           |
 * |-------------------|--------------------------------------------------------|--------------------------------------------------------------|
 * | 正常收敛          | "REMAINING: DONE 带尾随说明时收敛"                      | REMAINING 协议解析 + converged 停机                           |
 * | 正常收敛          | "正常完成：工具后返回总结"                                | 工具执行 → 模型总结 → metrics 聚合                            |
 * | 跨轮协作          | "弹窗跨轮"                                              | Done steps 摘要注入 + 多轮工具执行                            |
 * | 故障恢复          | "元素找不到恢复"                                         | handleElementRecovery + recoveryCount 指标                    |
 * | 防空转            | "空转终止"                                              | detectIdleLoop + idle_loop 停机                               |
 * | 导航感知          | "导航后重定位"                                           | handleNavigationUrlChange + 快照刷新                          |
 * | 可观测性          | "指标聚合"                                              | token / 成功率 / 快照大小 全量统计                             |
 * | 防自转            | "重复相同批次先提示后终止"                                | consecutiveSamePlannedBatch + repeated_batch 停机              |
 * | 断轮保护          | "DOM 变更动作后强制断轮"                                  | shouldForceRoundBreak + Previous executed/planned 注入         |
 * | 启发式推进        | "缺失 REMAINING 协议"                                    | reduceRemainingHeuristically + 启发式 remaining 推进           |
 * | 协议修复          | "未完成但无工具调用"                                      | protocolViolationHint 注入 + protocol_fix_failed 停机          |
 * | 快照放宽          | "SNAPSHOT_HINT 放宽 children 截断"                       | parseSnapshotExpandHints + expandChildrenRefs 传参              |
 * | 快照放宽          | "scroll 自动触发放宽"                                    | extractHashSelectorRef + scroll 自动策略                       |
 * | 稳定等待          | "轮次后双重等待"                                         | runRoundStabilityBarrier: loading hidden → DOM quiet           |
 * | 稳定等待          | "自定义 loadingSelectors 合并"                           | 用户 loadingSelectors 与默认值去重合并                          |
 * | 防协议缺失        | "连续无 REMAINING 协议 5 轮后终止"                       | consecutiveNoProtocolRounds + no_protocol 停机                  |
 * | 防自转 + 无协议   | "无 REMAINING + 重复批次"                                | 无效点击拦截 + 框架拦截视为 error 轮                            |
 * | 断轮保护          | "dom.click 强制断轮"                                     | click 后 shouldForceRoundBreak=true → 剩余工具推迟到下一轮     |
 *
 * ═══ 依赖关系 ═══
 *
 * ```
 * index.test.ts
 *   ├── engine/index.ts        → executeAgentLoop（被测对象）
 *   ├── shared/tool-registry   → ToolRegistry + ToolCallResult（测试工具注册）
 *   ├── shared/types           → AIClient / AIMessage / AIToolCall（类型定义）
 *   └── @sinclair/typebox      → Type.Object（工具 schema 定义）
 * ```
 */
import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { executeAgentLoop } from "./index.js";
import { ToolRegistry, type ToolCallResult } from "../shared/tool-registry.js";
import type { AIClient, AIChatResponse, AIMessage, AIToolCall } from "../shared/types.js";

/**
 * 模型响应的单步定义。
 *
 * 每个 step 对应一次 client.chat() 调用的返回值：
 * - text: 模型的文本输出（包含 REMAINING 协议 / SNAPSHOT_HINT 等）
 * - toolCalls: 模型请求调用的工具列表
 * - usage: token 消耗统计（用于验证 metrics 聚合）
 * - assert: 可选的运行时断言回调，在 chat() 调用时验证传入的 systemPrompt / messages
 */
type ScriptedStep = {
  text?: string;
  toolCalls?: AIToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  assert?: (params: { systemPrompt: string; messages: AIMessage[] }) => void;
};

/**
 * 可编程 AI 客户端 — 按预定义的 steps 序列返回模型响应。
 *
 * 核心设计：
 * - 每次 chat() 调用消费一个 step（index 递增）
 * - 超出 steps 长度时固定返回最后一个 step（避免越界）
 * - 支持 step.assert 回调，允许测试在运行时验证 engine 传入的消息内容
 *
 * 使用示例：
 * ```ts
 * const client = new ScriptedClient([
 *   { toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#btn" } }] },
 *   { text: "REMAINING: DONE" },
 * ]);
 * // 第 1 次 chat() → 返回工具调用
 * // 第 2 次 chat() → 返回 "REMAINING: DONE"
 * ```
 *
 * 在 v2 架构中的角色：
 * ScriptedClient 实现 AIClient 接口（shared/types.ts），
 * 是 executeAgentLoop 的 client 参数的测试替身。
 * 真实环境中此处会是 createAIClient() 创建的 Anthropic/OpenAI 等客户端。
 */
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

/**
 * 创建可配置的 page_info 工具 — 模拟浏览器的快照和 URL 读取。
 *
 * page_info 是 engine 最核心的工具依赖：
 * - action="snapshot": 返回预设的快照序列（模拟页面 DOM 变化）
 * - action="get_url": 返回当前页面 URL（由 getUrl 回调控制）
 * - action="query_all": 返回固定文本（用于 idle loop 检测）
 *
 * 快照序列设计：每次调用 snapshot 消费一个，超出后固定返回最后一个。
 * 这模拟了真实场景中每轮刷新快照后页面可能发生的变化。
 */
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

/**
 * 创建最小工具注册表 — 包含 page_info / dom / navigate 三个核心工具。
 *
 * 这是 engine 执行环境的最小集：
 * - page_info: 快照读取 + URL 读取（engine 的阶段 1 依赖）
 * - dom: DOM 操作（click / fill / get_text 等，engine 的阶段 4 主执行体）
 * - navigate: 页面导航（goto / back / forward，触发 handleNavigationUrlChange）
 *
 * 所有参数可选：不传则使用默认行为（3 个快照、固定 URL、简单成功返回）。
 * 测试用例通过覆写 domExecute / navigateExecute 来模拟各种故障场景。
 *
 * 在 v2 架构中的对照：
 * 真实环境中 registry 由 web/ 层创建，注册 10+ 个浏览器工具（dom / navigate / wait /
 * page_info / evaluate / assert 等）。测试环境只需最小集即可覆盖 engine 逻辑。
 */
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
  // ═══ 正常收敛场景 ═══

  /**
   * 场景：模型首轮即通过快照判定任务已完成，直接输出 "REMAINING: DONE - 说明"。
   *
   * 验证：
   * - REMAINING: DONE 后的尾随文本不影响收敛判定
   * - 首轮无工具调用 + DONE → converged 停机
   * - roundCount = 1, toolCalls 为空
   *
   * 对应 engine 逻辑：
   * → 阶段 3 解析 deriveNextInstruction → hasRemainingProtocol=true, nextInstruction=""
   * → 无 toolCalls 分支 → remainingInstruction="" → converged
   */
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

  /**
   * 场景：两轮正常执行 — 第 1 轮执行工具，第 2 轮模型总结并收敛。
   *
   * 验证：
   * - 工具执行成功后 toolCalls 记录完整
   * - metrics 正确聚合：roundCount / totalToolCalls / successfulToolCalls / inputTokens / outputTokens
   * - onMetrics 回调被触发一次
   *
   * 这是 engine 最基本的"执行 → 总结"两轮模式，
   * 也是 micro-task 执行的典型路径（短循环，快速收敛）。
   */
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

  // ═══ 跨轮协作场景 ═══

  /**
   * 场景：弹窗操作需要跨两轮完成 — 第 1 轮 click 打开弹窗，第 2 轮 fill 填写内容。
   *
   * 验证：
   * - 第 2 轮的 messages 中包含 assistant 角色的 "Done steps" 摘要
   * - Done steps 中包含第 1 轮执行的 "openModal" 信息
   * - 两轮共产生 2 个 toolCalls
   *
   * 对应 engine 逻辑：
   * → Round 0: click → shouldForceRoundBreak=true → 断轮
   * → Round 1: buildCompactMessages 注入 Done steps + 最新快照
   * → 模型基于新快照（弹窗已打开）决定 fill
   *
   * 这验证了 engine 的核心多轮协作能力：
   * click 触发页面变化 → 刷新快照 → 模型看到新状态 → 继续执行
   */
  it("弹窗跨轮：第2轮消息包含 Done steps 再继续执行", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#openModal" } }],
      },
      {
        assert: ({ messages }) => {
          // 验证 Round 1 的 messages 中 assistant 消息包含 Done steps
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

  // ═══ 故障恢复场景 ═══

  /**
   * 场景：dom 工具返回 ELEMENT_NOT_FOUND 错误 → engine 自动触发恢复流程。
   *
   * 验证：
   * - 工具结果被替换为 ELEMENT_NOT_FOUND_RECOVERY（恢复后的结果）
   * - metrics.recoveryCount = 1
   * - onBeforeRecoverySnapshot 回调被触发（用于恢复前的快照准备）
   *
   * 对应 engine 逻辑（保护 2: handleElementRecovery）：
   * → 检测 ELEMENT_NOT_FOUND → 等待 100ms → 刷新快照 → 重试工具调用
   * → 重试后结果标记为 ELEMENT_NOT_FOUND_RECOVERY
   * → 最多重试 2 次（DEFAULT_ACTION_RECOVERY_ROUNDS）
   *
   * 在 v2 micro-task 模式下尤其重要：
   * 微任务通常 maxRounds 较小（8 轮），浪费一轮在元素未找到上代价很高。
   * 自动恢复让工具层面解决瞬态问题，不消耗模型的决策轮次。
   */
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

  // ═══ 防空转保护 ═══

  /**
   * 场景：模型连续 2 轮只调用只读工具（get_text）→ 触发空转停机。
   *
   * 验证：
   * - 2 轮后自动停机，reply = "任务已完成。"
   * - stopReason = "idle_loop"
   *
   * 对应 engine 逻辑（保护 6: detectIdleLoop）：
   * → get_text 是只读工具（不会改变页面状态）
   * → 连续 2 轮只读 → detectIdleLoop 返回 -1 → idle_loop 停机
   *
   * 防御的实际风险：
   * 某些模型会陷入"先看看页面内容"的循环，反复调用 get_text 而不做实际操作。
   * 空转检测在 2 轮后果断停机，避免浪费 token。
   */
  it("空转终止：连续只读轮次后自动退出", async () => {
    const registry = createBaseRegistry({
      domExecute: async (params) => {
        if (params.action === "get_text") return { content: "some text" };
        return { content: "dom ok" };
      },
    });

    const client = new ScriptedClient([
      {
        toolCalls: [{ id: "1", name: "dom", input: { action: "get_text", selector: "#el1" } }],
      },
      {
        toolCalls: [{ id: "2", name: "dom", input: { action: "get_text", selector: "#el2" } }],
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
  });

  // ═══ 导航感知场景 ═══

  /**
   * 场景：模型调用 navigate.goto 跳转页面 → engine 自动刷新快照和 URL。
   *
   * 验证：
   * - 导航成功后 onBeforeRecoverySnapshot 被调用（导航触发快照刷新流程）
   * - 第 2 轮模型能正常收敛
   *
   * 对应 engine 逻辑（保护 4: handleNavigationUrlChange）：
   * → navigate 工具成功后 → 读取新 URL → 刷新快照 → 更新 pageContext
   * → 下一轮 buildCompactMessages 使用新的快照和 URL
   *
   * 在 v2 架构中的重要性：
   * 多步任务经常涉及页面跳转（如"打开项目列表 → 点击项目 → 编辑详情"），
   * 每次跳转后必须刷新快照，否则模型基于旧页面做决策。
   */
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

  // ═══ 可观测性验证 ═══

  /**
   * 场景：工具全部失败 + 多轮执行 → 验证 metrics 聚合的完整性。
   *
   * 验证：
   * - inputTokens / outputTokens 跨轮累加正确
   * - failedToolCalls / toolSuccessRate 反映真实失败率
   * - snapshotReadCount / maxSnapshotSize 反映快照读取情况
   *
   * 在 v2 架构中的重要性：
   * metrics 是 engine 对外的可观测性接口，web 层通过 onMetrics 回调获取，
   * 用于实时展示执行进度、成本统计、异常预警。
   * micro-task 模式下还会写入 MicroTaskResult.metrics 供 TaskMonitor 分析。
   */
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

  // ═══ 防自转保护 ═══

  /**
   * 场景：模型连续 3 轮返回完全相同的工具调用批次 → 渐进式防自转。
   *
   * 验证：
   * - 第 1 轮正常执行
   * - 第 2 轮注入 "Repeated action warning"（protocolViolationHint），但仍执行
   * - 第 3 轮停机（repeated_batch），不执行工具
   * - 最终 toolCalls.length = 2（仅第 1、2 轮的各 1 次 fill）
   *
   * 对应 engine 逻辑：
   * → plannedBatchKey = JSON.stringify(toolCalls) 做序列化比较
   * → consecutiveSamePlannedBatch ≥ 2: 注入提示
   * → consecutiveSamePlannedBatch ≥ 3 && !lastRoundHadError: repeated_batch 停机
   *
   * lastRoundHadError 的豁免机制：
   * 如果上轮有错误（如元素未找到），模型重试相同批次是合理的，
   * 不应在此时触发自转停机。
   */
  it("重复相同任务批次且上轮无错：先提示后终止避免自转", async () => {
    const registry = createBaseRegistry({
      domExecute: async () => ({ content: "dom ok" }),
    });

    const client = new ScriptedClient([
      {
        text: "REMAINING: 输入11并发送",
        toolCalls: [{ id: "1", name: "dom", input: { action: "fill", selector: "#input", text: "11" } }],
      },
      {
        text: "REMAINING: 输入11并发送",
        toolCalls: [{ id: "2", name: "dom", input: { action: "fill", selector: "#input", text: "11" } }],
      },
      {
        text: "REMAINING: 输入11并发送",
        toolCalls: [{ id: "3", name: "dom", input: { action: "fill", selector: "#input", text: "11" } }],
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

    expect(result.toolCalls).toHaveLength(2);
    expect(result.metrics.roundCount).toBe(3);
  });

  // ═══ 断轮保护 ═══

  /**
   * 场景：模型在同一轮返回 [click, fill] 两个工具调用 → click 触发强制断轮。
   *
   * 验证：
   * - 第 1 轮只执行 click（断轮后 fill 未执行）
   * - 第 2 轮 messages 中 "Previous executed" 只包含 click
   * - 第 2 轮 messages 中 "Previous planned" 包含 click + fill（完整计划）
   * - 模型在第 2 轮基于新快照重新决定是否执行 fill
   *
   * 对应 engine 逻辑：
   * → shouldForceRoundBreak("dom", { action: "click" }) → true
   * → 工具循环 break → fill 不执行
   * → previousRoundTasks（实际执行）vs previousRoundPlannedTasks（完整计划）分别注入
   *
   * 断轮设计意图：
   * click 可能导致页面结构变化（弹窗打开/关闭、页面跳转），
   * click 后的 fill 可能基于旧 DOM 执行导致目标不存在。
   * 强制断轮确保 fill 基于 click 后的新快照决策。
   */
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
          // Previous executed 只包含实际执行的 click
          expect(payload).toContain("Previous executed:");
          expect(payload).toContain("dom:{\"action\":\"click\",\"selector\":\"#openModal\"}");
          // Previous planned 包含完整计划（click + fill）
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

  // ═══ 启发式推进 ═══

  /**
   * 场景：模型执行了 fill 但未输出 REMAINING 协议 → engine 启发式推进剩余任务。
   *
   * 验证（通过 step.assert 在运行时验证）：
   * - Original Goal 保持不变（"输入框输入 abc 然后发送"）
   * - Remaining 被启发式推进为仅包含"发送"（"输入 abc" 部分已被剔除）
   * - Previous model output 被合成为 "REMAINING: 发送"
   *
   * 对应 engine 逻辑：
   * → 模型无 REMAINING 协议 → reduceRemainingHeuristically() 根据已执行的 fill 动作
   *   推断"输入 abc"已完成，剔除后剩余"发送"
   * → previousRoundModelOutput 被合成为 `REMAINING: ${推进后的 remaining}`
   *
   * 在 v2 多模型适配中的重要性：
   * 不是所有模型都能稳定遵循 REMAINING 协议（如 MiniMax、某些小模型），
   * 启发式推进是兜底机制，确保即使模型不输出 REMAINING 也能推进任务。
   */
  it("缺失 REMAINING 协议且本轮有执行动作：启发式推进剩余任务", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        text: "",  // 故意不输出 REMAINING 协议
        toolCalls: [{ id: "1", name: "dom", input: { action: "fill", selector: "#input", value: "abc" } }],
      },
      {
        assert: ({ messages }) => {
          const contextPayload = String(messages[messages.length - 1]?.content ?? "");
          expect(contextPayload).toContain("Original Goal: 输入框输入 abc 然后发送");
          expect(contextPayload).toContain("Remaining:");
          expect(contextPayload).toContain("发送");
          const remainingMatch = contextPayload.match(/Remaining:\s*(.+)/);
          expect(remainingMatch).not.toBeNull();
          expect(remainingMatch![1]).not.toContain("输入框输入 abc");
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

  // ═══ 协议修复 ═══

  /**
   * 场景：模型在 remaining 未完成时返回纯文本（无工具调用）→ engine 注入协议修复提示。
   *
   * 验证（3 轮执行流程）：
   * - 第 1 轮：正常执行 click + 输出 "REMAINING: 打开任务弹窗"
   * - 第 2 轮：模型只输出规划文本，无工具调用 → 触发协议修复
   * - 第 3 轮：messages 中包含 "Protocol violation in previous round" 提示
   *           + "Previous model output: REMAINING: 打开任务弹窗"
   *           模型收到提示后输出 "REMAINING: DONE" → converged
   *
   * 对应 engine 逻辑：
   * → 无 toolCalls + unresolvedRemaining → protocolViolationHint 注入
   * → lastRoundHadError = true（不触发重复批次停机）
   * → 刷新快照 → continue 进入下一轮
   *
   * 防御的实际风险：
   * 某些模型（特别是国产模型）会在任务未完成时输出"让我规划一下"的纯文本，
   * 不返回工具调用也不输出 REMAINING: DONE。协议修复提示强制模型在下一轮做出选择。
   */
  it("未完成但无工具调用：不直接结束，进入下一轮协议修复", async () => {
    const registry = createBaseRegistry();

    const client = new ScriptedClient([
      {
        text: "REMAINING: 打开任务弹窗",
        toolCalls: [{ id: "1", name: "dom", input: { action: "click", selector: "#openModal" } }],
      },
      {
        text: "根据当前快照，我先规划下步骤。",  // 纯文本，无工具调用
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

  // ═══ 快照放宽：SNAPSHOT_HINT 协议 ═══

  /**
   * 场景：模型输出 "SNAPSHOT_HINT: EXPAND_CHILDREN #1rv01x" → 下一轮快照放宽该节点。
   *
   * 验证：
   * - page_info.snapshot 调用中包含 expandChildrenRefs: ["1rv01x"]
   * - expandedChildrenLimit = 120
   *
   * 对应 engine 逻辑：
   * → parseSnapshotExpandHints(response.text) 提取 ref ID
   * → snapshotExpandRefIds.add(ref)
   * → refreshSnapshot() 传入 { expandChildrenRefs, expandedChildrenLimit: 120 }
   *
   * 应用场景：
   * 下拉列表、时间选择器等组件在快照中可能只显示 "... (N children omitted)"，
   * 模型通过 SNAPSHOT_HINT 协议请求展开特定节点的子元素。
   */
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

  // ═══ 快照放宽：scroll 自动策略 ═══

  /**
   * 场景：模型对某个 hash 节点执行 scroll，但未输出 SNAPSHOT_HINT。
   * engine 自动将该 ref 加入放宽列表。
   *
   * 验证：
   * - 即使无 SNAPSHOT_HINT，scroll 的目标 ref 也会出现在 expandChildrenRefs 中
   *
   * 对应 engine 逻辑（保护 3: scroll 自动放宽）：
   * → dom.scroll + extractHashSelectorRef(input) → ref
   * → snapshotExpandRefIds.add(ref)
   *
   * 设计意图：
   * 模型 scroll 下拉列表时，通常是为了看到更多选项。
   * 不依赖模型显式输出 SNAPSHOT_HINT（很多模型做不到），
   * engine 自动推断意图并放宽截断。
   */
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

  // ═══ 轮次后稳定等待 ═══

  /**
   * 场景：同轮执行 fill + click → 轮次结束后触发一次双重稳定等待。
   *
   * 验证：
   * - wait 工具被调用 2 次：wait_for_selector（loading 隐藏）+ wait_for_stable（DOM 安静）
   * - 即使同轮有多个 DOM 变更动作，等待屏障只触发一次（轮次级别）
   *
   * 对应 engine 逻辑（runRoundStabilityBarrier）：
   * → roundHasPotentialDomMutation = true（fill + click 都是潜在 DOM 变更）
   * → 轮次结束后调用 runRoundStabilityBarrier()
   * → 依次：wait_for_selector(loadingSelectors, hidden) → wait_for_stable(quietMs)
   *
   * 在 v2 架构中的重要性：
   * SPA 应用中 click 后页面可能需要异步加载数据。
   * 双重等待确保：1) loading 指示器消失 2) DOM 不再变化 → 快照稳定。
   */
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

  /**
   * 场景：用户传入自定义 loadingSelectors → 与 shared/constants 中的默认值合并（非覆盖）。
   *
   * 验证：
   * - wait_for_selector 的 selector 参数同时包含默认的 ".ant-spin" 和自定义的 ".custom-loading"
   * - 重复的 ".custom-loading"（含空格变体）去重后只出现一次
   *
   * 对应 engine 逻辑（effectiveRoundStabilityWait 初始化）：
   * → [...DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS, ...用户 loadingSelectors]
   * → .map(trim).filter(Boolean) → new Set() 去重
   *
   * 设计意图：
   * 不同项目使用不同 UI 框架（AntD / Element Plus / 自定义），
   * 默认值覆盖主流框架，用户可追加自定义 selector 而非替换。
   */
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

  // ═══ 防协议缺失保护 ═══

  /**
   * 场景：模型连续 5 轮有工具调用但始终不输出 REMAINING 协议，且工具全部失败。
   *
   * 验证：
   * - 第 4 轮 messages 中包含 "Protocol reminder" 和 "REMAINING protocol missing"
   * - 第 5 轮停机（no_protocol），roundCount = 5
   *
   * 对应 engine 逻辑（保护 5: consecutiveNoProtocolRounds）：
   * → 工具执行但无 REMAINING 协议 + 启发式无法推进 + 无确认性进展 → 计数 +1
   * → ≥ 3 轮：注入 "Protocol reminder" 提示
   * → ≥ 5 轮：no_protocol 停机
   *
   * 计数器重置条件：
   * - 模型遵循 REMAINING 协议 → 重置
   * - 启发式成功推进 → 重置
   * - 有确认性进展（fill/press/navigate 成功）→ 重置
   * - 快照指纹变化（click 导致真实页面变化）→ 重置
   *
   * 本用例中工具全部失败（ELEMENT_ERROR），因此计数器不被重置。
   */
  it("连续无 REMAINING 协议且启发式无法推进：5 轮后强制终止（仅失败或无 DOM 变更时计数）", async () => {
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
        text: "再试一次。",
        toolCalls: [{ id: "3", name: "dom", input: { action: "click", selector: "#btn3" } }],
      },
      {
        assert: ({ messages }) => {
          const payload = String(messages[messages.length - 1]?.content ?? "");
          expect(payload).toContain("Protocol reminder");
          expect(payload).toContain("REMAINING protocol missing");
        },
        text: "还是试试看。",
        toolCalls: [{ id: "4", name: "dom", input: { action: "click", selector: "#btn4" } }],
      },
      {
        text: "弹窗内容已查看完毕，任务完成。",
        toolCalls: [{ id: "5", name: "dom", input: { action: "click", selector: "#btn5" } }],
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

    expect(result.metrics.roundCount).toBe(5);
    expect(result.reply).toContain("任务完成");
  });

  // ═══ 无效点击拦截 + 协议缺失复合场景 ═══

  /**
   * 场景：模型重复点击同一个 #same 元素，且快照不变 → 无效点击被框架拦截。
   *
   * 验证：
   * - 第 1 轮正常执行 click
   * - 第 2 轮起 #same 被 checkIneffectiveClickRepeat 拦截（快照指纹不变 → 加入无效集合）
   * - 至少执行了 2 轮
   *
   * 对应 engine 逻辑（保护 1 + 保护 7 联动）：
   * → 保护 7: 第 1 轮 click 后快照指纹不变 → #same 加入 ineffectiveClickSelectors
   * → 保护 1: 第 2 轮 click #same → checkIneffectiveClickRepeat 返回拦截结果
   * → 拦截后 executedTaskCalls 为空 → 全轮被框架拦截 → lastRoundHadError=true
   * → 重复批次停机不在 error 轮触发 → 最终由 no_protocol 或 max_rounds 停机
   */
  it("无 REMAINING 协议但重复相同批次：先提示后停机", async () => {
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
        text: "弹窗已打开。",
        toolCalls: [{ id: "3", name: "dom", input: { action: "click", selector: "#same" } }],
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

    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.metrics.roundCount).toBeGreaterThanOrEqual(2);
  });

  // ═══ 断轮保护（click 后续动作推迟）═══

  /**
   * 场景：模型返回 [click #openDialog, fill #name] → click 触发断轮 → fill 推迟到下一轮。
   *
   * 验证：
   * - 第 1 轮 domExecute 的首次调用 action="click"
   * - 最终 toolCalls 总数 = 2（第 1 轮 click + 第 2 轮 fill）
   *
   * 与 "DOM 变更动作后强制断轮" 用例的区别：
   * 本用例验证第 2 轮模型重新返回 fill → 实际执行 → REMAINING: DONE 收敛。
   * 整个流程验证了"断轮 → 新快照 → 重新决策 → 继续执行"的完整链路。
   */
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

    const round1Executed = domExecute.mock.calls.filter(
      (_, i) => i === 0,
    );
    expect(String((round1Executed[0][0] as Record<string, unknown>).action)).toBe("click");

    expect(result.toolCalls).toHaveLength(2);
  });
});
