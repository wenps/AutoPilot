/**
 * 键盘模拟工具函数 / Keyboard simulation utilities.
 *
 * 参考 Playwright Keyboard.press，支持组合键（如 Control+a, Shift+Enter）。
 * 从 dom-tool 提取。
 */

/** 键名→code 映射 */
const KEY_CODE_MAP: Record<string, string> = {
  Enter: "Enter", Escape: "Escape", Esc: "Escape",
  Tab: "Tab", Space: "Space", " ": "Space",
  Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Control: "ControlLeft", Shift: "ShiftLeft", Alt: "AltLeft", Meta: "MetaLeft",
};

/** 解析组合键字符串为 token 数组（如 "Control+a" → ["Control", "a"]） */
export function splitKeyCombo(key: string): string[] {
  const tokens = key.split("+");
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "" && i + 1 < tokens.length) { tokens[i + 1] = "+" + tokens[i + 1]; tokens.splice(i, 1); }
  }
  return tokens.filter(Boolean);
}

/** 将键名映射为 KeyboardEvent.code */
export function resolveKeyCode(key: string): string {
  return KEY_CODE_MAP[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
}

/**
 * 执行 press：修饰键按正序 down → 主键 down/up → 修饰键逆序 up（参考 Playwright）。
 * 修饰键按下时抑制文本输入（只发 keydown/keyup，不发 keypress）。
 */
export function executePress(el: Element, key: string): void {
  const tokens = splitKeyCombo(key);
  const mainKey = tokens[tokens.length - 1];
  const mods = tokens.slice(0, -1);
  const modState = {
    ctrlKey: mods.includes("Control"),
    shiftKey: mods.includes("Shift"),
    altKey: mods.includes("Alt"),
    metaKey: mods.includes("Meta"),
  };
  const hasNonShiftMod = modState.ctrlKey || modState.altKey || modState.metaKey;

  for (const m of mods) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: m, code: resolveKeyCode(m), bubbles: true, cancelable: true, ...modState }));
  }
  const allowed = el.dispatchEvent(new KeyboardEvent("keydown", { key: mainKey, code: resolveKeyCode(mainKey), bubbles: true, cancelable: true, ...modState }));
  // 只有无非 Shift 修饰键且是单字符时才发 keypress（参考 Playwright 文本抑制逻辑）
  if (allowed && mainKey.length === 1 && !hasNonShiftMod) {
    el.dispatchEvent(new KeyboardEvent("keypress", { key: mainKey, code: resolveKeyCode(mainKey), bubbles: true, cancelable: true, ...modState }));
  }
  el.dispatchEvent(new KeyboardEvent("keyup", { key: mainKey, code: resolveKeyCode(mainKey), bubbles: true, cancelable: true, ...modState }));
  for (let i = mods.length - 1; i >= 0; i--) {
    el.dispatchEvent(new KeyboardEvent("keyup", { key: mods[i], code: resolveKeyCode(mods[i]), bubbles: true, cancelable: true, ...modState }));
  }
}
