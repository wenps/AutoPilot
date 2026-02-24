# AutoPilot — 项目指南

> 个人 AI 自动化代理 — 三层架构：`core`(共享) + `node`(CLI/服务端) + `web`(浏览器端)。
> 基于 fetch 的跨平台 AI 客户端，支持 OpenAI / GitHub Copilot / Anthropic。

## 项目结构与模块组织

```
src/
├── core/                        # 🔷 共享核心（零环境依赖，Node 和浏览器通用）
│   ├── types.ts                 #    类型定义：AIClient, AIMessage, AIChatResponse
│   ├── tool-registry.ts         #    ToolRegistry 类：工具注册/查询/分发（实例化）
│   ├── agent-loop.ts            #    决策循环：executeAgentLoop()（ReAct 模式）
│   ├── ai-client.ts             #    AI 客户端工厂：createAIClient()（纯 fetch）
│   └── system-prompt.ts         #    系统提示词构建：buildSystemPrompt()
│
├── node/                        # 🟢 Node 端模块（依赖 core，不依赖 web）
│   ├── index.ts                 #    入口：runAgent() — 创建 registry + client + loop
│   ├── config.ts                #    配置：AutoPilotConfig 接口 + loadConfig()
│   ├── cli/
│   │   └── interactive.ts       #    交互式聊天循环（readline REPL）
│   ├── tools/
│   │   ├── index.ts             #    registerBuiltinTools(registry) — 注册 7 个工具
│   │   ├── exec-tool.ts         #    Shell 命令执行
│   │   ├── browser-tool.ts      #    Playwright 浏览器自动化（17 种动作）
│   │   ├── file-tools.ts        #    文件读写 + 目录浏览（3 个工具）
│   │   ├── web-search-tool.ts   #    网页搜索（Brave Search API）
│   │   └── web-fetch-tool.ts    #    网页内容抓取
│   ├── process/
│   │   ├── exec.ts              #    带超时的子进程执行
│   │   └── shell.ts             #    Shell 检测 + 输出清理
│   └── browser/
│       └── controller.ts        #    Playwright 浏览器控制器
│
├── web/                         # 🌐 浏览器端模块（依赖 core，不依赖 node）
│   ├── index.ts                 #    WebAgent 类 — 浏览器端 AI Agent
│   ├── tsconfig.json            #    Web 专用 TS 配置（含 DOM lib）
│   └── tools/
│       ├── register.ts          #    registerWebTools(registry) — 注册 5 个工具
│       ├── dom-tool.ts          #    DOM 操作：click, fill, getText...
│       ├── navigate-tool.ts     #    页面导航：goto, back, scroll...
│       ├── page-info-tool.ts    #    页面信息：url, title, snapshot...
│       ├── wait-tool.ts         #    等待元素：waitForSelector...
│       ├── evaluate-tool.ts     #    JS 执行：在页面上下文中运行
│       └── messaging.ts         #    Chrome Extension 消息桥
│
├── entry.ts                     # 🚪 CLI 入口：加载 .env → 启动 REPL
│
demo/                            # 🎨 Web Agent 演示
├── index.html                   #    Chat UI
├── main.ts                      #    WebAgent 实例 + UI 交互
vite.demo.config.ts              #    Vite 配置（proxy → GitHub Models API）
```

**文件总数**：26 个 TypeScript 源文件。

### 三层架构原则

| 层 | 目录 | 依赖 | 环境 |
|----|------|------|------|
| **core** | `src/core/` | 无（纯 TypeScript + fetch） | Node 22+ / 浏览器 |
| **node** | `src/node/` | core | Node 22+ |
| **web** | `src/web/` | core | 浏览器 |

- `node/` 和 `web/` **只从 `core/` 导入**，互不依赖
- `core/` **不含任何环境 API**（无 `process.env`、无 `fs`、无 `DOM`）
- AI 客户端使用原生 `fetch`（Node 22+ 内置，浏览器天然支持）
- ToolRegistry 是实例化的（非全局 Map），每个 Agent 拥有独立的工具集

## 构建、测试与开发命令

- 运行时要求：Node **22+**
- 安装依赖：`pnpm install`
- 安装浏览器：`npx playwright install chromium`
- 交互式聊天：`pnpm autopilot`
- 仅类型检查：`pnpm tsc --noEmit`
- Web 端类型检查：`npx tsc --noEmit -p src/web/tsconfig.json`
- 运行 Demo：`pnpm demo`（需 Vite，端口 3000）
- 运行测试：`pnpm test`（vitest）

## 代码风格与命名规范

- 语言：TypeScript（ESM 模块）。优先使用严格类型，避免 `any`。
- 对复杂或不直观的逻辑添加简短注释。
- 保持文件精简，单文件建议不超过 ~500 行。
- 命名规范：产品/文档标题用 **AutoPilot**；CLI 命令、路径、配置键用 `autopilot`。

## 防冗余规则

- 避免创建只做"转发导出"的文件，直接从原始源文件导入。
- 创建工具函数前，先搜索是否已有现成实现。
- `core/` 中的工具函数是共享的，不要在 `node/` 或 `web/` 中重复实现。

## 各模块权威位置（源码定位表）

### 共享核心（`src/core/`）
- 类型定义（AIClient/AIMessage/AIToolCall）：`src/core/types.ts`
- 工具注册表（ToolRegistry class）：`src/core/tool-registry.ts`
- 决策循环（executeAgentLoop）：`src/core/agent-loop.ts`
- AI 客户端工厂（createAIClient）：`src/core/ai-client.ts`
- 系统提示词（buildSystemPrompt）：`src/core/system-prompt.ts`

### Node 端（`src/node/`）
- Node Agent 入口（runAgent）：`src/node/index.ts`
- 配置管理（AutoPilotConfig + loadConfig）：`src/node/config.ts`
- 交互式 REPL：`src/node/cli/interactive.ts`
- Node 工具注册入口：`src/node/tools/index.ts`
- Shell 命令执行：`src/node/tools/exec-tool.ts`
- Playwright 浏览器：`src/node/tools/browser-tool.ts`
- 文件读写：`src/node/tools/file-tools.ts`
- 网页搜索/抓取：`src/node/tools/web-search-tool.ts`、`src/node/tools/web-fetch-tool.ts`
- Playwright 控制器：`src/node/browser/controller.ts`
- 进程管理：`src/node/process/exec.ts`、`src/node/process/shell.ts`

### 浏览器端（`src/web/`）
- WebAgent 类：`src/web/index.ts`
- Web 工具注册入口：`src/web/tools/register.ts`
- DOM/导航/页面信息/等待/JS执行：`src/web/tools/*.ts`
- Chrome Extension 消息桥：`src/web/tools/messaging.ts`

### 启动流程
- `src/entry.ts` → 加载 `.env` → `src/node/cli/interactive.ts`（REPL 聊天循环）

## AI 连接与工具调用机制

### AI 客户端（纯 fetch，零 SDK）

`src/core/ai-client.ts` 使用原生 `fetch` 连接 AI，支持三种 provider：

| Provider | 端点 | 认证方式 |
|----------|------|---------|
| `copilot` | `https://models.inference.ai.azure.com` | GitHub PAT (`GITHUB_TOKEN`) |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |

`createAIClient(config)` 工厂函数接收 `{ provider, model, apiKey, baseURL? }`，返回 `AIClient` 接口：
- OpenAI/Copilot → `createOpenAICompatibleClient()`（共享 OpenAI Chat Completions 格式）
- Anthropic → `createAnthropicClient()`（Anthropic Messages API 格式）

### ToolRegistry（实例化设计）

```typescript
// 每个 Agent 创建独立的 registry，避免全局状态污染
const registry = new ToolRegistry();
registry.register(tool);              // 注册工具
registry.getDefinitions();            // 获取工具列表（发给 AI）
await registry.dispatch(name, input); // 分发执行工具调用
```

- Node 端：`runAgent()` 创建 registry → `registerBuiltinTools(registry)` 注册 7 个工具
- Web 端：`WebAgent` 持有私有 registry → `registerWebTools(registry)` 注册 5 个工具
- 多实例安全：不同 Agent 的工具集互不干扰

### 完整调用链路

```
Node 端：
  runAgent() → new ToolRegistry() → registerBuiltinTools(registry)
            → createAIClient({ provider, model, apiKey })
            → buildSystemPrompt({ tools: registry.getDefinitions() })
            → executeAgentLoop({ client, registry, systemPrompt, message })
            → AI ↔ 工具循环（最多 10 轮）→ 返回最终回复

Web 端：
  new WebAgent({ token, provider }) → 内部 new ToolRegistry()
  agent.registerTools() → registerWebTools(registry)
  agent.chat(message) → createAIClient() → buildSystemPrompt()
                      → executeAgentLoop() → 返回结果
```

### Tool-Use Loop（决策循环）

`src/core/agent-loop.ts` 的 `executeAgentLoop()` 实现 ReAct 模式：

```typescript
for (let round = 0; round < maxRounds; round++) {
  const response = await client.chat({ systemPrompt, messages, tools });
  if (!response.toolCalls) { finalReply = response.text; break; }
  for (const tc of response.toolCalls) {
    const result = await registry.dispatch(tc.name, tc.input);
    // 结果反馈给 AI，继续循环...
  }
}
```

### 关键文件对照表

| 职责 | 文件 | 核心 API |
|------|------|---------|
| AI 连接 | `src/core/ai-client.ts` | `createAIClient()` |
| 决策循环 | `src/core/agent-loop.ts` | `executeAgentLoop()` |
| 工具注册表 | `src/core/tool-registry.ts` | `ToolRegistry` class |
| 系统提示词 | `src/core/system-prompt.ts` | `buildSystemPrompt()` |
| Node 入口 | `src/node/index.ts` | `runAgent()` |
| Web 入口 | `src/web/index.ts` | `WebAgent` class |

## 导入规范

- 跨包导入使用 `.js` 扩展名（ESM 要求）
- `node/` 和 `web/` 只从 `core/` 导入，不互相导入
- 仅导入类型时使用 `import type { X }`
- 直接导入，不使用"转发导出"的包装文件

## 测试指南

- 框架：Vitest
- 命名：与源文件同名，后缀为 `*.test.ts`
- ToolRegistry 是实例化的，测试中每个 case 创建独立实例即可

## 提交与 PR 规范

- 提交信息简洁、动作导向（例如：`core: refactor ToolRegistry to class`）
- 相关改动归为一次提交

## 安全规范

- 永远不要提交真实 API Key
- 文档和测试中使用假数据占位符
- API Key 解析仅在 `node/index.ts` 的 `resolveApiKey()` 中，通过 `process.env` 读取
