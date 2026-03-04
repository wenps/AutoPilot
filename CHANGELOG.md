# Changelog

## 0.0.25

### 新增

- 在 Agent Loop 中引入“轮次级操作稳定性屏障”：
  - 使用 `wait.wait_for_selector(state=hidden)` 等待 loading 指示器消失
  - 使用 `wait.wait_for_stable` 等待 DOM 进入静默窗口
- 在 core/web 对外 API 中新增 `RoundStabilityWaitOptions`，用于配置轮次后稳定性等待行为。
- 新增回归测试覆盖：
  - 同一轮多个潜在变更动作只触发一次稳定性屏障
  - `loadingSelectors` 合并语义（默认 + 自定义，且去重）

### 变更

- 在保持既有循环语义不变的前提下，下调默认等待参数以降低端到端任务耗时。
- `core/agent-loop` 默认值调整：
  - `DEFAULT_NOT_FOUND_RETRY_WAIT_MS`: `2000 -> 1000`
  - `DEFAULT_ROUND_STABILITY_WAIT_TIMEOUT_MS`: `8000 -> 4000`
  - `DEFAULT_ROUND_STABILITY_WAIT_QUIET_MS`: `300 -> 200`
  - `DEFAULT_ROUND_STABILITY_WAIT_LOADING_SELECTORS` 扩充为覆盖 AntD / Element Plus / BK / TDesign 及通用 loading 状态
- `web/tools` 默认值调整：
  - `dom-tool` 的 `DEFAULT_WAIT_MS`: `2000 -> 1200`
  - `wait-tool` 的 `DEFAULT_TIMEOUT`: `10000 -> 6000`
- `roundStabilityWait.loadingSelectors` 调整为“与默认列表合并（追加 + 去重）”，不再覆盖默认选择器。

### 文档

- 已同步以下文档中的机制与默认参数说明：
  - `README.md`
  - `AGENTS.md`
  - `src/core/agent-loop/LOOP_MECHANISM.md`
  - `TODO.md`

### 移除

- 删除体积过大的研究文档：`docs/PLAYWRIGHT_DOM_RESEARCH.md`。
