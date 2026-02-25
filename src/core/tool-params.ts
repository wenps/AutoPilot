/**
 * Tool 参数与结果辅助函数。
 *
 * 该文件负责“参数提取/转换”和“标准返回封装”，
 * 让 `tool-registry.ts` 只关注注册与分发职责。
 */
import type { ToolCallResult } from "./tool-registry.js";

/**
 * 从参数对象中读取字符串类型的参数。
 * @param params  - AI 传入的参数对象
 * @param key     - 参数名
 * @param options - required: 是否必填（缺失则抛错）；trim: 是否去除首尾空白
 */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  const { required = false, trim = true } = options;
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) throw new Error(`Parameter "${key}" is required`);
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && required) throw new Error(`Parameter "${key}" is required`);
  return value || undefined;
}

/**
 * 从参数对象中读取数字类型的参数。
 * 支持 AI 传入数字或数字型字符串（如 "5"），自动转换。
 */
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): number | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    if (options.required) throw new Error(`Parameter "${key}" is required`);
    return undefined;
  }
  const num = typeof raw === "number" ? raw : Number(raw);
  if (Number.isNaN(num)) throw new Error(`Parameter "${key}" must be a number`);
  return num;
}

/**
 * 将任意数据包装为 JSON 格式的工具返回结果。
 * 便捷方法，同时提供序列化文本（给 AI 看）和原始对象（给 details 日志用）。
 */
export function jsonResult(payload: unknown): ToolCallResult {
  return {
    content: JSON.stringify(payload, null, 2),
    details: payload as Record<string, unknown>,
  };
}
