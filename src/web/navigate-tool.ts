/**
 * Navigate Tool — 基于 Web API 的页面导航工具。
 *
 * 替代 Playwright 的 goto/goBack/goForward/reload。
 * 运行环境：浏览器 Content Script。
 *
 * 支持 5 种动作：
 *   goto    — 跳转到指定 URL
 *   back    — 浏览器后退
 *   forward — 浏览器前进
 *   reload  — 刷新当前页面
 *   scroll  — 滚动页面到指定位置或元素
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../core/tool-registry.js";

export function createNavigateTool(): ToolDefinition {
  return {
    name: "navigate",
    description: [
      "Navigate the current page.",
      "Actions: goto (open URL), back, forward, reload, scroll (to position or element).",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Navigation action: goto | back | forward | reload | scroll",
      }),
      url: Type.Optional(Type.String({ description: "URL for goto action" })),
      selector: Type.Optional(
        Type.String({ description: "CSS selector for scroll action (scrolls element into view)" }),
      ),
      x: Type.Optional(Type.Number({ description: "Horizontal scroll position (pixels)" })),
      y: Type.Optional(Type.Number({ description: "Vertical scroll position (pixels)" })),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;

      try {
        switch (action) {
          case "goto": {
            // 跳转到指定 URL
            const url = params.url as string;
            if (!url) return { content: "缺少 url 参数" };

            // 支持相对路径和绝对路径
            window.location.href = url;
            return { content: `正在导航到 ${url}` };
          }

          case "back": {
            // 浏览器后退（等同于点击后退按钮）
            window.history.back();
            return { content: "已后退" };
          }

          case "forward": {
            // 浏览器前进
            window.history.forward();
            return { content: "已前进" };
          }

          case "reload": {
            // 刷新当前页面
            window.location.reload();
            return { content: "正在刷新页面" };
          }

          case "scroll": {
            // 滚动页面：优先滚动到元素，否则滚动到坐标
            const selector = params.selector as string | undefined;

            if (selector) {
              const el = document.querySelector(selector);
              if (!el) return { content: `未找到元素 "${selector}"` };
              el.scrollIntoView({ behavior: "smooth", block: "center" });
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
