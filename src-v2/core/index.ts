/**
 * Core 模块统一入口 — barrel export。
 *
 * 聚合 shared/ 和 assertion/ 的公共 API，
 * 供 web/ 层和未来的 engine/main-agent/micro-task 模块使用。
 */

// ─── shared 基础类型 ───
export type {
  AIToolCall,
  AIMessage,
  AIChatResponse,
  AIClient,
  StopReason,
  TaskItem,
  RoundStabilityWaitOptions,
  AgentLoopMetrics,
  AgentLoopCallbacks,
  AgentLoopParams,
  AgentLoopResult,
  PageContextState,
  ToolTraceEntry,
} from "./shared/types.js";

// ─── 工具注册表 ───
export {
  ToolRegistry,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./shared/tool-registry.js";
export type { ToolCallResult, ToolDefinition } from "./shared/tool-registry.js";

// ─── 工具参数 ───
export { jsonResult as jsonResultAlias } from "./shared/tool-params.js";

// ─── 常量 ───
export {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_RECOVERY_WAIT_MS,
  DEFAULT_ACTION_RECOVERY_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_ROUNDS,
  DEFAULT_NOT_FOUND_RETRY_WAIT_MS,
  DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS,
  DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS,
  DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS,
  SNAPSHOT_START,
  SNAPSHOT_END,
  SNAPSHOT_OUTDATED,
} from "./shared/constants.js";

// ─── helpers ───
export {
  sleep,
  toContentString,
  parseSnapshotExpandHints,
  extractHashSelectorRef,
  computeSnapshotFingerprint,
  computeSnapshotDiff,
  findNearbyClickTargets,
  buildTaskArray,
  normalizeModelOutput,
  parseRemainingInstruction,
  deriveNextInstruction,
  reduceRemainingHeuristically,
  splitUserGoalIntoTasks,
  updateTaskCompletion,
  formatTaskChecklist,
  deriveRemainingFromTasks,
  shouldForceRoundBreak,
  isPotentialDomMutation,
  isConfirmedProgressAction,
  collectMissingTask,
  isElementNotFoundResult,
  buildToolCallKey,
  resolveRecoveryWaitMs,
  getToolAction,
  hasToolError,
} from "./shared/helpers.js";

// ─── 事件追踪 ───
export {
  installEventListenerTracking,
  getTrackedElementEvents,
  hasTrackedElementEvents,
} from "./shared/event-listener-tracker.js";

// ─── 消息通信 ───
export {
  createProxyExecutor,
  registerToolHandler,
} from "./shared/messaging.js";
export type { ToolCallMessage, ToolCallResponse, ToolExecutorMap } from "./shared/messaging.js";

// ─── 快照 ───
export {
  readPageUrl,
  readPageSnapshot,
  wrapSnapshot,
  stripSnapshotFromPrompt,
  SNAPSHOT_REGEX,
  generateSnapshot,
} from "./shared/snapshot/index.js";
export type { SnapshotOptions } from "./shared/snapshot/index.js";

// ─── 恢复 ───
export {
  handleElementRecovery,
  handleNavigationUrlChange,
  detectIdleLoop,
  checkIneffectiveClickRepeat,
} from "./shared/recovery/index.js";

// ─── 断言 ───
export { evaluateAssertions, evaluate, evaluateAsync, awaitAllAssertions } from "./assertion/index.js";
export { buildMicroTaskAssertionRequest, buildSystemAssertionRequest } from "./assertion/levels.js";
export type {
  TaskAssertion,
  AssertionConfig,
  TaskAssertionResult,
  AssertionResult,
  AssertionLevel,
  AssertionRequest,
  PendingAssertion,
  MicroTaskExecutionRecord,
} from "./assertion/types.js";

// ─── AI 客户端 ───
export { createAIClient } from "./shared/ai-client/index.js";
