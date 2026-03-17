/**
 * Tool Registry — 工具注册表，负责工具的注册、查询和分发。
 *
 * 实例化设计 — 每个 Agent 创建独立的 ToolRegistry，避免全局状态污染：
 *
 *   // Node 端
 *   const registry = new ToolRegistry();
 *   registerBuiltinTools(registry);      // 注册 exec, file, browser...
 *   await executeAgentLoop({ registry, ... });
 *
 *   // Web 端
 *   const registry = new ToolRegistry();
 *   registerWebTools(registry);           // 注册 dom, navigate...
 *   await executeAgentLoop({ registry, ... });
 *
 * 优点：
 * - 多实例安全：Node Agent 和 Web Agent 可并行运行，工具列表互不干扰
 * - 测试隔离：每个 test case 创建独立 registry，无需清理全局状态
 * - 可组合：可按需注册不同工具子集
 */
import type { TObject } from "@sinclair/typebox";
export { jsonResult, readNumberParam, readStringParam } from "./tool-params.js";

/**
 * 工具执行结果 — 每个工具的 execute() 必须返回此类型。
 */
export type ToolCallResult = {
  /** 返回内容（字符串文本或结构化对象，最终会序列化后发给 AI） */
  content: string | Record<string, unknown>;
  /** 可选的额外细节（用于日志记录、调试等，不直接发给 AI） */
  details?: Record<string, unknown>;
};

/**
 * 工具定义 — 注册工具时需要提供的完整描述。
 *
 * 这四个字段分别告诉 AI「叫什么名字」「能做什么」「需要什么参数」「怎么执行」：
 * - name + description → AI 根据用户意图选择合适的工具
 * - schema → AI 生成符合格式的参数 JSON
 * - execute → 实际执行逻辑
 */
export type ToolDefinition = {
  /** 工具名称（AI 通过此名称调用，如 "exec"、"file_read"） */
  name: string;
  /** 工具描述（AI 据此判断何时使用这个工具） */
  description: string;
  /** 参数的 JSON Schema（TypeBox 定义，描述工具接受哪些参数及其类型） */
  schema: TObject;
  /** 执行函数 — 接收 AI 传入的参数，返回执行结果 */
  execute: (params: Record<string, unknown>) => Promise<ToolCallResult>;
};

/**
 * 工具注册表实例 — 管理一组工具的注册、查询和分发。
 *
 * 每个 Agent 拥有独立的 ToolRegistry 实例，从而：
 * - Node Agent 的 exec/file 工具不会泄漏到 Web Agent
 * - Web Agent 的 dom/navigate 工具不会泄漏到 Node Agent
 * - 测试中不同 case 互不影响
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** 注册一个工具 */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** 获取所有已注册的工具定义列表（发给 AI，告知可用工具） */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 按名称检查工具是否已注册。 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 按名称注销工具，返回是否删除成功。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 根据工具名分发并执行工具调用。
   * - 找到工具 → 执行 execute() → 返回结果
   * - 找不到 → 返回错误信息（不抛异常，让 AI 知道工具不存在）
   * - 执行出错 → 捕获异常，返回错误信息（不中断 Agent 循环）
   */
  async dispatch(name: string, input: unknown): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Unknown tool: ${name}`,
        details: { error: true, toolName: name },
      };
    }

    try {
      const params = (input ?? {}) as Record<string, unknown>;
      return await tool.execute(params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Tool "${name}" failed: ${message}`,
        details: { error: true, toolName: name, message },
      };
    }
  }
}
