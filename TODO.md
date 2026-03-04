# AutoPilot TODO

> **产品定位**：面向 B 端大型系统的 **AI TestAgent Runtime** —— 不是 Copilot，是可验证、可交付的自动化执行引擎。
>
> **两大核心场景**：
> 1. 为 B 端系统提供可靠的 AI 自动化执行能力（操作复杂表单、弹窗、表格等）
> 2. 前端通过配置 tools 构建 AI 自动化流程，附带任务验证 + 截图取证

---

## 方向导向（基于对比结论，后续可继续优化）

> 保留“要优先做什么”的导向，不展开竞品细节。

1. **验证闭环优先**：assert + screenshot，先把“可验证、可交付”做实。
2. **操作成功率优先**：弹窗聚焦、加载等待、表单语义、DOM 稳定等待。
3. **可观测可复现优先**：trace、失败回放包、指标对外暴露。
4. **协议可靠性优先**：REMAINING 状态机、防空转、防自转、明确停机原因。

---

## 第一梯队 · 立即做 — 决定产品能不能用

> 这些不做，B 端场景跑不通、验证闭环建不起来。

### 0. 任务模式（隐藏 iframe 后台执行）

> **为什么高优先**：让自动化从“前台演示”升级为“可后台执行的任务系统”，支持用户边操作边跑任务。

- [ ] **新增 `taskMode` 开关**（默认关闭）
	- [ ] 开启后创建隐藏 iframe（`display:none` 或不可见容器），用于后台执行 Agent Loop
	- [ ] iframe 页面与当前页面保持同源同路由（初始化 URL 与主页面一致）
- [ ] **任务上下文同步到 iframe**
	- [ ] 将当前任务文本、对话历史、首轮快照通过 postMessage 发送给 iframe
	- [ ] iframe 内独立运行 ToolRegistry + AgentLoop，不污染父页面执行状态
- [ ] **单任务并发约束**（必须）
	- [ ] 同一时刻仅允许 1 个任务运行（`idle -> running -> done/failed/cancelled`）
	- [ ] 重复提交时返回 `TASK_ALREADY_RUNNING`，并附带当前任务 id
- [ ] **结果回传与状态同步**
	- [ ] iframe 通过 postMessage 回传 `{ taskId, status, summary, result, metrics }`
	- [ ] 父页面暴露 `onTaskUpdate / onTaskDone / onTaskError` 回调
	- [ ] 任务完成后自动销毁 iframe（或进入可配置复用池）
- [ ] **可靠性与安全边界**
	- [ ] iframe 心跳与超时（如 5 分钟无进展自动失败）
	- [ ] 父子通信 channel 隔离（带 sessionId，防止串消息）
	- [ ] 仅允许同源页面启用 taskMode，跨域直接拒绝
- [ ] 验收：用户在主页面继续操作时，后台任务可独立跑完并把最终结果与摘要同步回父页面

### 1. 任务验证框架（全新 · 最高优先）

> **为什么最重要**：没有验证 = 只是"演示工具"，有验证 = "可交付的自动化平台"。
> 这是产品从演示到可交付的关键能力。

- [ ] **新增 `assert` 工具** — 注册到 ToolRegistry，AI 可主动调用
	- [ ] `assert.visible(selector)` — 断言元素可见
	- [ ] `assert.text(selector, expected)` — 断言元素文本匹配（精确/包含/正则）
	- [ ] `assert.value(selector, expected)` — 断言 input/select 当前值
	- [ ] `assert.url(pattern)` — 断言当前 URL 匹配
	- [ ] `assert.title(pattern)` — 断言页面标题匹配
	- [ ] `assert.element_count(selector, count)` — 断言匹配元素数量
	- [ ] `assert.checked(selector, expected?)` — 断言 checkbox/radio 状态
	- [ ] 每个 action 返回 `{ passed: boolean, actual, expected, screenshot? }`
- [ ] **断言失败自动截图** — assert 不通过时自动触发截图，附带到结果中
- [ ] **AgentLoopResult 扩展验证摘要**
	- [ ] 新增 `result.assertions: { total, passed, failed, details[] }`
	- [ ] 新增 `result.status: 'passed' | 'failed' | 'partial' | 'error'`
	- [ ] 每条 detail 含 `{ step, action, passed, actual, expected, screenshotUrl? }`
- [ ] 验收：用户配置一段"填表单 - 提交 - 断言成功提示"任务，结果自动输出 pass/fail + 截图

### 2. 页面截图能力（从 P2 提升）

> **为什么提升**：截图是验证框架的基础设施，也是 B 端测试交付物的核心需求。

- [ ] **新增 `screenshot` 工具** — 基于 `html2canvas`（纯浏览器，无需后端）
	- [ ] `screenshot.capture()` — 全页/可视区域截图，返回 base64 或 Blob URL
	- [ ] `screenshot.element(selector)` — 指定元素截图
	- [ ] `screenshot.annotate(selector[])` — 在截图上叠加红框标注指定元素
- [ ] **截图与回调集成**
	- [ ] `callbacks.onScreenshot?: (data: { base64, trigger, timestamp }) => void`
	- [ ] 支持 assert 失败自动截图、任务完成自动截图、手动调用截图三种触发方式
- [ ] **截图存储策略**
	- [ ] 内存保留最近 N 张（默认 10），避免内存膨胀
	- [ ] 结果中以 `screenshotUrl`（Blob URL）返回，由调用方决定是否上传/持久化
- [ ] 验收：任务结束后 `result.screenshots[]` 中包含至少 1 张截图，可在浏览器直接预览

### 3. B 端弹窗/抽屉自动聚焦（从 P1 提升）

> **为什么提升**：B 端 80% 的交互发生在弹窗/抽屉中，这是首要失败场景。

- [ ] **弹窗检测** — 检测 z-index 最高且可见的 modal/drawer/dialog 容器
	- [ ] 支持 `[role="dialog"]`、`.ant-modal`、`.el-dialog`、`.el-drawer` 等常见选择器
	- [ ] 支持用户通过 `snapshotOptions.modalSelectors` 配置自定义弹窗选择器
- [ ] **自动聚焦快照** — 弹窗存在时，快照自动切换为只采集弹窗内子树 + 遮罩标记
- [ ] **弹窗出现/消失检测** — 工具执行后检测弹窗状态变化，自动重新快照
- [ ] 验收：打开弹窗 - AI 直接在弹窗内操作 - 无需额外"看全页面"轮次

### 4. B 端加载态感知（从 P1 提升）

> **为什么提升**：B 端页面异步加载极其频繁，不等加载完就操作 = 必然失败。

- [ ] **加载态自动等待** — 每次工具执行前/后自动检测
	- [ ] 支持 `.ant-spin`、`.el-loading`、`[aria-busy="true"]`、`.skeleton`、`.loading`
	- [ ] 支持用户通过 `snapshotOptions.loadingSelectors` 配置自定义加载指示器
	- [ ] 超时上限（默认 8s），防止页面持续 loading 时无限卡住
- [ ] **网络空闲检测** — Hook fetch / XMLHttpRequest，追踪 pending 请求数
	- [ ] 新增 `wait.wait_for_network_idle` action
	- [ ] 默认等待 pending 归零后 300ms 稳定期
- [ ] 验收：加载中不操作，加载完成后自动继续

### 5. B 端表单语义增强（从 P1 提升）

> **为什么提升**：B 端核心场景就是表单，AI 看不懂 label-input 关系 = 填错位置。

- [ ] **label-input 关联** — 识别 form 或 role="form" 边界
	- [ ] 通过 for/id、aria-labelledby、DOM 邻近关系自动关联 label 和 input
	- [ ] 快照中输出 `input#ref label="用户名"` 而非裸 `input#ref`
- [ ] **表单组件语义** — 识别 B 端常见组件库语义
	- [ ] el-form-item / ant-form-item 提取 label 属性关联到内部 input
	- [ ] el-select / ant-select 标注完整选项列表或当前值
- [ ] 验收：AI 能正确理解"在用户名字段输入xxx"并定位到正确 input

### 6. 收敛协议产品化

> 现有 REMAINING 协议需要固化为可靠的状态机，否则复杂任务必定跑散。

- [ ] 固化 REMAINING 状态机：ACTIVE / DONE / VIOLATION_REPAIR
- [ ] 明确停机优先级：完成 > 无进展 > 重复批次 > 超预算
- [ ] 输出结构化终止原因 `finishReason`
- [ ] `maxNoProgressRounds`（默认 2），连续无推进立即收敛
- [ ] 协议修复回合上限：remaining 未完成 + 无工具调用 最多修复 1 次
- [ ] 验收：100 个标准任务中"无限轮次" = 0

### 7. 快照可执行性

> 大型 B 端页面快照可能超 token 预算且许多节点不可执行。

- [ ] **Token 预算控制** — `maxTokenEstimate` 参数，达预算后输出 `(更多元素已省略...)`
- [ ] 强化 omitted children 定向展开（提示词 + 运行时双通道，已部分实现）
- [ ] 弹窗/抽屉/虚拟列表建立快照策略白名单（与第 3 条联动）
- [ ] 验收：500+ 节点页面在 token 预算内且关键交互元素完整

---

## 第二梯队 · 短期做 — 决定产品好不好用

> 第一梯队完成后马上做，提升 B 端场景稳定性和开发体验。

### 8. 可观测与可复现

> 不可复现 = 不可信任，B 端客户不接受"有时能用有时不能"。

- [ ] 统一每轮 trace：输入快照摘要（前 200 字符）、模型决策、工具结果、停机原因
- [ ] `result.trace` 对外暴露完整轨迹
- [ ] 提供失败回放包导出（可脱敏的 JSON 包含轨迹 + 快照 + 截图引用）
- [ ] 建立 3 个 benchmark 基线场景：登录表单、弹窗选择、后台批量操作
- [ ] 验收：任一失败任务 10 分钟内可复盘定位

### 9. 防空转与防自旋加固

> 在已有机制基础上补充更细粒度控制。

- [ ] 重复计划判定加入 remaining 文本变化量
- [ ] 轮次内只读动作预算（page_info/query/get_text/get_attr 每轮不超过 2 次）
- [ ] 无实质推进熔断后输出"建议下一步"到 finishReason 附加信息
- [ ] 新增轮次级指标：avgRoundLatency、noProgressRoundCount
- [ ] 验收：平均轮次下降 30%+

### 10. 动作后恢复闭环加固

> 在已有重试机制基础上落实可配置预算。

- [ ] 对 click/press/scroll/navigate/evaluate 强制重采样检查点（部分已实现）
- [ ] 提供可配置重试预算：`retryBudget: { perAction: 3, perTask: 5 }`
- [ ] 元素失效恢复归一化：失败聚合 - 快照刷新 - attempt 约束 - 超限退出
- [ ] 验收：元素失效导致的整任务失败率下降 40%+

### 11. 快照分区 + 深度自适应

- [ ] **分区快照** — `focusSelector` 参数，只快照指定子树
- [ ] **深度自适应** — 稀疏区域自动深入、密集区域提前截断
- [ ] 验收：指定 focusSelector 后快照体积下降 50%+

### 12. DOM 稳定等待

- [ ] 执行操作前使用 debounced MutationObserver 等待 DOM 无变化（默认 300ms）
- [ ] 与加载态检测联动：loading 消失 + DOM 稳定后才执行下一步
- [ ] 验收：动态渲染页面操作成功率提升

### 13. 上下文窗口化压缩

- [ ] memory 开启时仅保留最近 N 轮关键摘要（任务 + 结果 + remaining）
- [ ] 早期轮次自动压缩为单条摘要消息
- [ ] 验收：50 轮对话后 token 消耗不线性增长

### 13A. 对话流与执行流隔离（新增 · 高优先）

> 目标：聊天列表只展示真实人机对话，任务执行细节不污染会话体验。

- [ ] **双通道消息模型**
	- [ ] `chatMessages`：仅保留 user/assistant 可读对话
	- [ ] `executionMessages`：存放 tool calls、快照注入、recovery 提示、trace 事件
- [ ] **memory 模式只记忆真实对话**
	- [ ] memory 开启时仅将 `chatMessages` 回灌到下一轮 AI 输入
	- [ ] `executionMessages` 不进入用户可见聊天列表，不参与常规会话记忆
- [ ] **可观测不丢失**
	- [ ] 执行细节继续保留在 `result.trace` / 调试面板中，支持排障
	- [ ] 提供 `includeExecutionInChat?: boolean` 调试开关（默认 false）
- [ ] 验收：连续高频任务执行后，UI 对话列表仍保持简洁，且 memory 语义仅反映真实人机对话

---

## 第三梯队 · 中期做 — 持续增强产品能力

> 做完前两梯队后，这些功能让你从"能用"变成"最好用"。

### 14. 视觉增强：Set-of-Mark 标注

- [ ] 截图时在交互元素上叠加数字/颜色标签
- [ ] 生成编号到ref路径映射表，供多模态模型使用
- [ ] 可用于：调试界面、任务报告截图、客户演示

### 15. B 端表格结构化摘要

- [ ] 识别 table / role="grid" / .el-table / .ant-table
- [ ] 输出行列摘要（表头 + 当前页前 N 行 + 总行数）而非逐行展开
- [ ] 支持表格内操作（行内编辑、行内按钮点击）的 ref 关联
- [ ] 验收：100 行表格的快照 token 下降 70%+

### 16. Shadow DOM 穿透

- [ ] 遍历时检测 el.shadowRoot，进入 shadow tree
- [ ] ref 路径标记 /#shadow，resolveRef() 同步更新
- [ ] 验收：使用 Web Components 的 B 端组件可正常操作

### 17. 操作录制与回放

- [ ] **录制模式** — 监听 click/input/change/submit，记录操作序列
- [ ] **回放引擎** — 读取录制序列执行；ref 失效时调用 AI 智能修复
- [ ] **模板导入导出** — JSON 格式序列，跨环境复用
- [ ] 与验证框架联动：回放时可插入 assert 步骤

### 18. iframe 穿透（同源）

- [ ] 检测 IFRAME，尝试 contentDocument 访问
- [ ] ref 路径标记 /#iframe，快照包含 iframe 内子树
- [ ] 验收：同源 iframe 内元素可正常操作

### 19. 差量快照注入

- [ ] 注入"本轮变化节点"而非整页重复快照
- [ ] 对无变化区域仅注入 (unchanged) 标记
- [ ] 验收：连续轮次间快照 token 下降 40%+

---

## 已完成

- [x] **快照：视口裁剪** — viewportOnly 跳过不可见区域
- [x] **快照：智能剪枝** — pruneLayout 折叠纯布局容器
- [x] **快照：base64/data URL 截断** — 防止快照因图片数据膨胀
- [x] **DOM：scroll action** — 支持 deltaX/deltaY/steps 滚动
- [x] **快照：children 定向展开** — SNAPSHOT_HINT + dom.scroll 自动触发
- [x] **Prompt/Tool 管理 API** — key-value prompt 注册 + 工具增删查
- [x] **Demo 依赖隔离** — Vue3 demo 独立子包
