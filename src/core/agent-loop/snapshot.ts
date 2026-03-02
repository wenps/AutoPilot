/**
 * DOM 快照生命周期管理（中）/ DOM snapshot lifecycle management (EN).
 *
 * 负责读取、包裹、去重、剥离。
 * Handles read, wrap, deduplicate, and strip operations.
 *
 * 快照读取主流程（中）/ Snapshot read pipeline (EN):
 * 1) 组装快照参数（默认偏完整性）/ Build snapshot params with completeness-oriented defaults.
 * 2) 调用 page_info.snapshot / Dispatch `page_info.snapshot` via ToolRegistry.
 * 3) 将 provider/tool 的 content 统一转成字符串 / Normalize tool content to plain string.
 * 4) 将快照交给消息层包裹并注入 / Pass snapshot to message layer for wrapping/injection.
 * 5) 在多轮对话中去重旧快照 / Deduplicate outdated snapshots across rounds.
 *
 * 调用链（中）/ Call chain (EN):
 * - `agent-loop/index.ts` 在“无快照、每轮结束、导航后、恢复后”触发读取。
 * - `messages.ts` 负责把最新快照注入到本轮上下文。
 * - 本文件只处理快照文本本身，不负责业务决策与停机判定。
 *
 * 压缩/剪枝实现位置（中）/ Where compression & pruning are implemented (EN):
 * - 具体算法在 `src/web/tools/page-info-tool.ts` 的 `generateSnapshot()`。
 * - 本文件通过 `readPageSnapshot()` 传参触发这些策略，不在 core 层直接操作 DOM。
 * - 这样保持分层：core 只声明策略参数，web 负责真实遍历与裁剪。
 */
import { ToolRegistry } from "../tool-registry.js";
import type { AIMessage } from "../types.js";
import {
  SNAPSHOT_END,
  SNAPSHOT_OUTDATED,
  SNAPSHOT_START,
} from "./constants.js";
import { toContentString } from "./helpers.js";

// ─── 快照读取 ───

/**
 * 读取页面 URL（中）/ Read current page URL via page_info (EN).
 *
 * 步骤（中）/ Steps (EN):
 * 1) 通过 registry 分发 `page_info.get_url`。
 * 2) 若 content 为字符串则直接返回。
 * 3) 否则返回 undefined，交由上层容错。
 *
 * 输入/输出（中）/ I/O contract (EN):
 * - In: `ToolRegistry`
 * - Out: `string | undefined`
 * - Side effects: 无（仅发起一次工具调用）/ none (single tool dispatch only)
 */
export async function readPageUrl(
  registry: ToolRegistry,
): Promise<string | undefined> {
  const result = await registry.dispatch("page_info", { action: "get_url" });
  return typeof result.content === "string" ? result.content : undefined;
}

/**
 * 读取页面快照（中）/ Read current page snapshot (EN).
 *
 * 默认关闭 viewportOnly，优先完整性。
 * viewportOnly defaults to false to prioritize completeness.
 *
 * 步骤（中）/ Steps (EN):
 * 1) 合并调用方 options 与默认值（深度/裁剪/剪枝/节点上限等）。
 * 2) 分发 `page_info.snapshot` 获取当前 DOM 文本快照。
 * 3) 使用 `toContentString` 归一化输出，避免 provider 差异导致结构不一致。
 * 4) 返回稳定字符串给 loop，供后续注入消息与统计。
 *
 * 默认参数意图（中）/ Default parameter rationale (EN):
 * - `maxDepth=8`: 保留足够层级，减少关键控件被截断。
 * - `viewportOnly=false`: 优先完整性，避免误判“元素不存在”。
 * - `pruneLayout=true`: 抑制纯布局噪声，降低 token 压力。
 * - `maxNodes=500` / `maxChildren=30`: 控制体积上限，兼顾可读性。
 * - `maxTextLength=40`: 防止长文本淹没结构信息。
 *
 * 压缩/剪枝是怎么做的（中）/ How compression & pruning works in practice (EN):
 * - `viewportOnly=true` 时：仅保留与视口相交元素（根层容器保留），完全视口外元素跳过。
 * - `pruneLayout=true` 时：无 id/无语义/无交互/无直接文本的布局容器会被“折叠”，
 *   子节点直接提升输出，减少无意义层级；当同一折叠容器提升出多个相邻节点时，
 *   快照会用括号分组块标记其关联来源（collapsed-group）。
 * - `maxNodes`：全局节点预算，超限后停止继续遍历并追加 truncation 提示。
 * - `maxChildren`：每个父节点只保留前 N 个子元素，其余用 `... (n children omitted)` 汇总。
 * - `maxTextLength`：节点文本按长度截断，避免长段文案占满上下文。
 * - 交互优先排序：优先输出按钮/输入框/链接等交互元素，再输出普通元素。
 * - 属性压缩：仅保留关键属性（如 id、关键 class、交互属性、布尔状态、val），减少冗余 token。
 *
 * 输入/输出（中）/ I/O contract (EN):
 * - In: `ToolRegistry` + 可选快照参数
 * - Out: 归一化后的快照字符串（始终 string）
 * - Side effects: 无本地状态写入；仅依赖工具调用结果
 */
export async function readPageSnapshot(
  registry: ToolRegistry,
  options?: {
    maxDepth?: number;
    viewportOnly?: boolean;
    pruneLayout?: boolean;
    maxNodes?: number;
    maxChildren?: number;
    maxTextLength?: number;
    expandOptionLists?: boolean;
    expandChildrenRefs?: string[];
    expandedChildrenLimit?: number;
  },
): Promise<string> {
  const result = await registry.dispatch("page_info", {
    action: "snapshot",
    maxDepth: options?.maxDepth ?? 8,
    viewportOnly: options?.viewportOnly ?? false,
    pruneLayout: options?.pruneLayout ?? true,
    maxNodes: options?.maxNodes ?? 500,
    maxChildren: options?.maxChildren ?? 30,
    maxTextLength: options?.maxTextLength ?? 40,
    expandOptionLists: options?.expandOptionLists,
    expandChildrenRefs: options?.expandChildrenRefs,
    expandedChildrenLimit: options?.expandedChildrenLimit,
  });
  return toContentString(result.content);
}

// ─── 快照标记 ───

/**
 * 包裹快照（中）/ Wrap snapshot with boundary markers (EN).
 *
 * 作用（中）/ Purpose (EN):
 * - 为快照加 `SNAPSHOT_START/END` 边界，便于后续正则定位。
 * - 支持去重与旧快照剥离，防止多轮 token 累积。
 * - 仅做纯字符串变换，不访问外部状态。
 */
export function wrapSnapshot(snapshot: string): string {
  return `${SNAPSHOT_START}\n${snapshot}\n${SNAPSHOT_END}`;
}

// ─── 快照去重 ───

/** 转义正则字符（中）/ Escape regex special chars (EN). */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 快照块匹配正则（中）/ Regex for snapshot blocks (EN). */
const SNAPSHOT_REGEX = new RegExp(
  `${escapeRegex(SNAPSHOT_START)}[\\s\\S]*?${escapeRegex(SNAPSHOT_END)}`,
  "g",
);

/** 是否包含快照标记（中）/ Check whether text includes snapshot markers (EN). */
function containsSnapshot(text: string): boolean {
  return text.includes(SNAPSHOT_START);
}

/**
 * 去重消息快照（中）/ Deduplicate snapshots in messages (EN).
 * 仅保留最后一份快照，旧快照替换为过期提示。
 * Keep only the latest snapshot and mark older ones as outdated.
 *
 * 步骤（中）/ Steps (EN):
 * 1) 扫描 tool 消息中的快照块引用。
 * 2) 保留最后一次快照，视为当前事实来源。
 * 3) 将更早快照替换为 `SNAPSHOT_OUTDATED`，避免模型引用旧状态。
 *
 * 返回语义（中）/ Return semantics (EN):
 * - `true`: 至少发现了 1 份快照（可能发生替换，也可能只有一份无需替换）。
 * - `false`: 未发现任何快照标记。
 */
export function deduplicateSnapshots(messages: AIMessage[]): boolean {
  type SnapshotRef = {
    items: Array<{ toolCallId: string; result: string }>;
    index: number;
  };
  const refs: SnapshotRef[] = [];

  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    const items = msg.content as Array<{ toolCallId: string; result: string }>;
    for (let j = 0; j < items.length; j++) {
      if (typeof items[j].result === "string" && containsSnapshot(items[j].result)) {
        refs.push({ items, index: j });
      }
    }
  }

  if (refs.length <= 1) return refs.length > 0;

  // 保留最后一份快照，将更早的快照替换为过期提示
  for (let i = 0; i < refs.length - 1; i++) {
    const ref = refs[i];
    ref.items[ref.index].result = ref.items[ref.index].result.replace(
      SNAPSHOT_REGEX,
      SNAPSHOT_OUTDATED,
    );
  }

  return true;
}

/**
 * 剥离旧快照（中）/ Strip outdated snapshot blocks from system prompt (EN).
 *
 * 说明（中）/ Notes (EN):
 * - 当 prompt 中已有历史快照时，将其替换为过期占位文本。
 * - 让每轮真正生效的只有“最新注入快照”，减少冲突上下文。
 * - 这是 prompt 级清理；不会触碰 tool trace 中的原始结果对象。
 */
export function stripSnapshotFromPrompt(prompt: string): string {
  if (!containsSnapshot(prompt)) return prompt;
  return prompt.replace(SNAPSHOT_REGEX, SNAPSHOT_OUTDATED);
}

/** 导出快照正则（中）/ Export snapshot regex for message helpers (EN). */
export { SNAPSHOT_REGEX };
