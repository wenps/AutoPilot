# 断言模块设计文档

## 模块职责

断言模块是 AI 驱动的任务完成验证引擎。核心能力：

1. **微任务断言** — MT 完成后，基于 MT 前后快照 + 执行操作评估该 MT 的断言
2. **系统断言** — 全部 MT 完成后，基于全局初始/最终快照 + 完整执行记录链评估整体断言
3. **异步流水线** — MT 完成后断言异步执行，下一个 MT 立即启动不等断言结果

## 文件结构

```
assertion/
├── index.ts      # 断言引擎入口
├── levels.ts     # 分级断言请求构建器
├── prompt.ts     # 断言专用 prompt
├── types.ts      # 类型定义
└── DESIGN.md     # 本文档
```

## 核心类型

### AssertionLevel
`"micro-task" | "system"` — 区分微任务级和系统级断言。

### AssertionRequest
统一输入格式，包含：
- `level` — 断言级别
- `taskAssertions` — 任务断言列表
- `currentSnapshot` — 当前快照
- `initialSnapshot` — 初始快照（可选）
- `postActionSnapshot` — 动作后瞬态快照（可选，微任务级）
- `executedActions` — 操作摘要（微任务级）
- `executionEvidence` — 执行记录链证据（系统级）

### PendingAssertion
异步断言句柄，包含 `promise`、`resolved`、`result` 字段，用于流水线追踪。

## 公共 API

### 底层（向后兼容）
- `evaluateAssertions(client, snapshot, executedActions, taskAssertions, initialSnapshot?, postActionSnapshot?)` — 原始同步入口

### 统一入口
- `evaluate(client, request)` — 接受 `AssertionRequest`，按 `level` 分发到微任务或系统断言

### 异步流水线
- `evaluateAsync(client, request, microTaskId)` — 立即发起断言，返回 `PendingAssertion`，不阻塞
- `awaitAllAssertions(pendings)` — 批量等待所有 pending 断言完成

### 请求构建器（levels.ts）
- `buildMicroTaskAssertionRequest(params)` — 构建微任务级断言请求
- `buildSystemAssertionRequest(params)` — 构建系统级断言请求

## 异步流水线设计

```
MT-1 完成 → evaluateAsync(MT-1) → 拿到 pending1 → MT-2 立即开始
MT-2 完成 → evaluateAsync(MT-2) → 拿到 pending2
             同时 pending1.promise resolve → 检查结果
             PASS → 继续
             FAIL → 阻塞，重新执行 MT-1
```

`evaluateAsync()` 本质是立即调用 `evaluate()` 但不 await，将 Promise 包装为 `PendingAssertion` 返回。

**流水线调度不在本模块** — "MT-1 失败则重试" 等策略是编排层逻辑（`micro-task/task-monitor.ts` 的职责），断言模块只提供 `evaluateAsync()` 和 `awaitAllAssertions()`。

## Prompt 策略

### 微任务级
使用 `buildAssertionUserMessage()`：
- Initial Snapshot（MT 开始前）
- Post-Action Snapshot（最后一个动作后瞬态）
- Current Snapshot（稳定状态）
- Executed Actions（操作列表）
- Task Assertions

### 系统级
使用 `buildSystemAssertionUserMessage()`：
- Initial Snapshot（全局初始）
- Current Snapshot（全局最终）
- Execution Evidence（完整执行记录链摘要）
- Task Assertions
