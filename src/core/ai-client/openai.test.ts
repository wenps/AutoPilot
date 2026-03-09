import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { buildOpenAIRequest, OpenAIClient } from "./openai.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildOpenAIRequest", () => {
  it("默认开启 parallel_tool_calls", () => {
    const req = buildOpenAIRequest(
      {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "test-key",
      },
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "dom",
            description: "dom tool",
            schema: Type.Object({ action: Type.String() }),
            execute: async () => ({ content: "ok" }),
          },
        ],
      },
    );

    const body = JSON.parse(req.body) as { parallel_tool_calls?: boolean };
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("显式开启 parallelToolCalls 时写入 true", () => {
    const req = buildOpenAIRequest(
      {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "test-key",
        parallelToolCalls: true,
      },
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "dom",
            description: "dom tool",
            schema: Type.Object({ action: Type.String() }),
            execute: async () => ({ content: "ok" }),
          },
        ],
      },
    );

    const body = JSON.parse(req.body) as { parallel_tool_calls?: boolean };
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("JSON 模式超时后自动重试一次", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      callCount += 1;

      if (callCount === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            const abortError = new Error("Aborted");
            abortError.name = "AbortError";
            reject(abortError);
          }, { once: true });
        });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new OpenAIClient({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "test-key",
      stream: false,
      requestTimeoutMs: 5,
    });

    const response = await client.chat({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.text).toBe("ok");
    expect(callCount).toBe(2);
  });
});
