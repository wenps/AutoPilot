/**
 * 断言系统类型定义。
 *
 * 断言是 AI 驱动的任务完成验证机制：
 * - 执行 AI（主循环）主动调用 assert 工具触发断言
 * - 断言 AI（独立调用，专用 prompt，不带 tools）判定任务是否完成
 * - 判定依据：当前快照 + 已执行操作 + 断言描述
 *
 * 两层断言：
 * 1. 任务断言（TaskAssertion）：针对单个子任务的完成条件描述
 * 2. 总断言：所有任务断言都通过 = 整体任务完成
 *
 * 触发时机：
 * - AI 通过 assert 工具主动触发（可与其他工具调用一起返回）
 * - 若 assert 与其他工具一起返回，先执行其他工具、等待稳定后再发起断言
 *
 * Design: AI-driven assertion — the execution AI actively calls assert tool,
 * which triggers an independent AI judge (dedicated prompt, no tools) to verify
 * task completion based on snapshot + actions + assertion descriptions.
 */

// ─── 任务断言 ───

/**
 * 单条任务断言 —— 描述一个子任务的完成条件。
 *
 * @example
 * ```ts
 * { task: "满意度选五星", description: "满意度评分组件应显示 5 个激活状态的星星（is-active）" }
 * { task: "填写用户名", description: "用户名输入框的值应为 'admin'" }
 * ```
 */
export type TaskAssertion = {
  /** 子任务名称（对应用户指令中的某个步骤） */
  task: string;
  /** 完成条件的自然语言描述（发给断言 AI 判定） */
  description: string;
};

// ─── 断言配置 ───

/**
 * 断言配置 —— 传入 chat() 或 executeAgentLoop() 的断言参数。
 */
export type AssertionConfig = {
  /** 任务断言列表（每个子任务的完成条件） */
  taskAssertions: TaskAssertion[];
};

// ─── 断言结果 ───

/**
 * 单条任务断言的判定结果。
 */
export type TaskAssertionResult = {
  /** 对应的任务名称 */
  task: string;
  /** 是否通过 */
  passed: boolean;
  /** 断言 AI 的判定理由 */
  reason: string;
};

/**
 * 一次断言评估的完整结果。
 */
export type AssertionResult = {
  /** 是否所有任务断言都通过（总断言） */
  allPassed: boolean;
  /** 任务断言总数 */
  total: number;
  /** 通过数 */
  passed: number;
  /** 失败数 */
  failed: number;
  /** 每条任务断言的详细结果 */
  details: TaskAssertionResult[];
};
