/**
 * activeRefStore 状态管理 / Active RefStore state holder.
 *
 * 将 RefStore 的全局引用从 dom-tool 中独立出来，
 * 使 resolve-selector / dom-tool / page-info-tool 都能无循环依赖地访问。
 *
 * 生命周期由 WebAgent 管理：
 * - chat() 开始时 setActiveRefStore(instance)
 * - chat() 结束时 setActiveRefStore(undefined)
 */
import type { RefStore } from "../../ref-store.js";

let activeRefStore: RefStore | undefined;

export function setActiveRefStore(store: RefStore | undefined): void {
  activeRefStore = store;
}

export function getActiveRefStore(): RefStore | undefined {
  return activeRefStore;
}
