/**
 * Agent-loop 快照模块统一入口。
 *
 * - lifecycle: 读取/包裹/剥离
 * - engine: DOM 序列化算法与 SnapshotOptions
 */
export {
  readPageUrl,
  readPageSnapshot,
  wrapSnapshot,
  stripSnapshotFromPrompt,
  SNAPSHOT_REGEX,
} from "./lifecycle.js";

export { generateSnapshot, type SnapshotOptions } from "./engine.js";
