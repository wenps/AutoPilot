# AutoPilot — 项目指南（深度版）

> 浏览器内嵌 AI Agent SDK：让 AI 通过 tool-calling 操作网页。
> 本文是协作与演进指南，关注“怎么改不出错”。

## 1. 项目目标

AutoPilot 的核心不是“聊天”，而是“可控执行”：

- 用户目标被拆解为可执行子任务
- AI 仅基于当前快照做决策
- 通过工具调用驱动真实 DOM 行为
- 每轮执行后刷新快照并增量推进

一句话：**在浏览器内实现任务增量消费的 Agent Loop。**

## 2. 当前权威目录结构

```text
src/
├── core/
│   ├── index.ts
│   ├── types.ts
│   ├── tool-params.ts
│   ├── tool-registry.ts
│   ├── system-prompt.ts
│   ├── snapshot.ts              # core 快照聚合出口（兼容）
│   ├── snapshot-engine.ts       # 兼容转发层（re-export -> agent-loop/snapshot/engine）
│   ├── messaging.ts
│   ├── event-listener-tracker.ts
│   ├── agent-loop/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── constants.ts
│   │   ├── helpers.ts
│   │   ├── snapshot.ts          # 兼容转发层（re-export -> snapshot/lifecycle）
│   │   ├── snapshot/
│   │   │   ├── index.ts
│   │   │   ├── lifecycle.ts
│   │   │   └── engine.ts
│   │   ├── messages.ts
│   │   ├── recovery.ts          # 兼容转发层（re-export -> recovery/index）
│   │   ├── recovery/
│   │   │   └── index.ts
│   │   ├── assertion/
│   │   │   ├── types.ts
│   │   │   ├── prompt.ts
│   │   │   └── index.ts
│   │   └── LOOP_MECHANISM.md   # Agent Loop 权威机制说明（必须同步维护）
│   └── ai-client/
│       ├── index.ts
│       ├── constants.ts
│       ├── custom.ts
│       ├── sse.ts
│       └── models/
│           ├── index.ts
│           ├── openai.ts
│           ├── anthropic.ts
│           ├── deepseek.ts
│           ├── doubao.ts
│           ├── qwen.ts
│           └── minimax.ts
└── web/
  ├── index.ts
  ├── dom-tool.ts          # 兼容转发层（re-export）
  ├── navigate-tool.ts     # 兼容转发层（re-export）
  ├── page-info-tool.ts    # 兼容转发层（re-export）
  ├── wait-tool.ts         # 兼容转发层（re-export）
  ├── evaluate-tool.ts     # 兼容转发层（re-export）
  ├── event-listener-tracker.ts  # 兼容转发层（re-export -> core）
  ├── ref-store.ts
  ├── messaging.ts         # 兼容转发层（re-export -> core）
  ├── snapshot.ts          # 兼容转发层（re-export -> core）
  ├── snapshot-engine.ts   # 兼容转发层（re-export -> core）
  ├── helpers/
  │   ├── base/             # 基础能力层（环境无关的纯工具函数）
  │   │   ├── index.ts      # barrel 导出
  │   │   ├── active-store.ts       # activeRefStore 模块级状态管理
  │   │   ├── resolve-selector.ts   # #hashID / CSS 选择器统一解析
  │   │   ├── visibility.ts         # 元素可见性判定（含 isStyleVisible + details/summary）
  │   │   ├── element-checks.ts     # 元素状态检查（disabled / editable / blocked types）
  │   │   ├── form-item.ts          # 表单项容器检测（泛化 endsWith 匹配）
  │   │   ├── event-dispatch.ts     # Playwright 风格事件模拟原语（click/hover/input 事件链）
  │   │   ├── keyboard.ts           # 键盘模拟（组合键解析 + keydown/keypress/keyup）
  │   │   └── actionability.ts      # 可操作性校验（stable/scroll/hit-target/describe/click-signal）
  │   └── actions/          # 动作执行层（与工具动作直接关联的高层逻辑）
  │       ├── index.ts      # barrel 导出
  │       ├── retarget.ts           # 目标重定向与归一化（Playwright retarget 模式）
  │       ├── fill-helpers.ts       # 表单填充策略（分类型 fill + nearby 推断 + slider 关联）
  │       ├── dropdown-helpers.ts   # 自定义下拉交互（弹窗等待 + 选项文本匹配）
  │       └── wait-helpers.ts       # 等待策略（selector state / text / DOM stable）
  └── tools/
    ├── dom-tool.ts        # DOM 操作工具定义与分发（16 种 action）
    ├── navigate-tool.ts   # 导航工具定义与分发（5 种 action）
    ├── page-info-tool.ts  # 页面信息 + 快照生成引擎（6 种 action）
    ├── wait-tool.ts       # 等待工具定义与分发（5 种 action）
    └── evaluate-tool.ts   # JS 执行工具定义与分发（2 种 action）
```

## 3. 分层边界（必须遵守）

### core 层（环境无关）

职责：
- AI Provider 适配与统一响应
- Agent 主循环与恢复策略
- 工具注册与分发
- 快照消息管理

约束：
- 不依赖 DOM API
- 不引入浏览器上下文对象（window/document）
- 逻辑可在任意 JS 环境复用

### web 层（浏览器实现）

职责：
- WebAgent 入口与配置管理
- 5 个内置浏览器工具
- RefStore 哈希定位
- Extension 消息桥

约束：
- 可依赖 DOM API
- 仅向 core 提供能力，不反向污染 core

## 4. 关键运行原理

### 4.1 增量消费模型

每轮循环都做同一件事：
1. 读取最新页面快照
2. 告诉 AI：当前剩余任务 + 上一轮已执行任务 + 当前快照
3. 执行 AI 返回的工具调用
4. 刷新快照
5. 重复，直到 remaining 收敛（`REMAINING: DONE`）或触发停机条件

补充（渐进式协议）：
- 每轮消息必须显式包含：
  - 当前剩余任务文本（remaining instruction）
  - 上一轮已执行任务数组（previous round tasks）
- 模型可在文本中返回：
  - `REMAINING: <text>`（仍有剩余任务）
  - `REMAINING: DONE`（当前文本任务已消费完）

补充（当前实现）：
- Round 0 使用原始任务作为起点；Round 1+ 不再重复注入原始 userMessage，避免“回头重做”。
- 模型在 `tool_calls` 轮可能返回空 `content`，不可视为完成。
- `REMAINING` 缺失且本轮有执行动作时：按线性任务剔除做启发式推进。
- `REMAINING` 缺失且本轮无执行进展时：保持 remaining 不推进。

### 4.2 不跨 DOM 变化链式执行

原则：
- 当前快照可见的目标可以同轮批量执行
- 会引发结构变化的动作（如打开弹窗）执行后，必须等待下一轮新快照再继续

目标：减少“猜测未来 DOM”导致的失败与空转。

补充（当前实现）：
- 对可能引发 DOM 结构变化的动作（如 `dom.click` / `dom.press`、`navigate.*`、`evaluate`）执行后可强制断轮，等待下一轮新快照。
- 轮次结束时（仅当本轮出现潜在 DOM 变化动作且启用配置）会执行“加载态 + DOM 稳定”双重等待：先等待 loading 指示器隐藏，再等待 DOM 静默窗口（默认 200ms，超时默认 4s）。
- loading 选择器默认覆盖 AntD / Element Plus / BK / TDesign（TD）及通用加载态；用户自定义 `roundStabilityWait.loadingSelectors` 采用“追加合并 + 去重”，不会覆盖默认值。

### 4.3 快照优先级

快照是当前可执行范围的唯一事实来源：
- `messages.ts` 持续注入最新快照
- `snapshot.ts` 负责包裹、去重、剥离旧快照
- `recovery.ts` 负责在失败后触发重新快照

补充（当前实现）：
- chat 发起时由前端先生成首轮快照并注入 `initialSnapshot`。
- 默认拦截 `page_info.*`，避免模型把“看页面”当主流程。
- `pruneLayout=true` 折叠布局容器时，若同一折叠链路提升出多个相邻子节点，快照会输出括号分组块（`collapsed-group`）保留关联语义。
- Round 1+ 注入快照变化摘要（Snapshot Changes）：通过 `computeSnapshotDiff()` 对比前后两轮快照（hashID 归一化后逐行对比），以 `- removed` / `+ added` 格式输出变化行（最多 20 行），让 AI 直接看到"什么变了"，避免微小状态变化（如 `checked` 消失、`is-checked` 消失）淹没在几百行快照中。

### 4.4 找不到元素重试对话流（新增）

当工具执行返回“元素未找到”时：
1. 聚合失败工具（name/input）与失败原因
2. 将失败工具集合 + 最新快照 + 当前任务一起发给 AI
3. 在对话上下文中标注当前尝试次数（attempt x/y）
4. 若仍未命中，默认等待 2 秒后刷新快照再重试
5. 超过最大尝试次数后退出重试流，交由剩余任务协议收敛

### 4.5 工具语义对齐（Playwright 风格，新增）

当前实现在 Web 工具层对齐了常见 Playwright 语义：
- `dom.click`：补齐 `pointerdown/mousedown/pointerup/mouseup/click` 事件链，通过 `elementFromPoint` 定位最内层可见目标并在其上分发事件（冒泡到外层），避免在外层容器 dispatch 导致内层 handler 无法触发。
- `dom.select_option`：支持 `value/label/index` 多策略选择；结果中显式返回 `value + label`。
- `dom.fill`：限制不适用于 `checkbox/radio/file/button/submit/reset`，避免错误动作。
- `wait.wait_for_selector`：支持 `state=attached|visible|hidden|detached`（默认 `attached`）。
- 快照增强运行态：`select val`、`option selected`、`checked`、`disabled`、`readonly`、`aria-checked`、`aria-expanded`、`aria-selected`、`bg="..."` 可见；checkbox/radio 跳过固定 `.value`（状态完全由 `checked` 有无表达）。
- 快照增强结构语义：布局折叠后可通过括号分组块（`collapsed-group`）看出被提升节点之间的来源关联；含 `background-color` 的色块元素不被折叠或文本聚合吞掉。
- 仅交互节点分配 hash ID：通过 `hasInteractiveTrackedEvents()` + 语义标签/ARIA role 判定交互性，非交互节点不占 token。
- 角色优先标签：当元素拥有 `INTERACTIVE_ROLES` 内的 ARIA role 且与 HTML tag 不等价时，用 role 替代 tag 作为显示标签（如 `[combobox]` 替代 `[input] role="combobox"`、`[slider]` 替代 `[div] role="slider"`），同时从属性列表中移除冗余的 `role="..."`。
- 点击目标选择约束：`click/navigation` 动作优先命中具备点击信号的目标（`listeners` 含 `clk/pdn/mdn`、`onclick`、原生链接/按钮语义或 `role=button/link`）；仅 `focus/hover` 信号节点默认视为上下文，不作为主点击目标。
- 点击无效关联回退：当一次点击未产生推进时，下一轮应优先尝试同语义组内最近的可操作 sibling/ancestor（如同一行中相邻 repo path/link/button），避免重复点击同一无效目标。

### 4.6 效果验证机制

通过 system prompt 和 Round 1+ 用户消息中的通用 "Effect check" 规则实现：
- 每轮行动前，要求 AI 确认上轮操作的预期效果是否在当前快照中可见
- 若未生效，不重复同一目标，改为尝试同语义区域内信号更强的邻近元素
- 实现方式：
  - system prompt 中的 "Effect check" 规则（通用，覆盖所有动作类型）
  - Round 1+ 用户消息中补强同一规则
  - previousRoundTasks 列表后附加简短效果提示（非阻塞式，避免分析瘧痪）

### 4.7 快照指纹变化检测（框架级）

通过 `computeSnapshotFingerprint` 在每轮行动前后各算一次快照指纹，从框架层判定操作是否产生了真实页面变化：
- 指纹计算前先将快照中的 `#hashID`（如 `#1kry9hw`）替换为占位符 `#_`，避免 DOM 重新渲染导致 hashID 变化但内容未变的误判
- 仅在本轮有潜在 DOM 变更动作（`roundHasPotentialDomMutation`）时才对比
- 若行动后指纹不变：注入 `Snapshot unchanged after action` 提示，告知模型该操作无效果，必须换目标
- 该提示与 `protocolViolationHint`（重复批次/协议缺失）合并注入，不覆盖
- 与效果验证机制互补：效果验证依赖模型自我察觉，指纹检测是框架级兜底

### 4.8 快照变化摘要（Snapshot Diff）

通过 `computeSnapshotDiff()` 对比前后两轮快照，输出可读的变化行摘要，注入到 Round 1+ 用户消息中：
- hashID 归一化后逐行对比，消除 DOM 重渲染噪音
- 输出格式：`- removed line` / `+ added line`，最多 20 行
- 仅在 Round 1+（有前一轮快照可对比）且 diff 非空时注入
- 注入位置：快照之前，作为 `## Snapshot Changes (since last round)` 区块
- 与指纹检测互补：指纹只判断"变没变"，diff 告诉 AI "变了什么"
- 典型场景：开关 toggle 后 `checked` 消失、颜色选择器 `bg` 变化、表单值更新等微小状态变化

## 5. 模块职责细化

### core/agent-loop

- `index.ts`
  - 主循环编排
  - 工具执行与结果汇总
  - 与 AIClient 和 ToolRegistry 协同

- `messages.ts`
  - 紧凑消息构建
  - Round 0 注入“原始任务 + 快照 + 关键行为强化”
  - Round 1+ 注入"remaining + done steps + previous executed + effect check + previous model output + assertion progress + snapshot changes diff + latest snapshot"
  - 效果检查（Effect check）：通过简短提示要求 AI 确认上轮操作是否生效，非阻塞式设计避免分析瘧痪
  - 快照变化摘要（Snapshot Changes）：diff 非空时在快照前注入 `## Snapshot Changes`，让 AI 直接看到前后轮变化
  - 断言进度（Assertion Progress）：lastAssertionResult 未全通过时，在快照前注入 `## Assertion Progress`，标记每条断言的通过/失败状态及理由

- `snapshot/`
  - `lifecycle.ts`：读取页面 URL/快照、快照包裹与去重、prompt 中旧快照剥离
  - `engine.ts`：DOM 快照序列化实现（`generateSnapshot` / `SnapshotOptions`）
  - `index.ts`：snapshot 子模块聚合导出
- `snapshot.ts`
  - 兼容转发层（re-export -> `snapshot/lifecycle.ts`）

- `assertion/`
  - `types.ts`：断言类型定义（`TaskAssertion` / `AssertionConfig` / `AssertionResult` / `TaskAssertionResult`）
  - `prompt.ts`：断言专用 prompt 构建（`buildAssertionSystemPrompt` / `buildAssertionUserMessage`），独立 AI 调用不继承 system prompt
  - `index.ts`：断言评估引擎（`evaluateAssertions`），发起无 tools 的独立 AI 请求并解析 JSON 结果

### core

- `helpers.ts`
  - 工具结果识别、输入摘要、等待时间解析等纯函数
  - `isPotentialDomMutation()`：宽泛判定（含 click），用于轮次后稳定等待
  - `isConfirmedProgressAction()`：窄判定（含 fill/type/press/navigate/自定义工具，不含 click），用于协议缺失计数器重置与豁免
  - `computeSnapshotFingerprint()`：剥离 hashID 后的快照指纹，用于轮次间变化检测
  - `computeSnapshotDiff()`：hashID 归一化后逐行对比两份快照，输出变化行摘要（最多 20 行），用于 Round 1+ 快照变化注入

### core/ai-client

- `index.ts`：provider 路由与统一类型导出
- `constants.ts`：provider 默认端点与共享校验逻辑
- `custom.ts`：BaseAIClient 抽象封装
- `sse.ts`：SSE 统一消费器
- `models/`：各 provider 客户端类
  - `index.ts`：模型客户端统一导出
  - `openai.ts`：OpenAI/Copilot 协议
  - `anthropic.ts`：Anthropic 协议
  - `deepseek.ts`：DeepSeek 协议（复用 OpenAIClient）
  - `doubao.ts`：豆包（Ark）OpenAI 兼容协议（复用 OpenAIClient）
  - `qwen.ts`：通义千问（DashScope）OpenAI 兼容协议（复用 OpenAIClient）
  - `minimax.ts`：MiniMax OpenAI 兼容协议（复用 OpenAIClient）

### web

- `index.ts`：WebAgent 对外 API，负责配置、记忆、autoSnapshot、callbacks
- `snapshot.ts`：兼容转发层（re-export -> core/snapshot-engine）
- `helpers/base/`：基础能力层，提供不直接参与工具动作执行的底层纯函数
  - `active-store.ts`：activeRefStore 模块级状态，解耦 dom-tool / page-info-tool / resolve-selector 的循环依赖
  - `resolve-selector.ts`：统一选择器解析（#hashID 优先通过 RefStore，CSS 作为兼容回退）
  - `visibility.ts`：元素可见性判定（含 `isStyleVisible` 递归检测 + `<details>/<summary>` 特殊处理）
  - `element-checks.ts`：元素状态检查（`isElementDisabled` 含 ARIA disabled 祖先链、`isEditableElement`、`INPUT_BLOCKED_TYPES`）
  - `form-item.ts`：表单项容器检测（`endsWith("form-item")` 泛化匹配 + `role="group"`，覆盖主流 UI 框架）
  - `event-dispatch.ts`：Playwright 风格事件模拟原语（完整 click/hover/input 事件链、`setNativeValue`、`selectText`、`deepestChildAtPoint` 最内层目标穿透）
  - `keyboard.ts`：键盘模拟（组合键解析 `splitKeyCombo`、keyCode 映射 `resolveKeyCode`、keydown/keypress/keyup 分发 `executePress`）
  - `actionability.ts`：可操作性校验（位置稳定 `checkElementStable`、多策略滚动 `scrollIntoViewIfNeeded`、遮挡检测 `checkHitTarget`、点击信号校验 `validateClickSignal`、综合检查 `ensureActionable`）
- `helpers/actions/`：动作执行层，与工具动作直接关联的高层组合逻辑
  - `retarget.ts`：目标重定向与归一化（Playwright retarget 模式：非交互→button/link 回溯、label→control 关联、checkbox/radio/switch 归一化、formItem→control 重定向；元素自身有 click/pointerdown/mousedown 追踪事件时跳过祖先回溯）
  - `fill-helpers.ts`：表单填充策略（分类型 fill、nearby 不可编辑目标推断、slider 关联数值输入、`collectSearchScopes` 共享作用域收集）
  - `dropdown-helpers.ts`：自定义下拉交互（`waitForDropdownPopup` 弹窗等待、`findVisibleOptionByText` 选项文本匹配，覆盖 ARIA listbox + 主流框架 popper）
  - `wait-helpers.ts`：等待策略（selector state 四态判定、MutationObserver + 轮询双通道、文本等待、DOM 静默窗口）
- `tools/dom-tool.ts`：DOM 操作工具定义与 action 分发（16 种动作），自身仅含 schema 定义 + 元素查找 + switch-case 分发，底层能力全部委托 helpers
- `tools/navigate-tool.ts`：导航工具定义与分发（goto/back/forward/scroll/reload 5 种动作）
- `tools/page-info-tool.ts`：页面信息工具定义与分发（6 种动作）；`snapshot` 动作为框架内部调用，序列化实现位于 `core/agent-loop/snapshot/engine.ts`（经 `web/snapshot.ts` 转发）
- `tools/wait-tool.ts`：等待工具定义与分发（5 种动作），底层逻辑委托 helpers/actions/wait-helpers
- `tools/evaluate-tool.ts`：JS 执行工具定义与分发（2 种动作），自包含实现，无外部 helper 依赖
- `dom-tool.ts` / `navigate-tool.ts` / `page-info-tool.ts` / `wait-tool.ts` / `evaluate-tool.ts`：兼容转发层，避免外部导入路径断裂
- `event-listener-tracker.ts`：兼容转发层（实现已迁移至 core/event-listener-tracker.ts）
- `ref-store.ts`：`#hashID -> Element` 映射
- `messaging.ts`：兼容转发层（实现已迁移至 core/messaging.ts）

## 6. 保护机制（系统稳定性的核心）

必须理解并保留以下机制：

1. 元素恢复机制
- 元素找不到时进入重试对话流（失败工具聚合 + 快照 + 尝试次数）

2. 导航上下文更新
- 导航后刷新快照，避免旧映射污染

3. 空转检测
- 连续只读/无实质推进时终止循环，防止无限迭代

4. 重复批次防自转
- 若连续两轮返回完全相同的任务批次且上一轮无错误，注入"换策略"提示（不停机）
- 若连续三轮仍相同批次且上一轮无错误，直接终止本次请求
- 目标：给模型一次换策略的机会，避免因页面跳转延迟等瞬态原因过早终止

5. 无效点击拦截与交替循环检测
- 快照指纹未变时，将本轮 click selector 加入拦截集合，下一轮再次点击直接返回 `INEFFECTIVE_CLICK_BLOCKED` 引导模型换目标。
- 快照变化时，仅移除本轮点击的 selector（可能引发了变化），保留其他轮次标记的无效 selector。
  - 避免模型在两个目标间交替点击时，其中一个引发轻微快照变化（如焦点样式）导致另一个被错误解锁。
- 交替循环检测：近 6 轮 click 目标滑动窗口，若近 4 轮内唯一目标 ≤ 2 个且总点击 ≥ 4 次，判定为循环，将目标全部加入拦截集并注入警告。
- 附近可点击元素推荐：当点击被拦截或证实无效时，使用 `findNearbyClickTargets()` 从快照中查找目标上下 15 行内带点击信号的元素，按距离排序后以 `#hashID (brief)` 格式注入提示，让模型有明确替代目标而非盲猜。

6. 协议修复回合
- 当"remaining 未完成 + 无工具调用"出现时，不直接结束
- 下一轮注入 protocol violation 提示，要求"要么工具调用推进，要么严格 `REMAINING: DONE`"

7. 滞止收敛检测（stale remaining）
- 当 remaining 连续 N 轮不推进且本轮无确认性进展（fill/type/press/navigate/自定义工具成功执行）时触发
- ≥ 2 轮：注入 CRITICAL 提示，要求模型检查快照是否已满足目标，若满足则输出 REMAINING: DONE
- ≥ 3 轮：直接终止，stopReason = `stale_remaining`
- 典型场景：任务已通过快照可见完成，但模型不主动输出 REMAINING: DONE，转而反复尝试 click OK、page_info 等无实质推进动作

8. 停机原因可观测（stopReason）
- 每次停机时 `metrics.stopReason` 输出精确的停机原因枚举值
- 枚举值：`converged`（任务收敛）/ `assertion_passed`（断言通过）/ `repeated_batch`（重复批次）/ `idle_loop`（空转）/ `stale_remaining`（滞止收敛）/ `no_protocol`（协议缺失）/ `protocol_fix_failed`（协议修复失败）/ `max_rounds`（达到上限）/ `dry_run`（干运行模式）
- 目标：消除停机原因靠猜测的问题，所有保护停机条件均可追溯

9. 断言能力（Assertion）
- 通过独立 AI 调用判断任务是否已完成，解决模型自行收敛不可靠的问题
- 触发方式：执行 AI 主动调用 `assert({})` 工具（system prompt 告知模型具备断言能力）
- `assert` 可与其他工具调用在同一轮共存：先执行其他工具，等待稳定后再触发断言
- 评估流程：聚合已执行动作 → 读取最新快照 → 独立 AI 请求（无 tools、无 system prompt 继承）→ 返回 JSON 结果
- `allPassed = true`：停机，`stopReason = "assertion_passed"`
- `allPassed = false`：失败原因通过 `## Assertion Progress` 区块注入下一轮上下文，继续循环
- 配置入口：`ChatOptions.assertionConfig.taskAssertions[]`（每条含 `task` + `description`）
- 关键实现：`src/core/agent-loop/assertion/`（types.ts / prompt.ts / index.ts）
## 7. 变更策略（高优先级）

### 允许做的

- 以“最小改动”修复链路中的单点问题
- 优先增强类型与可观测性
- 在不改变外部 API 的前提下优化内部结构

### 禁止做的

- 跨层耦合（core 直接引用 DOM）
- 通过全局单例绕过 ToolRegistry 实例化设计
- 修改 recovery 语义却不更新 messages/prompt 一致性
- 以“删除快照信息”掩盖决策问题

## 8. 开发与验证

```bash
pnpm install
pnpm check
pnpm test
pnpm demo
pnpm build
```

验收要求：
- `pnpm check` 无 error
- 关键链路可在 demo 中完成一次完整任务（有工具调用、有快照更新、有最终总结）

## 9. 文档治理

- 权威架构说明：`README.md` 的“完整架构流程图（含链路）”章节
- `docs/ARCHITECTURE_FLOW.md`：可作为扩展草稿或历史版本
- Agent Loop 机制权威说明：`src/core/agent-loop/LOOP_MECHANISM.md`
- 修改运行机制（loop、snapshot、recovery）时，必须同步更新 README 对应章节
- 只要改动涉及 `src/core/agent-loop` 的流程语义（轮次阶段、REMAINING 协议、停机条件、恢复策略、指标语义），必须同步更新 `src/core/agent-loop/LOOP_MECHANISM.md`

## 10. 一句话协作准则

**先保证“快照-决策-执行-反馈”闭环正确，再谈优化。**

补充：对“渐进式任务消费”相关改动，必须同时维护三处一致性：
- `messages.ts` 的输入语义（remaining + previous tasks + previous model output）
- `index.ts` 的停机判定（无工具调用/重复批次/错误回退）
- README/AGENTS 的机制描述

并新增一致性要求：
- 找不到元素重试流（attempt 标注、等待策略、最大重试）在 `index.ts` 与 README/AGENTS 中必须一致。

## 11. 注释与提示词语言规范

- 函数级注释（JSDoc）以中文为主：
  - 优先保证中文说明清晰、可维护
  - 对外暴露 API、跨模块边界、易歧义逻辑可补充英文摘要
- 对外 Prompt 正文统一英文：
  - 发送给模型的 system/user 指令文本必须是英文
  - 中文仅用于源码注释，不应进入 prompt payload
- 改动规则：
  - 修改函数逻辑时，同步更新该函数注释，确保描述与行为一致
  - 新增 core 模块导出函数时，至少提供清晰中文注释；必要时补充英文

## 12. Provider 变更一致性（新增）

- 新增或调整 provider 时，至少同步以下文件：
  - `src/core/ai-client/index.ts`（provider 路由）
  - `src/core/ai-client/constants.ts`（默认端点）
  - `src/web/index.ts`（WebAgentOptions 注释/提示）
  - `README.md`（对外配置示例与支持矩阵）
- 若 provider 协议走 OpenAI 兼容层，优先复用 `OpenAIClient`，避免复制请求/流解析逻辑。
