# Changelog

## 0.0.35

### 变更

- `system-prompt` 点击目标选择策略增强：
  - 对 `click/navigation` 动作新增强约束：优先选择具备明确点击信号的元素（如 `listeners` 含 `clk/pdn/mdn`、`onclick`、原生 `a/button` 语义或 `role=button/link`）
  - 明确禁止将仅 `focus/hover` 信号节点当作导航点击目标（如仅 `fcs/blr/men/mlv`）
  - 引入“关联性回退”指引：点击无效时，下一轮应优先尝试同语义组内最近的可操作 sibling/ancestor，避免重复点击无效目标

### 文档

- 同步更新 `README.md`：补充内置 prompt 的点击目标与关联回退规则说明。
- 同步更新 `AGENTS.md`：补充工具语义对齐章节中的“点击信号优先 + 邻近关联回退”执行约束。

## 0.0.34

### 新增

- 快照角色优先标签（Role-first tag）能力：
  - 当元素存在交互性 ARIA role 且与原始 HTML tag 不等价时，快照标签优先输出 role
  - 示例：`[combobox]` 替代 `[input] role="combobox"`，`[slider]` 替代 `[div] role="slider"`
  - 角色提升后自动移除冗余 `role="..."` 属性，减少 token 噪音

### 变更

- 快照 hash 分配策略升级为“仅交互节点分配”：
  - 基于 `hasInteractiveTrackedEvents()` + 语义标签 + ARIA role + 可聚焦/可编辑能力综合判定
  - 非交互节点不再输出 `#hashId`，降低快照体积与定位歧义
- 快照排序策略增强：
  - 同层子节点由“交互优先 + 事件优先级评分”排序
  - 输入链路事件（`input/change/focus/blur`）优先级高于点击链路，提升模型命中率
- 运行时事件信号增强：
  - 快照新增 `listeners="..."` 简写标注（如 `clk/ inp/ chg/ fcs/ blr`）
  - 事件追踪由全局 `EventTarget.prototype` 补丁驱动，支持 add/remove 监听动态更新
- Agent Loop 收敛优化：
  - 当模型显式返回 `REMAINING: DONE` 且本轮执行成功时，直接收敛结束，避免重复轮次
- 默认快照深度统一提升：
  - `core` 读取与 `web` 首轮快照默认 `maxDepth` 对齐到 `12`

### 文档

- 同步更新 `README.md`：
  - 增补 `event-listener-tracker` 模块说明与架构图节点
  - 补充“仅交互节点 hash + 角色优先标签”快照语义
  - 补充 system prompt 侧对 role 标签语义的执行约束说明
- 同步更新 `AGENTS.md`：
  - 更新目录结构与 web 模块职责，纳入 `event-listener-tracker.ts`
  - 明确快照交互判定、角色优先标签与 token 控制策略

## 0.0.33

回到 0.0.24 的版本基础。

## 0.0.32

### 变更

- 快照深度与折叠策略大幅增强，解决组件库深层嵌套元素不可见问题：
  - `page_info.snapshot` 默认 `maxDepth` 从 `7` 提升至 `12`，`maxNodes` 从 `280` 提升至 `500`
  - `agent-loop/snapshot.ts` 核心层默认 `maxDepth` 从 `8` 同步提升至 `12`
  - 新增**深度感知折叠策略**：深度 ≤ 5 保留含语义文本的布局容器；深度 > 5 对纯布局容器强制折叠（子节点仍提升输出），避免深层包装 div 浪费深度预算
  - 覆盖 Element Plus / Ant Design 等组件库 16+ 层 DOM 嵌套场景，确保表单控件、选择器、穿梭框等交互元素在快照中可见
- `dom.fill` 新增离散评分组件支持（如 `el-rate`）：
  - `role=slider` 元素无关联 input 时，根据 `aria-valuemin/max` 自动识别离散子项并点击第 N 个完成设值
  - 示例：`fill(selector="#rate", value="4")` 在 5 星评分组件上设置 4 星
  - `ensureActionable` 对 `role=slider` 放行 editable 检查，允许 fill 穿透到离散设值逻辑
- `resolveEditableTarget` 祖先搜索深度从 5 层收紧到 3 层：
  - 避免 `role=slider`（如 el-rate）向上搜索时跨 form-item 误关联到其他表单项的 input

## 0.0.31

### 变更

- `page_info.snapshot` 结构保真与预算平衡优化：
  - 默认快照参数调整为 `maxDepth=7`、`maxNodes=280`、`maxChildren=32`
  - 布局剪枝新增浅层主干保留策略，避免页面骨架被过早折叠
  - 容器保留规则改为“自身事件优先 + 中浅层事件探测 + 语义文本保留”平衡策略
- 快照噪音控制补强：
  - 过滤 `__SVG_SPRITE_NODE__` 等装饰性节点，降低图标定义树对节点预算的挤占
- 文档与注释同步：
  - 同步更新 `README.md` 快照默认值与剪枝规则说明
  - 同步更新 `src/core/agent-loop/snapshot.ts` 注释，明确 core/web 分层与压缩策略

## 0.0.30

### 变更

- `page_info.snapshot` 噪音过滤修复：
  - 修复标签过滤大小写/命名空间判定，确保 `svg` 等装饰节点按预期跳过
  - 跳过 `__SVG_SPRITE_NODE__` 容器，避免图标定义树占用节点预算导致业务层级被稀释

## 0.0.29

### 变更

- `page_info.snapshot` 剪枝保护增强：
  - 布局容器在“自身或子树存在绑定事件”时不再被折叠剪枝
  - 避免交互链路节点因 `pruneLayout` 被错误隐藏，降低任务漂移与重复点击

## 0.0.28

### 变更

- `system-prompt.ts` 调整为 Core Rules 主体并保留关键约束：
  - 保留“当前快照 + 当前 remaining”的渐进式执行约束
  - 补回 `Listener Abbrevs` 映射段（`clk` / `inp` / `chg` / `kdn` 等）
  - 保留 anti-drift 提示（执行前对照原始目标，避免 create issue / create repository 混淆）
- `agent-loop` 在 `REMAINING` 缺失时的回退推进改为保守策略：
  - 仅在 remaining 文本含显式顺序连接词（如 `然后` / `next` / `->`）时启发式推进
  - 每轮最多推进一步，避免因一次多工具调用误吞后续提醒子句

### 测试

- 新增回归用例：缺失 `REMAINING` 协议时，逗号提醒子句（如“记得选负责人”）不应被误剔除。

## 0.0.27

### 新增

- Round 1+ 消息注入 Master goal 锚点（防任务漂移）：
  - 当 `remaining` 与原始任务不同时，注入 `Master goal (reference only — do NOT restart from scratch)`
  - 让模型随时能交叉校验当前行动是否符合原始意图，避免 remaining 被错误缩减后完全偏离目标
  - 标注 `reference only` 语义，防止模型回头从头重做

### 变更

- `system-prompt.ts` Constraints 新增反漂移规则：
  - "Always cross-check your planned actions against the Master goal to avoid task drift"

### 测试

- 更新"缺失 REMAINING 协议且本轮有执行动作"测试用例：
  - 断言 Round 1+ 消息包含 `Master goal (reference only` 锚点
  - 移除旧的"不包含原始任务"断言（该行为已变更为有条件注入）

## 0.0.26

### 新增

- `dom-tool` 单文件（960 行）拆分为模块文件夹 `src/web/tools/dom-tool/`：
  - `index.ts`：入口 + schema + execute 路由
  - `constants.ts`：共享常量（等待时间、键码映射、输入类型白名单）
  - `query.ts`：元素查找（hash/CSS/复合选择器）、RefStore 管理、describeElement
  - `actionability.ts`：可操作性检查（可见/禁用/可编辑/稳定/命中）
  - `events.ts`：事件派发（click/hover/input 完整事件链、键盘 press）
  - `resolve.ts`：目标解析（retarget、checkable/pointer/formItem/editable 穿透）
  - `dropdown.ts`：自定义下拉增强（findVisibleOptionByText、waitForDropdownPopup）
- `resolve.ts` 新增通用 ARIA widget → input 穿透策略：
  - 支持 `role=slider` / `role=spinbutton` 元素向上遍历（最多 5 层）查找关联 `<input>`
  - 无硬编码框架类名，适用于 Element Plus / AntD / 原生等任意实现
- 新增浏览器端全局事件监听追踪器：
  - 通过 `EventTarget.prototype.addEventListener/removeEventListener` 统一记录事件绑定
  - 仅记录 `Element` 目标，使用 `WeakMap<Element, Set<string>>` 存储
  - 在 `web` 入口默认安装（模块加载即生效），尽量覆盖早期绑定
- 快照交互增强：
  - `page_info.snapshot` 增加 `listeners="..."` 输出字段，暴露运行时事件绑定
  - 交互优先级判定接入追踪事件（如 `click/input/change/keydown`）
  - 布局剪枝时，带事件绑定的容器不再被误折叠
- `RefStore` 新增引用维护能力：
  - 新增 `delete(id)`
  - 新增 `prune(keepIds)`，用于批量清理未保留和失联引用

### 变更

- `system-prompt.ts` 重写为 Decision Framework 架构：
  - 决策流程：ANALYZE snapshot → ASSESS targets → CHOOSE action → EXECUTE → OUTPUT
  - 新增 Targeting Rules（hash selector、ordinal 视觉稳定序）
  - 新增 Constraints（form-input 顺序、DOM 变化断轮）
  - 新增 Listener Abbreviations 映射（`clk` / `inp` / `chg` 等）
  - 工具描述部分完全由各工具 `t.description` 动态注入，prompt 不再重复
- `dom-tool` 工具描述精简（10 行 → 3 行）：
  - 移除与 system prompt 重复的决策指导内容
  - 仅保留能力枚举（actions / fill auto-resolve / check-uncheck / press / scroll）
  - ordinal 规则迁移至 system prompt Targeting Rules
- 快照收敛后新增引用清理流程：
  - `generateSnapshot()` 在完成输出后执行 `refStore.prune(emittedRefIds)`
  - 自动移除本轮未出现在快照中的 ref 与已失联（`isConnected=false`）元素映射
- `dom-tool` / `wait-tool` 的 `#ref` 解析逻辑增强：
  - 命中映射但元素失联时立即删除脏引用，避免后续重复命中无效 ref

### 测试

- 新增 `src/web/event-listener-tracker.test.ts`：覆盖事件追踪 add/remove 与非 Element 目标过滤。
- 新增 `src/web/ref-store.test.ts`：覆盖 `delete` 与 `prune` 清理行为。

### 文档

- `README.md` 新增 Demo Prompt 建议（Element Plus），同步 `demo/App.vue` 的 `setSystemPrompt('demo', ...)` 策略。
- `docs/ARCHITECTURE_FLOW.md` 同步新增 Demo Prompt 配置示例与策略说明。

## 0.0.25

### 新增

- 在 Agent Loop 中引入“轮次级操作稳定性屏障”：
  - 使用 `wait.wait_for_selector(state=hidden)` 等待 loading 指示器消失
  - 使用 `wait.wait_for_stable` 等待 DOM 进入静默窗口
- 在 core/web 对外 API 中新增 `RoundStabilityWaitOptions`，用于配置轮次后稳定性等待行为。
- 新增回归测试覆盖：
  - 同一轮多个潜在变更动作只触发一次稳定性屏障
  - `loadingSelectors` 合并语义（默认 + 自定义，且去重）

### 变更

- 在保持既有循环语义不变的前提下，下调默认等待参数以降低端到端任务耗时。
- `core/agent-loop` 默认值调整：
  - `DEFAULT_NOT_FOUND_RETRY_WAIT_MS`: `2000 -> 1000`
  - `DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS`: `8000 -> 4000`
  - `DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS`: `300 -> 200`
  - `DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS` 扩充为覆盖 AntD / Element Plus / BK / TDesign 及通用 loading 状态
- `web/tools` 默认值调整：
  - `dom-tool` 的 `DEFAULT_WAIT_MS`: `2000 -> 1200`
  - `wait-tool` 的 `DEFAULT_TIMEOUT`: `10000 -> 6000`
- `roundStabilityWait.loadingSelectors` 调整为“与默认列表合并（追加 + 去重）”，不再覆盖默认选择器。

### 文档

- 已同步以下文档中的机制与默认参数说明：
  - `README.md`
  - `AGENTS.md`
  - `src/core/agent-loop/LOOP_MECHANISM.md`
  - `TODO.md`

### 移除

- 删除体积过大的研究文档：`docs/PLAYWRIGHT_DOM_RESEARCH.md`。
