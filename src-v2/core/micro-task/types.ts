/**
 * micro-task 模块类型定义。
 *
 * ## 什么是微任务？
 *
 * 用户下达一个复杂指令（如 "登录后台并导出报表"），Main Agent 会将其拆解为
 * 多个**原子级微任务**，依次交给 micro-task engine 执行：
 *
 *   用户指令: "登录后台并导出报表"
 *   ┌─────────────────────────────────┐
 *   │  Main Agent 拆解为 3 个微任务:   │
 *   │  MT-1: 填写用户名和密码          │
 *   │  MT-2: 点击登录按钮              │
 *   │  MT-3: 导航到报表页并点击导出     │
 *   └─────────────────────────────────┘
 *
 * 每个微任务由一个独立的 Agent Loop 执行（点击、输入、滚动等），
 * 执行完成后产出一条 **MicroTaskExecutionRecord**，记录做了什么、成功与否。
 *
 * 所有微任务的记录串成一条 **ExecutionRecordChain**，提供两个视角：
 * - `buildPreviousContext()` — 给下一个微任务看"前面做了什么"，避免重复操作
 * - `buildEvidenceSummary()` — 给系统级断言看"整体执行了哪些步骤"，判定总任务是否完成
 *
 * ## 模块边界
 *
 * 本模块只负责 **数据结构 + 编排逻辑**，不直接操作浏览器。
 * 真正驱动页面的是 engine 模块（尚未实现），通过 `MicroTaskExecuteFn` 回调注入。
 *
 * ## 类型复用
 *
 * `MicroTaskExecutionRecord` 定义在 assertion/types.ts（断言系统的输入证据），
 * 本模块 re-export 供外部统一引用，保持单一数据源。
 */
import type {
  MicroTaskExecutionRecord,
  TaskAssertion,
  AssertionResult,
} from "../assertion/types.js";
import type { AgentLoopMetrics } from "../shared/types.js";

// ─── re-export（断言模块已定义的共享类型） ───
export type { MicroTaskExecutionRecord, TaskAssertion, AssertionResult };

// ─── 微任务描述 ───

/**
 * 微任务描述 — Main Agent 分派给 micro-task engine 的执行指令。
 *
 * Main Agent 在规划阶段生成一组 descriptor，逐个交给 TaskMonitor.execute() 执行。
 *
 * @example
 * ```ts
 * const descriptor: MicroTaskDescriptor = {
 *   id: "mt-1",
 *   task: "在用户名输入框填写 admin 并在密码框填写 123456",
 *   assertions: [
 *     { task: "用户名已填写", description: "用户名输入框的值应为 'admin'" },
 *     { task: "密码已填写", description: "密码输入框的值应为 '123456'" },
 *   ],
 *   maxRounds: 10,
 * };
 * ```
 */
export type MicroTaskDescriptor = {
  /** 微任务唯一标识（如 "mt-1"、"mt-login"） */
  id: string;
  /** 微任务目标的自然语言描述，engine 会将其作为 prompt 驱动 Agent Loop */
  task: string;
  /**
   * 微任务级断言列表（可选）。
   * 若提供，engine 执行完毕后会用断言 AI 逐条验证是否完成。
   * 若不提供，则依赖 Agent Loop 自身的收敛判定（REMAINING 协议）。
   */
  assertions?: TaskAssertion[];
  /**
   * 最大执行轮次（可选）。
   * 覆盖 engine 默认的 maxRounds（通常 40），
   * 对于简单微任务（如单次点击）可设为较小值以加速失败检测。
   */
  maxRounds?: number;
  /** 聚焦目标的 hash ref（不含 #），微任务将聚焦此节点子树而非全量快照 */
  focusRef?: string;
};

// ─── 微任务执行结果 ───

/**
 * 微任务执行结果 — engine 执行完一个微任务后返回的完整产出。
 *
 * TaskMonitor 收到结果后，会将 `executionRecord` 追加到记录链，
 * 并将整个 result 原样返回给 Main Agent 做后续决策（继续 / 重试 / 终止）。
 *
 * @example
 * ```ts
 * // 成功结果
 * const result: MicroTaskResult = {
 *   descriptor,
 *   success: true,
 *   executionRecord: {
 *     id: "mt-1",
 *     task: "填写登录表单",
 *     success: true,
 *     completedSubGoals: ["用户名已填写", "密码已填写"],
 *     actions: ['fill("#username", "admin")', 'fill("#password", "123456")'],
 *     summary: "成功填写用户名和密码",
 *   },
 *   metrics: { roundCount: 3, totalToolCalls: 4, ... },
 *   finalSnapshot: "<div id='login-form'>...</div>",
 * };
 *
 * // 失败结果
 * const failed: MicroTaskResult = {
 *   descriptor,
 *   success: false,
 *   executionRecord: { ... , success: false },
 *   metrics: { ... , stopReason: "max_rounds" },
 *   finalSnapshot: "<div id='error'>...</div>",
 *   failureReason: "用户名输入框被禁用，无法填写",
 * };
 * ```
 */
export type MicroTaskResult = {
  /** 原始任务描述（方便调用方回溯是哪个微任务） */
  descriptor: MicroTaskDescriptor;
  /** 是否成功完成微任务目标 */
  success: boolean;
  /** 执行记录 — 会被追加到 ExecutionRecordChain，包含 actions / completedSubGoals / summary 等 */
  executionRecord: MicroTaskExecutionRecord;
  /** Agent Loop 运行指标（轮次数、token 消耗、停机原因等） */
  metrics: AgentLoopMetrics;
  /** 微任务结束时的页面 DOM 快照，下一个微任务可据此判断当前页面状态 */
  finalSnapshot: string;
  /** 失败原因的自然语言描述（仅 success=false 时存在） */
  failureReason?: string;
};

// ─── 执行记录链接口 ───

/**
 * 执行记录链 — 按时间顺序管理所有已完成微任务的执行记录。
 *
 * 核心职责是将原始的 MicroTaskExecutionRecord[] 格式化为两种文本视角，
 * 分别服务于"下一个微任务的 prompt 注入"和"系统级断言的证据输入"。
 *
 * @example
 * ```ts
 * const chain = createExecutionRecordChain();
 *
 * // 微任务 1 完成后追加记录
 * chain.append({
 *   id: "mt-1", task: "填写用户名", success: true,
 *   completedSubGoals: ["输入框已填写为 admin"],
 *   actions: ['fill("#username", "admin")'],
 *   summary: "成功填写用户名",
 * });
 *
 * // 微任务 2 开始前，获取上下文注入 prompt
 * chain.buildPreviousContext();
 * // → "✅ 填写用户名: 输入框已填写为 admin"
 *
 * // 所有微任务结束后，生成系统断言的证据
 * chain.buildEvidenceSummary();
 * // → "[1] 填写用户名\n    status: success\n    completedSubGoals: 输入框已填写为 admin\n    actions: fill(\"#username\", \"admin\")"
 * ```
 */
export type ExecutionRecordChain = {
  /** 当前所有记录（只读，按追加顺序排列） */
  readonly records: readonly MicroTaskExecutionRecord[];

  /** 追加一条执行记录到链尾 */
  append(record: MicroTaskExecutionRecord): void;

  /**
   * 格式化为精简版上下文，注入到下一个微任务的 system prompt 中。
   *
   * 让执行 AI 知道"前面做过什么"，避免重复点击或填写。
   *
   * 输出格式:
   * - 空链: `"(no prior micro-tasks)"`
   * - 成功: `"✅ 填写用户名: 输入框已填写为 admin"`
   * - 失败: `"✗ 点击提交 (failed): 提交按钮未找到"`
   */
  buildPreviousContext(): string;

  /**
   * 格式化为完整证据摘要，传给系统级断言 AI 做最终判定。
   *
   * 包含每条记录的 task、status、completedSubGoals、actions、assertionResult 等，
   * 让断言 AI 能全面了解整体执行过程。
   *
   * 输出格式:
   * - 空链: `"(no execution records)"`
   * - 非空: 带编号的多行文本，每条记录包含完整执行细节
   */
  buildEvidenceSummary(): string;
};

// ─── 执行回调类型 ───

/**
 * 微任务执行回调 — TaskMonitor 通过此函数驱动实际的页面操作。
 *
 * 设计为回调而非直接依赖 engine 实例，好处：
 * - micro-task 模块不耦合 engine 实现（engine 尚未开发）
 * - 单测时传入 mock 函数即可，无需构造完整 engine
 * - engine 就绪后，在调用侧一行 lambda 即可组装
 *
 * @param descriptor - 要执行的微任务描述
 * @param previousContext - 之前微任务的精简上下文（由 buildPreviousContext() 生成）
 * @returns 微任务执行结果
 *
 * @example
 * ```ts
 * // 未来 engine 就绪后的组装方式：
 * const executeFn: MicroTaskExecuteFn = (descriptor, previousContext) =>
 *   engine.runMicroTask(descriptor, { previousContext });
 *
 * // 测试时的 mock 方式：
 * const mockExecuteFn: MicroTaskExecuteFn = async (descriptor) => ({
 *   descriptor,
 *   success: true,
 *   executionRecord: { id: descriptor.id, task: descriptor.task, ... },
 *   metrics: { ... },
 *   finalSnapshot: "<div>mock</div>",
 * });
 * ```
 */
export type MicroTaskExecuteFn = (
  descriptor: MicroTaskDescriptor,
  previousContext: string,
) => Promise<MicroTaskResult>;
