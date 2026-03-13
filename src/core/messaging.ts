/**
 * Web Tools 消息通信桥接层。
 *
 * 解决 Chrome Extension 的作用域隔离问题：
 *
 *   Service Worker (后台)                    Content Script (页面)
 *   ┌──────────────────┐                    ┌──────────────────────┐
 *   │ agent-core       │                    │ document / window    │
 *   │ tool-registry    │  chrome.tabs       │                      │
 *   │                  │  .sendMessage()    │ DOM 操作实际执行       │
 *   │ tool.execute()   │ ─────────────────► │ handleToolMessage()  │
 *   │   ↓              │                    │   ↓                  │
 *   │ sendToContent()  │ ◄───────────────── │   返回执行结果        │
 *   └──────────────────┘   response         └──────────────────────┘
 *
 * 使用方式：
 *   Service Worker 端：
 *     import { createProxyExecutor } from "./messaging.js";
 *     const execute = createProxyExecutor();
 *     // execute 会把调用转发到 content script
 *
 *   Content Script 端：
 *     import { registerToolHandler } from "./messaging.js";
 *     registerToolHandler(actualExecutors);
 *     // 监听来自 service worker 的工具调用请求
 */

// ─── 消息类型定义 ───

/** Service Worker → Content Script 的工具调用请求 */
export type ToolCallMessage = {
  type: "AUTOPILOT_TOOL_CALL";
  toolName: string;
  params: Record<string, unknown>;
  callId: string;
};

/** Content Script → Service Worker 的工具调用结果 */
export type ToolCallResponse = {
  type: "AUTOPILOT_TOOL_RESULT";
  callId: string;
  result: {
    content: string | Record<string, unknown>;
    details?: Record<string, unknown>;
  };
};

// ─── Service Worker 端（发送方） ───

/**
 * 创建代理执行器 — 在 Service Worker 端使用。
 *
 * 它不直接执行 DOM 操作，而是通过 chrome.tabs.sendMessage
 * 把调用请求发给当前活动 tab 的 content script 执行。
 *
 * @returns execute 函数，签名与 ToolDefinition.execute 相同
 */
export function createProxyExecutor() {
  return async (
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ content: string | Record<string, unknown>; details?: Record<string, unknown> }> => {
    const callId = `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 获取当前活动 tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return { content: "错误：没有活动的浏览器标签页" };
    }

    // 发送消息到 content script 并等待结果
    const message: ToolCallMessage = {
      type: "AUTOPILOT_TOOL_CALL",
      toolName,
      params,
      callId,
    };

    try {
      const response = await chrome.tabs.sendMessage(tab.id, message) as ToolCallResponse;
      return response.result;
    } catch (err) {
      return {
        content: `工具调用失败（content script 可能未加载）: ${err instanceof Error ? err.message : String(err)}`,
        details: { error: true, toolName },
      };
    }
  };
}

// ─── Content Script 端（接收方） ───

/** 工具执行器映射：toolName → execute 函数 */
export type ToolExecutorMap = Map<
  string,
  (params: Record<string, unknown>) => Promise<{
    content: string | Record<string, unknown>;
    details?: Record<string, unknown>;
  }>
>;

/**
 * 在 Content Script 端注册工具执行处理器。
 *
 * 监听来自 Service Worker 的 AUTOPILOT_TOOL_CALL 消息，
 * 根据 toolName 找到对应的执行函数，执行后返回结果。
 *
 * @param executors 工具名称 → 执行函数的映射
 */
export function registerToolHandler(executors: ToolExecutorMap): void {
  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: ToolCallResponse) => void) => {
      // 只处理我们的消息类型
      const msg = message as ToolCallMessage;
      if (msg?.type !== "AUTOPILOT_TOOL_CALL") return false;

      const executor = executors.get(msg.toolName);
      if (!executor) {
        sendResponse({
          type: "AUTOPILOT_TOOL_RESULT",
          callId: msg.callId,
          result: { content: `未知工具: ${msg.toolName}` },
        });
        return true; // 同步返回 true 表示我们会异步 sendResponse
      }

      // 异步执行工具并返回结果
      executor(msg.params)
        .then((result) => {
          sendResponse({
            type: "AUTOPILOT_TOOL_RESULT",
            callId: msg.callId,
            result,
          });
        })
        .catch((err) => {
          sendResponse({
            type: "AUTOPILOT_TOOL_RESULT",
            callId: msg.callId,
            result: {
              content: `工具 ${msg.toolName} 执行异常: ${err instanceof Error ? err.message : String(err)}`,
              details: { error: true },
            },
          });
        });

      return true; // 告诉 Chrome 我们会异步调用 sendResponse
    },
  );
}
