# AutoPilot

> 个人 AI 自动化代理 — 三层架构：`core`(共享) + `node`(CLI) + `web`(浏览器)。

---

## 目录

- [项目简介](#项目简介)
- [目录结构](#目录结构)
- [三层架构](#三层架构)
- [执行流程](#执行流程)
- [核心模块详解](#核心模块详解)
- [快速开始](#快速开始)
- [如何添加新工具](#如何添加新工具)
- [Web Agent 使用](#web-agent-使用)

---

## 项目简介

AutoPilot 是一个 **AI Agent 工程**，核心思路：

1. 用户给 AI 发一条自然语言消息
2. AI 理解意图后，自主**调用工具**（执行命令、搜索网页、读写文件、操作 DOM…）完成任务
3. 循环多轮 tool-calling 直到得出最终结果，返回给用户

### 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js 22+（CLI）/ 浏览器（Web） |
| AI 后端 | GitHub Copilot / OpenAI / Anthropic（纯 fetch，零 SDK） |
| 包管理 | pnpm |
| Demo 工具 | Vite |

---

## 目录结构

```
src/
├── core/                     # 🔷 共享核心（零环境依赖）
│   ├── types.ts              #    类型定义
│   ├── tool-registry.ts      #    ToolRegistry 类（实例化）
│   ├── agent-loop.ts         #    决策循环 executeAgentLoop()
│   ├── ai-client.ts          #    AI 客户端工厂（纯 fetch）
│   └── system-prompt.ts      #    系统提示词构建
│
├── node/                     # 🟢 Node 端（CLI + 服务端工具）
│   ├── index.ts              #    runAgent() 入口
│   ├── config.ts             #    配置管理
│   ├── cli/interactive.ts    #    交互式 REPL
│   ├── tools/                #    7 个 Node 工具
│   ├── process/              #    子进程执行
│   └── browser/              #    Playwright 控制器
│
├── web/                      # 🌐 浏览器端（Web Agent）
│   ├── index.ts              #    WebAgent 类
│   └── tools/                #    5 个 Web 工具
│
└── entry.ts                  # 🚪 CLI 入口

demo/                         # 🎨 Web Agent 演示页面
├── index.html
└── main.ts
```

**26 个 TypeScript 源文件**，分三层：core（5）+ node（12）+ web（8）+ entry（1）。

---

## 三层架构

```
                    ┌──────────────────┐
                    │     core/        │  ← 纯 TypeScript + fetch
                    │  AI 连接 · 循环   │     零环境依赖
                    │  注册表 · 类型    │
                    └────────┬─────────┘
                   ┌─────────┴─────────┐
                   ▼                   ▼
           ┌──────────────┐    ┌──────────────┐
           │    node/     │    │    web/      │
           │  CLI/服务端   │    │  浏览器端    │
           │  7 个工具     │    │  5 个工具    │
           │  (exec,file  │    │  (dom,nav    │
           │   browser…)  │    │   page…)     │
           └──────────────┘    └──────────────┘
```

| 规则 | 说明 |
|------|------|
| core 零依赖 | 不含 `process.env`、`fs`、`DOM` — 纯 TypeScript + fetch |
| 单向依赖 | node/ 和 web/ 只从 core/ 导入，**互不依赖** |
| ToolRegistry 实例化 | 每个 Agent 创建独立 `new ToolRegistry()`，无全局状态 |
| fetch 跨平台 | Node 22+ 内置 fetch，浏览器天然支持 |

---

## 执行流程

### Node 端（CLI）

```
用户输入 "帮我查看 package.json 的内容"
    │
    ▼
entry.ts → 加载 .env → interactive.ts（REPL 循环）
    │
    ▼
runAgent() ─────────────────────────────────────┐
│                                                │
│  ① new ToolRegistry()                          │
│     → registerBuiltinTools(registry)           │
│     → 注册 7 个工具到实例                        │
│                                                │
│  ② resolveApiKey(provider)                     │
│     → 从 process.env 读取 API Key              │
│                                                │
│  ③ createAIClient({ provider, model, apiKey }) │
│     → 创建纯 fetch 客户端                       │
│                                                │
│  ④ buildSystemPrompt({ tools })                │
│     → 身份描述 + 工具列表                        │
│                                                │
│  ⑤ executeAgentLoop({ client, registry, ... }) │
│     ┌──────────────────────────────────┐       │
│     │ client.chat(prompt, msgs, tools) │       │
│     │         ↓                        │       │
│     │ AI 返回 toolCalls?               │       │
│     │   否 → 拿到 finalReply, 结束      │       │
│     │   是 → registry.dispatch() 执行   │       │
│     │      → 结果反馈给 AI → 继续循环    │       │
│     └──────────────────────────────────┘       │
│                                                │
│  return { reply, toolCalls, model }            │
└────────────────────────────────────────────────┘
    │
    ▼
interactive.ts → 打印 "autopilot > {reply}" → 等待下一条输入
```

### Web 端（浏览器）

```
new WebAgent({ token, provider })
  → 内部 new ToolRegistry()
  → agent.registerTools() → 注册 5 个 Web 工具

agent.chat("获取页面标题")
  → createAIClient() + buildSystemPrompt()
  → executeAgentLoop({ client, registry, ... })
  → 回调 onToolCall / onToolResult / onText → 更新 UI
```

---

## 核心模块详解

### 1. ToolRegistry — 工具注册表（实例化）

```typescript
const registry = new ToolRegistry();
registry.register(tool);              // 注册工具
registry.getDefinitions();            // 工具列表（发给 AI）
await registry.dispatch(name, input); // 按名字执行

// Node 端：7 个工具
registerBuiltinTools(registry);  // exec, browser, file_read, file_write, list_dir, web_search, web_fetch

// Web 端：5 个工具
registerWebTools(registry);      // dom, navigate, page_info, wait, evaluate
```

实例化设计的好处：不同 Agent 工具集互不干扰，测试中不会相互污染。

### 2. AI Client — 纯 fetch 客户端

| Provider | 端点 | 认证 |
|----------|------|------|
| `copilot` | `models.inference.ai.azure.com` | `GITHUB_TOKEN` |
| `openai` | `api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | `api.anthropic.com` | `ANTHROPIC_API_KEY` |

```typescript
const client = createAIClient({
  provider: "copilot",
  model: "gpt-4o",
  apiKey: "ghp_xxx...",
});
```

零 SDK 依赖 — 使用原生 `fetch` 直接调用 REST API。

### 3. Agent Loop — 决策循环

```typescript
executeAgentLoop({
  client,       // AI 客户端
  registry,     // 工具注册表
  systemPrompt, // 系统提示词
  message,      // 用户消息
  maxRounds: 10,
  callbacks: { onText, onToolCall, onToolResult, onRound },
});
```

循环最多 10 轮：AI 思考 → 调用工具 → 结果反馈 → 继续思考 → 直到不再需要工具。

### 4. Node 工具

| 工具 | 名称 | 能力 |
|------|------|------|
| exec-tool | `exec` | 执行 Shell 命令，30s 超时 |
| browser-tool | `browser` | Playwright 浏览器自动化（17 种动作） |
| file-tools | `file_read` / `file_write` / `list_dir` | 文件读写 + 目录浏览 |
| web-search-tool | `web_search` | Brave Search API |
| web-fetch-tool | `web_fetch` | 抓取网页内容 |

### 5. Web 工具

| 工具 | 名称 | 能力 |
|------|------|------|
| dom-tool | `dom` | click, fill, type, getText, getAttr... |
| navigate-tool | `navigate` | goto, back, forward, reload, scroll |
| page-info-tool | `page_info` | url, title, snapshot, selection, query_all |
| wait-tool | `wait` | waitForSelector, waitForHidden, waitForText |
| evaluate-tool | `evaluate` | 在页面上下文运行 JS |

---

## 快速开始

### 1. 环境准备

```bash
nvm use 22
pnpm install
```

### 2. 配置 API Key

```bash
# GitHub Copilot（推荐）
export GITHUB_TOKEN="ghp_xxx..."

# 或 OpenAI
export OPENAI_API_KEY="sk-xxx..."

# 或 Anthropic
export ANTHROPIC_API_KEY="sk-ant-xxx..."

# 也可以写入 .env 文件
echo 'GITHUB_TOKEN=ghp_xxx...' > .env
```

### 3. 运行

```bash
# 交互式聊天
pnpm autopilot

# Web Demo（端口 3000）
pnpm demo
```

---

## 如何添加新工具

### Node 端工具

**第 1 步**：在 `src/node/tools/` 创建 `my-tool.ts`

```typescript
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../core/tool-registry.js";

export function createMyTool(): ToolDefinition {
  return {
    name: "my_tool",
    description: "描述这个工具做什么",
    schema: Type.Object({
      param1: Type.String({ description: "参数描述" }),
    }),
    async execute(params) {
      const param1 = params.param1 as string;
      return { content: "结果" };
    },
  };
}
```

**第 2 步**：在 `src/node/tools/index.ts` 中注册

```typescript
import { createMyTool } from "./my-tool.js";

export function registerBuiltinTools(registry: ToolRegistry): void {
  // ...已有工具
  registry.register(createMyTool());
}
```

### Web 端工具

同理，在 `src/web/tools/` 创建工具，在 `register.ts` 中注册到 registry。

---

## Web Agent 使用

### 作为 JS 模块

```typescript
import { WebAgent } from "./src/web/index.js";

const agent = new WebAgent({
  token: "ghp_xxx...",
  provider: "copilot",   // "copilot" | "openai" | "anthropic"
  model: "gpt-4o",
});

agent.registerTools();  // 注册 5 个内置 Web 工具

agent.callbacks = {
  onText: (text) => console.log("AI:", text),
  onToolCall: (name, input) => console.log("调用:", name),
};

const result = await agent.chat("获取页面标题");
console.log(result.reply);
```

### Demo 页面

```bash
pnpm demo  # 启动 Vite 开发服务器，端口 3000
```

Demo 使用 Vite proxy 将 `/api` 转发到 GitHub Models API，解决浏览器 CORS 问题。

---

## License

MIT
