/** SSE 事件处理器（中）/ SSE JSON event handler (EN). Return false to stop early. */
export type SSEJSONHandler = (
  event: Record<string, unknown>,
  meta: { event?: string; rawData: string },
) => void | boolean | Promise<void | boolean>;

/** SSE 配置（中）/ SSE consume options (EN). */
export type SSEConsumeOptions = {
  /** 单次读取超时（毫秒）。不传则不超时。 */
  readTimeoutMs?: number;
  /** 是否在遇到 [DONE] 时提前结束（默认 true）。 */
  stopOnDone?: boolean;
};

/**
 * 通用 SSE(JSON) 消费器（中）/ Generic SSE(JSON) consumer (EN).
 *
 * 读取 response.body，按 SSE 规则拼装并分发 JSON data 事件。
 * Reads response body, assembles SSE frames, and dispatches JSON data events.
 */
export async function consumeSSEJSON(
  response: Response,
  onEvent: SSEJSONHandler,
  options: SSEConsumeOptions = {},
): Promise<void> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const stopOnDone = options.stopOnDone ?? true;

  let buffer = "";
  let currentEvent: string | undefined;
  let dataLines: string[] = [];
  let stoppedByDone = false;

  async function readChunk() {
    const readTimeoutMs = options.readTimeoutMs;
    if (!readTimeoutMs || readTimeoutMs <= 0) {
      return reader.read();
    }

    return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SSE read timeout (${readTimeoutMs}ms)`));
      }, readTimeoutMs);

      reader.read().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function flushEvent(): Promise<boolean> {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return true;
    }

    const rawData = dataLines.join("\n").trim();
    const event = currentEvent;
    dataLines = [];
    currentEvent = undefined;

    if (!rawData) return true;
    if (stopOnDone && rawData === "[DONE]") {
      stoppedByDone = true;
      return false;
    }

    try {
      const parsed = JSON.parse(rawData) as Record<string, unknown>;
      const shouldContinue = await onEvent(parsed, { event, rawData });
      if (shouldContinue === false) return false;
    } catch {
      // 非 JSON data 事件忽略
    }

    return true;
  }

  while (true) {
    const { done, value } = await readChunk();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const trimmed = line.trim();

      if (!trimmed) {
        const shouldContinue = await flushEvent();
        if (!shouldContinue) break;
        continue;
      }
      if (trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("event:")) {
        currentEvent = trimmed.slice(6).trim() || undefined;
        continue;
      }
      if (trimmed.startsWith("data:")) {
        dataLines.push(trimmed.slice(5).trimStart());
      }
    }

    if (stoppedByDone) break;
  }

  if (!stoppedByDone) {
    await flushEvent();
  } else {
    await reader.cancel().catch(() => undefined);
  }
}
