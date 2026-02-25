# AutoPilot — 项目指南

> 浏览器内嵌 AI Agent SDK — 让 AI 通过 tool-calling 操作网页。
> 基于 fetch 的纯浏览器 AI 客户端，支持 OpenAI / GitHub Copilot / Anthropic。
> 版本：0.2.0 · 许可：MIT · 唯一运行时依赖：`@sinclair/typebox`

## 项目结构与模块组织

```
src/
├── core/                        # 🔷 共享引擎（零环境依赖，纯 TypeScript + fetch）
│   ├── types.ts                 #    类型定义：AIClient, AIMessage, AIChatResponse, AIToolCall
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
│       ├── wait-tool.ts         #    等待元素：waitForSelector（MutationObserver 实现）
│       ├── evaluate-tool.ts     #    JS 执行：在页面上下文中运行任意代码
│       └── messaging.ts         #    Chrome Extension 消息桥（Service Worker ↔ Content Script）
│
demo/                            # 🎨 Web Agent 演示
├── index.html                   #    Chat UI（暗色主题 + 快捷测试按钮）
├── main.ts                      #    WebAgent 实例 + UI 交互 + 回调绑定
vite.demo.config.ts              #    Vite 配置（proxy /api → GitHub Models API）
vitest.config.ts                 #    Vitest 配置（覆盖率阈值 60%）
```

**文件总数**：13 个 TypeScript 源文件（src/）+ 2 个 demo 文件。

### 两层架构原则

| 层 | 目录 | 依赖 | 环境 |
|----|------|------|------|
| **core** | `src/core/` | 无（纯 TypeScript + fetch） | 任意（浏览器/Worker） |
| **web** | `src/web/` | core + DOM API | 浏览器 |

- `web/` 只从 `core/` 导入
- `core/` 不含任何环境 API（无 `process.env`、无 `fs`、无 `DOM`）
- AI 客户端使用原生 `fetch`（浏览器天然支持）
- ToolRegistry 是实例化的（非全局 Map），每个 Agent 拥有独立的工具集

## 构建、测试与开发命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 构建产物（tsdown → `dist/`） |
| `pnpm check` | 类型检查（`tsc --noEmit`）+ lint |
| `pnpm lint` | 代码检查（oxlint） |
| `pnpm format` | 代码格式化（oxfmt `--write`） |
| `pnpm format:check` | 检查格式（oxfmt `--check`，不修改） |
| `pnpm demo` | 启动 Demo 开发服务器（Vite，端口 3000） |
| `pnpm test` | 运行测试（vitest `run`，单次执行） |
| `pnpm test:watch` | 运行测试（vitest watch 模式） |

### 工具链

| 工具 | 用途 |
|------|------|
| **tsdown** | 构建打包（产出 `dist/`） |
| **oxlint** | 代码检查（替代 ESLint，更快） |
| **oxfmt** | 代码格式化（替代 Prettier） |
| **vitest** | 测试框架（覆盖率阈值 60%，provider: v8） |
| **vite** | Demo 开发服务器 + TypeScript 编译 |
| **TypeScript 5.9+** | 类型系统，`strict: true`，`module: NodeNext` |

### TypeScript 配置要点

- `target: ES2022`，`module: NodeNext`，`moduleResolution: NodeNext`
- `lib: ["ES2022", "DOM", "DOM.Iterable"]`
- `strict: true`，`isolatedModules: true`
- 输出包含 `declaration` + `declarationMap` + `sourceMap`
- `pnpm check` 引用 `src/web/tsconfig.json`（web 子项目配置）

## 代码风格与命名规范

- 语言：TypeScript（ESM 模块）。优先使用严格类型，避免 `any`。
- 对复杂或不直观的逻辑添加简短注释。
- 保持文件精简，单文件建议不超过 ~500 行。
- 命名规范：产品/文档标题用 **AutoPilot**；路径、配置键用 `autopilot`。
- 使用 `@sinclair/typebox` 的 `Type.Object()` / `Type.String()` 等定义工具参数 Schema。

## 防冗余规则

- 避免创建只做"转发导出"的文件，直接从原始源文件导入。
- 创建工具函数前，先搜索是否已有现成实现。
- `core/` 中的工具函数是共享的，不要在 `web/` 中重复实现。

## 各模块权威位置（源码定位表）

### 共享引擎（`src/core/`）

| 职责 | 文件 | 核心导出 |
|------|------|---------|
| 类型定义 | `src/core/types.ts` | `AIClient`, `AIMessage`, `AIChatResponse`, `AIToolCall` |
| 工具注册表 | `src/core/tool-registry.ts` | `ToolRegistry` class, `ToolDefinition`, `ToolCallResult` |
| 参数辅助函数 | `src/core/tool-registry.ts` | `readStringParam()`, `readNumberParam()`, `jsonResult()` |
| 决策循环 | `src/core/agent-loop.ts` | `executeAgentLoop()`, `AgentLoopCallbacks`, `AgentLoopResult` |
| AI 客户端（高层） | `src/core/ai-client.ts` | `createAIClient()`, `AIClientConfig` |
| AI 请求构建（底层） | `src/core/ai-client.ts` | `buildChatRequest()`, `parseChatResponse()` |
| AI 请求类型 | `src/core/ai-client.ts` | `ChatParams`, `ChatRequestInit` |
| 系统提示词 | `src/core/system-prompt.ts` | `buildSystemPrompt()` |

### 浏览器端（`src/web/`）

| 职责 | 文件 | 核心导出 |
|------|------|---------|
| WebAgent 类 | `src/web/index.ts` | `WebAgent`, `WebAgentOptions`, `WebAgentCallbacks` |
| 工具注册入口 | `src/web/tools/register.ts` | `registerWebTools()` |
| DOM 操作 | `src/web/tools/dom-tool.ts` | `createDomTool()` |
| 页面导航 | `src/web/tools/navigate-tool.ts` | `createNavigateTool()` |
| 页面信息/快照 | `src/web/tools/page-info-tool.ts` | `createPageInfoTool()`, `generateSnapshot()` |
| 等待元素 | `src/web/tools/wait-tool.ts` | `createWaitTool()` |
| JS 执行 | `src/web/tools/evaluate-tool.ts` | `createEvaluateTool()` |
| Chrome 消息桥 | `src/web/tools/messaging.ts` | `createProxyExecutor()`, `registerToolHandler()` |

## AI 连接与工具调用机制

### AI 客户端（两层 API，纯 fetch，零 SDK）

`src/core/ai-client.ts` 使用原生 `fetch` 连接 AI，提供两层 API：

| 层级 | 函数 | 说明 |
|------|------|------|
| **高层** | `createAIClient(config)` | 返回 `AIClient`，封装完整的 chat 流程（构建→fetch→解析） |
| **底层** | `buildChatRequest(config, params)` | 返回 `ChatRequestInit`（url/headers/body），用户可自定义 fetch |
| **底层** | `parseChatResponse(provider, data)` | 将原始 JSON 解析为统一的 `AIChatResponse` |

支持三种 provider：

| Provider | 端点 | 认证方式 | 认证头 |
|----------|------|---------|--------|
| `copilot` | `https://models.inference.ai.azure.com` | GitHub PAT | `Authorization: Bearer <token>` |
| `openai` | `https://api.openai.com/v1` | OpenAI API Key | `Authorization: Bearer <key>` |
| `anthropic` | `https://api.anthropic.com` | Anthropic API Key | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |

#### 高层 API：`createAIClient(config)`

```typescript
const client = createAIClient({ provider: "copilot", model: "gpt-4o", apiKey: "ghp_xxx" });
const response = await client.chat({ systemPrompt, messages, tools });
```

内部流程：`buildChatRequest()` → `fetch()` → 错误检查 → `parseChatResponse()`。

#### 底层 API：`buildChatRequest()` + `parseChatResponse()`

用户可自行控制 fetch 行为（自定义 headers、超时、重试、代理等）：

```typescript
const req = buildChatRequest(config, { systemPrompt, messages, tools });
// 自定义修改
req.headers["X-Custom"] = "value";
// 自行 fetch
const { url, ...init } = req;
const res = await fetch(url, init);
const data = await res.json();
const response = parseChatResponse(config.provider, data);
```

#### 统一类型

- `ChatParams` — chat 方法的统一入参：`{ systemPrompt, messages, tools? }`
- `ChatRequestInit` — 构建好的 HTTP 请求：`{ url, method, headers, body }`
- `AIChatResponse` — 统一的 AI 响应：`{ text?, toolCalls?, usage? }`

#### 两种 provider 的格式差异（内部自动处理）

- OpenAI 使用 `tool_calls` 字段返回工具调用，工具结果用 `role: "tool"` 消息
- Anthropic 使用 `tool_use` content block，工具结果用 `tool_result` content block
- Anthropic 的 system prompt 通过 `system` 字段传入（非消息数组）
- Anthropic 对 opus 模型设置 `max_tokens: 16384`，其他模型 `max_tokens: 8192`
- OpenAI 统一 `max_tokens: 8192`，`temperature: 0.3`
- TypeBox Schema 的 Symbol 属性通过 `cleanSchema()` 做 JSON roundtrip 清理

### ToolRegistry（实例化设计）

```typescript
// 每个 Agent 创建独立的 registry，避免全局状态污染
const registry = new ToolRegistry();
registry.register(tool);              // 注册工具
registry.getDefinitions();            // 获取工具列表（发给 AI）
await registry.dispatch(name, input); // 分发执行工具调用
```

- `WebAgent` 持有私有 registry → `registerWebTools(registry)` 注册 5 个工具
- 多实例安全：不同 Agent 的工具集互不干扰
- `dispatch()` 内部捕获所有异常，返回错误信息而不抛出（不中断 Agent 循环）

### 参数辅助函数（`src/core/tool-registry.ts`）

工具的 `execute()` 收到 `Record<string, unknown>` 类型参数，以下 helper 提供类型安全的提取：

| 函数 | 用途 | 参数 |
|------|------|------|
| `readStringParam(params, key, { required?, trim? })` | 读取字符串参数 | `required=false`, `trim=true` |
| `readNumberParam(params, key, { required? })` | 读取数字参数（支持字符串自动转换） | `required=false` |
| `jsonResult(payload)` | 将任意数据包装为 `ToolCallResult`（JSON 序列化） | 无 |

### 完整调用链路

```
new WebAgent({ token, provider }) → 内部 new ToolRegistry()
agent.registerTools() → registerWebTools(registry)  // 注册 5 个工具
agent.chat(message)
  ├→ createAIClient({ provider, model, apiKey, baseURL })
  ├→ buildSystemPrompt({ tools })
  ├→ [autoSnapshot] generateSnapshot(document.body, 8) → 注入 systemPrompt 尾部
  ├→ executeAgentLoop({ client, registry, systemPrompt, message, history, ... })
  │    └→ 循环: AI.chat() → toolCalls? → registry.dispatch() → 结果反馈 → 继续
  └→ [memory] 累积 result.messages → this.history
```

### Tool-Use Loop（决策循环）

`src/core/agent-loop.ts` 的 `executeAgentLoop()` 实现 ReAct 模式：

```typescript
for (let round = 0; round < maxRounds; round++) {
  const response = await client.chat({ systemPrompt, messages, tools });

  // 没有工具调用 → 结束循环，拿到最终回复
  if (!response.toolCalls) { finalReply = response.text; break; }

  // Dry-run 模式 → 只打印不执行
  if (dryRun) { /* 格式化输出后 break */ }

  // 执行所有工具调用
  for (const tc of response.toolCalls) {
    callbacks?.onToolCall?.(tc.name, tc.input);
    const result = await registry.dispatch(tc.name, tc.input);
    callbacks?.onToolResult?.(tc.name, result);
    toolResults.push({ toolCallId: tc.id, result: ... });
  }

  // 将 assistant 消息（含 toolCalls）和 tool 结果追加到对话历史
  messages.push({ role: "assistant", content: text, toolCalls });
  messages.push({ role: "tool", content: toolResults });
  // → 回到循环顶部
}
```

回调接口 `AgentLoopCallbacks`：

| 回调 | 触发时机 |
|------|---------|
| `onRound(round)` | 每轮循环开始（round 从 0 开始） |
| `onText(text)` | AI 返回文本回复（最终或伴随工具调用的） |
| `onToolCall(name, input)` | AI 请求调用工具（执行前） |
| `onToolResult(name, result)` | 工具执行完成 |

## WebAgent 类（`src/web/index.ts`）

### 配置项 `WebAgentOptions`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `token` | `string` | 必填 | API Key（GitHub PAT / OpenAI key / Anthropic key） |
| `provider` | `string` | `"copilot"` | AI 提供商 |
| `model` | `string` | `"gpt-4o"` | 模型名称 |
| `baseURL` | `string` | — | 自定义 API 基础 URL |
| `dryRun` | `boolean` | `false` | 干运行（只打印工具调用不执行） |
| `systemPrompt` | `string` | — | 自定义系统提示词（不传则使用默认） |
| `maxRounds` | `number` | `10` | 最大工具调用轮次 |
| `memory` | `boolean` | `false` | 多轮对话记忆开关 |
| `autoSnapshot` | `boolean` | `true` | 每次 chat 前自动生成 DOM 快照 |

### 方法

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
| `setMemory(enabled)` | 开关多轮记忆（关闭时清空历史） |
| `getMemory()` | 获取当前记忆开关状态 |
| `setAutoSnapshot(enabled)` | 开关自动快照 |
| `getAutoSnapshot()` | 获取当前自动快照开关 |
| `clearHistory()` | 清空对话历史（不影响记忆开关） |

### 回调 `WebAgentCallbacks`

继承 `AgentLoopCallbacks`，并增加：

| 回调 | 说明 |
|------|------|
| `onSnapshot(snapshot)` | 自动快照生成完成时触发 |

### 多轮对话记忆机制

当 `memory: true` 时：
1. `chat()` 调用 `executeAgentLoop()` 时传入 `this.history` 作为 `history`
2. Agent Loop 在 messages 数组头部插入历史消息：`[...history, { role: "user", content: message }]`
3. 循环结束后，`result.messages` 包含完整的对话历史（历史 + 本轮）
4. WebAgent 将 `result.messages` 存回 `this.history`，供下次 `chat()` 使用
5. 调用 `clearHistory()` 可手动清空，关闭 `setMemory(false)` 也会自动清空

### 自动快照注入机制

当 `autoSnapshot: true`（默认）时：
1. 在 `chat()` 内部调用 `generateSnapshot(document.body, 8)` 生成当前页面快照
2. 将快照追加到系统提示词尾部（不污染对话历史 `messages`）
3. 同时注入操作规则：必须使用 ref 路径、禁止猜测 CSS 选择器
4. 快照失败（如 DOM 不可用）时静默忽略，不阻塞正常流程

## DOM 快照与 Ref 路径机制

这是项目的核心设计 — 让 AI 精确定位 DOM 元素，无需猜测选择器。

### 快照生成（`generateSnapshot()`，`src/web/tools/page-info-tool.ts`）

将 DOM 树转为 AI 可理解的文本描述，类似 Playwright 的 `ariaSnapshot()`：

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

每个元素输出格式：`[标签] "文本" 属性列表 ref="XPath路径"`

采集的信息类别：
1. **id** — 最重要的标识
2. **class** — 最多 3 个类名
3. **交互属性** — href, type, placeholder, value, name, role, aria-label, src, alt, title, for, action, method, target, min, max, pattern, maxlength, tabindex
4. **布尔状态** — disabled, checked, readonly, required, selected, hidden, multiple, autofocus, open
5. **事件绑定** — 内联事件处理器（onclick, onchange 等）
6. **data-\* 属性** — 最多 3 个，值截断到 30 字符
7. **当前值** — input/textarea 的实时 value（与 attribute 不同时补充 `current-value`）

过滤规则：
- 跳过 `SCRIPT`, `STYLE`, `SVG`, `NOSCRIPT`, `LINK`, `META`, `BR`, `HR` 标签
- 跳过 `display: none` 或 `visibility: hidden` 的元素
- 可配 `maxDepth`（默认 6，autoSnapshot 使用 8）

### Ref 路径格式

```
/body/div[1]/main/form/input[2]
```

- 每段为标签名（小写），可选 `[n]` 表示同标签兄弟中第 n 个（1-based）
- 同标签兄弟只有一个时省略索引后缀（如 `/body/main` 而非 `/body/main[1]`）
- `getSiblingIndex()` 函数计算同标签兄弟序号

### Ref 路径解析（`resolveRef()`，`src/web/tools/dom-tool.ts`）

将 ref 路径字符串解析回 DOM 元素：

1. 以 `/` 分割路径为 segments，过滤空段
2. 从 `document.documentElement`（`<html>`）开始逐段向下匹配
3. 每段解析为 `tag` + 可选 `[index]`
4. 如果当前元素的 `tagName` 等于目标标签 → `continue`（不进入子树）
5. 否则在当前元素的 children 中按标签名过滤 → 取第 index 个
6. **特殊逻辑**：同标签兄弟只有 1 个时，无论 index 值都取它（容错设计）

### 双重定位方式（`queryElement()`）

```typescript
function queryElement(selector: string): Element | string
```

- 以 `/` 开头 → 视为 ref 路径，调用 `resolveRef()`
- 否则 → 作为 CSS 选择器，调用 `document.querySelector()`
- 返回 `Element`（成功）或 `string`（错误消息）

## 五个内置 Web 工具详解

### 1. `dom` — DOM 操作（`src/web/tools/dom-tool.ts`）

| Action | 参数 | 说明 |
|--------|------|------|
| `click` | `selector` | 模拟点击（HTMLElement: focus→click，其他: MouseEvent） |
| `fill` | `selector`, `value` | 清空后填写（input/textarea/contentEditable，触发 input+change） |
| `type` | `selector`, `value` | 逐字符键入（每个字符触发 keydown→keypress→input→keyup） |
| `get_text` | `selector` | 获取 `textContent`（含子元素） |
| `get_attr` | `selector`, `attribute` | 获取元素属性值 |
| `set_attr` | `selector`, `attribute`, `value` | 设置元素属性 |
| `add_class` | `selector`, `className` | 添加 CSS 类名 |
| `remove_class` | `selector`, `className` | 移除 CSS 类名 |

`fill` vs `type` 的区别：
- `fill` 适合普通输入框 — 直接设置 `.value`，触发 input/change 事件
- `type` 适合需要逐键监听的输入框（如搜索自动补全）— 每个字符触发完整事件链

`describeElement()` 辅助函数：生成元素可读描述 `<tag#id.class> "文本" [attr=val]`，用于操作结果反馈。

### 2. `navigate` — 页面导航（`src/web/tools/navigate-tool.ts`）

| Action | 参数 | 说明 |
|--------|------|------|
| `goto` | `url` | 跳转到指定 URL（`window.location.href`） |
| `back` | — | 浏览器后退（`history.back()`） |
| `forward` | — | 浏览器前进（`history.forward()`） |
| `reload` | — | 刷新页面（`location.reload()`） |
| `scroll` | `selector?`, `x?`, `y?` | 滚动到元素（`scrollIntoView`）或坐标（`scrollTo`） |

### 3. `page_info` — 页面信息（`src/web/tools/page-info-tool.ts`）

| Action | 参数 | 说明 |
|--------|------|------|
| `get_url` | — | 返回 `window.location.href` |
| `get_title` | — | 返回 `document.title` |
| `get_selection` | — | 返回用户选中的文本 |
| `get_viewport` | — | 返回视口尺寸和滚动位置（JSON） |
| `snapshot` | `maxDepth?`（默认 6） | 生成 DOM 快照（调用 `generateSnapshot()`） |
| `query_all` | `selector` | 查询所有匹配元素并返回摘要（最多 20 个） |

### 4. `wait` — 等待元素（`src/web/tools/wait-tool.ts`）

| Action | 参数 | 说明 |
|--------|------|------|
| `wait_for_selector` | `selector`, `timeout?` | 等待元素出现（MutationObserver） |
| `wait_for_hidden` | `selector`, `timeout?` | 等待元素消失或隐藏 |
| `wait_for_text` | `text`, `timeout?` | 等待页面中出现指定文本 |

默认超时 10000ms。三个等待函数都先检查当前状态（已满足则立即返回），然后才启动 MutationObserver 监听。

### 5. `evaluate` — JS 执行（`src/web/tools/evaluate-tool.ts`）

| 参数 | 说明 |
|------|------|
| `expression` | JavaScript 表达式或代码块 |

执行策略（`safeEvaluate()`）：
1. 先尝试作为表达式执行：`new Function("return (expression)")`
2. 失败则作为语句块执行：`new Function("expression")`
3. 结果序列化（`serializeResult()`）：DOM 元素 → `<tag#id> "text"`，NodeList → 逐个序列化，其他 → JSON

## Chrome Extension 消息桥（`src/web/tools/messaging.ts`）

解决 Chrome Extension 的作用域隔离：AI Agent 运行在 Service Worker（后台），DOM 操作需在 Content Script（页面）中执行。

```
Service Worker                           Content Script
┌──────────────────┐                    ┌──────────────────────┐
│ agent-core       │  AUTOPILOT_TOOL_CALL  │ document / window    │
│ tool-registry    │  ────────────────►  │                      │
│                  │                    │ handleToolMessage()  │
│ createProxyExecutor()                 │   ↓                  │
│   ↓              │  AUTOPILOT_TOOL_RESULT │   执行 DOM 操作      │
│ sendToContent()  │  ◄────────────────  │   返回结果            │
└──────────────────┘                    └──────────────────────┘
```

消息类型：
- `ToolCallMessage` — `{ type: "AUTOPILOT_TOOL_CALL", toolName, params, callId }`
- `ToolCallResponse` — `{ type: "AUTOPILOT_TOOL_RESULT", callId, result }`

API：
- `createProxyExecutor()` — Service Worker 端使用，通过 `chrome.tabs.sendMessage` 转发调用
- `registerToolHandler(executors: ToolExecutorMap)` — Content Script 端注册，监听 `chrome.runtime.onMessage`

## 系统提示词（`src/core/system-prompt.ts`）

`buildSystemPrompt({ tools, thinkingLevel? })` 构建两段式提示词：

1. **身份段** — AI 是 AutoPilot，嵌入页面的 Agent，能点击/填写/读取/执行
2. **操作策略** — 规定必须使用快照 ref 路径、禁止猜测 CSS 选择器
3. **工具列表** — 动态生成已注册工具的名称和描述

WebAgent 在 `autoSnapshot: true` 时会额外追加：
- 当前页面 DOM 快照（Markdown 代码块包裹）
- 5 条操作规则（使用 ref 路径、禁止猜测、先滚动再查看等）

## 错误处理策略

全链路采用「容错不中断」设计，确保 Agent 循环不会因单个工具失败而停止：

| 层级 | 处理方式 |
|------|---------|
| `ToolRegistry.dispatch()` | try-catch 包裹 `execute()`，异常转为 `{ content: "Tool failed: ...", details: { error: true } }` |
| 各工具 `execute()` | 内部 try-catch，返回错误描述字符串而非抛出 |
| 参数缺失 | 返回 `{ content: "缺少 xxx 参数" }`（不抛出） |
| AI API 错误 | `res.ok` 检查 → 抛出 `Error("AI API {status}: ...")`，由上层处理 |
| 自动快照失败 | try-catch 静默忽略，不阻塞 `chat()` 流程 |

## Demo 开发服务器

`vite.demo.config.ts` 配置：
- 入口：`demo/index.html`
- 端口：3000（`open: true` 自动打开浏览器）
- Proxy：`/api` → `https://models.inference.ai.azure.com`（解决 CORS）
- 构建产出：`dist-demo/`

WebAgent 在 Demo 中使用 `baseURL: "/api"` 连接 GitHub Models API。

Demo UI 功能：
- Token 输入（localStorage 持久化）
- 模型选择（gpt-4o / gpt-4o-mini / o3-mini）
- Dry-run 开关
- 多轮记忆开关
- 6 个快捷测试按钮
- 实时展示工具调用和结果

## 导入规范

- 跨包导入使用 `.js` 扩展名（ESM 要求）
- `web/` 只从 `core/` 导入
- 仅导入类型时使用 `import type { X }`
- 直接导入，不使用"转发导出"的包装文件
- `ai-client.ts` 做了类型 re-export（`export type { AIClient, ... } from "./types.js"`），这是唯一的例外

## 测试指南

- 框架：Vitest（配置在 `vitest.config.ts`）
- 命名：与源文件同名，后缀为 `*.test.ts`
- 测试文件放在 `src/` 目录下（`include: ["src/**/*.test.ts"]`）
- ToolRegistry 是实例化的，测试中每个 case 创建独立实例即可
- 覆盖率阈值：lines/branches/functions/statements 各 60%
- 覆盖率 provider：v8

## 提交与 PR 规范

- 提交信息简洁、动作导向（例如：`core: refactor ToolRegistry to class`）
- 相关改动归为一次提交
- scope 使用模块名：`core:`, `web:`, `demo:`, `docs:`

## 安全规范

- 永远不要提交真实 API Key
- 文档和测试中使用假数据占位符
- API Key 由 WebAgent 的调用方传入（`token` 参数），不从环境变量读取
- Demo 使用 `localStorage` 持久化 Token（`ap_token` 键），仅存在用户本地
- `evaluate` 工具使用 `new Function()` 而非 `eval()`（不污染当前作用域，但仍有安全风险，仅限可信环境使用）
