# Changelog

## 0.0.57

### 新功能

- **断言能力（Assertion）**：
  - 新增内置 `assert` 工具 — AI 认为任务完成时主动调用 `assert({})`，触发独立 AI 判定任务是否真正完成
  - 断言 AI 使用专用 Prompt（不继承 system prompt、不带 tools），基于初始快照 + 动作后快照 + 当前快照 + 已执行操作判定每条任务断言
  - 断言 AI 接收三份快照：初始快照（任务开始前）、动作后快照（稳定等待前，捕获瞬态成功提示）、当前快照（稳定后最终状态）
  - 通过 before/after 对比判定"创建/修改/删除"等长任务是否完成；动作后快照解决"提交后自动跳转导致成功信息丢失"
  - 新增 `assertion/` 子模块（`types.ts` / `prompt.ts` / `index.ts`）：类型定义、断言专用 Prompt 构建、断言评估引擎
  - 新增 `StopReason: "assertion_passed"` — 所有断言通过时立即收敛停机
  - 新增 `StopReason: "assertion_loop"` — 连续 2 轮仅调 assert 且都失败时自动停机，防止断言死循环
  - 支持自定义断言：`ChatOptions.assertionConfig.taskAssertions` 传入细粒度子任务断言
  - 默认断言：无自定义配置时以用户原始消息作为整体断言依据
  - `assert` 可与其他工具调用在同一轮共存 — 先执行其他工具，等待稳定后再发起断言

- **断言进度注入（Assertion Progress）**：
  - 断言部分失败时，Round 1+ 消息中注入 `## Assertion Progress (x/y passed)` 区块
  - 每条断言标 `✓`/`✗` 附带 AI 判定理由，引导执行 AI 聚焦失败项

- **断言前 hover 清除**：
  - 新增 `onBeforeAssertionSnapshot` 回调，断言快照刷新前自动清除 hover/focus 瞬态视觉状态
  - 对所有 `:hover` 元素派发 `pointerleave`/`mouseleave`，对 `activeElement` 调 `blur()`
  - 解决 Element Plus Rate 等组件点击后 hover 遮盖 `is-active` 导致断言误判的问题

- **快照变化摘要（Snapshot Diff）**：
  - 新增 `computeSnapshotDiff()`，hashID 归一化后逐行对比前后快照，输出 `- removed` / `+ added` 格式变化摘要（最多 20 行）
  - Round 1+ 快照前注入 `## Snapshot Changes (since last round)` 区块，让 AI 直接看到"什么变了"

- **停机原因枚举（StopReason）**：
  - 新增 `StopReason` 类型（`converged` / `repeated_batch` / `idle_loop` / `no_protocol` / `protocol_fix_failed` / `max_rounds` / `dry_run`）
  - `AgentLoopMetrics` 新增 `stopReason` 字段，全链路记录停机原因

### 改进

- **快照引擎增强**：
  - 输出 `aria-checked` / `aria-expanded` / `aria-selected` ARIA 状态属性
  - 提取 inline `background-color` 作为 `bg="..."` 属性（颜色指示器/色块元素）
  - 跳过 checkbox/radio `.value` 输出（状态完全由 `checked` 有无表达）
  - 布局折叠与文本聚合保留背景色语义，含 `background-color` 的元素不被折叠或吞并

- **点击事件穿透（innermost targeting）**：
  - `dispatchClickEvents` 改为通过 `elementFromPoint` 定位元素中心最内层可见目标，在其上分发事件（冒泡到外层）
  - 新增 `deepestChildAtPoint` 回退穿透，覆盖 `elementFromPoint` 无法穿透的边界情况

- **retarget 自身点击信号守卫**：
  - 元素自身有 click/pointerdown/mousedown 追踪事件时，跳过祖先 button/link 回溯
  - 修复 el-color-picker 等内层 div 有独立 @click handler 却被回溯到外层 button 的问题
- **system prompt 始终包含断言能力说明**：`## Assertion Capability` 章节不再依赖外部配置，始终注入
- **`assert` 注册为内置工具**：与 `dom`/`navigate`/`wait`/`evaluate` 同级，在 `registerTools()` 时注册，`DEFAULT_TOOL_NAMES` 新增 `"assert"`
- **`AgentLoopResult` 新增 `assertionResult` 字段**：返回断言评估详细结果（`allPassed`/`total`/`passed`/`failed`/`details`）

### 修复

- **面板展开定位闪烁**：
  - `updatePanelPosition()` 改为 Promise 异步，await `computePosition` 返回后再移除 `collapsed` 类名

### 重构

- **web helpers 分层重组（base/ + actions/）**：
  - 将 `dom-tool.ts`（1145→500 行）和 `wait-tool.ts` 中的所有工具函数提取到 `src/web/helpers/` 下
  - 按职责拆分为两个子目录：
    - `helpers/base/`：基础能力层（8 个模块）— 状态管理（active-store）、选择器解析（resolve-selector）、可见性判定（visibility）、元素检查（element-checks）、表单项检测（form-item）、事件模拟原语（event-dispatch）、键盘模拟（keyboard）、可操作性校验（actionability）
    - `helpers/actions/`：动作执行层（4 个模块）— 目标重定向（retarget）、表单填充策略（fill-helpers）、自定义下拉交互（dropdown-helpers）、等待策略（wait-helpers）
  - 两个子目录各提供 `index.ts` barrel 导出
  - 工具文件（dom-tool / navigate-tool / page-info-tool / wait-tool / evaluate-tool）瘦身为纯 schema 定义 + action 分发层

- **共享代码去重**：
  - `getClickPoint`：actionability 从 event-dispatch 复用，移除重复中心点计算
  - `collectSearchScopes`：findAssociatedSliderInput / guessNearbyFillTarget 共享作用域收集逻辑
  - `isFormItemContainer` / `findFormItemContainer`：从 fill-helpers 和 retarget 提取到独立 form-item 模块

- **框架通用化**：
  - 表单项容器匹配从硬编码 `.el-form-item` 改为 `endsWith("form-item")` 泛化模式，覆盖 Element Plus / Ant Design / BK / TDesign 等

- **工具文件 JSDoc 增强**：
  - 5 个 tool 文件注释完善为结构化格式：职责说明、完整动作列表（含实现细节）、核心机制、依赖结构、运行环境

- **Agent Loop 模块目录化（snapshot / recovery）**：
  - 快照能力迁移为 `src/core/agent-loop/snapshot/` 子模块：
    - `lifecycle.ts`：读取/包裹/剥离
    - `engine.ts`：`generateSnapshot` / `SnapshotOptions`
    - `index.ts`：统一聚合导出
  - 恢复能力迁移为 `src/core/agent-loop/recovery/index.ts`，`recovery.ts` 保留为兼容转发层
  - `src/core/agent-loop/snapshot.ts` 保留为兼容转发层（re-export -> `snapshot/lifecycle.ts`）

- **core 统一维护关键能力（实现迁移，web 保留兼容层）**：
  - `event-listener-tracker` 与 `messaging` 实现迁移至 `src/core/`，`src/web/` 对应文件改为兼容转发层
  - `snapshot-engine` 实现统一维护于 core 路径，web 侧 `snapshot.ts` / `snapshot-engine.ts` 仅保留转发
  - `page-info-tool.ts` 保留 `snapshot` 动作作为框架内部调用，AI 可见动作描述中移除 `snapshot`

### 文档

- 同步更新 `LOOP_MECHANISM.md`、`AGENTS.md`、`README.md`
- recovery 模块注释移除已废弃的冗余拦截/快照防抖描述
- 同步更新 `system-prompt.ts`：明确 `page_info.snapshot` 为 INTERNAL framework action（禁止模型主动调用）
- AGENTS.md：新增断言目录结构、模块职责、stopReason 枚举、§9 断言能力说明
- LOOP_MECHANISM.md：新增 §5.8 断言能力、断言进度注入、assertion/ 模块描述
- README.md：新增 §6 断言能力章节、assert 工具说明、assertionResult 字段、目录结构更新

### Demo

- 新增 `ElementPlaygroundView`（表单/数据展示/反馈组件三 Tab 综合测试页）

## 0.0.56

### 修复

- **fill 单独调用时输入不生效（需先 focus 再 fill 才成功）**：
  - `selectText()` 中 `focus()`/`select()` 调用顺序反了：先 `select()` 后 `focus()` 导致 UI 框架（BK-Input、el-input 等）的 focus handler 通过 `nextTick` 重置光标，撤销已选区
  - 修正为先 `focus()` 后 `select()`，确保框架 handler 先执行，选区不被覆盖
  - `executeFillOnResolvedTarget()` 中 `dispatchClickEvents`（触发 focus）与 `selectText`/`setNativeValue` 之间无异步间隔，框架的异步 focus handler（Vue `nextTick`、BK-Input 后处理等）在值写入后才执行，可能重置值或选区
  - 在 `dispatchClickEvents` 后加 `await sleep(0)` 让出一个事件循环 tick，等待框架异步 handler 执行完毕后再写入值
  - 影响范围：HTMLInputElement、HTMLTextAreaElement、contentEditable 三种 fill 路径均已修复

## 0.0.55

### 改进

- **fill/type/select_option 自动 click + focus**：
  - `fill`：文本类 input、textarea、contentEditable 在填写前自动执行完整 click 事件链（pointermove→pointerdown→mousedown→focus→pointerup→mouseup→click），确保 React/Vue 受控组件和 UI 组件库（Ant Design、Element Plus 等）的状态机被正确激活
  - `type`：逐字输入前由 `focus()` 改为 `dispatchClickEvents()`，补齐 click 事件链
  - `select_option`（原生 `<select>`）：由 `focus()` 改为 `scrollIntoViewIfNeeded` + `dispatchClickEvents()`，补齐 click 事件链
  - date/color/range 等特殊类型不受影响（保持 `focus()` + `setValue`，避免触发原生 picker）

- **移除冗余的 focus/click 前置提示词**：
  - 移除 `Input order (MANDATORY): focus/click → fill/type/select_option` 规则
  - 移除 `Do NOT run focus-only batches` 规则
  - 新增 `fill/type/select_option auto-focus` 规则，告知模型无需额外发送 focus/click
  - 填写多字段从 4 个 tool_call（focus A→fill A→focus B→fill B）减少到 2 个（fill A→fill B），节省约 50% token 消耗

## 0.0.54

### 修复

- **`HTMLSummaryElement is not defined` 导致所有 click 失败**：
  - `validateClickSignal()` 中使用 `instanceof HTMLSummaryElement` 判定原生可点击元素
  - 部分浏览器/WebView 环境未定义该全局构造函数，导致 `ReferenceError` 抛出，所有 click 操作全部失败
  - 改用 `el.tagName === "SUMMARY"` 替代，兼容所有环境

## 0.0.53

### 新增

- **无效点击选择性清除**：
  - 快照变化时不再 `clear()` 整个无效集合，改为仅移除本轮点击的 selector
  - 保留其他轮次标记的无效 selector，防止交替点击循环中一个目标引发轻微快照变化（如焦点样式）导致另一个被错误解锁

- **点击目标交替循环检测**：
  - 维护近 6 轮 click 目标滑动窗口（`recentRoundClickTargets`）
  - 若近 4 轮内唯一目标 ≤ 2 个且总点击 ≥ 4 次，判定为循环
  - 将所有循环目标加入 `ineffectiveClickSelectors` 并注入警告提示
  - 解决模型在两个无效目标间交替点击（A→B→A→B）无法被重复批次检测捕获的问题

- **附近可点击元素推荐**：
  - 新增 `findNearbyClickTargets()` 纯函数（helpers.ts）
  - 当点击被拦截或证实无效时，自动从快照中查找目标上下 15 行内带点击信号的元素
  - 按距离排序后以 `#hashID ([tag] "text" listeners="...")` 格式注入提示
  - 三个触发场景：`INEFFECTIVE_CLICK_BLOCKED` 拦截响应 / "Snapshot unchanged" 提示 / 交替循环检测提示
  - 让模型有明确的替代 hashID 可选，而非泛泛的"换个目标"建议

## 0.0.52

### 新增

- **重复无效点击框架级拦截**：
  - 新增 `checkIneffectiveClickRepeat()` 保护机制（recovery.ts）
  - 当某个 click selector 在上一轮执行后快照未发生任何变化，该 selector 被标记为"无效"
  - 下一轮模型再次点击同一 selector 时，框架直接拦截并返回错误提示，强制模型换目标
  - 快照发生变化时自动清空无效集合（页面已改变，之前的判定失效）
  - 解决弱模型（如 MiniMax）反复点击同一无效目标导致死循环的问题

## 0.0.51

### 新增

- **原始目标锚定（Original Goal Anchor）**：
  - Round 1+ 每轮 user 消息注入 `Original Goal: <用户原始输入>`，作为任务对照组
  - 防止模型在多步执行过程中偏航（如把"去 X 仓库创建 issue"误解为"创建 X 仓库"）
  - System Prompt 新增 Original Goal Anchor 规则：要求模型每步行动都对照原始目标，不偏离

- **通用目标拆解规则（Goal Decomposition）**：
  - System Prompt 新增 Goal decomposition 规则：区分目标实体（TARGET）和要执行的动作（ACTION）
  - 覆盖 go to / create / edit / delete 等各类操作语义
  - 核心原则：不把"导航到某实体"与"创建/删除/修改它"混淆；找不到目标时先搜索而非点击最近同名按钮

## 0.0.50

### 修复

- **协议缺失停机过早终止多步 UI 导航任务**：
  - 问题：MiniMax 等不输出 `REMAINING:` 协议的模型，在多步 click 导航场景（搜索→点击仓库→选择分支→切换 Tab）中，连续 5 轮 click 导致 `consecutiveNoProtocolRounds` 达到阈值而被强制终止，即使每次 click 都成功导航到了新页面
  - 原因：`consecutiveNoProtocolRounds` 停机检查在快照指纹对比之前执行，click 不算 `isConfirmedProgressAction`，因此每轮都累加计数器
  - 修复：将协议缺失停机检查（保护 5）移至快照刷新 + 指纹对比之后；若本轮 click 导致快照指纹变化（页面确实切换），重置计数器为 0
  - 仅当连续多轮操作均无页面变化且无协议时，才触发停机

### 文档

- 同步更新 `LOOP_MECHANISM.md`：更新 §4.3 协议缺失容忍说明，新增快照指纹兜底逻辑描述，更新停机条件描述

## 0.0.48

### 新增

- **快照指纹变化检测（框架级）**：
  - 新增 `computeSnapshotFingerprint()` 辅助函数：将快照中 `#hashID` 替换为占位符 `#_` 后计算 djb2 哈希，避免 DOM 重新渲染导致 hashID 变化但内容未变的误判
  - Agent Loop 每轮行动前后各计算一次快照指纹，当本轮存在潜在 DOM 变更动作（`roundHasPotentialDomMutation`）且行动后指纹不变时，注入 `Snapshot unchanged after action` 提示
  - 与 Prompt 层效果验证互补：效果验证依赖模型自我察觉，指纹检测是框架级兜底，确保模型感知到操作无效并换目标

### 文档

- 同步更新 `AGENTS.md`：新增 §4.7 快照指纹变化检测说明，更新 helpers.ts 模块职责
- 同步更新 `README.md`：保护机制表格新增快照指纹检测行，核心优势补充指纹检测

## 0.0.47

### 修复

- **点击无效后模型不换目标**：
  - 增强 System Prompt `No-effect fallback` 规则：从抽象的"try nearest sibling"改为具体三步回退——(1) 找容器内 `<a>`/`<button>` 子元素 (2) 尝试父/兄弟节点 (3) 换全新策略（搜索、侧栏导航、或用 `evaluate` 编程触发）
  - 增强 `Effect check` 规则：明确"快照没变 = click 失败"，必须换元素（如行内链接或按钮）
  - 增强 `Repeated action warning`（防自转提示）：注入具体行动方案——找容器内 `<a>`/`<button>`、用 href 直接导航、换全新策略
  - 增强 Round 1+ 上轮执行回顾提示：无效果时引导找子元素而非重复

## 0.0.46

### 修复

- **重复批次防自转过于激进导致提前停机**：
  - 原逻辑：连续 2 轮相同工具调用批次 + 上轮无错误 → 直接停机
  - 修复后：连续 2 轮 → 注入"换策略"提示给模型一次机会；连续 3 轮 → 真正停机
  - 典型场景：模型点击"创建议题"按钮后页面跳转中，快照暂未更新，模型重试同一点击 → 旧逻辑直接终止任务

- **协议缺失计数器过早停机**：
  - 修复 `consecutiveNoProtocolRounds` 在有确定性推进时仅"不递增"但不重置的问题，改为 **重置为 0**
  - 原逻辑导致 fill 等动作只是暂停计数，后续 click/press 轮次继续累加，6 轮即触发停机
  - 修复后：confirmed progress 轮次重置计数器，给模型更多行动空间

- **`isConfirmedProgressAction` 覆盖范围扩展**：
  - 新增 `dom.press`（按键操作）：Enter 提交、Tab 切焦等均属用户显式操作，应算确定性推进
  - 新增自定义工具识别：非 SDK 内置工具（dom/navigate/page_info/wait/evaluate 以外）由开发者注册、模型有意调用，视为确定性推进
  - click 仍然排除——因为 click 可能点中无 listener 元素导致无效

- **修复 click 死循环**：
  - 新增 `isConfirmedProgressAction()` 辅助函数，仅包含必定产生可见状态变化的动作
  - 协议缺失豁免改用 `roundHasConfirmedProgress`（不含 click），避免模型反复点击无效目标时计数器被 `isPotentialDomMutation`（含 click）持续豁免导致无限循环

- **System Prompt 点击规则增强**：
  - 明确点击目标必须具备点击信号（`listeners` 含 `clk/pdn/mdn`、`onclick`、原生 `<a>/<button>`、`role=button/link`）
  - 禁止点击仅有 `blr/fcs` 信号的元素
  - 若目标文本无点击信号，引导 AI 查找父容器或最近可操作兄弟元素

## 0.0.42

### 修复

- **Agent Loop 健壮性增强（兼容 MiniMax 等不严格遵循协议的模型）**：
  - 修复 remaining 被模型污染：无工具调用轮次仅接受 `REMAINING: DONE` 收敛，不再采纳模型自行改写的非空 remaining（如 MiniMax 首轮返回"你好，请告诉我需要执行的操作"覆盖用户原始任务）
  - 修复空转检测误判：空转检测改为基于实际执行的工具（`executedTaskCalls`），被框架拦截的冗余 `page_info` 不再计入只读轮次
  - 修复重复批次误判：全部工具调用被框架拦截（无实际执行）时，视同"有错误"轮次，不触发"重复批次即停机"
  - 放宽协议缺失阈值：停机阈值从 3 轮放宽至 5 轮，提醒注入从 2 轮放宽至 3 轮，适配 MiniMax 等系统性不输出 REMAINING 的模型

### 变更

- **Demo 移除 Vite proxy 依赖**：
  - WebAgent 不再配置 `baseURL: '/api'`，直接使用 provider 默认端点
  - 用户只需配 `provider` + `token` 即可使用，无需额外代理设置

## 0.0.41

### 新增

- **MiniMax 模型接入**：
  - 新增 `minimax` provider，基于 OpenAI 兼容协议（`https://api.minimaxi.com/v1`）
  - 推荐模型：`MiniMax-M2.5` / `MiniMax-M2.5-highspeed`
  - 与 DeepSeek / Doubao / Qwen 同模式，复用 OpenAIClient 零额外依赖

- **遮罩透明度可配置（`maskOpacity`）**：
  - `PanelOptions` 新增 `maskOpacity` 参数（默认 `0.15`），支持自定义操作遮罩透明度
  - 遮罩背景模糊从 `2px` 调整为 `1px`，视觉更轻量

- **快照 class 名过滤（`classNameFilter`）**：
  - `SnapshotOptions` 新增 `classNameFilter` 配置（`string[] | false`）
  - 默认启用内置正则规则，按组件关键词（`-button`、`-input`、`-table`、`-form` 等）剔除 UI 框架噪音类名
  - 覆盖 Element Plus / Ant Design / TDesign / Arco / Vant / Naive UI 等主流框架
  - 保留悬浮层相关类名（dialog / modal / drawer / popover / tooltip / dropdown）以便 AI 识别弹层结构
  - 传 `false` 可禁用过滤，传自定义正则数组可替换默认规则

## 0.0.40

### 新增

- **内置 UI 面板（`web/ui/`）**：
  - 开箱即用的浮动聊天面板 + 操作遮罩，纯 DOM 实现，零框架依赖
  - FAB 按钮展开/收起，支持拖拽定位；使用 `@floating-ui/dom` tooltip 风格定位
  - 实时消息流（用户/AI/工具调用/错误），输入框 + 发送/停止控制
  - 操作遮罩：自动化执行期间阻止用户操作页面，防止干扰
  - 通过 `WebAgent` 的 `panel` 选项一行配置启用，或通过 `createPanel()` / `destroyPanel()` 动态管理
  - 面板与 WebAgent 双向绑定：`onSend → agent.chat()`，`callbacks → 面板消息流 & 状态`
  - 从 `agentpage` 包统一导出 `Panel` 类与 `PanelOptions` 类型

- **AI 请求超时与重试**：
  - `AIClientConfig` 新增 `requestTimeoutMs`（默认 45000ms）和 `parallelToolCalls`（默认 true）配置项
  - OpenAI 客户端新增 `fetchWithTimeout` + AbortController 超时机制
  - JSON（非流式）模式超时后自动重试 1 次，避免因单次网络抖动中断任务

- **协议缺失容忍机制**：
  - 当模型不遵循 REMAINING 协议但有成功的 DOM 变更时，不计入协议缺失计数（视为实质推进）
  - 仅在本轮工具全部失败或无 DOM 变更时才累计计数，连续 3 轮后强制终止
  - 连续 2 轮协议缺失时注入 Protocol reminder 提示，兼容 DeepSeek 等不严格遵循协议的模型

- **`dom.click` 强制断轮**：
  - click 动作执行后立即断轮，同批次后续动作推迟到下一轮
  - 确保每轮最多一次 click（作为批次末尾），降低因 DOM 变化导致的后续动作失败

- **快照文本聚合**：
  - 无交互后代的布局子树自动合并所有叶子文本为一行（`hasInteractiveDescendant` + `collectLeafTexts`）
  - 纯文本布局标签简化：无 hash、无子输出的布局标签只输出文本内容，去掉无意义的标签外壳
  - 移除 `collapsed-group` 括号分组，链式坍塌改为扁平提升，减少快照嵌套层级

- **快照 listener 事件白名单**：
  - `SnapshotOptions` 新增 `listenerEvents` 字段，支持自定义快照输出的事件类型
  - `buildSystemPrompt` 同步支持 `listenerEvents`，动态生成 Listener Abbrevs 表
  - 默认仅输出 9 种高价值事件（click/input/change/mousedown/pointerdown/keydown/submit/focus/blur）

- **多场景 Demo 页面**：
  - 新增 8 个路由独立页面（变更发布/供应商入驻/客户新建/应用开通/对账批次/工单升级/权限模板/总览）

### 变更

- **Prompt 规则重构**：
  - 批量执行规则改为"fill/type 自由批量，click 结束当前轮次，每轮最多一次 click 放在最后"
  - 新增"语义完成"规则（Semantic completion）：所有未解决的用户约束必须保留在 Remaining 中，直到快照可见确认
  - 新增"不压缩 Remaining"规则：禁止将 Remaining 压缩为丢失实体/值/数量/筛选条件/目标的模糊外壳动作
  - 新增"前置条件检查"规则：执行推进/完成动作前，先确认前置约束在快照中已满足
  - 新增"中间进度不等于完成"规则：打开/展开/筛选/翻页/切换上下文等中间动作不算任务完成
  - 下拉策略细化：原生 `select_option` 一轮完成；自定义下拉需 click 打开 → 下一轮 → click 选项
  - 搜索/筛选输入：fill 后需 press Enter 或 click 搜索按钮触发搜索
  - system prompt 不再包含工具列表章节（工具描述由 provider 协议传递）

- **五大工具描述精简**：
  - `dom`、`navigate`、`page_info`、`wait`、`evaluate` 工具描述和 schema description 大幅压缩
  - 移除重复性指导文本，仅保留能力枚举与关键约束，降低 tool schema token 消耗

- **REMAINING 协议解析增强**：
  - `parseRemainingInstruction` 改为按行从后往前搜索最后一个 `REMAINING:` 行
  - 兼容 `REMAINING: DONE - 总结文本` / `REMAINING: DONE: xxx` 等尾随说明写法

- **WebAgent 初始快照不再注入 system prompt**：
  - 首轮快照作为 `initialSnapshot` 传入 agent-loop，由消息层统一管理，不再拼入 system prompt 文本

- **快照跳过标签扩充**：
  - 新增 `COLGROUP` / `COL` 到 SKIP_TAGS，减少表格结构噪音

### 测试

- 新增 `openai.test.ts`：覆盖 `parallel_tool_calls` 默认值、显式配置、JSON 模式超时重试
- 新增 agent-loop 测试用例：
  - `REMAINING: DONE` 带尾随说明时收敛
  - 连续无 REMAINING 协议且启发式无法推进时 3 轮后终止（仅失败轮计数）
  - 无 REMAINING 但重复批次时正确触发同批检测
  - `dom.click` 强制断轮：click 后同批次 fill 推迟到下一轮

### 文档

- 同步更新 `AGENTS.md`：补充 §4.3 协议缺失容忍、UI 面板模块职责、目录结构
- 同步更新 `LOOP_MECHANISM.md`：新增 §4.3 协议缺失容忍、更新停机条件描述

## 0.0.39

### 变更

- **Prompt 大幅精简**：减少约 40% 的提示词 token 消耗，降低每轮调用成本
  - `system-prompt.ts`：30+ 条冗长规则压缩为 ~20 条精练规则，Minimal Example 压缩为 1 行
  - `messages.ts` Round 0：删除与 system prompt 重复的规则，仅保留动态上下文 + 关键行为强化
  - `messages.ts` Round 1+：删除 14 行重复规则，保留 5 行关键强化提示

- **Effect verification 重新设计**：从 7 行 MANDATORY 段落改为 1 行通用 "Effect check" 规则
  - 解决模型在效果验证时陷入分析瘧痪（反复推理无法产出工具调用）的问题
  - system prompt + user message 同步强化，通用覆盖所有动作类型

- **新增规则**：
  - `snapshot is auto-refreshed`：明确快照自动刷新，减少模型主动调 page_info 的冲动
  - `Never repeat same tool call`：禁止重复相同工具调用，减少无效轮次
  - `Do NOT use get_text/get_attr for visible content`：避免冗余读取操作
  - `Stop: confirmed in snapshot`：停机前必须确认快照中任务已完成

### 文档

- 同步更新 `AGENTS.md`：§4.6 效果验证机制、§5 messages.ts 模块职责
- 同步更新 `README.md`：Prompt 设计架构 A/B 章节
- 同步更新 `LOOP_MECHANISM.md`：消息构建描述

## 0.0.38

### 新增

- `messages.ts` Round 1+ 消息新增 **Effect verification** 验证段落：
  - 在注入上轮操作列表之后、规划新操作之前，要求 AI 先对比「上轮执行动作」与「当前快照」，判断每个操作是否已生效
  - 若操作未产生可见效果（页面在目标区域无变化），显式指引 AI 不重复同一目标，改为在同语义区域内寻找信号更强的邻近元素
  - 仅在有上轮操作时触发，Round 0 不受影响

### 文档

- 同步更新 `AGENTS.md`：补充 §4.6 效果验证机制说明，更新 `messages.ts` 模块职责
- 同步更新 `README.md`：Round Messages 层说明中补充 Effect verification 段落

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
