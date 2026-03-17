/**
 * AutoPilot UI 面板样式。
 *
 * 全部使用 CSS-in-JS（字符串注入），零外部依赖。
 * 所有选择器在 #autopilot-panel 作用域下，避免污染宿主样式。
 *
 * 风格：白色基调 — 轻量现代风，微妙阴影与品牌色点缀。
 */

export const PANEL_STYLES = /* css */ `
/* ─── CSS Variables ─── */
#autopilot-panel {
  --ap-bg: #ffffff;
  --ap-bg-secondary: #f8f9fb;
  --ap-bg-tertiary: #f0f2f5;
  --ap-border: #e8eaed;
  --ap-border-hover: #d0d3d9;
  --ap-text: #1a1a2e;
  --ap-text-secondary: #6b7280;
  --ap-text-tertiary: #b0b7c3;
  --ap-primary: #6366f1;
  --ap-primary-hover: #4f46e5;
  --ap-primary-light: rgba(99, 102, 241, 0.08);
  --ap-primary-glow: rgba(99, 102, 241, 0.18);
  --ap-success: #22c55e;
  --ap-error: #ef4444;
  --ap-warning: #f59e0b;
  --ap-shadow: 0 0 12px rgba(0, 0, 0, 0.06);
  --ap-shadow-lg: 0 0 16px rgba(0, 0, 0, 0.08);
  --ap-radius: 16px;
  --ap-radius-sm: 10px;
  --ap-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --ap-transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

/* ─── 操作遮罩 ─── */
#autopilot-mask {
  --ap-mask-opacity: 0.15;
  position: fixed;
  inset: 0;
  z-index: 99998;
  background: rgba(255, 255, 255, var(--ap-mask-opacity));
  backdrop-filter: blur(1px);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ap-transition);
}
#autopilot-mask.active {
  opacity: 1;
  pointer-events: auto;
  cursor: not-allowed;
}
#autopilot-mask .ap-mask-label {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: #ffffff;
  border: 1px solid var(--ap-border);
  color: var(--ap-primary);
  font-family: var(--ap-font);
  font-size: 13px;
  font-weight: 500;
  padding: 10px 24px;
  border-radius: 24px;
  letter-spacing: 0.2px;
  display: flex;
  align-items: center;
  gap: 10px;
  user-select: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}
#autopilot-mask .ap-mask-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(99, 102, 241, 0.2);
  border-top-color: var(--ap-primary);
  border-radius: 50%;
  animation: ap-spin 0.8s linear infinite;
}
@keyframes ap-spin {
  to { transform: rotate(360deg); }
}

/* ─── 面板容器 ─── */
#autopilot-panel {
  position: fixed;
  z-index: 99999;
  width: 520px;
  height: min(75vh, 820px);
  max-height: min(75vh, 820px);
  display: flex;
  flex-direction: column;
  background: var(--ap-bg);
  border-radius: var(--ap-radius);
  box-shadow: var(--ap-shadow);
  border: 1px solid var(--ap-border);
  font-family: var(--ap-font);
  font-size: 14px;
  color: var(--ap-text);
  overflow: hidden;
  opacity: 1;
  transition: opacity var(--ap-transition), transform var(--ap-transition);
  user-select: none;
}
#autopilot-panel.collapsed {
  opacity: 0;
  pointer-events: none;
  transform: scale(0.92);
}

/* ─── 触发按钮 (FAB) ─── */
#autopilot-fab {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 99998;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: #ffffff;
  color: var(--ap-primary);
  border: 1px solid var(--ap-border);
  cursor: pointer;
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s, box-shadow 0.2s, opacity var(--ap-transition);
  font-family: var(--ap-font);
  padding: 6px;
  overflow: hidden;
  touch-action: none;
}
#autopilot-fab:active {
  cursor: pointer;
}
/* FAB 拖拽态：长按激活拖拽时切换为 grabbing 光标 */
#autopilot-fab.dragging {
  cursor: grabbing;
}
/* FAB 激活态：面板展开时 FAB 显示品牌色边框 */
#autopilot-fab.active {
  border-color: var(--ap-primary);
  box-shadow: 0 0 0 3px var(--ap-primary-light), 0 0 8px rgba(0, 0, 0, 0.06);
}
#autopilot-fab img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

/* ─── 头部 ─── */
.ap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ap-border);
  background: var(--ap-bg);
  flex-shrink: 0;
}
.ap-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ap-header-logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--ap-bg-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  padding: 3px;
}
.ap-header-logo img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.ap-header-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--ap-text);
  letter-spacing: -0.01em;
}
.ap-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.ap-header-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--ap-text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
  font-family: var(--ap-font);
}
.ap-header-btn:hover {
  background: var(--ap-bg-tertiary);
  color: var(--ap-text-secondary);
}
.ap-header-btn svg {
  width: 16px;
  height: 16px;
}

/* ─── 状态条 ─── */
.ap-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--ap-text-secondary);
  background: var(--ap-bg-secondary);
  border-bottom: 1px solid var(--ap-border);
  flex-shrink: 0;
}
.ap-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ap-text-tertiary);
  flex-shrink: 0;
  transition: background 0.2s;
}
.ap-status-dot.idle {
  background: var(--ap-success);
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);
}
.ap-status-dot.running {
  background: var(--ap-primary);
  box-shadow: 0 0 8px var(--ap-primary-glow);
  animation: ap-pulse 1.5s ease-in-out infinite;
}
.ap-status-dot.error {
  background: var(--ap-error);
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.4);
}
@keyframes ap-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ─── 消息区 ─── */
.ap-messages {
  flex: 1 1 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  scroll-behavior: smooth;
}
.ap-messages::-webkit-scrollbar { width: 4px; }
.ap-messages::-webkit-scrollbar-track { background: transparent; }
.ap-messages::-webkit-scrollbar-thumb {
  background: var(--ap-text-tertiary);
  border-radius: 4px;
}

/* 消息气泡 */
.ap-msg {
  max-width: 88%;
  padding: 10px 14px;
  border-radius: var(--ap-radius-sm);
  line-height: 1.6;
  font-size: 13.5px;
  word-break: break-word;
  animation: ap-msg-in 0.25s ease-out;
}
@keyframes ap-msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.ap-msg.user {
  align-self: flex-end;
  background: var(--ap-primary);
  color: #fff;
  border-bottom-right-radius: 4px;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.2);
}
.ap-msg.assistant {
  align-self: flex-start;
  background: var(--ap-bg-tertiary);
  color: var(--ap-text);
  border: 1px solid var(--ap-border);
  border-bottom-left-radius: 4px;
}
.ap-msg.tool {
  align-self: flex-start;
  background: var(--ap-bg-secondary);
  color: var(--ap-text-secondary);
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  padding: 8px 12px;
  border-left: 3px solid var(--ap-primary);
  border-radius: 0 var(--ap-radius-sm) var(--ap-radius-sm) 0;
}
.ap-msg.error {
  align-self: flex-start;
  background: rgba(239, 68, 68, 0.05);
  color: var(--ap-error);
  border-left: 3px solid var(--ap-error);
  font-size: 12.5px;
  border-radius: 0 var(--ap-radius-sm) var(--ap-radius-sm) 0;
}

/* ─── 空状态 ─── */
.ap-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ap-text-tertiary);
  padding: 40px 20px;
  text-align: center;
}
.ap-empty-icon {
  width: 48px;
  height: 48px;
  opacity: 0.5;
}
.ap-empty-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.ap-empty-text {
  font-size: 13px;
  line-height: 1.5;
}

/* ─── 停止按钮 ─── */
.ap-stop-container {
  flex-shrink: 0;
  padding: 0 16px 8px;
}
.ap-stop-btn {
  width: 100%;
  height: 36px;
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: var(--ap-radius-sm);
  background: rgba(239, 68, 68, 0.04);
  color: var(--ap-error);
  cursor: pointer;
  font-family: var(--ap-font);
  font-size: 12.5px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background 0.15s, border-color 0.15s;
}
.ap-stop-btn:hover {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.35);
}
.ap-stop-btn svg {
  width: 13px;
  height: 13px;
}

/* ─── 输入区 ─── */
.ap-input-area {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--ap-border);
  background: var(--ap-bg);
  flex-shrink: 0;
}
.ap-input-wrapper {
  flex: 1;
  position: relative;
}
.ap-input {
  width: 100%;
  min-height: 40px;
  max-height: 120px;
  padding: 10px 14px;
  border: 1px solid var(--ap-border);
  border-radius: var(--ap-radius-sm);
  background: var(--ap-bg);
  color: var(--ap-text);
  font-family: var(--ap-font);
  font-size: 13.5px;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}
.ap-input:focus {
  border-color: var(--ap-primary);
  box-shadow: 0 0 0 3px var(--ap-primary-light);
}
.ap-input::placeholder {
  color: var(--ap-text-tertiary);
}
.ap-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ap-send-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--ap-radius-sm);
  border: none;
  background: var(--ap-primary);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
  flex-shrink: 0;
  font-family: var(--ap-font);
}
.ap-send-btn:hover {
  background: var(--ap-primary-hover);
  box-shadow: 0 2px 10px rgba(99, 102, 241, 0.25);
}
.ap-send-btn:active {
  transform: scale(0.95);
}
.ap-send-btn:disabled {
  background: var(--ap-text-tertiary);
  cursor: not-allowed;
  box-shadow: none;
}
.ap-send-btn svg {
  width: 18px;
  height: 18px;
}

/* ─── 进度指示器 ─── */
.ap-typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 14px;
  align-self: flex-start;
}
.ap-typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ap-primary);
  animation: ap-typing 1.4s ease-in-out infinite;
}
.ap-typing-dot:nth-child(2) { animation-delay: 0.2s; }
.ap-typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes ap-typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}
`;
