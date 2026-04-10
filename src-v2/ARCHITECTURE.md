# AutoPilot v2 — 完整架构文档

> 浏览器内嵌 AI Agent SDK：让 AI 通过 tool-calling 操作网页。
> 本文档是 v2 版本的**权威架构参考**，涵盖目录结构、分层设计、执行流程、任务推进机制及重构方向。

---

## 1. 项目定位

AutoPilot 的核心不是"聊天"，而是**可控执行**：

- 用户目标被拆解为可执行子任务
- AI 仅基于**当前快照**做决策（走一步看一步）
- 通过工具调用驱动真实 DOM 行为
- 每轮执行后刷新快照并增量推进

**一句话：在浏览器内实现任务增量消费的 Agent Loop。**

---

## 2. 目录结构

```text
src-v2/
├── ARCHITECTURE.md                  # 本文档
├── MULTI_AGENT_ARCHITECTURE.md      # 多 Agent 架构设计文档
│
├── core/                            # 🔵 环境无关层（不依赖 DOM/浏览器）
│   ├── index.ts                     # Core barrel export（统一对外 API）
│   │
│   ├── shared/                      # 无状态基础设施
│   │   ├── types.ts                 # 核心类型（AIClient / AIMessage / AgentLoopParams / StopReason 等）
│   │   ├── tool-registry.ts         # ToolRegistry 类（注册/查询/分发）
│   │   ├── tool-params.ts           # 参数解析工具函数
│   │   ├── constants.ts             # 默认常量（MAX_ROUNDS / RETRY / SNAPSHOT 标记等）
│   │   ├── helpers.ts (43KB)        # 核心工具函数集（40+ 函数）
│   │   │                              任务解析 / 指纹计算 / diff / nearby 推荐 / REMAINING 协议等
│   │   ├── system-prompt.ts         # Main Agent system prompt 构建器
│   │   ├── prompt-rules.ts          # 共享 prompt 规则（Main + MicroTask Agent 公用）
│   │   ├── messaging.ts             # Extension 消息桥（proxy / handler）
│   │   ├── event-listener-tracker.ts # 全局事件监听追踪
│   │   │
│   │   ├── snapshot/                # 快照子系统
│   │   │   ├── index.ts             # barrel export
│   │   │   ├── lifecycle.ts         # 读取 / 包裹 / 剥离快照
│   │   │   └── engine.ts (33KB)     # DOM 序列化算法（generateSnapshot / generateFocusedSnapshot）
│   │   │
│   │   ├── recovery/                # 恢复策略
│   │   │   └── index.ts             # 元素恢复 / 导航检测 / 空转检测 / 无效点击拦截
│   │   │
│   │   └── ai-client/               # AI 客户端（基于 fetch，跨平台）
│   │       ├── index.ts             # createAIClient() 工厂 + provider 路由
│   │       ├── constants.ts         # provider 白名单校验
│   │       ├── custom.ts            # BaseAIClient 基类（自定义客户端扩展点）
│   │       ├── sse.ts               # SSE 流式解析
│   │       └── models/              # 各 provider 适配
│   │           ├── openai.ts        # OpenAI / Copilot（流式 + 非流式）
│   │           ├── anthropic.ts     # Anthropic Claude（流式 + 非流式）
│   │           ├── deepseek.ts      # DeepSeek
│   │           ├── doubao.ts        # 豆包
│   │           ├── qwen.ts          # 通义千问
│   │           ├── minimax.ts       # MiniMax
│   │           └── glm.ts           # 智谱 GLM
│   │
│   ├── assertion/                   # 独立断言判定层
│   │   ├── types.ts                 # TaskAssertion / AssertionResult / PendingAssertion
│   │   ├── levels.ts                # 断言请求构建（micro-task 级 / system 级）
│   │   ├── prompt.ts                # 断言专用 prompt（不含 tools）
│   │   └── index.ts                 # evaluateAssertions / evaluate / evaluateAsync / awaitAllAssertions
│   │
│   ├── micro-task/                  # 微任务数据结构与编排
│   │   ├── types.ts                 # MicroTaskDescriptor / MicroTaskResult / ExecutionRecordChain
│   │   ├── record.ts               # createExecutionRecordChain() 工厂
│   │   ├── task-monitor.ts          # TaskMonitor 类（编排器 + 记录链管理）
│   │   ├── prompt.ts                # buildMicroTaskPrompt()（精简 prompt）
│   │   └── index.ts                 # barrel export
│   │
│   ├── engine/                      # 决策主循环（统一执行引擎）
│   │   ├── index.ts                 # executeAgentLoop()（唯一入口）
│   │   ├── engine-context.ts        # EngineContext 类（状态容器 + 辅助方法）
│   │   ├── phases.ts (738行)        # 7 阶段 phase 函数（核心执行逻辑）
│   │   ├── messages.ts (567行)      # 消息编排（Round 语义 + REMAINING 协议）
│   │   ├── index.test.ts            # engine 单元测试
│   │   └── messages.test.ts         # 消息编排单元测试
│   │
│   └── main-agent/                  # 对话管理 + 模式调度
│       ├── index.ts                 # MainAgent 类（chat + chatWithOrchestration）
│       ├── dispatch.ts              # executeMicroTask() 函数
│       ├── orchestration-context.ts # OrchestrationContext（AI 自主编排会话状态）
│       └── ARCHITECTURE.md          # 模块级架构说明
│
└── web/                             # 🟢 浏览器实现层（依赖 DOM API）
    ├── index.ts (681行)             # WebAgent 类（面向用户的顶层 API）
    ├── ref-store.ts                 # RefStore（Hash ID → Element 映射）
    │
    ├── ui/                          # 内置聊天面板 UI
    │   ├── index.ts                 # Panel 类导出
    │   ├── panel.ts                 # 面板实现
    │   ├── styles.ts                # 面板样式
    │   ├── icons.ts                 # 图标 SVG
    │   └── logo-data.ts             # Logo 数据
    │
    ├── helpers/                     # DOM 操作辅助函数
    │   ├── base/                    # 基础能力层（环境无关的纯工具函数）
    │   │   ├── index.ts             # barrel 导出
    │   │   ├── active-store.ts      # activeRefStore 模块级状态管理
    │   │   ├── resolve-selector.ts  # #hashID / CSS 选择器统一解析
    │   │   ├── visibility.ts        # 元素可见性判定
    │   │   ├── element-checks.ts    # 元素状态检查（disabled / editable）
    │   │   ├── form-item.ts         # 表单项容器检测
    │   │   ├── event-dispatch.ts    # Playwright 风格事件模拟原语
    │   │   ├── keyboard.ts          # 键盘模拟（组合键）
    │   │   ├── actionability.ts     # 可操作性校验
    │   │   ├── hover-force.ts       # Hover 效果强制清理
    │   │   ├── interactive-overlay.ts       # 交互元素高亮覆盖层
    │   │   └── interactive-overlay-store.ts # 覆盖层状态
    │   │
    │   └── actions/                 # 动作执行层（高层业务逻辑）
    │       ├── index.ts             # barrel 导出
    │       ├── retarget.ts          # 目标重定向与归一化（Playwright retarget 模式）
    │       ├── fill-helpers.ts      # 表单填充策略（分类型 fill + nearby 推断 + slider）
    │       ├── dropdown-helpers.ts  # 自定义下拉交互（弹窗等待 + 选项匹配）
    │       └── wait-helpers.ts      # 等待策略（selector state / text / DOM stable）
    │
    └── tools/                       # 5 个内置浏览器工具
        ├── dom-tool.ts (30KB)       # DOM 操作（16 种 action）
        ├── navigate-tool.ts         # 导航操作（5 种 action）
        ├── page-info-tool.ts        # 页面信息 + 快照引擎（6 种 action）
        ├── wait-tool.ts             # 等待操作（5 种 action）
        └── evaluate-tool.ts         # JS 执行（2 种 action）
```

---

## 3. 分层边界

### 3.1 core 层（环境无关）

**职责：**
- AI Provider 适配与统一响应
- Agent 主循环与恢复策略
- 工具注册与分发
- 快照消息管理
- 微任务编排
- 断言判定

**约束：**
- 不依赖 DOM API（window / document / Element）
- 不引入浏览器上下文对象
- 逻辑可在任意 JS 环境复用（Node.js / Web Worker / 浏览器）

### 3.2 web 层（浏览器实现）

**职责：**
- WebAgent 入口与配置管理
- 5 个内置浏览器工具（dom / navigate / page_info / wait / evaluate）
- RefStore 哈希定位（Hash ID → DOM Element）
- 快照生成（DOM 序列化）
- Extension 消息桥
- 内置 UI 面板

**约束：**
- 可依赖 DOM API
- 仅向 core 提供能力（工具实现），不反向污染 core

### 3.3 依赖方向

```
web/ ──依赖──▶ core/shared
web/ ──依赖──▶ core/main-agent
web/ ──依赖──▶ core/assertion

core/main-agent ──依赖──▶ core/engine
core/main-agent ──依赖──▶ core/micro-task
core/main-agent ──依赖──▶ core/assertion
core/main-agent ──依赖──▶ core/shared

core/engine ──依赖──▶ core/shared
core/engine ──依赖──▶ core/assertion

core/micro-task ──依赖──▶ core/assertion (类型)
core/micro-task ──依赖──▶ core/shared (类型)

core/assertion ──依赖──▶ core/shared (AIClient 类型)
```

**禁止反向依赖：**
- core/ 不依赖 web/
- engine/ 不依赖 main-agent/
- shared/ 不依赖 engine/ / main-agent/ / micro-task/

---

## 4. 关键类/函数职责速查

| 类/函数 | 文件 | 职责 |
|---------|------|------|
| **WebAgent** | `web/index.ts` | 浏览器端顶层入口，管理 RefStore/快照/UI/回调 |
| **MainAgent** | `core/main-agent/index.ts` | 对话管理 + 双模式调度 + 历史累积 |
| **OrchestrationContext** | `core/main-agent/orchestration-context.ts` | AI 自主编排会话状态 + 异步断言流水线 |
| **executeMicroTask** | `core/main-agent/dispatch.ts` | 微任务执行桥（prompt + engine） |
| **executeAgentLoop** | `core/engine/index.ts` | 决策主循环唯一入口 |
| **EngineContext** | `core/engine/engine-context.ts` | 循环状态容器（配置/累积/防护计数） |
| **phases.ts** | `core/engine/phases.ts` | 7 阶段 phase 函数（核心逻辑） |
| **buildCompactMessages** | `core/engine/messages.ts` | 消息编排（Round 语义 + REMAINING 协议） |
| **ToolRegistry** | `core/shared/tool-registry.ts` | 工具注册/查询/分发 |
| **TaskMonitor** | `core/micro-task/task-monitor.ts` | 微任务编排器 + 执行记录链管理 |
| **createExecutionRecordChain** | `core/micro-task/record.ts` | 记录链工厂 |
| **evaluateAssertions** | `core/assertion/index.ts` | 同步断言评估（独立 AI 调用） |
| **evaluateAsync** | `core/assertion/index.ts` | 异步断言（流水线，不阻塞） |
| **buildSystemPrompt** | `core/shared/system-prompt.ts` | Main Agent prompt 构建 |
| **buildMicroTaskPrompt** | `core/micro-task/prompt.ts` | MicroTask Agent prompt 构建 |
| **buildCoreOperationRules** | `core/shared/prompt-rules.ts` | 两种 Agent 共享的 DOM 操作规则 |
| **generateSnapshot** | `core/shared/snapshot/engine.ts` | DOM 序列化算法 |
| **createAIClient** | `core/shared/ai-client/index.ts` | AI 客户端工厂（8 provider） |

---

## 5. 三种执行模式

### 模式 A：直接执行（chat）

最常用的模式，等价 v1 的 WebAgent.chat()。

```
用户 → WebAgent.chat(msg)
  → RefStore 创建 + 初始快照生成
  → MainAgent.chat(msg, { initialSnapshot })
    → buildSystemPrompt({ extraInstructions, assertionTasks })
    → executeAgentLoop({ client, registry, systemPrompt, message, initialSnapshot, history })
      → [Round 0..N] 7 阶段循环
        → 阶段 2: messages.ts 编排消息 → AI 调用
        → 阶段 4: ToolRegistry.dispatch → web/tools/* 执行
        → 阶段 7: 快照刷新 + 指纹对比 + 9 大防护
      → 停机 → buildResult()
    → history 累积
  → 返回 AgentLoopResult
```

### 模式 B：编排执行（chatWithOrchestration）

用户预定义微任务列表，逐个执行。

```
用户 → WebAgent.chatWithOrchestration(msg, tasks[])
  → MainAgent.chatWithOrchestration(msg, tasks)
    → TaskMonitor 初始化
    → for each task:
        → monitor.execute(task, executeFn)
          → executeMicroTask(descriptor, previousContext)
            → buildMicroTaskPrompt({ task, previouslyCompleted })
            → executeAgentLoop({ focusedMode: true, maxRounds: 15 })
            → 生成 MicroTaskResult + MicroTaskExecutionRecord
          → chain.append(record)
        → 失败 → 重试（最多 maxRetries 次）
    → 汇总指标 + monitor.recordChain.buildEvidenceSummary()
  → 返回 MainAgentResult { microTaskResults[], metrics }
```

### 模式 C：AI 自主编排（chat + enableOrchestration）

AI 在主循环中自行决定是否拆解微任务。

```
用户 → WebAgent.chat(msg, { enableOrchestration: true })
  → MainAgent.chat(msg, { enableOrchestration: true })
    → OrchestrationContext 创建
    → 注册 dispatch_micro_task 工具到 ToolRegistry
    → buildSystemPrompt({ enableOrchestration: true }) — 注入编排策略章节
    → executeAgentLoop（主循环）
      → AI 自主决定是否调用 dispatch_micro_task
      → OrchestrationContext.dispatch({ task, focusRef })
        → 检查 pendingAssertions（失败的自动重试 1 次）
        → monitor.execute → executeMicroTask → 子 executeAgentLoop
        → 异步断言（evaluateAsync，不阻塞）
      → 返回结果给主循环继续
    → orchestrationCtx.finalize()（等待所有异步断言）
    → 清理 dispatch_micro_task 工具
  → 返回 MainAgentResult { microTaskResults[] }
```

---

## 6. Engine 决策主循环

### 6.1 每轮 7 阶段

```
轮次开始
   │
   ├─ 阶段 1: Ensure Snapshot        — 确保有快照可用（聚焦模式走 focused）
   ├─ 阶段 2: Build Messages + AI    — prepareAndCallAI（消息编排 + AI 调用）
   ├─ 阶段 3: No-tool-call handling  — handleNoToolCallResponse（收敛/协议修复）
   ├─ 阶段 4: Execute Tools          — executeRoundTools（逐个执行 + 恢复 + 拦截）
   ├─ 阶段 5: Assertion handling      — handleAssertionTool（断言评估）
   ├─ 阶段 6: State update           — updateRemainingState（REMAINING 推进 + DONE 收敛）
   └─ 阶段 7: Post-round guards      — runPostRoundGuards（防护检测 + 快照刷新）
```

### 6.2 10 种停机条件

| StopReason | 含义 |
|------------|------|
| `converged` | 任务正常完成（REMAINING: DONE 或 remaining 收敛为空） |
| `assertion_passed` | 所有断言通过（AI 驱动的完成验证） |
| `assertion_loop` | 断言死循环（连续 3 轮仅 assert 且失败） |
| `repeated_batch` | 重复相同工具调用批次 ≥ 3 轮 |
| `idle_loop` | 连续只读轮次（空转检测） |
| `no_protocol` | 连续 5+ 轮有工具调用但无 REMAINING 协议且无有效推进 |
| `protocol_fix_failed` | 协议修复失败（remaining 未完成 + 无工具调用） |
| `stale_remaining` | remaining 连续 3+ 轮不推进且无确认性进展 |
| `max_rounds` | 达到 maxRounds 上限 |
| `dry_run` | 干运行模式 |

### 6.3 9 大保护机制

1. **元素恢复**（handleElementRecovery）— 工具返回"元素未找到"时重试
2. **导航上下文更新**（handleNavigationUrlChange）— URL 变化后刷新快照
3. **空转检测**（detectIdleLoop）— 连续 2 轮只读工具 → 停机
4. **重复批次防自转** — 连续 ≥ 3 轮相同工具调用 → 停机
5. **无效点击拦截**（checkIneffectiveClickRepeat）— 快照不变时拦截 + 推荐
6. **交替循环检测** — 近 4 轮 ≤ 2 个目标 + ≥ 4 次点击 → 拦截
7. **协议修复回合** — 无工具调用 + remaining 未完成 → 注入修复提示
8. **滞止收敛检测** — remaining 连续 3+ 轮不变 → 停机
9. **断言能力** — AI 主动调用 assert，独立 AI 判定完成

---

## 7. 消息编排协议

### 7.1 Round 0（首轮）

单条 user 消息，结构：

```
用户原始目标
Remaining: <当前 remaining>
[Task Progress checklist]  ← 多步任务时注入
[URL]
── 行为约束 ──
Use #hashID ... / Batch fills ... / REMAINING 协议要求 ...
── 快照 ──
## Snapshot
<SNAPSHOT>...</SNAPSHOT>
```

### 7.2 Round 1+（后续轮）

两条消息：

**assistant 消息：**
```
Done steps (do NOT repeat):
✅ 1. dom (action="fill", selector="#abc") → ✓ dom ok
✅ 2. dom (action="click", selector="#def") → ✓ dom ok
```

**user 消息：**
```
Original Goal: <用户原始目标>
Remaining: <当前 remaining>
[Task Progress checklist]
── 行为约束 ──
...
[Previous executed / Previous planned / Previous model output]
[Error summary]
[Assertion Progress]
[Protocol violation hint]
── 快照 ──
## Snapshot Changes (since last round)
<diff>
## Snapshot
<SNAPSHOT>...</SNAPSHOT>
```

### 7.3 REMAINING 协议

AI 每轮输出的文本中必须包含：
- `REMAINING: <剩余任务描述>` — 仍有任务未完成
- `REMAINING: DONE` — 全部完成

Engine 通过 `parseRemainingInstruction()` 解析，驱动 `remainingInstruction` 状态流转。

---

## 8. 当前任务推进机制（问题分析）

### 8.1 现状

当前任务推进完全依赖 **REMAINING 文本协议**：

```
用户指令: "主题色选红色，然后关闭开关，然后满意度五星"

Round 0: AI 填入红色 → REMAINING: 关闭开关，然后满意度五星
Round 1: AI 关闭开关 → REMAINING: 满意度五星
Round 2: AI 选五星   → REMAINING: DONE
```

**协议解析链：**
1. `parseRemainingInstruction(text)` — 从 AI 输出中提取 REMAINING 行
2. `deriveNextInstruction(text, current)` — 推导下一轮 remaining
3. `reduceRemainingHeuristically(current, executedCount)` — 无协议时启发式推进
4. `updateTaskCompletion(tasks, remaining)` — 同步 checklist
5. `formatTaskChecklist(tasks)` — 格式化进度注入 prompt

### 8.2 核心问题

#### 问题 1：过度依赖模型的文本协议遵守

REMAINING 协议要求模型**每轮准确输出剩余任务文本**。但实际中：
- 模型经常忘记输出 REMAINING 行
- 模型输出的 REMAINING 语义与实际页面状态不一致
- 模型会压缩 REMAINING 丢失关键约束（如 "选红色" → "选颜色"）
- 不同模型对协议的遵守程度差异很大

**后果：** `consecutiveNoProtocolRounds` 快速累积，触发 `no_protocol` / `stale_remaining` 停机，任务未完成就终止。

#### 问题 2：启发式推进不可靠

当模型不遵守协议时，`reduceRemainingHeuristically()` 用"剔除前 N 步"的方式推进：
- 按"然后/再/接着"分隔，跳过已执行步数
- 无法判断步骤是否**真正完成**（只看执行了几个工具调用）
- 单步任务无法拆分时直接放弃推进

#### 问题 3：任务拆分过于简单

`splitUserGoalIntoTasks()` 只按显式分隔符（然后/再/接着/箭头）拆分：
- "填写表单并提交" → 无法拆分（"并"不在分隔符中）
- "在搜索框输入关键词，回车，然后点击第一个结果" → 3 步
- 复杂条件（"如果有弹窗先关闭"）完全无法处理

#### 问题 4：完成判定依赖文本匹配

`updateTaskCompletion()` 通过关键词匹配判断任务是否完成：
- 从 remaining 中检查任务关键词是否消失
- 关键词提取规则简陋（≥2 字中文 / ≥3 字英文）
- 无法处理语义等价（"选红色" vs "颜色改成红" → 关键词不同但同义）

#### 问题 5：缺乏基于快照的验证

任务是否完成，唯一可靠的依据是**快照中的可见状态**，但当前：
- 完成判定只看 REMAINING 文本，不看快照
- 快照指纹对比只用于"点击无效"检测，不用于"任务完成"判定
- 断言是可选的、额外的验证层，不是核心推进机制

#### 问题 6：走一步看一步的本质被忽略

浏览器环境的核心特征：**页面状态在操作后不可预测**。
- 点击一个按钮可能打开弹窗、跳转页面、展开折叠区……
- 填写一个字段可能触发联动（自动填充其他字段、显示/隐藏区域）
- 当前架构要求 AI 在 Round 0 就给出完整的 REMAINING 规划，这与"走一步看一步"矛盾

---

## 9. 重构方向：快照驱动的任务推进

### 9.1 核心理念

**从"文本协议驱动"转向"快照状态驱动"**：

```
旧模型: AI 说完成了 → 信它 → 推进
新模型: AI 做了动作 → 看快照 → 框架判定是否推进
```

### 9.2 设计原则

1. **快照是唯一事实来源** — 任务是否完成，由快照中的可见状态决定，不由 AI 的文本输出决定
2. **走一步看一步** — 每轮只规划当前快照可见范围内的动作，不预测未来 DOM
3. **框架侧验证** — 任务完成由框架（通过快照 diff + 语义匹配）验证，而非完全信任 AI
4. **渐进收敛** — 任务列表是动态的：初始拆分 → 每轮根据快照调整 → 新发现的子任务动态追加
5. **优雅降级** — 新机制与 REMAINING 协议并行，模型遵守协议时使用协议结果，不遵守时用框架推进

### 9.3 拟重构模块

#### A. 快照状态提取器（新增）

```ts
// core/shared/snapshot-state.ts

type PageState = {
  /** 所有可见表单字段及其当前值 */
  fields: Array<{
    ref: string;           // #hashID
    label: string;         // 关联 label 文本
    type: 'text' | 'select' | 'checkbox' | 'radio' | 'switch' | 'slider' | 'color' | 'date' | 'custom';
    value: string | boolean | number | null;  // 当前值（null = 空/默认）
    placeholder?: string;  // 占位文本
  }>;
  /** 当前可见的弹窗/抽屉/Modal */
  overlays: Array<{ ref: string; title: string; type: 'modal' | 'drawer' | 'popover' }>;
  /** 当前 URL */
  url: string;
  /** 可见的 toast / alert 消息 */
  toasts: string[];
};

/**
 * 从快照文本中提取结构化页面状态。
 * 不依赖 DOM API，纯文本解析。
 */
function extractPageState(snapshot: string): PageState;

/**
 * 对比两个 PageState，返回变化摘要。
 */
function diffPageState(before: PageState, after: PageState): PageStateDiff;
```

**价值：** 将非结构化快照文本转为结构化数据，支持精确的字段级完成判定。

#### B. 任务匹配器（新增）

```ts
// core/shared/task-matcher.ts

type TaskGoal = {
  id: string;
  description: string;          // "主题色选红色"
  /** 从描述中提取的预期状态 */
  expectedState: {
    fieldLabel?: string;        // "主题色"
    expectedValue?: string;     // "红色"
    action?: 'navigate' | 'click' | 'fill' | 'select' | 'toggle';
    targetText?: string;        // 目标元素的文本
  };
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
};

/**
 * 基于快照状态判定任务是否完成。
 *
 * 策略：
 * 1. 从 task description 提取预期状态（label + value）
 * 2. 在 PageState.fields 中查找匹配字段
 * 3. 对比当前值与预期值
 * 4. 模糊匹配（"红色" 匹配 "#ff0000" / "red" / "rgb(255,0,0)"）
 */
function evaluateTaskCompletion(
  task: TaskGoal,
  currentState: PageState,
  previousState: PageState,
): 'done' | 'in_progress' | 'pending';
```

**价值：** 框架侧自主判定任务完成，不依赖 AI 的 REMAINING 输出。

#### C. 动态任务管理器（重构现有 TaskItem）

```ts
// core/shared/task-manager.ts

class TaskManager {
  private goals: TaskGoal[] = [];

  /** 从用户输入初始化任务列表 */
  initFromUserMessage(message: string): void;

  /** 根据当前快照状态更新所有任务的完成状态 */
  updateFromSnapshot(currentState: PageState, previousState: PageState): void;

  /** AI 发现新的子任务时动态追加 */
  addDiscoveredTask(task: TaskGoal): void;

  /** 获取当前应该执行的任务（第一个 pending/in_progress） */
  getCurrentTask(): TaskGoal | null;

  /** 获取所有未完成任务的描述（替代 remainingInstruction） */
  getRemainingDescription(): string;

  /** 是否所有任务都已完成 */
  isAllDone(): boolean;

  /** 格式化为 checklist */
  formatChecklist(): string;
}
```

**价值：** 将 `remainingInstruction` / `taskItems` / `updateTaskCompletion` / `formatTaskChecklist` 等散落的函数统一为有状态的管理器。

#### D. 双轨推进（兼容层）

Phase D（updateRemainingState）的重构：

```
新推进逻辑:
  1. 从最新快照提取 PageState
  2. TaskManager.updateFromSnapshot(current, previous) — 框架侧判定
  3. 如果 AI 遵守了 REMAINING 协议 → 对比框架判定和 AI 判定
     - 一致 → 直接采用
     - 不一致 → 以框架判定为准，但记录偏差（调试用）
  4. 如果 AI 未遵守协议 → 完全使用框架判定
  5. 所有任务 done → converged 停机
```

### 9.4 渐进式实施路线

| 阶段 | 改动 | 风险 | 收益 |
|------|------|------|------|
| **Phase 0** | 新增 `snapshot-state.ts`（纯新增，不改现有代码） | 无 | 为后续提供基础 |
| **Phase 1** | 新增 `task-matcher.ts` + `TaskManager`（纯新增） | 无 | 可独立测试 |
| **Phase 2** | 在 `runPostRoundGuards` 中接入 TaskManager（并行运行，只日志不决策） | 低 | 验证准确率 |
| **Phase 3** | 在 `updateRemainingState` 中启用双轨推进（框架判定优先） | 中 | 核心改善 |
| **Phase 4** | 简化 REMAINING 协议要求（从"必须"降为"建议"） | 中 | 减少协议违规停机 |
| **Phase 5** | 移除启发式推进（reduceRemainingHeuristically）| 低 | 清理技术债 |

---

## 10. 快照子系统

### 10.1 快照类型

| 快照类型 | 生成函数 | 用途 | 特征 |
|---------|---------|------|------|
| **全量快照** | `generateSnapshot()` | 主循环每轮决策 | 含 #hashID、listeners、完整 DOM 树 |
| **聚焦快照** | `generateFocusedSnapshot()` | 微任务聚焦执行 | 仅目标元素关联链 |
| **断言快照** | `readAssertionPageSnapshot()` | 断言 AI 判定 | 无 #hashID、无 listeners、纯结构+状态 |

### 10.2 快照增强特性

- **运行态属性：** `val`、`checked`、`disabled`、`readonly`、`aria-checked`、`aria-expanded`、`bg="..."`
- **布局折叠：** `pruneLayout=true` 时折叠纯布局容器，保留 `collapsed-group` 语义
- **角色优先标签：** ARIA role 替代 HTML tag（如 `[combobox]` 替代 `[input] role="combobox"`）
- **交互节点 Hash ID：** 仅交互元素（按 `hasInteractiveTrackedEvents()` + 语义判定）分配 hash ID
- **子树展开：** `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>` 动态展开省略的子节点

### 10.3 快照 Diff

- **轮间 diff：** `computeSnapshotDiff()` 对比前后两轮快照，输出 `- removed` / `+ added` 格式
- **基准 diff：** 微任务模式下对比任务开始时的基准快照与当前全量快照
- **指纹对比：** `computeSnapshotFingerprint()` 归一化 hashID 后计算指纹，判定操作是否产生真实变化

---

## 11. 断言系统

### 11.1 两层断言

- **micro-task 级：** 当前快照 + 操作记录 → 判定单个微任务完成
- **system 级：** 执行记录链证据 + 全局快照 → 判定总任务完成

### 11.2 断言流程

1. AI 在主循环中主动调用 `assert({})` 工具
2. Engine 捕获 → 刷新断言专用快照（无 hashID、无 listeners）
3. 发起独立 AI 调用（专用 prompt，不带 tools）
4. 断言 AI 基于 before/after/current 三快照 + 操作记录判定
5. 全部通过 → `assertion_passed` 停机；失败 → 注入 Assertion Progress 继续

### 11.3 异步断言流水线

编排模式（OrchestrationContext）中的优化：
- 微任务完成后立即发起 `evaluateAsync()`，不阻塞
- 下一个微任务 dispatch 时检查前一个的断言结果
- 失败时自动重试一次
- `finalize()` 等待所有 pending 断言完成

---

## 12. AI Provider 支持

通过 `createAIClient(config)` 工厂函数统一创建：

| Provider | 类 | 流式 | 协议 |
|----------|-----|------|------|
| OpenAI | `OpenAIClient` | ✅ | OpenAI API |
| Copilot | `OpenAIClient` | ✅ | OpenAI 兼容 |
| Anthropic | `AnthropicClient` | ✅ | Anthropic Messages API |
| DeepSeek | `DeepSeekClient` | ✅ | OpenAI 兼容 |
| 豆包 | `DoubaoClient` | ✅ | OpenAI 兼容 |
| 通义千问 | `QwenClient` | ✅ | OpenAI 兼容 |
| MiniMax | `MiniMaxClient` | ✅ | OpenAI 兼容 |
| 智谱 GLM | `GLMClient` | ✅ | OpenAI 兼容 |

所有客户端继承 `BaseAIClient`，支持自定义扩展。

---

## 13. v1 → v2 变化对照

| 维度 | v1 | v2 |
|------|----|----|
| **架构** | 单体（WebAgent 管一切） | 分层（core + web 解耦） |
| **核心入口** | `WebAgent.chat()` | `WebAgent.chat()` + `chatWithOrchestration()` |
| **编排** | 无 | 微任务链式编排（3 种模式） |
| **执行引擎** | agent-loop 内联 | 独立 `engine/`（EngineContext + phases） |
| **断言** | 同步断言 | 同步 + 异步流水线 + 两级断言 |
| **提示词** | 单一 `buildSystemPrompt` | Main Agent + MicroTask 双 prompt 共享规则 |
| **聚焦快照** | 无 | 微任务支持 `focusedMode`（聚焦子树 + base diff） |
| **AI 自主编排** | 无 | `dispatch_micro_task` + `OrchestrationContext` |
| **工具注册** | 全局单例 | 实例化 `ToolRegistry`（多实例安全） |
| **对话历史** | agent 内部管理 | `MainAgent.history` 多轮累积 |

---

## 14. 调试工具

WebAgent 在 `window.__autopilot` 上暴露调试函数：

```js
__autopilot.snapshot()                    // 全量快照
__autopilot.snapshot({ maxNodes: 100 })   // 带选项的全量快照
__autopilot.focused('#hashId')            // 聚焦快照
__autopilot.diff(base, current)           // 智能 diff（行级 + 语义级）
__autopilot.semanticDiff(base, current)   // 纯语义 diff
__autopilot.lineDiff(prev, current)       // 纯行级 diff
__autopilot.refStore()                    // 当前 RefStore 实例
```
