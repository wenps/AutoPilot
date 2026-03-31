/**
 * 微任务专用提示词构建器。
 *
 * ─── 与 shared/system-prompt.ts 的关系 ───
 *
 * 两者共享 shared/prompt-rules.ts 中的 buildCoreOperationRules()，
 * 确保 DOM 操作规则（快照驱动、点击、批量操作、轮次管理等）完全一致。
 *
 * | 维度 | Main Agent (buildSystemPrompt) | Micro-task (buildMicroTaskPrompt) |
 * |------|-------------------------------|----------------------------------|
 * | 角色 | "AutoPilot" 全能指挥官        | "Micro-task Agent" 聚焦执行者     |
 * | 专有规则 | 目标锚定 + 编排策略 + 断言   | 任务聚焦 + 必须完成              |
 * | 公共规则 | buildCoreOperationRules()    | buildCoreOperationRules()        |
 * | 上下文 | 用户完整指令                  | 微任务描述 + Previously completed |
 *
 * ─── 在 v2 架构中的位置 ───
 *
 * ```
 * core/
 * ├── shared/
 * │   ├── prompt-rules.ts      ← 公共规则（两种 Agent 共用）
 * │   └── system-prompt.ts     ← Main Agent 使用
 * ├── micro-task/
 * │   ├── prompt.ts            ← 【当前文件】Micro-task Agent 使用
 * │   ├── types.ts
 * │   ├── record.ts
 * │   └── task-monitor.ts
 * └── main-agent/
 *     └── dispatch.ts          ← 调用本模块构建微任务 prompt
 * ```
 */

import {
  buildListenerAbbrevLine,
  buildCoreOperationRules,
} from "../shared/prompt-rules.js";

/**
 * 微任务提示词构建参数。
 */
export type MicroTaskPromptParams = {
  /** 微任务目标描述（自然语言） */
  task: string;
  /**
   * 之前已完成的微任务上下文（由 ExecutionRecordChain.buildPreviousContext() 生成）。
   * 空链时值为 "(no prior micro-tasks)"。
   */
  previouslyCompleted: string;
  /** 允许在 Listener Abbrevs 中输出的事件白名单（可选） */
  listenerEvents?: string[];
  /** AI 思考深度标签（可选） */
  thinkingLevel?: string;
};

/**
 * 构建微任务专用系统提示词。
 *
 * 输出结构：
 * 1. Role — 角色定义 + 任务聚焦
 * 2. Your Task — 当前微任务目标
 * 3. Previously Completed — 之前微任务执行记录
 * 4. Core Rules — 公共 DOM 操作规则 + 微任务专有完成规则
 * 5. Listener Abbrevs — 事件简写
 * 6. Output — 输出协议
 * 7. Reasoning Profile（可选）
 */
export function buildMicroTaskPrompt(params: MicroTaskPromptParams): string {
  const sections: string[] = [];

  sections.push(
    [
      // ─── 角色 + 任务 + 上下文 ───
      "You are a Micro-task Agent of AutoPilot.", // 微任务 Agent
      "You execute ONE specific task on the current page via DOM tools.", // 通过 DOM 工具执行一个具体任务
      "Focus ONLY on your assigned task — ignore other parts of the page that are not related to it.", // 只专注于分配的任务
      "",

      "## Your Task",
      params.task,
      "",

      "## Previously Completed",
      params.previouslyCompleted,
      "",

      // ─── 核心规则 = 公共规则 + 微任务专有规则 ───
      "## Core Rules",

      // 公共 DOM 操作规则（来自 prompt-rules.ts，与 Main Agent 一致）
      ...buildCoreOperationRules(),

      // ── 微任务专有：必须完成规则 ──
      "- **You MUST complete your entire assigned task.** Do not output REMAINING: DONE until every part is finished. If an operation encounters difficulty (element not visible, popup overlay blocking, unexpected state), try different approaches (alternative selector, scroll into view, dismiss overlay, use evaluate tool) instead of skipping. For form fields, every field in your task description must be filled.", // 【关键】必须完成全部任务，遇到困难换方法不能跳过
      "- Stop: when remaining task is fully achieved (confirmed in snapshot), output REMAINING: DONE with a summary.", // 任务完成输出 DONE
      "",

      // ─── 事件简写 ───
      "## Listener Abbrevs",
      buildListenerAbbrevLine(params.listenerEvents),
      "",

      // ─── 输出协议 ───
      "## Output",
      "Tool calls + one text line: REMAINING: <new remaining> or REMAINING: DONE",
    ].join("\n"),
  );

  // ─── 思考深度（可选） ───
  if (params.thinkingLevel) {
    sections.push(
      ["## Reasoning Profile", `- Thinking level: ${params.thinkingLevel}`].join(
        "\n",
      ),
    );
  }

  return sections.join("\n\n");
}
