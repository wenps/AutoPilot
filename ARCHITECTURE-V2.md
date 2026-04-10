# AutoPilot V2 — 完整架构文档

> 本文档覆盖 v2 引擎的核心循环、保护机制、快照系统、提示词架构、微任务编排、断言系统、
> 工具体系的完整技术细节。面向后续维护者或接手者阅读。

---

## 目录

1. [总体架构](#1-总体架构)
2. [核心对话循环（Agent Loop）](#2-核心对话循环agent-loop)
3. [消息构建协议](#3-消息构建协议)
4. [10 种停机条件](#4-10-种停机条件)
5. [9 层保护 & 兜底机制](#5-9-层保护--兜底机制)
6. [快照系统](#6-快照系统)
7. [提示词架构](#7-提示词架构)
8. [工具体系](#8-工具体系)
9. [微任务编排](#9-微任务编排)
10. [断言系统](#10-断言系统)
11. [Web 层接线](#11-web-层接线)
12. [关键常量](#12-关键常量)
13. [文件清单](#13-文件清单)

---

## 1. 总体架构

```
用户 / Web 层
    ↓
 WebAgent                        ← src-v2/web/index.ts（浏览器入口）
    ├── RefStore（#hashID ↔ DOM 元素映射）
    ├── generateSnapshot()（DOM → 文本树）
    └── MainAgent               ← src-v2/core/main-agent/index.ts
         ├── chat()                       → 直接执行模式
         └── chat(enableOrchestration)    → 编排模式
               ├── OrchestrationContext   ← 编排会话管理
               ├── TaskMonitor            ← 执行记录链
               ├── executeMicroTask()     ← dispatch.ts
               └── evaluateAssertions     ← 断言 AI
         ↓
 executeAgentLoop()              ← src-v2/core/engine/index.ts
    ├── EngineContext             ← 全状态容器
    ├── phases.ts                ← 7 阶段管线
    ├── messages.ts              ← 消息构建
    ↓
 AI Client + ToolRegistry        ← 实际调用 LLM + 分派工具
```

### 分层职责

| 层 | 路径 | 职责 |
|----|------|------|
| **shared** | `core/shared/` | 无状态基础设施：prompt-rules、helpers、snapshot、recovery、constants、types |
| **assertion** | `core/assertion/` | 独立判定层：断言 AI（无 tools，只看快照判定完成情况） |
| **micro-task** | `core/micro-task/` | 数据结构层：MicroTaskDescriptor / ExecutionRecordChain / TaskMonitor |
| **engine** | `core/engine/` | 决策主循环：7 阶段管线 + 9 层保护 + 10 种停机 |
| **main-agent** | `core/main-agent/` | 对话管理 + 双模式调度（直接 / 编排） |
| **web** | `web/` | 浏览器集成：6 个工具、RefStore、DOM 序列化 |

---

## 2. 核心对话循环（Agent Loop）

入口：`executeAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult>`

### 7 阶段管线（每轮重复）

```
for round = 0 .. maxRounds:
│
├─ 阶段 1：确保快照存在
│   ├─ 聚焦模式 → refreshFocusedSnapshot()
│   └─ 标准模式 → refreshSnapshot()
│
├─ 阶段 2：构建消息 + 调用 AI（prepareAndCallAI）
│   ├─ 计算快照 diff（Round 1+ 对比上一轮快照）
│   ├─ 构建聚焦/标准上下文
│   ├─ buildCompactMessages()（Round 0 vs Round 1+ 不同结构）
│   ├─ 调用 AI client（system prompt + tools 定义）
│   ├─ 累加 token 计数
│   └─ 解析 REMAINING 协议 + FOCUS_TARGET 提示
│
├─ 阶段 3：处理无工具调用响应（handleNoToolCallResponse）
│   ├─ 检查是否有待处理的 not-found 重试
│   ├─ 无重试且无 remaining → 发出 finalReply + "converged" / "protocol_fix_failed"
│   └─ 返回信号：continue / break
│
├─ 检查点：重复批次检测（checkRepeatedBatch）
│   ├─ 连续 ≥3 轮完全相同工具调用 → break "repeated_batch"
│   └─ 连续 2 轮 → 注入违规提示
│
├─ 检查点：DryRun 模式
│   └─ dryRun=true → 展示工具调用，不执行 → break "dry_run"
│
├─ 阶段 4：执行本轮工具（executeRoundTools）
│   ├─ 对每个工具调用：
│   │   ├─ 检查无效点击拦截（checkIneffectiveClickRepeat）
│   │   ├─ 通过 registry.dispatch 执行工具
│   │   ├─ 恢复 1：元素未找到 → 自动等待 + 刷新快照（最多 2 次）
│   │   ├─ 恢复 2：导航成功 → 立即刷新快照
│   │   ├─ 收集未找到任务（用于重试流）
│   │   └─ 记录点击选择器、DOM 变更、确认进度
│   └─ 返回 RoundToolResult { errors, mutations, progress, missingTasks }
│
├─ 阶段 5：处理断言工具（handleAssertionTool）
│   ├─ 如果有 assert 工具调用：
│   │   ├─ 刷新断言快照（无 hashID、无 listeners）
│   │   ├─ DOM 变更后等待稳定
│   │   ├─ 调用 evaluateAssertions AI
│   │   ├─ 全部通过 → "assertion_passed" → break
│   │   ├─ 失败 + 连续 ≥3 轮仅 assert → "assertion_loop" → break
│   │   └─ 否则注入断言进度提示
│   └─ 返回信号：proceed / break
│
├─ 阶段 6：状态更新（updateRemainingState）
│   ├─ 更新 pendingNotFoundRetry（如有未找到任务）
│   ├─ 推进 REMAINING（协议解析或启发式推断）
│   ├─ 同步任务检查清单
│   ├─ 检查 DONE 收敛 → remaining 为空 + 无错误 → break "converged"
│   └─ 返回信号：proceed / break
│
└─ 阶段 7：轮后守卫（runPostRoundGuards）
    ├─ 守卫 6：空转检测（2+ 轮只读 → break "idle_loop"）
    ├─ 守卫 8：滞止检测（3+ 轮无进展 → break "stale_remaining"）
    ├─ DOM 变更后等待稳定（roundStabilityBarrier）
    ├─ 刷新快照（全量/聚焦）
    ├─ 对比快照指纹（before/after）
    │   ├─ 不变（点击无效）→ 注入 "unchanged" 提示 + 加入无效集合
    │   └─ 变化 → 清除本轮选择器的无效标记
    ├─ 守卫 8：点击循环检测（4+ 轮 ≤2 个目标 → 注入提示 + 拦截）
    ├─ 守卫 5：无协议检测（5+ 轮有工具但无 REMAINING → break "no_protocol"）
    └─ 返回信号：proceed / break
```

循环结束后：`ctx.buildResult()` 组装最终 `AgentLoopResult`。

---

## 3. 消息构建协议

### Round 0（首轮，trace 为空）

```
User 消息结构：
├─ 用户原始目标文本
├─ Remaining: <任务指令>
├─ [Task Progress 检查清单（如有 taskItems）]
├─ URL: <当前页面 URL>
├─ 行为约束：
│   ├─ "Do NOT call page_info (snapshot auto-refreshed)"
│   ├─ "Completion = visible outcome in snapshot, not sub-steps"
│   ├─ "Click ends the round (max 1 click)"
│   ├─ "Batch fills freely"
│   ├─ "If snapshot shows goal state → REMAINING: DONE immediately"
│   ├─ [聚焦模式: "output FOCUS_TARGET: #hashId"]
│   └─ [Agent UI: "Do NOT interact unless explicitly requested"]
├─ ## Snapshot（含 SNAPSHOT_START/END 标记）
└─ [协议违规提示（如有）]
```

### Round 1+（后续轮，trace 非空）

```
两条消息：

1. Assistant 消息（已完成步骤摘要）：
   Done steps (do NOT repeat):
   ✅/❌ 1. tool (args...) → result
   ✅/❌ 2. tool (args...) → result
   ...

2. User 消息结构：
   ├─ Original Goal: <用户原始目标>
   ├─ Remaining: <当前剩余任务>
   ├─ [Task Progress 检查清单]
   ├─ 行为约束（同 Round 0）
   ├─ [Previous executed tasks: 列表]
   ├─ [Previous planned tasks: 列表]
   ├─ [Previous model output: 摘要]
   ├─ [Last step error（如上轮失败）]
   ├─ URL: <当前 URL>
   ├─ [Assertion Progress（如断言未全通过）]
   ├─ ## Snapshot Changes（与上轮的 diff）
   ├─ ## Snapshot（全量或聚焦）
   └─ [协议违规提示]
```

### 特殊消息注入场景

| 场景 | 注入内容 |
|------|---------|
| 聚焦模式 | `#focusTargetRef` 子树快照 + `baseDiff`（相对任务开始的变化） |
| 断言进度 | 哪些断言通过/失败 + 失败原因 |
| Not-Found 重试 | 未解决目标 + 重试次数 |
| 快照不变 | "Snapshot unchanged after click" + 附近可点击元素 |
| 点击循环 | "Cycling between same targets" + 替代建议 |
| 重复批次 | "Repeated action warning" |
| 滞止 remaining | "No progress detected, check if done" |

---

## 4. 10 种停机条件

| StopReason | 含义 | 触发阶段 |
|------------|------|---------|
| **converged** | 任务正常完成（REMAINING: DONE 或 remaining 收敛为空） | 阶段 3 / 6 |
| **assertion_passed** | 所有断言通过（独立 AI 判定完成） | 阶段 5 |
| **assertion_loop** | 断言死循环（连续 ≥3 轮仅 assert 且失败） | 阶段 5 |
| **repeated_batch** | 连续 ≥3 轮完全相同工具调用批次 | 检查点 |
| **idle_loop** | 连续 ≥2 轮只执行只读工具（page_info / get_text / get_attr） | 阶段 7 |
| **no_protocol** | 连续 ≥5 轮有工具调用但无 REMAINING 协议输出 | 阶段 7 |
| **protocol_fix_failed** | 无工具调用 + remaining 未解决（协议修复失败） | 阶段 3 |
| **stale_remaining** | 连续 ≥3 轮 remaining 不变 + 无确认进度 | 阶段 7 |
| **max_rounds** | 达到 maxRounds 上限（默认 40） | 循环退出 |
| **dry_run** | 干运行模式，仅展示不执行 | 检查点 |

---

## 5. 9 层保护 & 兜底机制

### 保护 1：元素未找到自动恢复（Element Not-Found Recovery）

```
工具返回 ELEMENT_NOT_FOUND
    ↓
检查该 (toolName + input) 的恢复尝试次数
    ↓
尝试 ≤ 2 次（DEFAULT_ACTION_RECOVERY_ROUNDS）:
    ├─ 等待 100ms（DEFAULT_RECOVERY_WAIT_MS）
    ├─ 刷新快照
    └─ 返回恢复标记，AI 下轮重试
    ↓
尝试 > 2 次:
    └─ 返回 MAX_RECOVERY_REACHED 错误，AI 须换策略
```

### 保护 2：导航 URL 变化检测（Navigation URL Change）

```
导航工具执行成功
    ↓
检测 URL 是否变化
    ↓
变化 → 立即刷新快照
    （避免旧 DOM 引用污染下一轮决策）
```

### 保护 3：空转检测（Idle Loop Detection）

```
连续 2+ 轮仅执行只读工具（page_info / dom.get_text / dom.get_attr）
    ↓
判定为空转循环 → break "idle_loop"
```

### 保护 4：重复批次防自转（Repeated Batch Detection）

```
连续 2 轮完全相同的工具调用批次（上一轮无错误时）:
    → 注入 "Repeated action warning" 提示
连续 ≥3 轮仍相同:
    → break "repeated_batch"
```

### 保护 5：无效点击拦截（Ineffective Click Detection & Blocking）

```
工具执行后，对比快照指纹 before/after:
    ↓
指纹不变（click 无效果）:
    ├─ 将 selector 加入 ineffectiveClickSelectors 集合
    └─ 注入提示："Snapshot unchanged" + 附近可点击元素列表
    ↓
下一轮 AI 再次点击同一 selector:
    → checkIneffectiveClickRepeat() 拦截
    → 直接返回错误 + 替代元素建议
    ↓
指纹变化（说明操作有效果）:
    → 仅移除本轮点击的无效标记
    → 保留其他历史无效 selector
```

### 保护 6：交替循环检测（Click Cycling Detection）

```
维护近 6 轮点击目标滑动窗口
    ↓
唯一目标 ≤ 2 个 且 总点击 ≥ 4 次:
    → 判定为 A→B→A→B 交替循环
    → 将所有目标加入拦截集
    → 注入详细提示 + 替代建议：
        搜索/筛选、查看容器内部、
        尝试父级/兄弟级、直接 URL 导航
```

### 保护 7：协议修复回合（Protocol Violation Fix）

```
"remaining 未完成 + 无工具调用" 出现时:
    → 不直接停机
    → 下一轮注入 protocol violation 提示
    → 要求模型要么行动要么 REMAINING: DONE
    ↓
下一轮仍无改善:
    → break "protocol_fix_failed"
```

### 保护 8：滞止收敛检测（Stale Remaining Detection）

```
remaining 连续 ≥2 轮不变 且 无确认进度
    （无 fill/type/press/navigate 等确认性动作）:
    → 注入 CRITICAL 提示："no progress detected, check if done"
    ↓
连续 ≥3 轮:
    → break "stale_remaining"
    ↓
注意：仅对多步任务（taskItems 存在）激活
      单步任务由 idle_loop / no_protocol 处理
```

### 保护 9：断言能力（Assertion Capability）

```
AI 主动调用 assert 工具:
    → 通过独立 AI（专用 prompt，无 tools）判定
    → 对比：初始快照 + 动作后快照 + 当前快照
    ↓
全部通过 → break "assertion_passed"
    ↓
失败 → 注入 ## Assertion Progress（失败原因写入下一轮）
    ↓
连续 ≥3 轮仅 assert 且失败 → break "assertion_loop"
```

### 兜底机制总结表

| 问题场景 | 兜底策略 | 最终安全网 |
|---------|---------|----------|
| 元素找不到 | 自动等待 + 刷新快照重试 2 次 | 返回错误让 AI 换策略 |
| 页面导航 | 检测 URL 变化 → 刷新快照 | 旧快照被 strip |
| AI 只读不动 | 2 轮检测 → idle_loop 停机 | max_rounds |
| AI 重复动作 | 2 轮警告 → 3 轮 repeated_batch 停机 | max_rounds |
| 点击无效 | 加入拦截集 + 推荐附近元素 | cycling detection |
| A↔B 循环点击 | 6 轮窗口检测 → 拦截 + 替代建议 | max_rounds |
| 不输出 REMAINING | 注入协议修复提示 | 5 轮 no_protocol 停机 |
| remaining 不推进 | 2 轮警告 → 3 轮 stale_remaining 停机 | max_rounds |
| 断言不通过 | 注入失败原因让 AI 修复 | 3 轮 assertion_loop 停机 |
| DOM 不稳定 | loading 指示器等待 + DOM quiet 窗口 | 超时 4s 继续 |
| 所有兜底都失败 | — | max_rounds（默认 40）硬上限 |

---

## 6. 快照系统

### 6.1 三种快照类型

| 类型 | 用途 | 特点 |
|------|------|------|
| **执行快照** (latestSnapshot) | AI 决策依据 | 完整 DOM + hashID + listeners |
| **断言快照** (assertionSnapshot) | 断言 AI 判定 | 有 hashID，无 listeners（省 ~10-15% tokens） |
| **聚焦快照** (focusedSnapshot) | 微任务聚焦 | 目标元素子树（祖先 + 兄弟 + 子节点） |

### 6.2 DOM 序列化引擎（generateSnapshot）

**输入**：DOM 元素 + SnapshotOptions
**输出**：文本树表示（含 hashID、listeners、属性）

```typescript
SnapshotOptions = {
  maxDepth: 12,              // 最大遍历深度
  viewportOnly: false,       // 是否仅可见区域
  pruneLayout: true,         // 折叠空容器
  maxNodes: 500,             // 全局节点预算
  maxChildren: 30,           // 每个父节点子节点上限
  maxTextLength: 40,         // 文本截断长度
  expandOptionLists: false,  // 放宽 select/listbox 子节点限制
  expandChildrenRefs: [],    // 指定展开的 #hashID
  expandedChildrenLimit: 120,// 展开后子节点上限
  skipListeners: false,      // 跳过 listeners（断言模式）
  classNameFilter: [...],    // 类名过滤正则
  refStore: RefStore,        // hashID 映射存储
}
```

### 6.3 序列化算法核心流程（walk 函数）

```
1. 跳过标签：SCRIPT, STYLE, SVG, NOSCRIPT, LINK, META, BR, HR
2. 可见性检查：跳过 display:none / visibility:hidden / 零尺寸
3. 视口裁剪（viewportOnly=true 时）
4. data-autopilot-ignore 跳过
5. 元素优先级评分：
   - input/button/select: 200 分
   - click/input/change listeners: 80-140 分
   - onclick 属性: 60 分
   - tabindex: 20 分
   - 子节点按优先级排序
6. 智能剪枝（pruneLayout=true）：
   - 空布局容器测试（无 id/role/事件/文本的 div/span/section）
   - 文本聚合（无交互子节点的子树 → 合并为一行）
   - 链接穿透（有交互子节点 → 跳过自身，提升子节点）
7. HashID 分配（仅交互节点）：
   - 有跟踪事件监听器
   - 或内联事件处理器
   - 或语义标签（button/input/a/select）
   - 或 ARIA 交互角色
   - 或 tabindex / contenteditable
8. 属性收集（精简版）：
   - id（跳过动态 ID：el-*, headlessui-*, rc-*, :r0:, n-123）
   - 首个语义类名（过滤 ~80 个 UI 框架类名）
   - 交互属性：href, type, placeholder, value, name, role, aria-label...
   - 布尔属性：disabled, checked, readonly, required, selected, hidden
   - 运行时值：input/textarea 的 el.value, checkbox/radio 的 el.checked
   - 事件监听器缩写：clk=click, inp=input, chg=change...（最多 6 个）
   - 内联 background-color（颜色选择器指示器）
9. 子节点渲染：
   - 按优先级排序
   - 取前 resolveChildLimit() 个
   - 超出显示 "... (N children omitted)"
10. 行格式：
    [tag] "直接文本" id="x" class="y" href="/z" listeners="clk,inp" #hashID
```

### 6.4 输出示例

```
[header] #k9f2a
  [nav] #m3d7e
    [a] "首页" href="/" #p1c4b
    [a] "关于" href="/about" #q8e5f
[main] #r2d6d
  [h1] "欢迎"
  [input] type="text" placeholder="搜索..." listeners="inp,chg" #t4j8k
  [button] "搜索" listeners="clk" #u5n2m
```

### 6.5 快照 Diff 算法

**computeSnapshotDiff（结构 diff）**：
1. 标准化 hashID（`#abc → #_`，基于内容匹配）
2. 贪心位置匹配（prev → curr）
3. 标记增删行
4. 每个变化附带祖先链 + 上下 2-3 行兄弟上下文
5. 输出统一 diff 格式（`+` `-` 前缀）

**computeSemanticDiff（语义 diff）**：
1. 按 hashID 匹配 base ↔ curr 节点
2. 仅报告语义变化：val / checked / text / aria-expanded
3. 未匹配节点报告 add / delete

```
~ #a1b2c val: "" → "test@example.com"
~ #x9k3d +checked
~ #ghi789 text: "未提交" → "已提交"
```

### 6.6 快照生命周期

```
Round 开始 → 确保快照存在（阶段 1）
    ↓
工具执行中 → 导航成功时立即刷新
    ↓
元素恢复时 → 等待 + 刷新
    ↓
Round 结束 → 等待稳定 + 刷新（阶段 7）
    ↓
断言时 → 特殊断言快照（无 listeners）
    ↓
历史消息中的旧快照 → stripSnapshotFromPrompt() 替换为
    "[snapshot outdated - previously captured, ignored]"
```

### 6.7 聚焦快照（Focused Snapshot）

```
targetElement（由 focusRef 定位）
    ↓
向上爬 3 层祖先（ancestorLevels=3）
    ↓
以祖先为根生成快照（maxDepth=6, maxNodes=200）
    ↓
如果根 = body（无实际范围）→ 回退全量快照
```

### 6.8 RefStore（Hash ID 映射）

- **算法**：FNV-1a 32 位哈希（URL + DOM 路径）→ base-36 ID（如 `a1b2c`）
- **确定性**：同一元素始终得到同一 ID
- **碰撞处理**：数字后缀（`a1b2c` → `a1b2c1`）
- **页面隔离**：URL 作为命名空间
- **生命周期**：每次 `chat()` 调用创建，结束时清除

**选择器解析链**：
```
AI 使用 #a1b2c
    ↓
resolveSelector("#a1b2c")
    ├─ 检查 RefStore → 找到 → 返回 DOM 元素
    └─ RefStore 无 → 降级 CSS querySelector
        └─ 仍无 → 返回错误
```

---

## 7. 提示词架构

### 7.1 两套 Prompt 共享基础

```
prompt-rules.ts
├── buildCoreOperationRules()    ← 14 组共享 DOM 操作规则
└── buildListenerAbbrevLine()    ← 事件缩写映射
        ↓                              ↓
system-prompt.ts             micro-task/prompt.ts
（Main Agent 完整提示词）      （Micro-task 精简提示词）
```

### 7.2 Main Agent 提示词结构（7 章节）

```
§1  角色定义 + 核心规则
    ├─ 目标锚定（Original Goal Anchor）
    ├─ 目标分解（Goal Decomposition）
    ├─ 共享 DOM 操作规则（14 组）
    ├─ 任务完成强制规则
    └─ 停止条件（REMAINING: DONE）

§2  事件缩写对照表（Listener Abbrevs）

§3  输出协议（REMAINING 协议）

§4  [可选] 执行策略（enableOrchestration=true 时）
    ├─ 先扫描所有字段再派发
    ├─ 直接模式 vs 微任务模式选择
    ├─ 派发规则（一次性全量 / 不混用 / 完全覆盖）
    ├─ 粒度规则（文本合并 / 其他单独）
    ├─ focusRef 使用说明
    ├─ 何时不用微任务
    └─ 结果处理 & 失败恢复

§5  [可选] 思考深度配置

§6  [可选] 额外自定义指令

§7  断言能力说明
    ├─ assert 工具说明
    ├─ 调用时机
    └─ 待验证断言列表
```

### 7.3 共享 DOM 操作规则（14 组）

| 类别 | 规则要点 |
|------|---------|
| 快照驱动 | 从当前快照 + remaining 出发；用 #hashID 作选择器 |
| 点击规则 | 必须有 click 信号；先确认上一步效果再计划新动作 |
| 批量操作 | fill/type/check/select_option 可自由批量；click 结束本轮（最多 1 个） |
| 控件操作 | dropdown 优先 select_option；stepper 计算差值；**确认弹窗必须点确定** |
| 轮次管理 | DOM 变更动作断轮；单次前置条件完成即从 remaining 移除 |
| 通用约束 | 不做超出任务要求的事；不验证除非用户要求；completion = 快照可见结果 |
| 空字段检测 | text 无 val 或有 placeholder；select 显示 placeholder；checkbox 无 checked |

### 7.4 Micro-task 提示词结构

```
§1  角色 & 任务定义
    ├─ "You are a Micro-task Agent"
    ├─ 聚焦单一任务
    └─ 任务描述

§2  已完成上下文（previouslyCompleted）

§3  核心规则
    ├─ 共享 DOM 操作规则（同 Main Agent）
    ├─ 微任务专有：必须完成全部任务
    ├─ 不输出 DONE 直到快照确认
    └─ 停止条件

§4  事件缩写

§5  输出协议

§6  [可选] 思考深度
```

**与 Main Agent 的关键差异**：
- 无"目标锚定"（微任务只有单一焦点）
- 无"执行策略"（不能再次 dispatch）
- 无"额外指令"
- 无"断言能力"章节
- 更小、更聚焦的规则集

### 7.5 断言提示词

独立 AI，**不带任何工具**，只做判定。

```
系统提示：
├─ "You are a verification judge"
├─ 对比 INITIAL vs CURRENT 快照
├─ 表单字段检查规则：
│   val="..." / checked / is-checked / is-active / bg="..."
├─ 严格模式：部分完成 = FAILED
└─ 输出纯 JSON 数组

用户消息：
├─ ## Initial Page Snapshot（操作前）
├─ ## Post-Action Snapshot（操作后瞬态）
├─ ## Current Page Snapshot（稳定态）
├─ ## Executed Actions（已执行动作列表）
├─ ## Task Assertions to Verify（待验证断言）
└─ "Return the JSON result array now"
```

---

## 8. 工具体系

### 8.1 6 个内置工具

#### DOM 工具（16 个动作）

| 动作 | 用途 | 关键机制 |
|------|------|---------|
| **click** | 点击元素 | 重定向（button/link）、滚动到视口、命中测试、click 信号验证 |
| **fill** | 表单输入 | 日期/颜色/range 用 setValue；文本用 selectAll+native write；滑块自动关联 |
| **select_option** | 下拉选择 | value/label/index 三种策略；支持原生 `<select>` + 自定义下拉 |
| **clear** | 清空输入 | selectAll + Delete |
| **check/uncheck** | 切换勾选 | 点击切换 + 状态验证 |
| **type** | 追加文本 | 不清空，触发 input 事件（搜索建议等） |
| **focus** | 聚焦元素 | 触发 focus 事件 |
| **hover** | 悬停元素 | 完整事件链：pointerenter → mouseover → pointermove → mousemove |
| **scroll** | 滚动元素 | deltaY/deltaX + steps（虚拟列表） |
| **press** | 键盘输入 | 支持 Control+a、Shift+Enter 等组合键 |
| **get_text** | 读取文本 | 只读 |
| **get_attr** | 获取属性 | 只读 |
| **set_attr** | 设置属性 | 修改 HTML 属性 |
| **add_class / remove_class** | CSS 类操作 | 修改 classList |

**Click 保护机制**：
- **重定向**：自动重定向到功能元素（label 内的 button、父级 link）
- **稳定检测**：rAF 逐帧位置稳定检测
- **命中测试**：`elementsFromPoint()` 检查遮挡物
- **ARIA 禁用**：向上遍历祖先链检查 `aria-disabled="true"`

#### Navigate 工具（4 个动作）

| 动作 | 用途 |
|------|------|
| **goto** | 打开 URL（新标签页） |
| **back** | 浏览器后退 |
| **forward** | 浏览器前进 |
| **scroll** | 页面/元素滚动 |

#### Page Info 工具

| 动作 | 用途 |
|------|------|
| **get_url** | 获取当前 URL |
| **get_title** | 获取页面标题 |
| **get_selection** | 获取选中文本 |
| **get_viewport** | 获取视口尺寸 |
| **query_all** | CSS 选择器查询 |
| **snapshot** | 全量快照（框架内部，AI 不应直接调用） |
| **focused_snapshot** | 聚焦快照（框架内部） |

#### Wait 工具（5 个动作）

| 动作 | 用途 | 实现 |
|------|------|------|
| **wait_for_selector** | 等待选择器状态 | MutationObserver + 轮询双通道 |
| **wait_for_hidden** | 等待元素隐藏 | wait_for_selector state=hidden |
| **wait_for_text** | 等待文本出现 | 全局 MutationObserver |
| **wait_for_stable** | 等待 DOM 静默 | 默认 500ms 无变更 |
| **wait_for_timeout** | 固定等待 | sleep |

#### Evaluate 工具（2 个动作）

| 动作 | 用途 |
|------|------|
| **evaluate** | 执行 JS 表达式/语句块 |
| **evaluate_handle** | 执行 JS + 获取 DOM 元素摘要 |

使用 `new Function()` 构造器，先尝试表达式，降级为语句块。

#### Assert 工具

- 触发断言验证（AI 驱动的任务完成检查）
- 返回通用成功消息；实际断言逻辑在 `core/assertion/index.ts`

### 8.2 工具注册与分派

```typescript
// 注册
registry.register({
  name: "dom",
  description: "...",
  schema: Type.Object({ action: Type.String(), ... }),
  execute: async (params) => { ... return { content: "..." } }
});

// 分派（engine 调用）
const result = await registry.dispatch("dom", { action: "click", selector: "#a1b2c" });
// result: { content: string | Record, details?: Record }

// 编排模式追加
registry.register({
  name: "dispatch_micro_task",
  schema: Type.Object({
    task: Type.String(),
    focusRef: Type.Optional(Type.String()),
  }),
  execute: (params) => orchestrationCtx.dispatch(params)
});

// 微任务防递归：克隆 registry 时排除 dispatch_micro_task
microTaskTools = clone(registry).exclude("dispatch_micro_task");
```

---

## 9. 微任务编排

### 9.1 两种执行路径

```
路径 1：直接执行（chat）
    User → buildSystemPrompt → executeAgentLoop → Result

路径 2：编排模式（chat + enableOrchestration）
    User → buildSystemPrompt（含编排策略）→ executeAgentLoop
        ↓
    AI 分析快照 → 决定用微任务
        ↓
    dispatch_micro_task({ task: "...", focusRef: "#form1" })
        ↓
    OrchestrationContext.dispatch()
        ├─ 检查上一轮断言结果（失败则重试）
        ├─ executeMicroTask()
        │   ├─ buildMicroTaskPrompt()（精简提示词）
        │   ├─ executeAgentLoop()（focusedMode=true, maxRounds=15）
        │   └─ 生成 MicroTaskResult
        ├─ 异步断言（evaluateAsync，不阻塞）
        └─ 返回 ToolCallResult 给主 AI
        ↓
    AI 继续派发更多微任务...
        ↓
    AI 调用 assert → 验证总体完成
        ↓
    REMAINING: DONE → 循环结束
        ↓
    orchestrationCtx.finalize()（等待所有 pending 断言）
```

### 9.2 核心数据流

```
MicroTaskDescriptor
    { id, task, focusRef?, assertions?, maxRounds? }
        ↓
TaskMonitor.execute(descriptor, executeFn)
    ├─ buildPreviousContext() → "✅ MT-1: done. ✗ MT-2: failed"
    ├─ executeFn(descriptor, previousContext) → MicroTaskResult
    └─ recordChain.append(executionRecord)
        ↓
MicroTaskResult
    { descriptor, success, executionRecord, metrics, finalSnapshot, failureReason? }
        ↓
ExecutionRecordChain
    ├─ buildPreviousContext() → 给下一个微任务看"前面做了什么"
    └─ buildEvidenceSummary() → 给系统级断言看"整体执行了哪些步骤"
```

### 9.3 编排粒度规则

| 控件类型 | 分派策略 |
|---------|---------|
| 所有文本输入 | **合并到一个微任务** |
| 每个下拉/选择 | 单独一个微任务 |
| 每个日期选择器 | 单独一个微任务 |
| 每个颜色选择器 | 单独一个微任务 |
| 每个开关/切换 | 单独一个微任务 |
| 每个单选组 | 单独一个微任务 |
| 每个复选组 | 单独一个微任务 |
| 每个滑块/评分 | 单独一个微任务 |

### 9.4 关键约束

1. **一次性全量派发**：所有微任务必须在同一轮派发，禁止分多轮
2. **不混用**：同一轮要么全是 dispatch，要么全是 DOM 操作
3. **完全覆盖**：每个可见字段都必须被微任务覆盖
4. **带 focusRef**：每次 dispatch 都带表单容器的 #hashID
5. **先断言后 DONE**：编排模式下必须先调 assert 再输出 REMAINING: DONE

### 9.5 异步断言流水线

```
Round N:  dispatch("选日期") → 执行 MT-1 → evaluateAsync() → 返回结果
Round N+1: dispatch("选颜色") → 检查 MT-1 断言 → 失败则重试 → 执行 MT-2 → evaluateAsync()
Round N+2: AI 收尾 → finalize() 等待所有断言
```

每个微任务最多重试 1 次（`retriedMicroTaskIds` 集合防止重复重试）。

### 9.6 聚焦快照 & focusRef

```
dispatch_micro_task({ task: "...", focusRef: "#form1" })
    ↓
OrchestrationContext: descriptor.focusRef = "form1"（去掉 #）
    ↓
executeMicroTask:
    initialFocusRef = descriptor.focusRef || task.match(/#([a-z0-9]{4,})/)?.[1]
    ↓
executeAgentLoop({ focusedMode: true, initialFocusRef: "form1" })
    ↓
引擎阶段 1: refreshFocusedSnapshot()
    → readFocusedPageSnapshot(registry, "form1")
    → 生成 form1 子树的聚焦快照
    ↓
AI 只看表单区域，不看全页
    → 减少 token、提高准确率
```

---

## 10. 断言系统

### 10.1 两条断言流

| 维度 | 微任务级断言 | 系统级断言 |
|------|------------|-----------|
| 触发方 | OrchestrationContext（异步，每个微任务后） | AI 调用 assert 工具（engine 阶段 5） |
| 输入 | 单个微任务的 before/after 快照 + actions | 全量快照 + 执行记录链 |
| 判定者 | 独立断言 AI（无 tools） | 同上 |
| 阻塞性 | 非阻塞（evaluateAsync） | 阻塞当前轮 |
| 失败处理 | 下次 dispatch 时重试 1 次 | 注入失败原因到下一轮 |

### 10.2 断言请求格式

```typescript
AssertionRequest = {
  level: "micro-task" | "system",
  taskAssertions: [{ task, description }],
  currentSnapshot: string,            // 当前页面状态
  initialSnapshot?: string,           // 操作前状态（before/after 对比）
  postActionSnapshot?: string,        // 瞬态状态（捕获成功提示）
  executedActions?: string[],         // 动作摘要
  executionEvidence?: string,         // 完整执行记录链（系统级）
}
```

### 10.3 断言结果格式

```typescript
AssertionResult = {
  allPassed: boolean,
  total: number,
  passed: number,
  failed: number,
  details: [{
    task: string,
    passed: boolean,
    reason: string      // "Current snapshot shows new item in table"
  }]
}
```

---

## 11. Web 层接线

### 11.1 完整调用链

```
WebAgent.chat(message, options)
    ├─ 创建 RefStore（当前 URL）
    ├─ setActiveRefStore(refStore)          ← 全局状态
    ├─ generateSnapshot(document.body, { ..., refStore })
    │   └─ walk() → 文本快照 + refStore 记录交互元素
    ├─ getMainAgent()（懒创建 / 复用）
    │   └─ new MainAgent({ aiClient, tools: registry, callbacks, maxRounds })
    ├─ buildWrappedCallbacks()
    │   ├─ onBeforeAssertionSnapshot: 清理 hover 样式、blur 焦点元素
    │   ├─ onAfterSnapshot: 应用交互叠加层（如开启）
    │   ├─ onAIResponse: 记录到 debugResponses
    │   └─ onBeforeRecoverySnapshot: URL 变化时更新 RefStore
    └─ MainAgent.chat(message, {
        initialSnapshot, callbacks, enableOrchestration?
      })
        ├─ buildSystemPrompt()
        ├─ executeAgentLoop()
        │   └─ [7 阶段管线循环]
        └─ return AgentLoopResult
    ↓
    Finally:
    ├─ if (!memory) clearHistory()
    ├─ clearInteractiveOverlay()
    ├─ refStore.clear()
    └─ setActiveRefStore(undefined)
```

### 11.2 DOM 稳定等待（Round Stability Barrier）

每轮有潜在 DOM 变更动作后执行双重等待：

```
1. Loading 指示器隐藏等待（最长 4000ms）
   覆盖：AntD (.ant-spin, .ant-skeleton)
         Element Plus (.el-loading-mask)
         BK UI (.bk-loading, .bk-skeleton)
         TDesign (.t-loading, .t-skeleton)
         通用 ([aria-busy="true"], .skeleton, .loading)

2. DOM Quiet 窗口（200ms 无 mutation）
   MutationObserver + 轮询双通道
```

---

## 12. 关键常量

```typescript
DEFAULT_MAX_ROUNDS = 40                              // 主任务最大轮次
DEFAULT_MICRO_TASK_MAX_ROUNDS = 15                   // 微任务最大轮次
DEFAULT_RECOVERY_WAIT_MS = 100                       // 元素恢复等待时间
DEFAULT_ACTION_RECOVERY_ROUNDS = 2                   // 最大自动恢复次数
DEFAULT_NOT_FOUND_RETRY_ROUNDS = 2                   // 最大对话级重试
DEFAULT_NOT_FOUND_RETRY_WAIT_MS = 1000               // 异步渲染等待
DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS = 4000       // 稳定等待超时
DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS = 200          // DOM 静默窗口
```

---

## 13. 文件清单

### Core 层

| 文件 | 职责 |
|------|------|
| `core/engine/index.ts` | executeAgentLoop 入口，7 阶段循环编排 |
| `core/engine/phases.ts` | 7 个阶段函数（prepareAndCallAI / executeRoundTools / ...） |
| `core/engine/engine-context.ts` | EngineContext 全状态容器（~50 个状态变量） |
| `core/engine/messages.ts` | 消息构建（buildCompactMessages / buildToolTrace） |
| `core/shared/system-prompt.ts` | Main Agent 系统提示词构建器 |
| `core/shared/prompt-rules.ts` | 共享 DOM 操作规则（14 组） |
| `core/shared/types.ts` | 核心类型（AIClient / StopReason / AgentLoopResult / ...） |
| `core/shared/constants.ts` | 全局常量 |
| `core/shared/helpers.ts` | 快照 diff / 语义 diff / SNAPSHOT_HINT 解析 |
| `core/shared/tool-registry.ts` | ToolRegistry / ToolDefinition / ToolCallResult |
| `core/shared/snapshot/engine.ts` | DOM 序列化引擎（generateSnapshot / generateFocusedSnapshot） |
| `core/shared/snapshot/lifecycle.ts` | 快照生命周期（read / wrap / strip） |
| `core/shared/snapshot/index.ts` | Barrel re-export |
| `core/shared/recovery/index.ts` | 4 个恢复函数（element / navigation / idle / ineffective click） |
| `core/assertion/types.ts` | 断言类型定义 |
| `core/assertion/index.ts` | 断言执行（evaluate / evaluateAsync / awaitAll） |
| `core/assertion/prompt.ts` | 断言提示词构建 |
| `core/micro-task/types.ts` | 微任务类型（Descriptor / Result / RecordChain / ExecuteFn） |
| `core/micro-task/record.ts` | ExecutionRecordChain 实现 |
| `core/micro-task/prompt.ts` | 微任务提示词构建 |
| `core/micro-task/task-monitor.ts` | TaskMonitor（执行记录管理） |
| `core/main-agent/index.ts` | MainAgent 类（chat / chatWithOrchestration） |
| `core/main-agent/dispatch.ts` | executeMicroTask 函数 |
| `core/main-agent/orchestration-context.ts` | OrchestrationContext（编排会话管理） |

### Web 层

| 文件 | 职责 |
|------|------|
| `web/index.ts` | WebAgent 入口（工具注册 / RefStore / 回调桥接） |
| `web/ref-store.ts` | RefStore 实现（FNV-1a 哈希 → base-36 ID） |
| `web/tools/dom-tool.ts` | DOM 工具（16 个动作） |
| `web/tools/navigate-tool.ts` | 导航工具（4 个动作） |
| `web/tools/page-info-tool.ts` | 页面信息工具（含 snapshot / focused_snapshot） |
| `web/tools/wait-tool.ts` | 等待工具（5 个动作） |
| `web/tools/evaluate-tool.ts` | JS 执行工具（2 个动作） |
| `web/helpers/base/resolve-selector.ts` | 选择器解析（#hashID → RefStore / CSS） |
| `web/helpers/base/active-store.ts` | 全局 RefStore 持有者 |
| `web/helpers/base/index.ts` | Barrel re-export |

---

## EngineContext 状态变量速查（~50 个）

### 不可变配置
`client` / `registry` / `tools` / `systemPrompt` / `message` / `initialSnapshot` / `history` / `dryRun` / `maxRounds` / `assertionConfig` / `callbacks` / `effectiveRoundStabilityWait`

### 输出累积
`allToolCalls[]` / `fullToolTrace[]` / `finalReply` / `stopReason` / `lastAssertionResult` / `inputTokens` / `outputTokens` / `usedRounds` / `recoveryCount` / `redundantInterceptCount` / `snapshotReadCount` / `snapshotSizeTotal` / `snapshotSizeMax`

### 页面状态
`pageContext { latestSnapshot, currentUrl }` / `actionRecoveryAttempts: Map` / `snapshotExpandRefIds: Set` / `previousRoundSnapshot`

### 聚焦模式
`microTaskBaseSnapshot` / `focusTargetRef` / `focusedMode` / `focusedSnapshot` / `baseDiff`

### 断言快照
`assertionSnapshot`

### 任务进度
`remainingInstruction` / `previousRoundTasks[]` / `previousRoundPlannedTasks[]` / `previousRoundModelOutput` / `taskItems: TaskItem[] | null` / `protocolViolationHint`

### 保护计数器
`consecutiveReadOnlyRounds` / `consecutiveNoProtocolRounds` / `consecutiveSamePlannedBatch` / `lastPlannedBatchKey` / `lastRoundHadError` / `consecutiveAssertOnlyFailedRounds` / `consecutiveNoProgressRounds` / `previousRoundRemaining` / `ineffectiveClickSelectors: Set` / `recentRoundClickTargets: string[][]` / `pendingNotFoundRetry?`
