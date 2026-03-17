/**
 * Qwen 客户端封装（中）/ Qwen client wrapper (EN).
 *
 * Qwen（阿里云百炼兼容模式）与 OpenAI Chat Completions 兼容，直接复用 OpenAIClient。
 * Qwen (DashScope compatible mode) is OpenAI-compatible, so it reuses OpenAIClient behavior.
 */
import { OpenAIClient } from "./openai.js";

/**
 * Qwen 客户端类（中）/ Qwen client class extending OpenAIClient (EN).
 */
export class QwenClient extends OpenAIClient {}
