/**
 * Wait Tool — 页面条件等待工具定义与分发。
 *
 * 职责：
 *   本文件只负责等待工具的 schema 定义和 action 分发，
 *   底层轮询和状态判定逻辑委托至 helpers/actions/wait-helpers。
 *
 * 支持 5 种动作：
 *   wait_for_selector — 等待选择器达到指定状态（支持 attached/visible/hidden/detached 四种状态）
 *                       实现：MutationObserver 监听 + 轮询双通道，先到先返回
 *   wait_for_hidden   — wait_for_selector state=hidden 的语法糖，等待元素隐藏或从 DOM 移除
 *   wait_for_text     — 等待页面中出现指定文本（全局 MutationObserver 监听 characterData/childList）
 *   wait_for_stable   — 等待 DOM 进入静默窗口（默认 500ms 无 mutation 视为稳定）
 *   wait_for_timeout  — 固定时长等待（类似 Playwright waitForTimeout，用于动画/延迟加载等场景）
 *
 * 选择器解析：
 *   #hashID（如 #1kry9hw）优先通过 RefStore 解析为 DOM 元素，
 *   CSS 选择器作为兼容回退。与 dom-tool 共享同一 resolveSelector 逻辑。
 *
 * 依赖结构：
 *   helpers/actions/wait-helpers — evaluateSelectorState, waitForSelectorState, waitForText, waitForDomStable
 *
 * 运行环境：浏览器 Content Script（直接访问 DOM，无 CDP）。
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import type { SelectorState } from "../helpers/actions/wait-helpers.js";
import {
  DEFAULT_TIMEOUT,
  waitForSelectorState,
  waitForText,
  waitForDomStable,
} from "../helpers/actions/wait-helpers.js";

export function createWaitTool(): ToolDefinition {
  return {
    name: "wait",
    description: [
      "Wait for page conditions.",
      "Actions: wait_for_selector, wait_for_hidden, wait_for_text, wait_for_stable, wait_for_timeout.",
      "wait_for_selector supports attached, visible, hidden, detached.",
      "wait_for_timeout: sleep for a fixed duration (timeout in ms). Use this when you need to wait a specific amount of time.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Wait action name",
      }),
      selector: Type.Optional(
        Type.String({ description: "Selector for wait_for_selector/wait_for_hidden" }),
      ),
      state: Type.Optional(
        Type.String({ description: "Selector state: attached | visible | hidden | detached" }),
      ),
      text: Type.Optional(
        Type.String({ description: "Text to wait for" }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in ms" }),
      ),
      quietMs: Type.Optional(
        Type.Number({ description: "Quiet window in ms" }),
      ),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;
      const timeoutMs = (params.timeout as number) ?? DEFAULT_TIMEOUT;

      try {
        switch (action) {
          case "wait_for_selector": {
            const selector = params.selector as string;
            if (!selector) return { content: "缺少 selector 参数" };
            const state = (params.state as SelectorState | undefined) ?? "attached";
            if (!["attached", "visible", "hidden", "detached"].includes(state)) {
              return { content: `无效 state: ${state}` };
            }
            const result = await waitForSelectorState(selector, state, timeoutMs);
            if (state === "attached" || state === "visible") {
              const tag = result.element?.tagName?.toLowerCase();
              return { content: `元素 "${selector}" 已达到状态 "${state}"${tag ? ` (${tag})` : ""}` };
            }
            return { content: `元素 "${selector}" 已达到状态 "${state}"` };
          }

          case "wait_for_hidden": {
            const selector = params.selector as string;
            if (!selector) return { content: "缺少 selector 参数" };
            await waitForSelectorState(selector, "hidden", timeoutMs);
            return { content: `元素 "${selector}" 已隐藏或消失` };
          }

          case "wait_for_text": {
            const text = params.text as string;
            if (!text) return { content: "缺少 text 参数" };
            await waitForText(text, timeoutMs);
            return { content: `文本 "${text}" 已出现` };
          }

          case "wait_for_stable": {
            const quietMs = Math.max(50, Math.floor((params.quietMs as number) ?? 300));
            await waitForDomStable(timeoutMs, quietMs);
            return { content: `页面已稳定（静默窗口 ${quietMs}ms）` };
          }

          case "wait_for_timeout": {
            const ms = Math.max(0, Math.floor(timeoutMs));
            await new Promise<void>((resolve) => setTimeout(resolve, ms));
            return { content: `已等待 ${ms}ms` };
          }

          default:
            return { content: `未知的等待动作: ${action}` };
        }
      } catch (err) {
        return {
          content: `等待操作 "${action}" 失败: ${err instanceof Error ? err.message : String(err)}`,
          details: { error: true, action },
        };
      }
    },
  };
}
