/**
 * ExecutionRecordChain 实现 — 管理微任务执行记录的有序集合。
 *
 * 提供两种格式化输出：
 * - buildPreviousContext(): 精简版，用于下一个微任务的上下文
 * - buildEvidenceSummary(): 完整版，用于系统级断言的证据
 */
import type { MicroTaskExecutionRecord } from "../assertion/types.js";
import type { ExecutionRecordChain } from "./types.js";

class ExecutionRecordChainImpl implements ExecutionRecordChain {
  private _records: MicroTaskExecutionRecord[] = [];

  get records(): readonly MicroTaskExecutionRecord[] {
    return this._records;
  }

  append(record: MicroTaskExecutionRecord): void {
    this._records.push(record);
  }

  buildPreviousContext(): string {
    if (this._records.length === 0) {
      return "(no prior micro-tasks)";
    }
    return this._records
      .map((r) => {
        if (r.success) {
          return `✅ ${r.task}: ${r.completedSubGoals.join(", ")}`;
        }
        return `✗ ${r.task} (failed): ${r.summary}`;
      })
      .join("\n");
  }

  buildEvidenceSummary(): string {
    if (this._records.length === 0) {
      return "(no execution records)";
    }
    return this._records
      .map((r, i) => {
        const lines: string[] = [];
        lines.push(`[${i + 1}] ${r.task}`);
        lines.push(`    status: ${r.success ? "success" : "failed"}`);
        if (r.completedSubGoals.length > 0) {
          lines.push(`    completedSubGoals: ${r.completedSubGoals.join(", ")}`);
        }
        if (r.actions.length > 0) {
          lines.push(`    actions: ${r.actions.join("; ")}`);
        }
        if (r.assertionResult) {
          const ar = r.assertionResult;
          lines.push(
            `    assertion: ${ar.allPassed ? "PASSED" : "FAILED"} (${ar.passed}/${ar.total})`,
          );
          for (const d of ar.details) {
            lines.push(
              `      - ${d.task}: ${d.passed ? "✅" : "❌"} ${d.reason}`,
            );
          }
        }
        return lines.join("\n");
      })
      .join("\n");
  }
}

/** 创建一个空的 ExecutionRecordChain */
export function createExecutionRecordChain(): ExecutionRecordChain {
  return new ExecutionRecordChainImpl();
}
