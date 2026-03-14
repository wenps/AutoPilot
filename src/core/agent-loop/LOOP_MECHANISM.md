# Agent Loop 机制说明

> 本文是 `src/core/agent-loop` 的权威流程说明，描述当前实现“如何决策、如何执行、何时停机”。
> 目标是让维护者在不通读全部代码的前提下，快速理解循环行为与关键约束。

---

## 1. 一句话概述

Agent Loop 是一个“快照驱动的增量执行循环”：

1) 基于最新快照构建上下文
2) 让模型生成工具调用
3) 执行工具并应用恢复/防护
4) 更新 remaining 与快照
5) 重复直到收敛或触发停机条件

---

## 2. 模块分工

- `index.ts`
  - 主循环编排
  - 停机判定
  - 指标汇总
- `messages.ts`
  - Round 0 / Round 1+ 消息构建
  - REMAINING 协议上下文注入
- `snapshot/`
  - `lifecycle.ts`：读取/包裹/去重/剥离快照
  - `engine.ts`：DOM 快照序列化实现
  - `index.ts`：snapshot 子模块聚合导出
- `snapshot.ts`
  - 兼容转发层（re-export -> `snapshot/lifecycle.ts`）
- `recovery/`
  - `index.ts`：恢复、导航刷新、空转检测、无效点击拦截
- `recovery.ts`
  - 兼容转发层（re-export -> `recovery/index.ts`）
- `helpers.ts`
  - 协议解析、任务规整、断轮规则等纯函数

---

## 3. 运行主流程（按轮次）

每轮固定执行以下阶段：

### 阶段 A：确保快照

- 若当前无快照，调用 `readPageSnapshot()` 读取
- 记录快照统计（读取次数、长度）
- 计算快照指纹（用于轮结束时变化检测）
- Round 1+：对比前一轮保存的快照，计算 `snapshotDiff`（hashID 归一化后逐行对比）

### 阶段 B：构建消息

- 先剥离 system prompt 里的历史快照（避免重复注入）
- 使用 `buildCompactMessages()` 构建本轮上下文
  - Round 0：原始任务 + 快照 + 关键行为强化（批量执行、禁 page_info、DOM 断轮、Effect check）
  - Round 1+：remaining + done steps + 关键强化 + previous executed + effect hint + snapshot changes diff + snapshot
  - 不再重复 system prompt 中已有的规则，仅补强模型易违反的关键条
  - 若 snapshotDiff 非空，在快照前注入 `## Snapshot Changes (since last round)` 区块
- 若处于“元素未找到重试流”，额外注入 retry context

### 阶段 C：调用模型并解析协议

- `client.chat(...)` 获取 `text + toolCalls`
- 解析：
  - `REMAINING: ...` / `REMAINING: DONE`
  - `SNAPSHOT_HINT: EXPAND_CHILDREN #ref...`

### 阶段 D：分支处理

#### 分支 D1：无 toolCalls

- 若在 not-found 重试流中：
  - 判断是否仍“找不到”
  - 未超上限则等待后刷新快照并继续
- 否则进入收敛/协议修复判定：
  - remaining 未完成且无动作 -> 注入 protocol violation hint，下一轮修复
  - 否则结束

#### 分支 D2：有 toolCalls

- 先做重复批次检测（防自转）
- `dryRun` 模式直接输出计划，不执行工具
- 正常模式逐个执行工具，并串联保护机制：
  1) 重复无效点击拦截
  2) 元素未找到恢复
  3) 导航后快照刷新
  4) 必要时断轮（例如 `navigate.*`、`evaluate`、`dom.press Enter`）

### 阶段 E：推进 remaining

- 优先使用 REMAINING 协议输出
- 协议缺失时启发式剔除已执行步骤
- 更新“上一轮执行/计划/模型输出摘要”上下文

### 阶段 F：空转检查 + 刷新快照

- 连续只读轮次触发停机（防空转）
- 若本轮存在潜在 DOM 变化动作，先执行“轮次后稳定等待”：
  - 等待 loading 指示器隐藏（可配置选择器，默认覆盖 AntD / Element Plus / BK / TDesign（TD）/ aria-busy / skeleton）
  - 等待 DOM quiet window（默认 200ms）
  - 总超时默认 4000ms，超时后不阻塞收敛
- 刷新快照进入下一轮

---

## 4. 协议与关键状态

### 4.1 REMAINING 协议

- `REMAINING: <text>`：仍有剩余任务
- `REMAINING: DONE`：当前任务已消费完成

### 4.2 协议缺失回退

- 本轮有执行动作：启发式推进 remaining
- 本轮无推进：保持 remaining，不盲目前进

### 4.3 协议缺失容忍

- 当启发式无法继续缩减 remaining 且模型未输出 REMAINING 时，进入"协议缺失计数"。
- **仅在本轮工具全部失败或无确定性推进动作时才累计计数**（确定性推进：fill/type/press/navigate/自定义工具；click 不算）。
- **快照指纹兜底**：协议缺失停机检查移至每轮快照刷新 + 指纹对比之后。若本轮 click 导致快照指纹变化（页面确实切换），重置计数器为 0。仅当连续多轮操作均无页面变化且无协议时，才触发停机。
- 目的：兼容不遵循 REMAINING 协议的模型（如 MiniMax / DeepSeek），避免多步 UI 导航场景（搜索→点击仓库→切换 Tab→创建）因连续 click 轮次被误判为空转而过早终止。

### 4.4 关键状态变量

- `remainingInstruction`：当前剩余任务文本
- `previousRoundTasks`：上一轮已执行任务数组
- `previousRoundPlannedTasks`：上一轮模型计划数组
- `previousRoundModelOutput`：上一轮模型输出摘要
- `previousRoundSnapshot`：上一轮快照文本（用于计算 snapshotDiff）
- `protocolViolationHint`：协议修复提示
- `pendingNotFoundRetry`：元素未找到重试上下文

---

## 5. 保护机制

### 5.1 元素恢复

- `ELEMENT_NOT_FOUND` 时自动等待 + 刷新快照 + 限次重试

### 5.2 导航刷新

- 导航成功后立即刷新快照，避免旧上下文决策

### 5.3 空转检测

- 连续纯只读轮次停机

### 5.4 重复批次防自转

- 连续返回相同任务批次且无错误时提前停机

### 5.5 无效点击拦截与循环检测

- 快照指纹未变时，将本轮 click selector 加入 `ineffectiveClickSelectors`，下一轮再次点击直接拦截。
- 快照变化时，仅移除本轮点击的 selector（可能是它们引发了变化），保留其他轮次标记的无效 selector。
  - 设计目的：防止模型在两个目标间交替点击时，其中一个引发轻微快照变化（如焦点样式）导致另一个被错误解锁。
  - 旧页面的 hashID 不会出现在新页面快照中，因此保留不会误拦。
- 交替循环检测：维护近 6 轮 click 目标滑动窗口；若最近 4 轮内唯一目标 ≤ 2 个且总点击 ≥ 4 次，判定为循环：
  - 注入 "Click target cycling detected" 提示
  - 将所有循环目标加入 ineffectiveClickSelectors 强制换目标
  - 清空窗口重新开始跟踪
- **附近可点击元素推荐（新增）**：当点击被拦截或证实无效时，使用 `findNearbyClickTargets()` 从快照中查找指定 selector 上下 15 行范围内带点击信号的元素，按距离排序后以 `#hashID (brief)` 格式注入提示。
  - 触发场景：“Snapshot unchanged” 提示 / `INEFFECTIVE_CLICK_BLOCKED` 拦截响应 / 交替循环检测提示
  - 设计目的：给模型具体的替代 hashID 而非泛泛建议，避免反复盲猜

### 5.6 操作稳定性（轮次后双重等待）

- 触发条件：本轮出现潜在 DOM 变化动作（例如 `dom.click/fill/select_option/scroll/press`、`navigate.*`、`evaluate`）且动作无错误。
- 执行顺序固定：
  1. `wait.wait_for_selector(state=hidden)` 等待 loading 指示器消失
  2. `wait.wait_for_stable` 等待 DOM 进入 quiet window
- 默认参数：`timeoutMs=4000`、`quietMs=200`。
- 选择器语义：`roundStabilityWait.loadingSelectors` 与默认列表合并去重，不覆盖默认值。
- 设计目的：在保证收敛性的同时，减少“页面尚未稳定即继续操作”导致的误点与空转。
### 5.7 快照变化摘要（Snapshot Diff）

- 每轮阶段 A 保存当前快照文本到 `previousRoundSnapshot`。
- Round 1+：通过 `computeSnapshotDiff(previousRoundSnapshot, currentSnapshot)` 计算变化摘要。
  - hashID 归一化（`#abc123` → `#_`），消除 DOM 重渲染噪音。
  - 逐行对比，输出 `- removed` / `+ added` 格式，最多 20 行。
- diff 非空时，在快照前注入 `## Snapshot Changes (since last round)` 区块。
- 与指纹检测互补：指纹只判断"变没变"，diff 告诉 AI "变了什么"。
- 典型场景：开关 toggle 后 `checked` / `is-checked` 消失、颜色选择器 `bg` 变化、表单值更新等微小状态变化。
---

## 6. 停机条件与 stopReason

命中任一条件即停止，同时在 `metrics.stopReason` 中记录精确的停机原因枚举值：

| 停机条件 | stopReason 枚举值 |
| --- | --- |
| remaining 收敛（`REMAINING: DONE` 或为空） | `converged` |
| 连续相同工具调用批次 ≥ 3 轮（防自转） | `repeated_batch` |
| 连续只读轮次（空转） | `idle_loop` |
| 连续多轮有工具调用但无 REMAINING 协议且无有效推进 | `no_protocol` |
| 协议修复轮失败（无工具调用 + remaining 未收敛） | `protocol_fix_failed` |
| 达到 `maxRounds` | `max_rounds` |
| dry-run 模式 | `dry_run` |

---

## 7. 输出结果与指标

`executeAgentLoop()` 最终返回：

- `reply`：最终文本回复
- `toolCalls`：完整工具调用记录
- `messages`：可复用消息（供 memory）
- `metrics`：
  - 轮次、总调用、成功/失败、成功率
  - 恢复次数、拦截次数
  - 快照读取次数与体积统计
  - token 输入/输出统计
  - `stopReason`：停机原因枚举（`converged` / `repeated_batch` / `idle_loop` / `no_protocol` / `protocol_fix_failed` / `max_rounds` / `dry_run`）

---

## 8. 变更约束（维护者必读）

凡是修改以下任一行为，必须同步更新本文：

- 轮次流程阶段顺序
- REMAINING 协议与回退规则
- 任何停机条件
- recovery/防护机制触发条件与返回码
- metrics 字段语义

建议同时同步：

- `AGENTS.md`（项目级规则）
- `README.md`（外部可见机制说明）
