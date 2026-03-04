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
- `snapshot.ts`
  - 读取/包裹/去重/剥离快照
- `recovery.ts`
  - 冗余拦截、恢复、空转检测
- `helpers.ts`
  - 协议解析、任务规整、断轮规则等纯函数

---

## 3. 运行主流程（按轮次）

每轮固定执行以下阶段：

### 阶段 A：确保快照

- 若当前无快照，调用 `readPageSnapshot()` 读取
- 记录快照统计（读取次数、长度）

### 阶段 B：构建消息

- 先剥离 system prompt 里的历史快照（避免重复注入）
- 使用 `buildCompactMessages()` 构建本轮上下文
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
  1) 冗余 `page_info.*` 拦截
  2) 快照防抖
  3) 元素未找到恢复
  4) 导航后快照刷新
  5) 必要时断轮（例如 `navigate.*`、`evaluate`、`dom.press Enter`）

### 阶段 E：推进 remaining

- 优先使用 REMAINING 协议输出
- 协议缺失时启发式剔除已执行步骤
- 更新“上一轮执行/计划/模型输出摘要”上下文

### 阶段 F：空转检查 + 刷新快照

- 连续只读轮次触发停机（防空转）
- 刷新快照进入下一轮

---

## 4. 协议与关键状态

### 4.1 REMAINING 协议

- `REMAINING: <text>`：仍有剩余任务
- `REMAINING: DONE`：当前任务已消费完成

### 4.2 协议缺失回退

- 本轮有执行动作：启发式推进 remaining
- 本轮无推进：保持 remaining，不盲目前进

### 4.3 关键状态变量

- `remainingInstruction`：当前剩余任务文本
- `previousRoundTasks`：上一轮已执行任务数组
- `previousRoundPlannedTasks`：上一轮模型计划数组
- `previousRoundModelOutput`：上一轮模型输出摘要
- `protocolViolationHint`：协议修复提示
- `pendingNotFoundRetry`：元素未找到重试上下文

---

## 5. 保护机制

### 5.1 冗余拦截

- 拦截循环内无意义 `page_info.*`，防止“只看不做”

### 5.2 快照防抖

- 连续 `page_info.snapshot` 标记冗余，提醒继续执行动作

### 5.3 元素恢复

- `ELEMENT_NOT_FOUND` 时自动等待 + 刷新快照 + 限次重试

### 5.4 导航刷新

- 导航成功后立即刷新快照，避免旧上下文决策

### 5.5 空转检测

- 连续纯只读轮次停机

### 5.6 重复批次防自转

- 连续返回相同任务批次且无错误时提前停机

---

## 6. 停机条件

命中任一条件即停止：

1) remaining 收敛（`REMAINING: DONE` 或为空）
2) 协议修复后仍无推进
3) 连续只读（空转）
4) 连续重复计划批次（自转）
5) 达到 `maxRounds`

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
