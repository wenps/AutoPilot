/**
 * Navigate Tool — 页面导航工具定义与分发。
 *
 * 职责：
 *   本文件负责导航相关工具的 schema 定义和 action 分发。
 *   导航动作可能引发 DOM 结构变化，Agent Loop 层会在执行后断轮等待新快照。
 *
 * 支持 5 种动作：
 *   goto    — 在新标签页打开指定 URL（window.open，不销毁当前 Agent 上下文）
 *   back    — 浏览器后退（history.back()，SPA 路由级，不触发整页刷新）
 *   forward — 浏览器前进（history.forward()，同上）
 *   scroll  — 页面级/元素级滚动（支持 #hashID / CSS 选择器定位 + scrollIntoView 多策略对齐）
 *   reload  — 已禁用，调用时返回错误提示（整页刷新会销毁 Agent 上下文）
 *
 * 与 dom.scroll 的区别：
 *   navigate.scroll — 页面/容器级定位滚动（通过 selector 定位目标或 x/y 绝对坐标）
 *   dom.scroll     — 元素内滚动（通过 deltaY/deltaX 增量 + steps 循环，适配虚拟列表）
 *
 * 依赖结构：
 *   helpers/base/resolve-selector — 解析 #hashID 和 CSS 选择器
 *
 * 运行环境：浏览器 Content Script（直接访问 DOM，无 CDP）。
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import { resolveSelector } from "../helpers/base/resolve-selector.js";

export function createNavigateTool(): ToolDefinition {
  return {
    name: "navigate",
    description: [
      "Page navigation tool.",
      "Actions: goto, back, forward, scroll.",
      "goto opens URL in a new tab (current page stays intact).",
      "back/forward use browser history (SPA-safe).",
      "scroll supports #hashID from snapshot or CSS selector.",
      "reload is NOT available — it would destroy the agent context.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Navigation action name",
      }),
      url: Type.Optional(Type.String({ description: "URL for goto (opens in new tab)" })),
      selector: Type.Optional(
        Type.String({ description: "#hashID or CSS selector for scroll" }),
      ),
      x: Type.Optional(Type.Number({ description: "Horizontal scroll position" })),
      y: Type.Optional(Type.Number({ description: "Vertical scroll position" })),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;

      try {
        switch (action) {
          case "goto": {
            const url = params.url as string;
            if (!url) return { content: "缺少 url 参数" };
            window.open(url, "_blank", "noopener,noreferrer");
            return { content: `已在新标签页打开 ${url}` };
          }

          case "reload":
            return {
              content: "reload is not supported — it would destroy the agent context. If the page is stuck, try clicking a navigation element or using back/forward.",
              details: { error: true, action },
            };

          case "back": {
            window.history.back();
            return { content: "已后退" };
          }

          case "forward": {
            window.history.forward();
            return { content: "已前进" };
          }

          case "scroll": {
            const selector = params.selector as string | undefined;

            if (selector) {
              const el = resolveSelector(selector);
              if (!el) return { content: `未找到元素 "${selector}"` };
              if ("scrollIntoViewIfNeeded" in el) {
                (el as HTMLElement & { scrollIntoViewIfNeeded: (c?: boolean) => void }).scrollIntoViewIfNeeded(true);
              } else {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
              }
              return { content: `已滚动到元素 "${selector}"` };
            }

            const x = (params.x as number) ?? 0;
            const y = (params.y as number) ?? 0;
            window.scrollTo({ left: x, top: y, behavior: "smooth" });
            return { content: `已滚动到 (${x}, ${y})` };
          }

          default:
            return { content: `未知的导航动作: ${action}` };
        }
      } catch (err) {
        return {
          content: `导航操作 "${action}" 失败: ${err instanceof Error ? err.message : String(err)}`,
          details: { error: true, action },
        };
      }
    },
  };
}
