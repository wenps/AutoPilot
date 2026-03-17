/**
 * Page Info Tool — 页面信息获取工具。
 *
 * 职责：
 *   提供页面元信息查询和快照动作分发，负责 schema 定义与 action 路由。
 *   快照序列化引擎已从本文件剥离到 `src/web/snapshot.ts`。
 *
 * 动作说明：
 *   - 对 AI 可见动作：get_url / get_title / get_selection / get_viewport / query_all
 *   - 框架内部动作：snapshot（由 Agent Loop 自动调用，AI 不应主动调用）
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolCallResult } from "../../core/shared/tool-registry.js";
import { getActiveRefStore } from "../helpers/base/active-store.js";
import { generateSnapshot } from "../../core/shared/snapshot/index.js";

/**
 * 查询所有匹配元素并返回摘要信息（标签、文本、关键属性）。
 */
function queryAllElements(selector: string, limit = 20): string {
  try {
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) return `未找到匹配 "${selector}" 的元素`;

    const results: string[] = [`找到 ${elements.length} 个元素：`];
    const count = Math.min(elements.length, limit);

    for (let i = 0; i < count; i++) {
      const el = elements[i];
      const tag = el.tagName.toLowerCase();
      const text = el.textContent?.trim().slice(0, 60) ?? "";
      const id = el.id ? `#${el.id}` : "";
      const cls = el.className && typeof el.className === "string"
        ? `.${el.className.split(" ").filter(Boolean).join(".")}`
        : "";
      results.push(`  ${i + 1}. <${tag}${id}${cls}> "${text}"`);
    }

    if (elements.length > limit) {
      results.push(`  ...还有 ${elements.length - limit} 个元素`);
    }

    return results.join("\n");
  } catch {
    return `选择器语法错误: ${selector}`;
  }
}

export function createPageInfoTool(): ToolDefinition {
  return {
    name: "page_info",
    description: [
      "Page information tool.",
      "Actions: get_url, get_title, get_selection, get_viewport, query_all.",
    ].join(" "),

    schema: Type.Object({
      action: Type.String({
        description: "Page info action name",
      }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector for query_all" }),
      ),
      maxDepth: Type.Optional(
        Type.Number({ description: "Snapshot max depth" }),
      ),
      viewportOnly: Type.Optional(
        Type.Boolean({ description: "Snapshot only visible elements" }),
      ),
      pruneLayout: Type.Optional(
        Type.Boolean({ description: "Collapse empty layout containers" }),
      ),
      maxNodes: Type.Optional(
        Type.Number({ description: "Snapshot max nodes" }),
      ),
      maxChildren: Type.Optional(
        Type.Number({ description: "Snapshot max children per node" }),
      ),
      maxTextLength: Type.Optional(
        Type.Number({ description: "Snapshot max text length" }),
      ),
      expandOptionLists: Type.Optional(
        Type.Boolean({ description: "Expand option/list containers" }),
      ),
      expandChildrenRefs: Type.Optional(
        Type.Array(Type.String({ description: "#hashIDs to expand children for" })),
      ),
      expandedChildrenLimit: Type.Optional(
        Type.Number({ description: "Expanded child limit" }),
      ),
      listenerEvents: Type.Optional(
        Type.Array(Type.String({ description: "Snapshot listener event whitelist" })),
      ),
    }),

    execute: async (params): Promise<ToolCallResult> => {
      const action = params.action as string;

      try {
        switch (action) {
          case "get_url":
            return { content: window.location.href };

          case "get_title":
            return { content: document.title || "(无标题)" };

          case "get_selection": {
            // 获取用户当前选中的文本
            const selection = window.getSelection();
            const text = selection?.toString().trim() ?? "";
            return { content: text || "(未选中任何文本)" };
          }

          case "get_viewport": {
            // 获取视口和滚动信息
            const info = {
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              pageWidth: document.documentElement.scrollWidth,
              pageHeight: document.documentElement.scrollHeight,
            };
            return { content: JSON.stringify(info, null, 2) };
          }

          case "snapshot": {
            // 框架内部动作：生成 DOM 快照（AI 不应主动调用）
            const maxDepth = (params.maxDepth as number) ?? 12;
            const viewportOnly = (params.viewportOnly as boolean) ?? true;
            const pruneLayout = (params.pruneLayout as boolean) ?? true;
            const maxNodes = (params.maxNodes as number) ?? 220;
            const maxChildren = (params.maxChildren as number) ?? 25;
            const maxTextLength = (params.maxTextLength as number) ?? 40;
            const expandOptionLists = (params.expandOptionLists as boolean) ?? false;
            const expandChildrenRefs = Array.isArray(params.expandChildrenRefs)
              ? (params.expandChildrenRefs as unknown[]).filter((ref): ref is string => typeof ref === "string")
              : undefined;
            const expandedChildrenLimit = typeof params.expandedChildrenLimit === "number"
              ? params.expandedChildrenLimit as number
              : undefined;
            const listenerEvents = Array.isArray(params.listenerEvents)
              ? (params.listenerEvents as unknown[]).filter((event): event is string => typeof event === "string")
              : undefined;
            const snapshot = generateSnapshot(document.body, {
              maxDepth,
              viewportOnly,
              pruneLayout,
              maxNodes,
              maxChildren,
              maxTextLength,
              expandOptionLists,
              expandChildrenRefs,
              expandedChildrenLimit,
              listenerEvents,
              refStore: getActiveRefStore(),
            });
            return { content: snapshot };
          }

          case "query_all": {
            // 查询所有匹配元素
            const selector = params.selector as string;
            if (!selector) return { content: "缺少 selector 参数" };
            return { content: queryAllElements(selector) };
          }

          default:
            return { content: `未知的页面信息动作: ${action}` };
        }
      } catch (err) {
        return {
          content: `页面信息操作 "${action}" 失败: ${err instanceof Error ? err.message : String(err)}`,
          details: { error: true, action },
        };
      }
    },
  };
}
