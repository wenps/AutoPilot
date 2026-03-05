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
│   ├── agent-loop/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── constants.ts
│   │   ├── helpers.ts
│   │   ├── snapshot.ts
│   │   ├── messages.ts
│   │   ├── recovery.ts
│   │   └── LOOP_MECHANISM.md   # Agent Loop 权威机制说明（必须同步维护）
│   └── ai-client/
│       ├── index.ts
│       ├── constants.ts
│       ├── custom.ts
│       ├── openai.ts
│       ├── anthropic.ts
│       ├── deepseek.ts
│       ├── doubao.ts
│       ├── qwen.ts
│       └── sse.ts
└── web/
  ├── index.ts
  ├── dom-tool.ts          # 兼容转发层（re-export）
  ├── navigate-tool.ts     # 兼容转发层（re-export）
  ├── page-info-tool.ts    # 兼容转发层（re-export）
  ├── wait-tool.ts         # 兼容转发层（re-export）
  ├── evaluate-tool.ts     # 兼容转发层（re-export）
  ├── event-listener-tracker.ts  # 全局事件监听追踪器
  ├── ref-store.ts
  ├── messaging.ts
  └── tools/
    ├── dom-tool.ts
    ├── navigate-tool.ts
    ├── page-info-tool.ts
    ├── wait-tool.ts
    └── evaluate-tool.ts
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

### 4.4 找不到元素重试对话流（新增）

当工具执行返回“元素未找到”时：
1. 聚合失败工具（name/input）与失败原因
2. 将失败工具集合 + 最新快照 + 当前任务一起发给 AI
3. 在对话上下文中标注当前尝试次数（attempt x/y）
4. 若仍未命中，默认等待 2 秒后刷新快照再重试
5. 超过最大尝试次数后退出重试流，交由剩余任务协议收敛

### 4.5 工具语义对齐（Playwright 风格，新增）

当前实现在 Web 工具层对齐了常见 Playwright 语义：
- `dom.click`：补齐 `pointerdown/mousedown/pointerup/mouseup/click` 事件链，减少站点事件漏触发。
- `dom.select_option`：支持 `value/label/index` 多策略选择；结果中显式返回 `value + label`。
- `dom.fill`：限制不适用于 `checkbox/radio/file/button/submit/reset`，避免错误动作。
- `wait.wait_for_selector`：支持 `state=attached|visible|hidden|detached`（默认 `attached`）。
- 快照增强运行态：`select val`、`option selected`、`checked`、`disabled`、`readonly` 可见。
- 快照增强结构语义：布局折叠后可通过括号分组块（`collapsed-group`）看出被提升节点之间的来源关联。
- 仅交互节点分配 hash ID：通过 `hasInteractiveTrackedEvents()` + 语义标签/ARIA role 判定交互性，非交互节点不占 token。
- 角色优先标签：当元素拥有 `INTERACTIVE_ROLES` 内的 ARIA role 且与 HTML tag 不等价时，用 role 替代 tag 作为显示标签（如 `[combobox]` 替代 `[input] role="combobox"`、`[slider]` 替代 `[div] role="slider"`），同时从属性列表中移除冗余的 `role="..."`。
- 点击目标选择约束：`click/navigation` 动作优先命中具备点击信号的目标（`listeners` 含 `clk/pdn/mdn`、`onclick`、原生链接/按钮语义或 `role=button/link`）；仅 `focus/hover` 信号节点默认视为上下文，不作为主点击目标。
- 点击无效关联回退：当一次点击未产生推进时，下一轮应优先尝试同语义组内最近的可操作 sibling/ancestor（如同一行中相邻 repo path/link/button），避免重复点击同一无效目标。

## 5. 模块职责细化

### core/agent-loop

- `index.ts`
  - 主循环编排
  - 工具执行与结果汇总
  - 与 AIClient 和 ToolRegistry 协同

- `messages.ts`
  - 紧凑消息构建
  - Round 0 注入“原始任务 + 快照”
  - Round 1+ 注入“remaining + done steps + previous executed + previous model output(normalized) + latest snapshot”

- `snapshot.ts`
  - 读取页面 URL/快照
  - 快照包裹与去重
  - prompt 中旧快照剥离

- `recovery.ts`
  - 冗余 page_info 拦截
  - 元素找不到后的恢复拍照
  - 导航变化检测
  - 空转检测

- `helpers.ts`
  - 工具结果识别、输入摘要、等待时间解析等纯函数

### core/ai-client

- `index.ts`：provider 路由
- `openai.ts`：OpenAI/Copilot 协议
- `anthropic.ts`：Anthropic 协议
- `deepseek.ts`：DeepSeek 协议
- `doubao.ts`：豆包（Ark）OpenAI 兼容协议
- `qwen.ts`：通义千问（DashScope）OpenAI 兼容协议
- `sse.ts`：SSE 统一消费器
- `custom.ts`：BaseAIClient 抽象封装
- `constants.ts`：provider 默认端点与共享校验逻辑

### web

- `index.ts`：WebAgent 对外 API，负责配置、记忆、autoSnapshot、callbacks
- `tools/*.ts`：工具实现主文件（DOM/导航/信息/等待/执行）
- `tools/dom-tool.ts`：对齐 Playwright 常见交互语义（事件链、select_option 多策略、fill 目标约束）
- `tools/wait-tool.ts`：支持 selector state 等待语义（attached/visible/hidden/detached）
- `tools/page-info-tool.ts`：快照输出运行态字段（selected/checked/disabled/readonly）
- `dom-tool.ts` / `navigate-tool.ts` / `page-info-tool.ts` / `wait-tool.ts` / `evaluate-tool.ts`：兼容转发层，避免外部导入路径断裂
- `event-listener-tracker.ts`：全局事件监听追踪器，通过 `EventTarget.prototype` 补丁拦截 `addEventListener/removeEventListener`，记录每个 Element 的运行时事件绑定。为快照的交互性判定（`hasInteractiveTrackedEvents`）、事件简写标注（`listeners="clk,inp,..."`）和优先级排序提供基础数据
- `ref-store.ts`：`#hashID -> Element` 映射
- `messaging.ts`：Extension 场景消息桥

## 6. 保护机制（系统稳定性的核心）

必须理解并保留以下机制：

1. 冗余调用拦截
- 避免 AI 无意义调用 page_info 导致 completion 浪费

2. 元素恢复机制
- 元素找不到时进入重试对话流（失败工具聚合 + 快照 + 尝试次数）

3. 导航上下文更新
- 导航后刷新快照，避免旧映射污染

4. 空转检测
- 连续只读/无实质推进时终止循环，防止无限迭代

5. 重复批次防自转
- 若连续两轮返回完全相同的任务批次且上一轮无错误，直接终止本次请求
- 目标：避免“看起来已完成但循环不停”的重复调用

6. 协议修复回合
- 当“remaining 未完成 + 无工具调用”出现时，不直接结束
- 下一轮注入 protocol violation 提示，要求“要么工具调用推进，要么严格 `REMAINING: DONE`”

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
