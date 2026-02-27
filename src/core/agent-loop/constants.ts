/**
 * Agent Loop 默认配置常量。
 *
 * 统一集中在该文件，避免在主循环中散落“魔法数字”。
 */
export const DEFAULT_MAX_ROUNDS = 40;
export const DEFAULT_RECOVERY_WAIT_MS = 100;
export const DEFAULT_ACTION_RECOVERY_ROUNDS = 2;
export const DEFAULT_NOT_FOUND_RETRY_ROUNDS = 2;
export const DEFAULT_NOT_FOUND_RETRY_WAIT_MS = 2000;
// ─── DOM 快照去重标记 ───

/** 快照起始标记 — 用于在消息中识别快照边界 */
export const SNAPSHOT_START = "<!-- SNAPSHOT_START -->";
/** 快照结束标记 */
export const SNAPSHOT_END = "<!-- SNAPSHOT_END -->";
/** 旧快照被替换后的占位文本 */
export const SNAPSHOT_OUTDATED = "[此快照已过期，请参考对话中最新的快照]";