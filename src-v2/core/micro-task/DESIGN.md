# micro-task 模块设计文档

## 概述

micro-task 模块提供微任务执行的核心数据结构层，包括任务描述、执行记录链、TaskMonitor 编排器。由 main-agent 调度，通过回调模式解耦 engine 依赖。

## 核心类型

### MicroTaskDescriptor

Main Agent 分派微任务的输入，包含 id、task 描述、可选断言列表和最大轮次。

### MicroTaskResult

微任务执行结果，包含原始 descriptor、成功标志、executionRecord、运行指标、最终快照和可选失败原因。

### ExecutionRecordChain

执行记录链接口，管理微任务执行记录的有序集合：

- `records` — 只读记录数组
- `append(record)` — 追加记录
- `buildPreviousContext()` — 格式化为下一个微任务的上下文（精简版）
- `buildEvidenceSummary()` — 格式化为系统断言的证据（完整版）

### MicroTaskExecuteFn

执行回调类型，接受 `(descriptor, previousContext)` 返回 `Promise<MicroTaskResult>`。

## 关键设计决策

### TaskMonitor 不直接依赖 Engine

`execute()` 接受 `executeFn` 回调而非持有 engine 实例：

- micro-task 模块不依赖尚未实现的 engine 模块
- 测试时用 mock executeFn
- engine 实现后在调用侧组装

### MicroTaskExecutionRecord 复用 assertion/types.ts

不重复定义，直接 import + re-export，保持单一数据源。

## 格式化规则

### buildPreviousContext()

- 空链: `(no prior micro-tasks)`
- 成功: `✅ {task}: {completedSubGoals.join(", ")}`
- 失败: `✗ {task} (failed): {summary}`

### buildEvidenceSummary()

- 空链: `(no execution records)`
- 每条记录包含: 编号、task、status、completedSubGoals、actions、assertionResult 详情

## 模块依赖

```
micro-task/types.ts
  ← assertion/types.ts (MicroTaskExecutionRecord, TaskAssertion, AssertionResult)
  ← shared/types.ts (AgentLoopMetrics)

micro-task/record.ts
  ← assertion/types.ts
  ← micro-task/types.ts

micro-task/task-monitor.ts
  ← micro-task/types.ts
  ← micro-task/record.ts
```
