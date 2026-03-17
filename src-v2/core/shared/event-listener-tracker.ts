/**
 * 全局事件监听追踪器（浏览器端）。
 *
 * 设计目标：
 * 1. 从 EventTarget.prototype 统一拦截 add/removeEventListener
 * 2. 仅记录 Element 实例，避免污染 document/window 等
 * 3. 不改变原调用语义：先执行原方法，再做追踪记录
 * 4. 追踪失败时静默兜底，不影响业务代码执行
 */

type AddEventListenerFn = EventTarget["addEventListener"];
type RemoveEventListenerFn = EventTarget["removeEventListener"];

const elementEventMap = new WeakMap<Element, Set<string>>();

let installed = false;
let originalAddEventListener: AddEventListenerFn | undefined;
let originalRemoveEventListener: RemoveEventListenerFn | undefined;

function normalizeEventType(type: unknown): string | null {
  if (typeof type !== "string") return null;
  const normalized = type.trim().toLowerCase();
  return normalized || null;
}

function canTrackElementTarget(target: EventTarget): target is Element {
  if (typeof Element === "undefined") return false;
  return target instanceof Element;
}

function trackElementEvent(target: EventTarget, type: string): void {
  if (!canTrackElementTarget(target)) return;
  const prev = elementEventMap.get(target);
  if (prev) {
    prev.add(type);
    return;
  }
  elementEventMap.set(target, new Set([type]));
}

function untrackElementEvent(target: EventTarget, type: string): void {
  if (!canTrackElementTarget(target)) return;
  const prev = elementEventMap.get(target);
  if (!prev) return;
  prev.delete(type);
  if (prev.size === 0) {
    elementEventMap.delete(target);
  }
}

/**
 * 安装全局监听追踪补丁（幂等）。
 */
export function installEventListenerTracking(): void {
  if (installed) return;
  if (typeof EventTarget === "undefined") return;

  const proto = EventTarget.prototype;
  const nativeAdd = proto.addEventListener;
  const nativeRemove = proto.removeEventListener;

  if (typeof nativeAdd !== "function" || typeof nativeRemove !== "function") return;

  originalAddEventListener = nativeAdd;
  originalRemoveEventListener = nativeRemove;

  proto.addEventListener = function patchedAddEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    originalAddEventListener?.call(this, type, listener, options);
    try {
      const normalizedType = normalizeEventType(type);
      if (!normalizedType || listener == null) return;
      trackElementEvent(this, normalizedType);
    } catch {
      // 追踪失败不应影响业务逻辑
    }
  };

  proto.removeEventListener = function patchedRemoveEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    originalRemoveEventListener?.call(this, type, listener, options);
    try {
      const normalizedType = normalizeEventType(type);
      if (!normalizedType || listener == null) return;
      untrackElementEvent(this, normalizedType);
    } catch {
      // 追踪失败不应影响业务逻辑
    }
  };

  installed = true;
}

/**
 * 读取元素已记录的事件名（排序后返回，便于稳定输出）。
 */
export function getTrackedElementEvents(el: Element): string[] {
  const set = elementEventMap.get(el);
  if (!set || set.size === 0) return [];
  return Array.from(set).sort();
}

/**
 * 判断元素是否存在至少一个被追踪到的事件绑定。
 */
export function hasTrackedElementEvents(el: Element): boolean {
  return (elementEventMap.get(el)?.size ?? 0) > 0;
}
