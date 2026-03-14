# AutoPilot

<p align="center">
  <img src="./assets/logo/contours%20(2).svg" alt="AutoPilot Logo" width="180" />
</p>

> 浏览器内嵌 AI Agent SDK：让 AI 通过 tool-calling 操作网页。

> 核心主张：通过 **Prompt + Tools + 路由**，快速为网站实现 AI 赋能，并构建**前端运行时 AI Skill**。AutoPilot 本质上是一个运行在前端浏览器中的 AI Agent。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
<a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/language-TypeScript-3178C6" alt="TypeScript" /></a>
<a href="https://www.npmjs.com/package/agentpage"><img src="https://img.shields.io/npm/v/agentpage" alt="npm" /></a>
<a href="https://www.npmjs.com/package/agentpage"><img src="https://img.shields.io/npm/dm/agentpage" alt="downloads" /></a>
<a href="https://bundlephobia.com/package/agentpage"><img src="https://img.shields.io/bundlephobia/minzip/agentpage" alt="minzipped size" /></a>

AutoPilot 的目标不是生成文本，而是在浏览器中完成真实任务：点击、填写、导航、等待、执行脚本，并在每一轮根据最新页面状态持续推进。

它的机制可以概括为三句话：

1. **极简、纯原生**：不依赖后端执行引擎，不要求重型中台改造，直接在前端浏览器环境运行。
2. **易集成、低侵入**：可以快速接入各类前端工程，通过少量配置就能落地可执行 Agent。
3. **可编排、可扩展**：通过**用户可自定义的 Prompt 规则** + Tools 注册 + 路由上下文，为网站渐进式构建 AI 能力（即前端运行时 AI Skill）。

AutoPilot 的定位是"**Web 端原生 Agent 补充层**"：在当前行业里，大多数 Agent 仍以"后端服务编排 + API 调用"为主，而真正长期驻留在前端浏览器、直接理解并操作真实页面状态的 Agent 仍然稀缺。AutoPilot 关注的正是这块空白能力。

```bash
npm install agentpage
```

---

## 项目定位

- 角色定位：作为后端 Agent 的补充，而非替代
- 运行形态：完全运行在浏览器上下文（可扩展到 Chrome Extension）
- 核心机制：快照驱动 + 工具调用 + 增量消费
- 场景目标：让 AI 理解"当前路由能做什么"，并在该上下文内可靠执行
- 产品形态：可作为前端系统的"AI 插件层"，按项目逐步接入、按路由逐步增强
- 架构分层：
  - `core`：环境无关引擎（Agent Loop、AI Client、Tool Registry）
  - `web`：浏览器能力实现（DOM/导航/快照/等待/执行）

## 前端运行时 AI Skill 落地模型

核心公式：

- **Prompt（策略） + Tools（能力） + Route（上下文） = 前端运行时 AI Skill**

三层职责：

1. **Prompt 层（可自定义）**：定义该页面的执行边界、风险约束、输出协议。
2. **Tools 层（可注册）**：定义 AI 在该页面可调用的动作集合（通用 + 业务专用）。
3. **Route 层（运行时上下文）**：告诉 AI 当前在哪个页面、允许做哪些任务、禁做哪些动作。

为什么这个模型对复杂业务有效：

- Prompt 解决"怎么做才安全可靠"。
- Tools 解决"能做什么动作"。
- Route 解决"现在应该做什么"。

因此它非常适合 DevOps/ERP 等高复杂前端系统：可按路由渐进式接入，不需要一次性重构全站。

## 为什么是前端原生 Agent

- 传统后端 Agent 更擅长：流程编排、跨系统调用、数据聚合。
- 前端原生 Agent 更擅长：理解当前页面真实状态、直接操作复杂 UI 组件、处理路由内交互细节。
- 两者组合后可形成闭环：
  - 后端负责"全局计划与系统级动作"
  - 前端负责"页面级执行与交互落地"

对 DevOps / ERP 这类复杂系统尤其关键：

- 页面状态复杂（列表、筛选、弹窗、步骤流、权限态）且变化快。
- 纯后端视角很难精确知道"此刻页面上到底可点什么"。
- 前端 Agent 可以基于快照和路由上下文做增量消费，显著减少误操作与空转。

## 核心优势

- **Prompt + Tools + 路由三层解耦**：可以快速把"可执行 AI 能力"植入现有前端系统，按路由渐进式接入，支持"项目级工具 + 路由级工具"组合。
- **增量任务消费协议（REMAINING）**：任务不是一次性执行，而是逐轮消费收敛。每轮只做当前快照可执行的动作，通过 `REMAINING` 协议跟踪进度，支持协议修复和启发式回退，确保复杂多步任务稳定收敛。
- **原始目标锚定（Original Goal Anchor）**：Round 1+ 每轮消息注入用户原始输入作为任务对照组，防止模型在多步执行过程中偏航（如把“去 X 仓库创建 issue”误解为“创建 X 仓库”）。
- **13 层保护机制**：元素恢复、Not-found 重试对话流、导航刷新、空转检测、重复批次防自转、协议修复、轮次稳定等待、快照指纹变化检测、快照变化摘要（Snapshot Diff）、无效点击拦截与循环检测、附近可点击元素推荐、原始目标锚定、停机原因可观测（stopReason） —— 目标是**稳定收敛**，而不是偶然成功。
- **Playwright 级别交互语义**：完整 pointer/mouse 事件链、4 种 scrollIntoView 策略轮换、actionability 五重检查（可见/稳定/可用/可编辑/遮挡）、智能重定向 retarget、隐藏控件代理点击（ElementPlus/AntD）、`select_option` value/label/index 三策略。
- **运行时事件信号追踪**：通过 `EventTarget.prototype` 补丁全局追踪事件绑定，快照中输出 `listeners="clk,inp,chg"` 信号，帮助 AI 精准识别真实可交互元素，而非猜测。
- **效果验证机制（Effect Check）**：每轮行动前自动检查上轮操作是否在当前快照中生效，未生效则尝试邻近元素，避免重复点击无效目标。
- **结构化可观测指标**：每次 chat 输出 `AgentLoopMetrics`（轮次、成功率、恢复次数、快照体积、Token 消耗、停机原因 `stopReason`），可直接接入监控系统。
- **core/web 分层架构**：`core` 零 DOM 依赖，可在 Worker/Extension/Node 复用；`web` 封装浏览器能力。

## 企业落地实践

对于企业前端系统（尤其是 DevOps / ERP），真正决定成败的不是"有没有 Agent"，而是是否能在真实路由中稳定收敛。AutoPilot 的价值在于它把落地拆成可持续演进的能力模型，而不是一次性大改造。

在工程实践中，建议围绕三条主线理解和建设：

- **路由主线（业务边界）**：把每个关键路由看作独立能力域。列表页、详情页、弹窗流不是同一种执行上下文，AI 必须在当前路由下决策和执行。
- **Prompt 主线（策略边界）**：Prompt 不是文案，而是运行时策略。你可以按项目与路由自定义约束，定义允许动作、风险动作确认条件、输出协议和禁止区域。
- **Tools 主线（动作边界）**：内置工具负责通用交互，业务工具负责高价值动作封装。把高频复杂流程沉淀成稳定工具，是规模化 AI 赋能的关键。

为什么这种方式能在企业系统里成立：

- 它天然适配渐进式改造：先做高价值路由，再扩展到全站，不阻断原有业务。
- 它天然具备可观测性：每轮工具调用、恢复次数、快照体积、收敛轮次都能被记录和优化。
- 它天然支持协同：后端 Agent 负责全局流程编排，前端 AutoPilot 负责页面级"最后一公里"执行。

最终形态不是"在网页里放一个会聊天的助手"，而是"在前端运行时形成一套可配置、可执行、可演进的 AI Skill 网络"。

---

## 快速开始

```ts
import { WebAgent } from "agentpage";

const agent = new WebAgent({
  token: "your-api-key",
  provider: "openai",       // openai | copilot | anthropic | deepseek | doubao | qwen
  model: "gpt-4o",
});

agent.registerTools();       // 注册内置 Web 工具

agent.callbacks = {
  onRound: (round) => console.log(`第 ${round + 1} 轮`),
  onToolCall: (name, input) => console.log("调用:", name, input),
  onToolResult: (name, result) => console.log("结果:", name, result.content),
  onText: (text) => console.log("回复:", text),
};

const result = await agent.chat("打开任务弹窗，填写标题和优先级，然后提交");
console.log(result.reply);
console.log(result.metrics);  // { roundCount, toolSuccessRate, inputTokens, ... }
```

### 按路由构建 AI Skill（推荐范式）

```ts
const routeSkills: Record<string, { prompt: string; tools?: () => void }> = {
  "/tickets": {
    prompt: "You are on tickets page. Prioritize filtering and status updates.",
  },
  "/deploy": {
    prompt: "You are on deploy page. Confirm risky actions before release.",
    tools: () => agent.registerTool(createDeployTool()),
  },
};

function applyRouteSkill(path: string) {
  agent.clearCustomTools();
  agent.clearSystemPrompts();
  const skill = routeSkills[path];
  if (!skill) return;
  agent.setSystemPrompt(skill.prompt);
  skill.tools?.();
}

applyRouteSkill(location.pathname);
```

---

## 架构

```
┌──────────────────────────────────────────────────────┐
│                    WebAgent (web)                      │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ AI Client│  │  Agent Loop  │  │  Web Tools     │  │
│  │ (fetch)  │  │  (core 循环) │  │  (DOM/导航/等待)│  │
│  └──────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────┘
```

| 层级 | 职责 | 约束 |
| --- | --- | --- |
| `core` | AI 客户端适配、Agent Loop 编排、工具注册分发、系统提示词 | 不依赖 DOM API，可在任意 JS 运行时复用 |
| `web` | WebAgent 入口、5 个内置工具、RefStore 映射、事件追踪、UI 面板 | 依赖浏览器 API，不反向污染 core |

---

## 核心机制

### 1. 快照驱动决策

AI 每轮不是"凭记忆猜页面"，而是基于最新 DOM 快照选择可执行动作：

```
输入：当前快照 S + 当前任务 R → 输出：可执行任务批次 T
```

快照包含：
- 元素标签与 ARIA role（`[combobox]`/`[slider]` 替代冗余 tag+role）
- hash 选择器（`#a1b2c`）— 仅交互元素携带，非交互元素作为上下文
- 运行态属性（`checked`/`disabled`/`readonly`/`val`/`selected`）
- 事件信号（`listeners="clk,inp,chg"`）— 基于运行时真实绑定
- 智能剪枝：布局容器折叠、`collapsed-group` 标记、视口裁剪、节点预算控制

### 2. 增量任务消费（REMAINING 协议）

用户任务被逐轮"吃掉"，不一次性硬做完：

```
总任务: A → B → C

Round 1: 执行 A → REMAINING: B → C
Round 2: 执行 B → REMAINING: C
Round 3: 执行 C → REMAINING: DONE
```

每轮消息携带：`当前剩余任务` + `上轮已执行动作` + `效果检查提示` + `最新快照`。

- Round 0 使用原始任务；Round 1+ 不再注入原始消息，避免"回头重做"
- 模型返回 `REMAINING: <text>` 表示还有剩余，`REMAINING: DONE` 表示完成
- REMAINING 缺失时自动启发式剔除已完成任务，或保持不推进
- "remaining 未完成 + 无工具调用" 触发协议修复回合

### 3. 批量执行但不跨 DOM 变化

- **可同轮**：同时填写多个已可见输入框（`focus→fill→focus→fill`）
- **不可同轮**：点击"打开弹窗"后立即填写弹窗内容（应等下一轮新快照）
- `click` 始终是本轮最后一个动作，执行后强制断轮
- 轮次结束后自动执行"loading 隐藏 + DOM 静默"双重等待

### 4. 多层保护机制

| 机制 | 触发条件 | 效果 |
| --- | --- | --- |
| 元素未找到恢复 | `dom` 操作命中失败 | 等待 100ms → 刷新快照 → 返回恢复标记 |
| Not-found 重试对话流 | 本轮存在未找到元素 | 注入失败上下文 + `attempt x/y`，最多 2 轮 |
| 导航后上下文刷新 | `navigate` 成功 | 重置 RefStore + 刷新快照 |
| 空转检测 | 连续只读无推进 | 自动终止循环 |
| 重复批次防自转 | 连续两轮相同任务批次 | 直接终止 |
| 协议修复回合 | remaining 未完成却无工具调用 | 注入强约束提示 |
| 轮次稳定等待 | 本轮有 DOM 变化动作 | loading hidden + DOM quiet（200ms/4s） |
| 快照指纹变化检测 | 本轮有 DOM 变更动作且行动后指纹不变 | 注入 `Snapshot unchanged` 提示，强制模型换目标 |
| 快照变化摘要 | Round 1+ 且前后快照 diff 非空 | 在快照前注入 `## Snapshot Changes` 变化行摘要，让 AI 直接看到什么变了 |
| 无效点击拦截与循环检测 | 快照未变时记录无效 click；近 4 轮在 ≤2 个目标间循环 | 拦截重复无效点击；循环检测后将所有循环目标加入拦截集 |
| 附近可点击元素推荐 | 点击被拦截或证实无效 | 从快照中查找目标附近 15 行内有点击信号的元素，按距离推荐 |
| 原始目标锚定 | Round 1+ 每轮 | 注入用户原始任务作为对照组，防止多步执行中偏航 |
| 断言验证（Assertion） | AI 主动调用 `assert({})` 工具 | 独立 AI 判定任务完成；全通过则停机，未通过注入进度继续循环 |
| 停机原因可观测 | 每次停机时 | `metrics.stopReason` 输出枚举值（`converged` / `assertion_passed` / `repeated_batch` / `idle_loop` / `no_protocol` / `max_rounds` 等） |

### 5. 停机条件与 stopReason

每次停机时，`metrics.stopReason` 会输出精确的停机原因枚举值：

| stopReason | 停机场景 |
| --- | --- |
| `converged` | 模型返回 `REMAINING: DONE` 或 remaining 收敛为空 |
| `assertion_passed` | AI 调用 `assert` 工具且所有任务断言均通过 |
| `repeated_batch` | 连续相同工具调用批次 ≥ 3 轮（防自转） |
| `idle_loop` | 连续只读轮次触发空转检测 |
| `no_protocol` | 连续多轮有工具调用但无 REMAINING 协议且无有效推进 |
| `protocol_fix_failed` | 协议修复轮失败（无工具调用 + remaining 未收敛） |
| `max_rounds` | 达到 maxRounds 上限 |
| `dry_run` | dry-run 模式，仅展示不执行 |

### 6. 断言能力（Assertion）

`assert` 是内置工具，AI 认为任务完成时主动调用 `assert({})` 触发验证：

```
AI 执行动作 → 认为完成 → 调用 assert({})
    ↓
框架：等待页面稳定 → 清除 hover → 刷新快照
    ↓
独立断言 AI（专用 Prompt，无 tools）判定任务是否完成
    ↓
全部通过 → stopReason: "assertion_passed"
部分失败 → 注入 Assertion Progress → 继续循环
```

**默认行为**：无自定义断言时，以用户原始消息作为整体断言依据。

**自定义断言**：

```ts
const result = await agent.chat("关闭开关，满意度五星，标签选灰度", {
  assertionConfig: {
    taskAssertions: [
      { task: "关闭开关", description: "开关组件不应有 is-checked class" },
      { task: "满意度五星", description: "满意度 slider 的 5 个 star 均应有 is-active class" },
      { task: "标签选灰度", description: "灰度 checkbox 应有 checked 状态" },
    ],
  },
});

console.log(result.assertionResult);
// { allPassed: true, total: 3, passed: 3, failed: 0, details: [...] }
```

---

## 配置参数

### WebAgentOptions

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `client` | `AIClient` | - | 自定义 AI 客户端实例；传入后忽略 token/provider/model/baseURL |
| `token` | `string` | `""` | API Token（GitHub PAT / OpenAI Key / Anthropic Key 等） |
| `provider` | `string` | `"copilot"` | AI 服务商（见下方 Provider 表） |
| `model` | `string` | `"gpt-4o"` | 模型名称（需与 provider 匹配） |
| `baseURL` | `string` | - | 自定义 API 端点（代理/私有部署） |
| `stream` | `boolean` | `true` | 是否启用 SSE 流式输出 |
| `requestTimeoutMs` | `number` | `45000` | 单次 AI 请求超时（毫秒） |
| `dryRun` | `boolean` | `false` | 干运行模式：输出工具计划但不执行 |
| `systemPrompt` | `string \| Record<string, string>` | 内置 | 自定义 Prompt；支持单条或 key-value 多条注册 |
| `maxRounds` | `number` | `40` | 单次 chat 最大循环轮次 |
| `memory` | `boolean` | `false` | 是否开启多轮对话记忆（跨 chat 保留历史） |
| `autoSnapshot` | `boolean` | `true` | chat 前自动生成首轮快照 |
| `snapshotOptions` | `SnapshotOptions` | `{}` | 快照参数（深度、裁剪、节点上限等） |
| `roundStabilityWait` | `RoundStabilityWaitOptions` | `{ enabled: true }` | 轮次后稳定等待配置 |
| `panel` | `boolean \| PanelOptions` | - | 内置 UI 面板配置（见下方 PanelOptions 表） |

### 面板配置（PanelOptions）

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `container` | `HTMLElement` | `document.body` | 面板挂载容器 |
| `mount` | `boolean` | `true` | 构造时是否自动挂载到 DOM |
| `enableMask` | `boolean` | `true` | Agent 运行时是否显示操作遮罩 |
| `maskOpacity` | `number` | `0.15` | 遮罩背景透明度（0–1，0 全透明，1 纯白） |
| `expanded` | `boolean` | `false` | 面板初始展开状态 |
| `title` | `string` | `"AutoPilot"` | 面板标题 |
| `placeholder` | `string` | `"输入要执行的网页操作..."` | 输入框占位文本 |
| `maskText` | `string` | `"AutoPilot 正在操作页面"` | 遮罩提示文本 |
| `emptyText` | `string` | `"发送一条消息，AI 将帮你操作页面"` | 空状态提示文本 |

### Provider 支持矩阵

| Provider | 默认端点 | 推荐模型 |
| --- | --- | --- |
| `copilot` | GitHub Copilot API | `gpt-4o` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o` / `gpt-4o-mini` |
| `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-20250514` |
| `deepseek` | `https://api.deepseek.com` | `deepseek-chat` |
| `doubao` | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-1.5-pro-32k` |
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `minimax` | `https://api.minimaxi.com/v1` | `MiniMax-M2.5` |

### 快照参数（SnapshotOptions）

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxDepth` | `number` | `12` | DOM 最大遍历深度 |
| `viewportOnly` | `boolean` | `false` | 仅保留视口内元素 |
| `pruneLayout` | `boolean` | `true` | 折叠无意义布局容器，子节点提升 |
| `maxNodes` | `number` | `500` | 快照最大节点数 |
| `maxChildren` | `number` | `30` | 每个父节点最大子元素数 |
| `maxTextLength` | `number` | `40` | 文本截断长度 |
| `listenerEvents` | `string[]` | 9 种常用事件 | 快照输出的 listener 事件白名单 |
| `classNameFilter` | `string[] \| false` | 内置 UI 框架过滤 | class 名过滤正则列表，匹配即剔除；`false` 禁用 |

### 轮次稳定等待（RoundStabilityWaitOptions）

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 是否启用 |
| `timeoutMs` | `number` | `4000` | 总超时 |
| `quietMs` | `number` | `200` | DOM 静默窗口 |
| `loadingSelectors` | `string[]` | AntD/ElementPlus/BK/TDesign 等 | 追加合并，不覆盖默认 |

---

## 内置工具

6 个内置工具通过 `agent.registerTools()` 一次注册。

### dom — DOM 交互

| 动作 | 说明 | 关键参数 |
| --- | --- | --- |
| `click` | 点击（完整 pointer/mouse 事件链） | `selector`, `clickCount` |
| `fill` | 清空后填写 | `selector`, `value` |
| `type` | 逐字追加输入 | `selector`, `value` |
| `press` | 按键（支持 `Control+a` 组合键） | `selector`, `key` |
| `select_option` | 选择下拉选项（value/label/index 三策略） | `selector`, `value`/`label`/`index` |
| `check` / `uncheck` | 勾选/取消 checkbox | `selector` |
| `clear` | 清空输入框 | `selector` |
| `focus` / `hover` | 聚焦/悬停 | `selector` |
| `get_text` / `get_attr` | 读取文本/属性 | `selector` |
| `set_attr` / `add_class` / `remove_class` | 修改属性/类名 | `selector`, `value` |

**Playwright 风格增强**：
- **Actionability 五重检查**：可见性、帧稳定性（rAF 连续 3 帧）、可用性（disabled + aria-disabled 祖先链）、可编辑性、遮挡检测（elementFromPoint）
- **智能重定向（retarget）**：非交互元素自动查找最近 button/link/label.control
- **scrollIntoView 4 策略轮换**：`ifNeeded → end → center → start`，解决 sticky 遮挡
- **隐藏控件代理点击**：ElementPlus/AntD 的 switch/checkbox/radio 自动重定向到可见代理元素
- **fill 分类型**：date/color/range 走 `value` setter，text 类走 `selectAll` + 原生写入
- **完整事件链**：`pointermove→pointerdown→mousedown→focus→pointerup→mouseup→click`

### navigate — 页面导航

| 动作 | 说明 |
| --- | --- |
| `goto` | 跳转到指定 URL |
| `back` / `forward` | 浏览器后退/前进 |
| `reload` | 刷新页面 |
| `scroll` | 滚动到指定元素或坐标 |

### wait — 条件等待

| 动作 | 说明 | state |
| --- | --- | --- |
| `wait_for_selector` | 等待选择器达到状态 | `attached`/`visible`/`hidden`/`detached` |
| `wait_for_hidden` | 等待元素隐藏 | - |
| `wait_for_text` | 等待页面出现文本 | - |
| `wait_for_stable` | 等待 DOM 静默 | - |

双通道检测：轮询（80ms）+ MutationObserver，确保快速响应又不遗漏。

### page_info — 页面信息

`get_url` / `get_title` / `get_selection` / `get_viewport` / `snapshot` / `query_all`

> `page_info.snapshot` 是框架内部动作；快照每轮自动刷新并注入给模型，模型无需主动调用。

### evaluate — JS 执行

执行页面上下文 JavaScript 表达式或语句块。兜底工具，适用于其他工具无法覆盖的场景。

### assert — 任务断言

AI 认为任务完成时主动调用 `assert({})`，框架发起独立 AI 判定（专用 Prompt、无 tools、不继承 system prompt），基于当前快照 + 已执行操作验证任务是否真正完成。

- **默认行为**：无自定义断言时，以用户原始消息作为整体断言依据
- **自定义断言**：通过 `ChatOptions.assertionConfig.taskAssertions` 传入细粒度子任务断言
- **断言全通过**：`stopReason = "assertion_passed"`，循环终止
- **部分失败**：失败原因注入下一轮 `## Assertion Progress` 区块，AI 聚焦修复后再次触发断言
- **hover 清除**：断言前自动派发 `pointerleave`/`mouseleave` 清除瞬态视觉状态，确保快照反映持久状态

---

## 自定义 Prompt

```ts
// 方式 1：初始化单条
const agent = new WebAgent({
  systemPrompt: "Only operate deploy-related UI. Confirm before release.",
});

// 方式 2：key-value 多条
const agent = new WebAgent({
  systemPrompt: {
    safety: "Never delete data without confirmation.",
    deploy: "Confirm risky actions before triggering release.",
  },
});

// 方式 3：运行时维护
agent.setSystemPrompt("tickets", "Prioritize filtering and status updates.");
agent.removeSystemPrompt("tickets");
agent.keepOnlySystemPrompt("deploy");
agent.clearSystemPrompts();
```

已注册 Prompt 作为扩展段追加到内置系统提示词之后。内置 Prompt 包含：快照优先决策、REMAINING 协议、批量执行规则、Effect check、事件信号优先级、禁止 page_info 空转等核心约束。

---

## 自定义工具

```ts
import { Type } from "@sinclair/typebox";

agent.registerTool({
  name: "create_ticket",
  description: "Create a new ticket in the system",
  schema: Type.Object({
    title: Type.String({ description: "Ticket title" }),
    priority: Type.String({ enum: ["high", "medium", "low"] }),
  }),
  async execute(params) {
    await api.createTicket(params);
    return { content: `Ticket created: ${params.title}` };
  },
});
```

工具管理：`registerTool()` / `removeTool()` / `hasTool()` / `getToolNames()` / `clearCustomTools()` / `getTools()`

内置工具（`dom/navigate/page_info/wait/evaluate/assert`）受保护，不允许删除。

---

## 自定义 AI Client

```ts
import { BaseAIClient } from "agentpage";

const agent = new WebAgent({
  client: new BaseAIClient({
    chatHandler: async ({ url, method, headers, body }) => {
      const res = await fetch("/api/ai-proxy", { method: "POST", body });
      return res;
    },
  }),
});
```

也可以实现 `AIClient` 接口直接传入：

```ts
type AIClient = {
  chat(params: {
    systemPrompt: string;
    messages: AIMessage[];
    tools?: ToolDefinition[];
  }): Promise<{ text?: string; toolCalls?: AIToolCall[]; usage?: { inputTokens: number; outputTokens: number } }>;
};
```

---

## 回调与可观测性

```ts
agent.callbacks = {
  onRound: (round) => console.log(`── Round ${round + 1} ──`),
  onText: (text) => ui.appendText(text),
  onToolCall: (name, input) => ui.showLoading(name),
  onToolResult: (name, result) => ui.showResult(name, result.content),
  onSnapshot: (snapshot) => console.log(`快照: ${snapshot.length} chars`),
  onMetrics: (metrics) => analytics.track("chat_complete", metrics),
};
```

### AgentLoopMetrics

| 字段 | 说明 |
| --- | --- |
| `roundCount` | 实际执行轮次 |
| `totalToolCalls` / `successfulToolCalls` / `failedToolCalls` | 工具调用计数 |
| `toolSuccessRate` | 成功率（0-1） |
| `recoveryCount` | 元素恢复触发次数 |
| `redundantInterceptCount` | 冗余拦截次数 |
| `snapshotReadCount` / `latestSnapshotSize` / `avgSnapshotSize` / `maxSnapshotSize` | 快照统计 |
| `inputTokens` / `outputTokens` | Token 消耗 |
| `stopReason` | 停机原因枚举（`converged` / `assertion_passed` / `repeated_batch` / `idle_loop` / `no_protocol` / `protocol_fix_failed` / `max_rounds` / `dry_run`） |

### AgentLoopResult

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `reply` | `string` | AI 最终回复 |
| `toolCalls` | `Array<{ name, input, result }>` | 完整工具调用轨迹 |
| `messages` | `AIMessage[]` | 完整对话消息（可用于 memory） |
| `metrics` | `AgentLoopMetrics` | 运行指标 |
| `assertionResult` | `AssertionResult` | 断言结果（仅在 AI 触发 assert 时存在） |

---

## Agent Loop 执行流程

```
chat(task) 触发
    │
    ├─ 创建 RefStore，生成首轮快照 S₀
    │
    └─ 进入 executeAgentLoop 循环
         │
         ├─ 1. Ensure Snapshot — 确保有最新快照
         ├─ 2. Build Messages — remaining + 上轮轨迹 + 效果检查 + 快照
         ├─ 3. Call AI — 拿到 text + toolCalls + REMAINING
         ├─ 4. Execute Tools — 逐个分发，应用保护机制
         ├─ 5. Reduce Remaining — 推进任务（协议优先，启发式回退）
         ├─ 6. Guard — 防空转/防自转/协议修复判定
         └─ 7. Refresh Snapshot → 下一轮
              │
              └─ 停机 → 返回 AgentLoopResult
```

---

## 目录结构

```
src/
├── core/                          # 环境无关引擎
│   ├── index.ts                   # Core 入口
│   ├── types.ts                   # 共享类型
│   ├── system-prompt.ts           # 系统提示词构建
│   ├── tool-registry.ts           # 工具注册表
│   ├── tool-params.ts             # 参数辅助
│   ├── snapshot.ts                # 快照聚合出口（兼容）
│   ├── snapshot-engine.ts         # 兼容转发层（-> agent-loop/snapshot/engine）
│   ├── messaging.ts               # 消息桥接实现
│   ├── event-listener-tracker.ts  # 事件追踪实现
│   ├── agent-loop/                # Agent 循环
│   │   ├── index.ts               # 主流程编排
│   │   ├── messages.ts            # 紧凑消息构建
│   │   ├── snapshot.ts            # 兼容转发层（-> snapshot/lifecycle）
│   │   ├── snapshot/              # 快照子模块
│   │   │   ├── index.ts
│   │   │   ├── lifecycle.ts       # 快照读取/包裹/去重
│   │   │   └── engine.ts          # DOM 快照序列化引擎
│   │   ├── recovery.ts            # 兼容转发层（-> recovery/index）
│   │   ├── recovery/              # 恢复与拦截子模块
│   │   │   └── index.ts
│   │   ├── assertion/             # 断言子模块
│   │   │   ├── types.ts           # 断言类型定义
│   │   │   ├── prompt.ts          # 断言专用 Prompt
│   │   │   └── index.ts           # 断言引擎
│   │   ├── helpers.ts             # 纯函数工具
│   │   ├── constants.ts           # 默认常量
│   │   ├── types.ts               # 循环类型
│   │   └── LOOP_MECHANISM.md      # 机制权威说明
│   └── ai-client/                 # AI 客户端
│       ├── index.ts               # Provider 路由
│       ├── openai.ts              # OpenAI/Copilot
│       ├── anthropic.ts           # Anthropic
│       ├── deepseek.ts            # DeepSeek
│       ├── doubao.ts              # 豆包 (Ark)
│       ├── qwen.ts                # 通义千问
│       ├── custom.ts              # BaseAIClient 基类
│       ├── sse.ts                 # SSE 解析器
│       └── constants.ts           # 端点与校验
└── web/                           # 浏览器实现
    ├── index.ts                   # WebAgent 入口
    ├── ref-store.ts               # #hashID → Element 映射
  ├── event-listener-tracker.ts  # 兼容转发层（-> core）
  ├── messaging.ts               # 兼容转发层（-> core）
  ├── snapshot.ts                # 兼容转发层（-> core）
  ├── snapshot-engine.ts         # 兼容转发层（-> core）
    ├── ui/                        # 内置 UI 面板
    └── tools/                     # 工具实现
        ├── dom-tool.ts
        ├── navigate-tool.ts
        ├── page-info-tool.ts
        ├── wait-tool.ts
        └── evaluate-tool.ts
```

---

## 开发

```bash
pnpm install       # 安装依赖
pnpm check         # 类型检查 + Lint
pnpm test          # 运行测试
pnpm demo          # 启动 Demo
pnpm build         # 构建
```

---

## License

MIT
