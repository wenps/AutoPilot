/**
 * RefStore — 快照 hash ID 与 DOM 元素的映射表。
 *
 * 快照生成时，根据元素的 DOM 路径 + 页面 URL 生成确定性 hash ID，
 * 同时保存 ID → Element 的映射。AI 使用 hash ID 作为 selector 定位元素，
 * 免去超长 XPath 路径，大幅减少 token 消耗。
 *
 * 优势：
 * - **确定性**：同一元素无论快照顺序，始终得到相同 ID
 * - **并发安全**：多次快照不会产生 ID 冲突
 * - **跨页面隔离**：URL hash 作为命名空间，不同页面元素 ID 互不碰撞
 *
 * 生命周期：每次 WebAgent.chat() 调用时创建，对话结束后清空。
 *
 * 使用方：
 *   page-info-tool.ts — generateSnapshot() 写入映射
 *   dom-tool.ts       — queryElement() 读取映射
 *   index.ts          — WebAgent 持有实例，管理生命周期
 */

/**
 * FNV-1a 32-bit hash — 简单高效的字符串散列。
 * 分布均匀，碰撞率低，适合生成短 ID。
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return h >>> 0; // 转为无符号 32-bit
}

/**
 * hash ID → DOM 元素的映射存储。
 *
 * - `set(el, path)` 由快照生成时调用，返回确定性 hash ID
 * - `get(id)` 由 dom-tool 查询时调用，根据 hash ID 取回元素
 * - `has(id)` 检查 ID 是否存在（用于 selector 类型判断）
 * - `clear()` 每次对话结束后清空
 */
export class RefStore {
  private map = new Map<string, Element>();
  /** 页面 URL 的 hash 前缀，用于跨页面命名空间隔离 */
  private urlKey: string;

  /**
   * @param url 当前页面 URL（可选）。传入后作为 hash 命名空间，
   *            使不同页面的相同 DOM 路径产生不同 ID。
   */
  constructor(url?: string) {
    this.urlKey = url ?? "";
  }

  /**
   * 注册一个元素，返回确定性 hash ID。
   * 相同 URL + path 始终产生相同 ID（并发安全）。
   *
   * @param el   DOM 元素引用
   * @param path 元素的 XPath-like 路径（如 "/body/div[1]/main/button"）
   */
  set(el: Element, path: string): string {
    const baseId = fnv1a(this.urlKey + path).toString(36);
    let id = baseId;
    // 极小概率碰撞处理：不同 path 映射到相同 hash 时追加后缀
    let suffix = 2;
    while (this.map.has(id) && this.map.get(id) !== el) {
      id = baseId + suffix++;
    }
    this.map.set(id, el);
    return id;
  }

  /**
   * 根据 hash ID 获取 DOM 元素。
   * 返回 Element 或 undefined（ID 不存在或元素已被移除）。
   */
  get(id: string): Element | undefined {
    return this.map.get(id);
  }

  /** 检查 hash ID 是否存在 */
  has(id: string): boolean {
    return this.map.has(id);
  }

  /** 清空所有映射 */
  clear(): void {
    this.map.clear();
  }

  /**
   * 重置映射表：清空所有映射，并可选更新 URL 命名空间。
   *
   * 用于页面导航后刷新 RefStore：旧的 hash ID → Element 映射已失效，
   * 需要用新 URL 重新生成确定性 hash。
   *
   * @param url 新的页面 URL（不传则保持原 URL 命名空间）
   */
  reset(url?: string): void {
    this.map.clear();
    if (url !== undefined) {
      this.urlKey = url;
    }
  }

  /** 当前映射数量 */
  get size(): number {
    return this.map.size;
  }
}
