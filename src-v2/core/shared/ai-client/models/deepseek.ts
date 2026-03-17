/**
 * DeepSeek 客户端封装（中）/ DeepSeek client wrapper (EN).
 *
 * DeepSeek 与 OpenAI Chat Completions 兼容，直接复用 OpenAIClient。
 * DeepSeek is OpenAI-compatible, so it reuses OpenAIClient behavior.
 */
import { OpenAIClient } from "./openai.js";

/**
 * DeepSeek 客户端类（中）/ DeepSeek client class extending OpenAIClient (EN).
 */
export class DeepSeekClient extends OpenAIClient {}
