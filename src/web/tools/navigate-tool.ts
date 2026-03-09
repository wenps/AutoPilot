/**
 * Navigate Tool — 页面导航工具（增强版）。
 *
 * 支持 5 种动作：
 *   goto    — 跳转到指定 URL
 *   back    — 浏览器后退
 *   forward — 浏览器前进
 *   reload  — 刷新当前页面
 *   scroll  — 滚动页面到指定位置或元素（支持 RefStore hash ID + 多策略对齐）
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/tool-registry.js";
import { getActiveRefStore } from "./dom-tool.js";

/** 解析 selector（支持 RefStore hash ID 和 CSS 选择器） */
function resolveElement(selector: string): Element | null {
  if (selector.startsWith("#")) {
    const store = getActiveRefStore();
    if (store) {
      const id = selector.slice(1);
      if (store.has(id)) return store.get(id) ?? null;
    }
  }
  try { return document.querySelector(selector); } catch { return null; }
}

export function createNavigateTool(): ToolDefinition {
  return {
    name: "navigate",
    description: [
      "Page navigation tool.",
      "Actions: goto, back, forward, reload, scroll.",
      "scroll supports #hashID from snapshot or CSS selector.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Navigation action name",
      }),
      url: Type.Optional(Type.String({ description: "URL for goto" })),
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
            window.location.href = url;
            return { content: `正在导航到 ${url}` };
          }

          case "back": {
            window.history.back();
            return { content: "已后退" };
          }

          case "forward": {
            window.history.forward();
            return { content: "已前进" };
          }

          case "reload": {
            window.location.reload();
            return { content: "正在刷新页面" };
          }

          case "scroll": {
            const selector = params.selector as string | undefined;

            if (selector) {
              const el = resolveElement(selector);
              if (!el) return { content: `未找到元素 "${selector}"` };
              // 尝试 scrollIntoViewIfNeeded（Chrome），回退 scrollIntoView center
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
