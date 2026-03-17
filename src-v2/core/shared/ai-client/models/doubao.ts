/**
 * Doubao 客户端封装（中）/ Doubao client wrapper (EN).
 *
 * Doubao（火山引擎 Ark）与 OpenAI Chat Completions 兼容，直接复用 OpenAIClient。
 * Doubao (Volcengine Ark) is OpenAI-compatible, so it reuses OpenAIClient behavior.
 */
import { OpenAIClient } from "./openai.js";

/**
 * Doubao 客户端类（中）/ Doubao client class extending OpenAIClient (EN).
 */
export class DoubaoClient extends OpenAIClient {}
