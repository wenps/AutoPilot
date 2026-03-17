/**
 * MiniMax 客户端封装（中）/ MiniMax client wrapper (EN).
 *
 * MiniMax 与 OpenAI Chat Completions 兼容，直接复用 OpenAIClient。
 * MiniMax is OpenAI-compatible, so it reuses OpenAIClient behavior.
 *
 * 默认端点：https://api.minimaxi.com/v1
 * 推荐模型：MiniMax-M2.5 / MiniMax-M2.5-highspeed
 */
import { OpenAIClient } from "./openai.js";

/**
 * MiniMax 客户端类（中）/ MiniMax client class extending OpenAIClient (EN).
 */
export class MiniMaxClient extends OpenAIClient {}
