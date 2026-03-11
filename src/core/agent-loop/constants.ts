/**
 * Agent Loop 默认配置常量。
 *
 * 统一集中在该文件，避免在主循环中散落“魔法数字”。
 */

/** 单次 chat 最大循环轮次（超过后强制停机） */
export const DEFAULT_MAX_ROUNDS = 40;

/** 元素未找到恢复时的等待时长（毫秒），等待后刷新快照重新定位目标 */
export const DEFAULT_RECOVERY_WAIT_MS = 100;

/** 同一工具调用（相同 name + input）命中元素未找到时的最大自动恢复轮次 */
export const DEFAULT_ACTION_RECOVERY_ROUNDS = 2;

/** 元素未找到重试对话流的最大尝试次数（聚合失败工具 + 快照 + attempt 标注发给 AI） */
export const DEFAULT_NOT_FOUND_RETRY_ROUNDS = 2;

/** 元素未找到重试对话流中每次重试前的等待时长（毫秒），等待页面异步渲染完成 */
export const DEFAULT_NOT_FOUND_RETRY_WAIT_MS = 1000;

/** 轮次后稳定等待的总超时（毫秒）：包含 loading 隐藏等待 + DOM 静默等待的总上限 */
export const DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS = 4000;

/** 轮次后 DOM 静默窗口（毫秒）：DOM 在此时间内无变化视为稳定 */
export const DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS = 200;

/**
 * 轮次后稳定等待的默认 loading 指示器选择器列表。
 *
 * 覆盖主流 UI 框架的加载态组件：
 * - AntD：`.ant-spin` / `.ant-spin-spinning` / `.ant-skeleton`
 * - Element Plus：`.el-loading-mask`
 * - BK（蓝鲸）：`.bk-loading` / `.bk-spin-loading` / `.bk-skeleton` / `.bk-sideslider-loading`
 * - TDesign（TD）：`.t-loading` / `.t-skeleton` / `.t-skeleton__row`
 * - 通用：`[aria-busy="true"]` / `.skeleton` / `.loading`
 *
 * 用户自定义的 `roundStabilityWait.loadingSelectors` 会与此列表合并去重，不会覆盖默认值。
 */
export const DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS = [
	".ant-spin",
	".ant-spin-spinning",
	".ant-skeleton",
	".el-loading-mask",
	".bk-loading",
	".bk-spin-loading",
	".bk-skeleton",
	".bk-sideslider-loading",
	".t-loading",
	".t-skeleton",
	".t-skeleton__row",
	"[aria-busy=\"true\"]",
	".skeleton",
	".loading",
];
// ─── DOM 快照去重标记 ───

/** 快照起始标记 — 用于在消息中定位快照边界，配合 stripSnapshotFromPrompt() 实现旧快照剥离 */
export const SNAPSHOT_START = "<!-- SNAPSHOT_START -->";
/** 快照结束标记 — 与 SNAPSHOT_START 配对使用 */
export const SNAPSHOT_END = "<!-- SNAPSHOT_END -->";
/** 旧快照被替换后的占位文本 — 防止过期快照干扰模型决策 */
export const SNAPSHOT_OUTDATED = "[此快照已过期，请参考对话中最新的快照]";