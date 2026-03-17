/**
 * AI Client 共享常量（中）/ Shared constants and helpers for AI clients (EN).
 */
import type { AIClientConfig } from "./index.js";

// ─── Provider 端点映射 ───

/** 默认端点映射（中）/ Default API endpoints by provider (EN). */
export const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  copilot: "https://models.inference.ai.azure.com",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimaxi.com/v1",
};

// ─── 共享工具函数 ───

/** 校验 provider（中）/ Validate provider support (EN). */
export function validateProvider(provider: string): void {
  if (!PROVIDER_ENDPOINTS[provider]) {
    const supported = Object.keys(PROVIDER_ENDPOINTS).join(", ");
    throw new Error(
      `Unknown AI provider: ${provider}. Supported: ${supported}`,
    );
  }
}

/** 解析 baseURL（中）/ Resolve API base URL (EN). */
export function resolveBaseURL(config: AIClientConfig): string {
  return config.baseURL ?? PROVIDER_ENDPOINTS[config.provider] ?? "";
}

/**
 * 清理 schema（中）/ Clean non-serializable fields from schema (EN).
 */
export function cleanSchema(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}
