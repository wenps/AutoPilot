/**
 * AutoPilot UI Panel — 开箱即用的聊天面板 + 操作遮罩。
 *
 * 纯 DOM 实现，零框架依赖。通过 `agent.panel.show()` 一行代码启用。
 *
 * 功能：
 * - 浮动聊天面板（FAB 按钮展开/收起）
 * - 操作遮罩（自动化执行期间阻止用户操作页面）
 * - 实时消息流（用户消息、AI 回复、工具调用、错误）
 * - 输入框 + 发送/停止控制
 *
 * 架构位置：web/ui/ 层，仅依赖 DOM API，不依赖 core。
 * 通过 WebAgent 的 callbacks 接口接收 Agent 事件。
 */
import { PANEL_STYLES } from "./styles.js";
import { ICONS } from "./icons.js";
import { computePosition, flip, shift, offset } from "@floating-ui/dom";

/** 面板配置选项 */
export type PanelOptions = {
  /** 面板容器挂载点（默认 document.body） */
  container?: HTMLElement;
  /** 构造时是否自动挂载到 DOM（默认 true）。设为 false 时需手动调用 mount() */
  mount?: boolean;
  /** 是否在 Agent 运行时自动显示操作遮罩（默认 true） */
  enableMask?: boolean;
  /** 遮罩背景透明度（0–1，默认 0.15）。0 = 全透明，1 = 纯白不透明 */
  maskOpacity?: number;
  /** 面板默认展开状态（默认 false，即收起状态，只显示 FAB） */
  expanded?: boolean;
  /** 面板标题（默认 "AutoPilot"） */
  title?: string;
  /** 输入框占位文本 */
  placeholder?: string;
  /** 遮罩提示文本 */
  maskText?: string;
  /** 空状态提示文本 */
  emptyText?: string;
};

/** 消息类型 */
type MessageType = "user" | "assistant" | "tool" | "error";

/** 面板状态 */
type PanelStatus = "idle" | "running" | "error";

/**
 * AutoPilot UI 面板。
 *
 * 使用方式：
 * ```ts
 * // 默认自动挂载
 * const panel = new Panel({ enableMask: true });
 * panel.onSend = async (text) => { await agent.chat(text); };
 *
 * // 延迟挂载
 * const panel = new Panel({ mount: false });
 * panel.mount(); // 手动挂载
 * ```
 */
export default class Panel {
  private container: HTMLElement;
  private enableMask: boolean;
  private maskOpacity: number;
  private title: string;
  private placeholder: string;
  private maskText: string;
  private emptyText: string;

  // ─── DOM 引用 ───
  private root: HTMLDivElement | null = null;
  private fab: HTMLButtonElement | null = null;
  private mask: HTMLDivElement | null = null;
  private panelEl: HTMLDivElement | null = null;
  private messagesEl: HTMLDivElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private statusDot: HTMLDivElement | null = null;
  private statusText: HTMLSpanElement | null = null;
  private stopBtnContainer: HTMLDivElement | null = null;
  private styleEl: HTMLStyleElement | null = null;

  // ─── FAB 拖拽状态 ───
  private fabDragging = false;
  private fabHasMoved = false;

  private mounted = false;
  private expanded: boolean;
  private status: PanelStatus = "idle";

  /** 用户发送消息回调 — 由 WebAgent 绑定 */
  onSend: ((text: string) => Promise<void>) | null = null;
  /** 用户点击停止按钮回调 */
  onStop: (() => void) | null = null;

  constructor(options: PanelOptions = {}) {
    this.container = options.container ?? document.body;
    this.enableMask = options.enableMask ?? true;
    this.maskOpacity = Math.max(0, Math.min(1, options.maskOpacity ?? 0.15));
    this.expanded = options.expanded ?? false;
    this.title = options.title ?? "AutoPilot";
    this.placeholder = options.placeholder ?? "输入要执行的网页操作...";
    this.maskText = options.maskText ?? "AutoPilot 正在操作页面";
    this.emptyText = options.emptyText ?? "发送一条消息，AI 将帮你操作页面";

    // 默认自动挂载，传 mount: false 时需手动调用 mount()
    if (options.mount !== false) {
      this.mount();
    }
  }

  // ─── 公共 API ───

  /** 挂载面板到 DOM（全局单例：先清理残留再创建，防止 HMR/多实例"分身"） */
  mount(): void {
    if (this.mounted) return;
    // 清理 DOM 中可能残留的旧实例（HMR 热更新、重复 new Panel()）
    this.cleanupStale();
    this.injectStyles();
    this.createDOM();
    this.bindEvents();
    this.mounted = true;
    // 根据初始状态显示
    if (this.expanded) {
      this.show();
    }
  }

  /** 卸载面板 */
  unmount(): void {
    if (!this.mounted) return;
    this.root?.remove();
    this.styleEl?.remove();
    this.root = null;
    this.fab = null;
    this.mask = null;
    this.panelEl = null;
    this.messagesEl = null;
    this.inputEl = null;
    this.sendBtn = null;
    this.statusDot = null;
    this.statusText = null;
    this.stopBtnContainer = null;
    this.styleEl = null;
    this.mounted = false;
  }

  /** 展开面板（tooltip 风格定位到 FAB 旁边，FAB 保持可见） */
  show(): void {
    if (!this.mounted) this.mount();
    this.expanded = true;
    this.fab?.classList.add("active");
    // 先定位再显示：等 computePosition 返回后再移除 collapsed，
    // 避免面板在默认位置闪烁后跳到正确位置。
    this.updatePanelPosition().then(() => {
      this.panelEl?.classList.remove("collapsed");
      this.inputEl?.focus();
    });
  }

  /** 收起面板 */
  hide(): void {
    this.expanded = false;
    this.panelEl?.classList.add("collapsed");
    this.fab?.classList.remove("active");
  }

  /** 切换展开/收起 */
  toggle(): void {
    if (this.expanded) this.hide();
    else this.show();
  }

  /** 是否已展开 */
  isExpanded(): boolean {
    return this.expanded;
  }

  /** 是否已挂载 */
  isMounted(): boolean {
    return this.mounted;
  }

  /** 添加消息到面板 */
  addMessage(type: MessageType, text: string): void {
    if (!this.messagesEl) return;
    // 移除空状态
    const empty = this.messagesEl.querySelector(".ap-empty");
    if (empty) empty.remove();
    // 移除 typing 指示器
    this.removeTyping();

    const msg = document.createElement("div");
    msg.className = `ap-msg ${type}`;
    msg.textContent = text;
    this.messagesEl.appendChild(msg);
    this.scrollToBottom();
  }

  /** 清空所有消息 */
  clearMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.innerHTML = "";
    this.showEmpty();
  }

  /** 设置面板状态 */
  setStatus(status: PanelStatus, text?: string): void {
    this.status = status;
    if (this.statusDot) {
      this.statusDot.className = `ap-status-dot ${status}`;
    }
    if (this.statusText) {
      const defaultTexts: Record<PanelStatus, string> = {
        idle: "就绪",
        running: "执行中...",
        error: "出错",
      };
      this.statusText.textContent = text ?? defaultTexts[status];
    }
    // 控制输入区 & 停止按钮
    this.updateInputState();
    // 控制遮罩
    if (this.enableMask) {
      if (status === "running") {
        this.showMask();
      } else {
        this.hideMask();
      }
    }
  }

  /** 显示操作遮罩 */
  showMask(): void {
    this.mask?.classList.add("active");
  }

  /** 隐藏操作遮罩 */
  hideMask(): void {
    this.mask?.classList.remove("active");
  }

  /** 显示 typing 指示器 */
  showTyping(): void {
    if (!this.messagesEl) return;
    this.removeTyping();
    const typing = document.createElement("div");
    typing.className = "ap-typing";
    typing.innerHTML = `
      <div class="ap-typing-dot"></div>
      <div class="ap-typing-dot"></div>
      <div class="ap-typing-dot"></div>
    `;
    this.messagesEl.appendChild(typing);
    this.scrollToBottom();
  }

  /** 移除 typing 指示器 */
  removeTyping(): void {
    const typing = this.messagesEl?.querySelector(".ap-typing");
    if (typing) typing.remove();
  }

  // ─── 内部方法 ───

  /**
   * 清理 DOM 中残留的旧 Panel 元素。
   * 防止 HMR 热更新或多次 new Panel() 导致多个 FAB/面板"分身"。
   */
  private cleanupStale(): void {
    // 清除所有旧的 autopilot root 容器（含 FAB + 面板 + 遮罩）
    document.querySelectorAll("[data-autopilot-ignore]").forEach((el) => {
      // 只清理顶层 root（不清理 root 内部的子元素）
      if (el.parentElement === this.container || el.parentElement === document.body) {
        el.remove();
      }
    });
    // 清除残留样式
    document.querySelectorAll("style[data-autopilot-panel]").forEach((el) => el.remove());
  }

  private injectStyles(): void {
    this.styleEl = document.createElement("style");
    this.styleEl.setAttribute("data-autopilot-panel", "");
    this.styleEl.textContent = PANEL_STYLES;
    document.head.appendChild(this.styleEl);
  }

  private createDOM(): void {
    this.root = document.createElement("div");
    this.root.setAttribute("data-autopilot-ignore", "");

    // ─── 操作遮罩 ───
    this.mask = document.createElement("div");
    this.mask.id = "autopilot-mask";
    this.mask.style.setProperty("--ap-mask-opacity", String(this.maskOpacity));
    this.mask.innerHTML = `
      <div class="ap-mask-label">
        <div class="ap-mask-spinner"></div>
        <span>${this.escapeHtml(this.maskText)}</span>
      </div>
    `;
    this.root.appendChild(this.mask);

    // ─── FAB 按钮 ───
    this.fab = document.createElement("button");
    this.fab.id = "autopilot-fab";
    this.fab.setAttribute("data-autopilot-ignore", "");
    this.fab.innerHTML = ICONS.logo;
    this.fab.title = this.title;
    if (this.expanded) this.fab.classList.add("active");
    this.root.appendChild(this.fab);

    // ─── 面板 ───
    this.panelEl = document.createElement("div");
    this.panelEl.id = "autopilot-panel";
    this.panelEl.setAttribute("data-autopilot-ignore", "");
    if (!this.expanded) this.panelEl.classList.add("collapsed");

    this.panelEl.innerHTML = `
      <div class="ap-header">
        <div class="ap-header-left">
          <div class="ap-header-logo">${ICONS.logo}</div>
          <span class="ap-header-title">${this.escapeHtml(this.title)}</span>
        </div>
        <div class="ap-header-actions">
          <button class="ap-header-btn" data-action="clear" title="清空消息">${ICONS.trash}</button>
          <button class="ap-header-btn" data-action="minimize" title="收起面板">${ICONS.minimize}</button>
        </div>
      </div>
      <div class="ap-status">
        <div class="ap-status-dot idle"></div>
        <span class="ap-status-text">就绪</span>
      </div>
      <div class="ap-messages">
        <div class="ap-empty">
          <div class="ap-empty-icon">${ICONS.logo}</div>
          <div class="ap-empty-text">${this.escapeHtml(this.emptyText)}</div>
        </div>
      </div>
      <div class="ap-stop-container" style="display:none">
        <button class="ap-stop-btn">${ICONS.stop}<span>停止执行</span></button>
      </div>
      <div class="ap-input-area">
        <div class="ap-input-wrapper">
          <textarea class="ap-input" rows="1" placeholder="${this.escapeHtml(this.placeholder)}"></textarea>
        </div>
        <button class="ap-send-btn" title="发送">${ICONS.send}</button>
      </div>
    `;

    this.root.appendChild(this.panelEl);

    // 缓存 DOM 引用
    this.messagesEl = this.panelEl.querySelector(".ap-messages");
    this.inputEl = this.panelEl.querySelector(".ap-input");
    this.sendBtn = this.panelEl.querySelector(".ap-send-btn");
    this.statusDot = this.panelEl.querySelector(".ap-status-dot");
    this.statusText = this.panelEl.querySelector(".ap-status-text");
    this.stopBtnContainer = this.panelEl.querySelector(".ap-stop-container");

    // 挂载到容器
    this.container.appendChild(this.root);
  }

  private bindEvents(): void {
    // FAB 点击 → 切换面板（拖拽过的不触发）
    this.fab?.addEventListener("click", () => {
      if (this.fabHasMoved) {
        this.fabHasMoved = false;
        return;
      }
      this.toggle();
    });

    // 头部按钮
    this.panelEl?.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest("[data-action]");
      if (!target) return;
      const action = target.getAttribute("data-action");
      if (action === "minimize") this.hide();
      if (action === "clear") this.clearMessages();
    });

    // 发送按钮
    this.sendBtn?.addEventListener("click", () => this.handleSend());

    // 输入框回车发送（Shift+Enter 换行）
    this.inputEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // 输入框自动调整高度
    this.inputEl?.addEventListener("input", () => {
      if (!this.inputEl) return;
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + "px";
    });

    // 停止按钮
    this.stopBtnContainer?.addEventListener("click", () => {
      this.onStop?.();
    });

    // ─── 拖拽绑定 ───
    this.initFabDrag();
  }

  /**
   * 使用 @floating-ui/dom 计算面板相对于 FAB 的 tooltip 位置。
   * 根据 FAB 贴边方向自动翻转，并设置对应的 transform-origin 确保动画自然。
   */
  private updatePanelPosition(): Promise<void> {
    if (!this.fab || !this.panelEl || !this.expanded) return Promise.resolve();
    return computePosition(this.fab, this.panelEl, {
      placement: "top-end",
      middleware: [
        offset(8),
        flip({ fallbackPlacements: ["top-start", "bottom-end", "bottom-start", "left", "right"] }),
        shift({ padding: 12 }),
      ],
    }).then(({ x, y, placement }) => {
      if (!this.panelEl) return;
      // 根据实际弹出方向设置 transform-origin，保证 tooltip 展开/收起动画自然
      const origins: Record<string, string> = {
        "top-end": "bottom right",
        "top-start": "bottom left",
        "bottom-end": "top right",
        "bottom-start": "top left",
        left: "center right",
        right: "center left",
      };
      Object.assign(this.panelEl.style, {
        left: `${x}px`,
        top: `${y}px`,
        right: "auto",
        bottom: "auto",
        transformOrigin: origins[placement] ?? "bottom right",
      });
    });
  }

  /**
   * 初始化 FAB 按钮拖拽：长按 300ms 后进入拖拽模式，松手后自动贴边。
   * 短按（未触发长按）或移动距离不超过阈值的走正常 click toggle 逻辑。
   */
  private initFabDrag(): void {
    if (!this.fab) return;
    const fab = this.fab;
    const LONG_PRESS_MS = 300;
    let startX = 0;
    let startY = 0;
    let fabStartX = 0;
    let fabStartY = 0;
    let moved = false;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let dragActivated = false;
    let pointerId = -1;

    const onDown = (e: PointerEvent) => {
      moved = false;
      dragActivated = false;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      const rect = fab.getBoundingClientRect();
      fabStartX = rect.left;
      fabStartY = rect.top;

      // 长按计时器
      longPressTimer = setTimeout(() => {
        dragActivated = true;
        this.fabDragging = true;
        fab.setPointerCapture(pointerId);
        fab.style.transition = "none";
        fab.classList.add("dragging");
      }, LONG_PRESS_MS);

      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // 如果还没激活拖拽，移动超过 4px 则取消长按（算作普通滑动）
      if (!dragActivated) {
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        }
        return;
      }

      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const fw = fab.offsetWidth;
      const fh = fab.offsetHeight;
      const newLeft = Math.max(0, Math.min(vw - fw, fabStartX + dx));
      const newTop = Math.max(0, Math.min(vh - fh, fabStartY + dy));
      fab.style.left = newLeft + "px";
      fab.style.top = newTop + "px";
      fab.style.right = "auto";
      fab.style.bottom = "auto";

      // 拖拽过程中实时更新 tooltip 面板位置
      if (this.expanded) this.updatePanelPosition();
    };

    const onUp = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (!dragActivated) {
        // 短按 → 不拦截，让 click 正常触发 toggle
        return;
      }
      this.fabDragging = false;
      this.fabHasMoved = dragActivated; // 拦截后续 click
      dragActivated = false;
      fab.classList.remove("dragging");
      if (moved) {
        this.snapFabToEdge();
      }
    };

    fab.addEventListener("pointerdown", onDown);
    fab.addEventListener("pointermove", onMove);
    fab.addEventListener("pointerup", onUp);
    fab.addEventListener("pointercancel", onUp);
  }

  /**
   * FAB 吸附到最近屏幕边缘（左/右贴边，上下保持位置）。
   */
  private snapFabToEdge(): void {
    if (!this.fab) return;
    const rect = this.fab.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fw = this.fab.offsetWidth;
    const fh = this.fab.offsetHeight;
    const gap = 12;
    const centerX = rect.left + fw / 2;
    const snapLeft = centerX < vw / 2;
    const targetX = snapLeft ? gap : vw - fw - gap;
    const targetY = Math.max(gap, Math.min(vh - fh - gap, rect.top));

    this.fab.style.transition = "left 0.3s cubic-bezier(0.22, 1, 0.36, 1), top 0.3s cubic-bezier(0.22, 1, 0.36, 1)";
    this.fab.style.left = targetX + "px";
    this.fab.style.top = targetY + "px";
    this.fab.style.right = "auto";
    this.fab.style.bottom = "auto";

    const cleanup = () => {
      if (this.fab) this.fab.style.transition = "";
      // 贴边后更新 tooltip 面板位置
      if (this.expanded) this.updatePanelPosition();
    };
    this.fab.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 350);
  }

  private handleSend(): void {
    if (!this.inputEl || this.status === "running") return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.addMessage("user", text);

    if (this.onSend) {
      this.onSend(text).catch((err) => {
        this.addMessage("error", `执行失败: ${err instanceof Error ? err.message : String(err)}`);
        this.setStatus("error");
      });
    }
  }

  private updateInputState(): void {
    const isRunning = this.status === "running";
    if (this.inputEl) {
      this.inputEl.disabled = isRunning;
    }
    if (this.sendBtn) {
      this.sendBtn.disabled = isRunning;
    }
    if (this.stopBtnContainer) {
      this.stopBtnContainer.style.display = isRunning ? "block" : "none";
    }
  }

  private showEmpty(): void {
    if (!this.messagesEl) return;
    this.messagesEl.innerHTML = `
      <div class="ap-empty">
        <div class="ap-empty-icon">${ICONS.logo}</div>
        <div class="ap-empty-text">${this.escapeHtml(this.emptyText)}</div>
      </div>
    `;
  }

  private scrollToBottom(): void {
    if (!this.messagesEl) return;
    // 双帧滚动：确保 DOM 渲染完毕后再滚到底部，避免新消息追加后高度未更新
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.messagesEl) return;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
