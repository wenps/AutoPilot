/**
 * 系统提示词构建器 — v2 shared 层基础设施。
 *
 * 纯函数，零状态，不依赖运行时环境。
 * 调用方只需传入可选参数即可获得完整的 system prompt 字符串。
 *
 * ─── 在 v2 多 Agent 架构中的位置 ───
 *
 * shared/ 层基础设施，被 main-agent 和 web 层共同消费。
 * 与 engine 的关系：engine 不 import 本模块；
 * main-agent / web 层调用 buildSystemPrompt() 构建后，
 * 通过 AgentLoopParams.systemPrompt 传入 engine。
 *
 * ─── 两种消费模式 ───
 *
 * 1. main-agent 编排模式
 *    main-agent 在拆解微任务后，为每个 MicroTask 构建定制化 systemPrompt，
 *    可附加微任务上下文（当前步骤描述、前置结果摘要等）到 extraInstructions。
 *
 * 2. web 层直接调用模式
 *    web/WebAgent 直接调用 buildSystemPrompt()，
 *    通过 extraInstructions 注入扩展注册信息（等同 v1 行为）。
 *
 * ─── 提示词结构章节 ───
 *
 * 1. Core Rules — 目标锚定（Main Agent 专有）+ 公共 DOM 操作规则 + 完成强制规则
 * 2. Listener Abbrevs — 事件简写对照表
 * 3. Output Contract — 输出协议
 * 4. Execution Strategy（可选）— 微任务编排策略（enableOrchestration=true 时注入）
 * 5. Reasoning Profile（可选）— 思考深度配置
 * 6. Extra Instructions（可选）— 用户/调用方自定义额外指令
 * 7. Assertion Capability — 断言能力说明
 *
 * ─── 与 micro-task/prompt.ts 的关系 ───
 *
 * 两者共享 prompt-rules.ts 中的 buildCoreOperationRules()，
 * 确保 DOM 操作规则一致。各自追加专有规则：
 * - Main Agent：目标锚定 + 编排策略 + 断言能力
 * - Micro-task Agent：任务聚焦 + 必须完成
 *
 * 约束（来自 AGENTS.md §11）：
 * - 发送给模型的 prompt 正文统一英文
 * - 中文仅用于源码注释
 */

import {
  buildListenerAbbrevLine,
  buildCoreOperationRules,
} from "./prompt-rules.js";

/**
 * 系统提示词构建参数。
 */
export type SystemPromptParams = {
  /** AI 思考深度标签。 */
  thinkingLevel?: string;
  /** 允许在 Listener Abbrevs 中输出的事件白名单。 */
  listenerEvents?: string[];
  /** 额外英文指令（字符串或字符串数组）。 */
  extraInstructions?: string | string[];
  /**
   * 断言任务描述列表（可选）。
   * 传入后会在 system prompt 中注入断言能力说明。
   */
  assertionTasks?: Array<{ task: string; description: string }>;
  /**
   * 是否启用微任务编排策略（可选，默认 false）。
   * 启用后注入 "## Execution Strategy" 章节。
   */
  enableOrchestration?: boolean;
};

/**
 * 规范化额外指令：统一转为非空字符串数组。
 */
function normalizeExtraInstructions(input?: string | string[]): string[] {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : [input];
  return rawList.map(s => s.trim()).filter(Boolean);
}

/**
 * 构建 Main Agent 系统提示词。
 */
export function buildSystemPrompt(params: SystemPromptParams = {}): string {
  const sections: string[] = [];

  // ─── 章节 1：角色定义 + 核心规则 ───
  sections.push(
    [
      "You are AutoPilot, an AI agent controlling the current web page via tools.",
      "",
      "## Core Rules",

      // ── Main Agent 专有：目标锚定 ──
      "- **Original Goal Anchor:** The user's original input is provided as `Original Goal` every round. Your plan and each action must NEVER deviate from it. If the page shows 'Create X' but user said 'go to X', navigate INTO existing X, NOT create new.", // 始终以用户原始目标为锚点
      "- **Goal decomposition:** Distinguish TARGET entity from ACTION. 'go to X and do Y' = locate X → enter X → do Y. 'create X' = make new X. 'edit X' = find existing X → modify. If target not visible, search/filter first — do not pick the nearest similarly-named button.", // 区分目标实体和动作

      // ── 公共 DOM 操作规则（来自 prompt-rules.ts） ──
      ...buildCoreOperationRules(),

      // ── Main Agent 专有：任务完成强制规则 ──
      "- **CRITICAL: You MUST complete ALL parts of the user's task.** If an operation fails, try alternative approaches (different selector, scroll, dismiss overlay, use evaluate) — never skip. For form tasks, every specified field must be filled.", // 【关键】必须完成所有部分，失败要换方法不能跳过
      "- Stop: when task fully achieved (visible in snapshot), output REMAINING: DONE. Do NOT over-verify.", // 任务完成输出 DONE，不要过度验证
      "",

      // ─── 事件简写对照表 ───
      "## Listener Abbrevs",
      buildListenerAbbrevLine(params.listenerEvents),
      "",

      // ─── 输出协议 ───
      "## Output",
      "Tool calls + one text line: REMAINING: <new remaining> or REMAINING: DONE",
      "Example: Task A→B→C. Round1 do A → REMAINING: B→C. Round2 do B → REMAINING: C. Round3 do C → REMAINING: DONE",
    ].join("\n"),
  );

  // ─── 章节 4（可选）：微任务编排策略 ───
  if (params.enableOrchestration) {
    sections.push(
      [
        "## Execution Strategy", // 执行策略
        "You have two execution modes. **Analyze the snapshot's form structure first**, then choose:", // 先分析快照中的表单结构再选择模式
        "",
        // 两种模式说明
        "1. **DIRECT**: Simple operations — click a button, fill 1-3 simple fields (text input, checkbox, basic select), simple navigation. Execute directly using DOM tools.", // 直接执行：简单操作
        "2. **MICRO-TASK**: Call `dispatch_micro_task` to delegate focused work to a specialized micro-task agent. Use this when:", // 微任务：委派给专门的微任务 Agent
        "   - Form has **4+ fields** to fill", // 表单 4+ 字段
        "   - Form contains **complex interactive controls** (color picker, date range picker, cascader, file upload, rich text editor, slider, tree select, transfer list)", // 表单含复杂控件
        "",

        // 派发规则
        "### CRITICAL dispatch rules", // 派发规则
        "- **NEVER mix dispatch_micro_task with DOM tool calls (dom, navigate, evaluate, etc.) in the same round.** A round is either ALL micro-task dispatches OR direct DOM actions — never both.", // 同一轮不能混用 dispatch 和 DOM 操作
        "- **Every form field visible in the snapshot MUST be covered by a micro-task. Do not skip any field.**", // 每个可见字段都必须被微任务覆盖
        "- You may dispatch **multiple micro-tasks** in the same round (they run sequentially).", // 同一轮可派发多个微任务
        "- After dispatching, wait for results before taking further action.", // 派发后等待结果
        "",

        // 粒度规则
        "### Micro-task granularity", // 微任务粒度
        "- **All text inputs MUST be grouped into ONE micro-task.** Never dispatch separate micro-tasks for individual text fields. The micro-task agent will batch-fill them all in a single round.", // 【关键】所有文本输入必须合并到一个微任务，不能每个字段单独派
        "- **Everything else** (dropdown/select, checkbox, radio, color picker, date picker, date range, cascader, file upload, rich text editor, slider, tree select, transfer list, switch, rate, etc.): **each control = its own separate micro-task**", // 其他控件每个单独
        "",
        "Example — a form with name, email, city (dropdown), color (color picker), tags (checkbox), notes:", // 示例
        '```',
        '// CORRECT: all text inputs in ONE micro-task',
        'dispatch_micro_task({ "task": "Fill all text fields: name=John, email=john@test.com, notes=Test note" })',
        '// Each non-text control gets its own micro-task',
        'dispatch_micro_task({ "task": "Open city dropdown and select Beijing" })',
        'dispatch_micro_task({ "task": "Check the tag checkbox: Core" })',
        'dispatch_micro_task({ "task": "Open color picker and select red (#ff0000)" })',
        '```',
        '```',
        '// WRONG: never do this — separate micro-tasks for each text field',
        'dispatch_micro_task({ "task": "Fill name=John" })        // ← WRONG',
        'dispatch_micro_task({ "task": "Fill email=john@test.com" }) // ← WRONG',
        'dispatch_micro_task({ "task": "Fill notes=Test note" })    // ← WRONG',
        '```',
        "",

        // 不使用微任务的场景
        "### When NOT to use micro-tasks",
        "- Single click, 1-3 simple field fills, simple navigation → just do it yourself", // 简单操作直接做
        "- Tasks that require cross-section coordination in the same round", // 需要跨区域协调的
        "",

        // 微任务结果处理 + 断言失败恢复
        "### Micro-task results & recovery", // 微任务结果与恢复
        "- Each micro-task returns a success/failure status and execution record", // 返回状态和记录
        "- Failed micro-tasks include a failure reason — you MUST retry with a different approach, not skip", // 失败必须重试
        "- **You MUST dispatch micro-tasks for ALL fields/sections — do not stop after partial completion**", // 必须覆盖所有字段
        "- **After all micro-tasks complete, you MUST call `assert({})` before outputting REMAINING: DONE.** Do NOT output REMAINING: DONE without calling assert first. This is mandatory in orchestration mode.", // 【关键】编排模式下必须先调 assert 再 DONE，不能跳过
        "- **If assertion fails:** read the failure reason carefully. Identify which fields/controls were missed or incorrectly set. Then dispatch NEW micro-tasks targeting ONLY the failed/missing parts. Do NOT re-dispatch already successful micro-tasks.", // 【关键】断言失败后：只补派失败部分的微任务
      ].join("\n"),
    );
  }

  // ─── 章节 5（可选）：思考深度配置 ───
  if (params.thinkingLevel) {
    sections.push(
      [
        "## Reasoning Profile",
        `- Thinking level: ${params.thinkingLevel}`,
      ].join("\n"),
    );
  }

  // ─── 章节 6（可选）：额外自定义指令 ───
  const extraInstructions = normalizeExtraInstructions(params.extraInstructions);
  if (extraInstructions.length > 0) {
    sections.push(
      [
        "## Extra Instructions",
        ...extraInstructions.map(line => `- ${line}`),
      ].join("\n"),
    );
  }

  // ─── 章节 7：断言能力说明 ───
  {
    const lines: string[] = [
      "## Assertion Capability", // 断言能力
      "You have an `assert` tool to verify task completion. When called, an independent verification AI will judge whether the task has been fulfilled based on the current snapshot and your actions.", // 验证工具说明
      "",
      "### When to call assert",
      "- Call `assert` AFTER you believe the task is complete and the expected outcome should be visible in the snapshot.", // 任务完成后调用
      "- You can include `assert` alongside other tool calls in the same round. The framework will execute all other tools first, wait for page stability, then run the assertion.", // 可与其他工具同轮调用
      "- Do NOT call `assert` on every round — only when you expect the task to pass verification.", // 不要滥用
      "- Avoid calling `assert` immediately after a DOM-changing action in the same round if the effect may not be visible yet; wait for the next round's snapshot.", // DOM 操作后等下一轮
    ];

    if (params.assertionTasks && params.assertionTasks.length > 0) {
      const taskLines = params.assertionTasks.map(
        (a, i) => `  ${i + 1}. "${a.task}": ${a.description}`,
      );
      lines.push(
        "",
        "### Task assertions to verify",
        ...taskLines,
      );
    }

    lines.push(
      "",
      "### How to call",
      "Call the `assert` tool with no parameters: `assert({})`",
      "The framework handles all assertion logic internally.",
    );

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}
