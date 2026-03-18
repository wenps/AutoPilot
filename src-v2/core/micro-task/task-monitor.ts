/**
 * TaskMonitor — 管理执行记录链 + 编排微任务执行。
 *
 * 通过 executeFn 回调解耦 engine 依赖：
 * - micro-task 模块不依赖尚未实现的 engine 模块
 * - 测试时使用 mock executeFn
 * - engine 实现后在调用侧组装
 */
import type {
  MicroTaskDescriptor,
  MicroTaskResult,
  MicroTaskExecuteFn,
  ExecutionRecordChain,
} from "./types.js";
import { createExecutionRecordChain } from "./record.js";

export class TaskMonitor {
  private _recordChain: ExecutionRecordChain;

  constructor() {
    this._recordChain = createExecutionRecordChain();
  }

  /** 当前执行记录链 */
  get recordChain(): ExecutionRecordChain {
    return this._recordChain;
  }

  /**
   * 执行一个微任务。
   *
   * 1. 从 recordChain 获取 previousContext
   * 2. 调用 executeFn(descriptor, previousContext)
   * 3. 将 result.executionRecord 追加到 recordChain
   * 4. 返回 result
   */
  async execute(
    descriptor: MicroTaskDescriptor,
    executeFn: MicroTaskExecuteFn,
  ): Promise<MicroTaskResult> {
    const previousContext = this._recordChain.buildPreviousContext();
    const result = await executeFn(descriptor, previousContext);
    this._recordChain.append(result.executionRecord);
    return result;
  }

  /** 重置记录链（清空所有执行记录） */
  reset(): void {
    this._recordChain = createExecutionRecordChain();
  }
}
