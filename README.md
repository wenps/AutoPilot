# AutoPilot

> **浏览器内嵌 AI Agent SDK** — 让 AI 通过 tool-calling 操作你的网页。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一行代码给你的网站加上 AI Agent 能力：用户说一句话，AI 自动点击按钮、填写表单、读取数据、执行 JS。

基于原生 `fetch` 的纯浏览器 AI 客户端，支持 **OpenAI** / **GitHub Copilot** / **Anthropic**。唯一运行时依赖：`@sinclair/typebox`。

---

## 核心特性

- **内嵌式 Agent** — 运行在页面内部，直接操作 DOM，无需截图、无需外部浏览器进程
- **零 SDK 依赖** — 使用原生 `fetch` 连接 AI，不引入 openai / anthropic SDK
- **DOM 快照 + Ref 路径** — 自动生成页面结构快照，AI 通过 ref 路径精确定位元素，无需猜测选择器
- **5 个内置工具** — DOM 操作、页面导航、页面信息、等待元素、JS 执行
- **可扩展** — 通过 `registerTool()` 添加自定义工具
- **多轮记忆** — 可开关的对话历史，Agent 能记住上下文
- **Chrome Extension 支持** — 内置 Service Worker ↔ Content Script 消息桥
- **~2000 行** — 轻量、可审计、无黑箱

---

## 快速开始

### 安装

```bash
pnpm install
```

### 使用

```typescript
import { WebAgent } from "autopilot/web";

const agent = new WebAgent({
  token: "your-api-key",
  provider: "copilot",    // "copilot" | "openai" | "anthropic"
  model: "gpt-4o",
  memory: true,           // 开启多轮记忆
  autoSnapshot: true,     // 每次对话前自动生成 DOM 快照（默认开启）
});

agent.registerTools();    // 注册 5 个内置 Web 工具

agent.callbacks = {
  onText: (text) => console.log("AI:", text),
  onToolCall: (name, input) => console.log("🔧", name),
  onToolResult: (name, result) => console.log("✅", name, result.content),
  onSnapshot: (snapshot) => console.log("📸 快照已生成"),
};

const result = await agent.chat("把搜索框填上 'AutoPilot' 然后点搜索按钮");
console.log(result.reply);
```

### 运行 Demo

```bash
pnpm demo  # 启动 Vite 开发服务器，端口 3000
```

Demo 页面提供开箱即用的聊天 UI（暗色主题），包含：
- Token 输入（localStorage 持久化）
- 模型选择（gpt-4o / gpt-4o-mini / o3-mini）
- Dry-run 开关 & 多轮记忆开关
- 6 个快捷测试按钮（页面信息、DOM 快照、点击、链接、滚动、DOM 计数）
- 实时展示工具调用和结果

---

## 架构

```
src/
├── core/                        # 🔷 共享引擎（零环境依赖，纯 TypeScript + fetch）
│   ├── types.ts                 #    类型：AIClient, AIMessage, AIChatResponse, AIToolCall
│   ├── tool-registry.ts         #    ToolRegistry 类 + 辅助函数（readStringParam 等）
│   ├── agent-loop.ts            #    决策循环：executeAgentLoop()（ReAct 模式）
│   ├── ai-client.ts             #    AI 客户端工厂：createAIClient()（纯 fetch）
│   └── system-prompt.ts         #    系统提示词构建：buildSystemPrompt()
│
├── web/                         # 🌐 浏览器端 Agent（依赖 core）
│   ├── index.ts                 #    WebAgent 类 — 浏览器端 AI Agent 入口
│   └── tools/
│       ├── register.ts          #    registerWebTools(registry) — 注册 5 个工具
│       ├── dom-tool.ts          #    DOM 操作：click, fill, type, get_text, get_attr...
│       ├── navigate-tool.ts     #    页面导航：goto, back, forward, reload, scroll
│       ├── page-info-tool.ts    #    页面信息与 DOM 快照：url, title, snapshot...
│       ├── wait-tool.ts         #    等待元素：waitForSelector（MutationObserver）
│       ├── evaluate-tool.ts     #    JS 执行：在页面上下文中运行任意代码
│       └── messaging.ts         #    Chrome Extension 消息桥（SW ↔ Content Script）
│
demo/                            # 🎨 Web Agent 演示
├── index.html                   #    Chat UI（暗色主题 + 快捷测试按钮）
├── main.ts                      #    WebAgent 实例 + UI 交互 + 回调绑定
```

两层结构：`core`（引擎，零环境依赖）+ `web`（浏览器工具 + DOM API），13 个源文件。

### 设计原则

| 层 | 目录 | 依赖 | 环境 |
|----|------|------|------|
| **core** | `src/core/` | 无（纯 TypeScript + fetch） | 任意（浏览器 / Worker） |
| **web** | `src/web/` | core + DOM API | 浏览器 |

- `web/` 只从 `core/` 导入，`core/` 不含任何 DOM/Node API
- ToolRegistry 是实例化的（非全局 Map），每个 Agent 拥有独立的工具集
- 全链路「容错不中断」— 单个工具失败不会中止 Agent 循环

---

## AI Provider 支持

| Provider | 端点 | 认证头 |
|----------|------|--------|
| `copilot` | `https://models.inference.ai.azure.com` | `Authorization: Bearer <GitHub PAT>` |
| `openai` | `https://api.openai.com/v1` | `Authorization: Bearer <API Key>` |
| `anthropic` | `https://api.anthropic.com` | `x-api-key: <API Key>` |

所有 provider 均使用原生 `fetch` 调用，支持 `baseURL` 自定义端点（如代理服务器）。

### 两层 API

**高层 API** — 一步到位：

```typescript
import { createAIClient } from "autopilot/core/ai-client";

const client = createAIClient({ provider: "copilot", model: "gpt-4o", apiKey: "ghp_xxx" });
const response = await client.chat({ systemPrompt, messages, tools });
```

**底层 API** — 自定义 fetch 逻辑（自定义 headers、超时、重试、代理等）：

```typescript
import { buildChatRequest, parseChatResponse } from "autopilot/core/ai-client";

const config = { provider: "copilot", model: "gpt-4o", apiKey: "ghp_xxx" };
const req = buildChatRequest(config, { systemPrompt, messages, tools });

// 自定义修改请求
req.headers["X-Custom"] = "value";

// 自行 fetch 并解析
const { url, ...init } = req;
const res = await fetch(url, init);
const data = await res.json();
const response = parseChatResponse(config.provider, data);
```

---

## 工具一览

| 工具 | 动作 | 说明 |
|------|------|------|
| **dom** | `click`, `fill`, `type`, `get_text`, `get_attr`, `set_attr`, `add_class`, `remove_class` | DOM 操作（支持 ref 路径和 CSS 选择器） |
| **navigate** | `goto`, `back`, `forward`, `reload`, `scroll` | 页面导航 |
| **page_info** | `get_url`, `get_title`, `get_selection`, `get_viewport`, `snapshot`, `query_all` | 页面信息与 DOM 快照 |
| **wait** | `wait_for_selector`, `wait_for_hidden`, `wait_for_text` | 等待元素变化（MutationObserver） |
| **evaluate** | *expression* | 执行任意 JavaScript（`new Function`） |

### DOM 快照与 Ref 路径

这是 AutoPilot 的核心设计 — 让 AI **精确定位** DOM 元素，无需猜测 CSS 选择器。

`generateSnapshot()` 将 DOM 树转为 AI 可理解的文本描述，每个元素自动生成基于层级位置的 ref 路径：

```
[header] ref="/body/header"
  [nav] ref="/body/header/nav"
    [a] "首页" href="/" ref="/body/header/nav/a[1]"
    [a] "关于" href="/about" ref="/body/header/nav/a[2]"
[main] ref="/body/main"
  [h1] "欢迎" ref="/body/main/h1"
  [input] type="text" placeholder="搜索..." ref="/body/main/input"
  [button] "搜索" id="search-btn" onclick ref="/body/main/button"
```

AI 使用 ref 路径调用 `dom` 工具，`resolveRef()` 在运行时将路径解析回 DOM 元素。采集的信息包括：id、class、交互属性、布尔状态、事件绑定、data-\* 属性、实时 value。

### 添加自定义工具

```typescript
import { Type } from "@sinclair/typebox";

agent.registerTool({
  name: "my_tool",
  description: "描述这个工具做什么",
  schema: Type.Object({
    param: Type.String({ description: "参数说明" }),
  }),
  async execute(params) {
    return { content: "执行结果" };
  },
});
```

---

## API

### `WebAgent`

```typescript
new WebAgent(options: WebAgentOptions)
```

**配置选项：**

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `token` | `string` | 必填 | API Key（GitHub PAT / OpenAI key / Anthropic key） |
| `provider` | `string` | `"copilot"` | AI 提供商：`"copilot"` \| `"openai"` \| `"anthropic"` |
| `model` | `string` | `"gpt-4o"` | 模型名称 |
| `baseURL` | `string` | — | 自定义 API 基础 URL |
| `dryRun` | `boolean` | `false` | 干运行（只打印工具调用不执行） |
| `systemPrompt` | `string` | — | 自定义系统提示词（不传则使用默认） |
| `maxRounds` | `number` | `10` | 最大工具调用轮次 |
| `memory` | `boolean` | `false` | 多轮对话记忆开关 |
| `autoSnapshot` | `boolean` | `true` | 每次 chat 前自动生成 DOM 快照 |

**方法：**

| 方法 | 说明 |
|------|------|
| `registerTools()` | 注册 5 个内置 Web 工具 |
| `registerTool(tool)` | 注册自定义工具 |
| `getTools()` | 获取所有已注册工具定义 |
| `chat(message)` | 发送消息，返回 `AgentLoopResult` |
| `setToken(token)` | 更新 API Key |
| `setProvider(provider)` | 更新 AI 提供商 |
| `setModel(model)` | 更新模型 |
| `setDryRun(enabled)` | 切换干运行模式 |
| `setSystemPrompt(prompt)` | 设置自定义系统提示词 |
| `setMemory(enabled)` | 开关多轮记忆（关闭时自动清空历史） |
| `getMemory()` | 获取当前记忆开关状态 |
| `setAutoSnapshot(enabled)` | 开关自动快照 |
| `getAutoSnapshot()` | 获取当前自动快照开关 |
| `clearHistory()` | 清空对话历史（不影响记忆开关） |

**回调（`callbacks`）：**

| 回调 | 触发时机 |
|------|---------|
| `onRound(round)` | 每轮循环开始（round 从 0 开始） |
| `onText(text)` | AI 返回文本回复 |
| `onToolCall(name, input)` | AI 请求调用工具（执行前） |
| `onToolResult(name, result)` | 工具执行完成 |
| `onSnapshot(snapshot)` | 自动快照生成完成 |

### `AgentLoopResult`

`chat()` 返回值：

```typescript
{
  reply: string;                // AI 的最终文本回复
  toolCalls: Array<{            // 所有工具调用记录
    name: string;
    input: unknown;
    result: ToolCallResult;
  }>;
  messages: AIMessage[];        // 完整对话消息（用于多轮记忆累积）
}
```

---

## Chrome Extension 支持

AutoPilot 内置 Service Worker ↔ Content Script 消息桥，解决 Chrome Extension 的作用域隔离：

```
Service Worker (后台)                    Content Script (页面)
┌──────────────────┐                    ┌──────────────────────┐
│  AI Agent 核心    │  AUTOPILOT_TOOL_CALL │  DOM 操作执行         │
│  createProxy     │  ────────────────►  │  registerToolHandler │
│  Executor()      │                    │                      │
│                  │  AUTOPILOT_TOOL_RESULT│                     │
│                  │  ◄────────────────  │                      │
└──────────────────┘                    └──────────────────────┘
```

```typescript
// Service Worker 端
import { createProxyExecutor } from "agentpage";
const execute = createProxyExecutor();

// Content Script 端
import { registerToolHandler } from "agentpage";
registerToolHandler(executorMap);
```

---

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # 构建产物（tsdown → dist/）
pnpm check            # 类型检查（tsc --noEmit）+ lint（oxlint）
pnpm lint             # 代码检查（oxlint）
pnpm format           # 代码格式化（oxfmt --write）
pnpm format:check     # 检查格式（oxfmt --check，不修改）
pnpm demo             # 启动 Demo（Vite，端口 3000）
pnpm test             # 运行测试（vitest run，单次执行）
pnpm test:watch       # 运行测试（vitest watch 模式）
```

### 工具链

| 工具 | 用途 |
|------|------|
| **tsdown** | 构建打包（产出 `dist/`） |
| **oxlint** | 代码检查（替代 ESLint） |
| **oxfmt** | 代码格式化（替代 Prettier） |
| **vitest** | 测试框架（覆盖率阈值 60%） |
| **vite** | Demo 开发服务器 |
| **TypeScript 5.9+** | 严格模式，`module: NodeNext` |

---

## License

MIT
