/**
 * AutoPilot SVG 图标集合（内联 SVG 字符串）。
 * 使用微型图标风格，线宽一致，视觉协调。
 */
import { LOGO_DATA_URL } from "./logo-data.js";

export const ICONS = {
  /** AutoPilot logo — 螃蟹图标（PNG data URI，用 <img> 渲染） */
  logo: `<img src="${LOGO_DATA_URL}" alt="AutoPilot" style="width:100%;height:100%;object-fit:contain;" />`,

  /** 发送 */
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,

  /** 最小化 */
  minimize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,

  /** 清空 */
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,

  /** 关闭 */
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,

  /** 停止（方块） */
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
};
