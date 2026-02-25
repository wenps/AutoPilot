/**
 * Demo 入口 — 使用 WebAgent 测试浏览器端 AI Agent。
 *
 * 这个文件只负责 UI 交互，所有 Agent 逻辑由 WebAgent 类封装：
 *
 *   UI 事件 → WebAgent.chat() → 回调更新 UI
 *
 * 对比原来的 main.ts：
 * - 不再重写 agent loop、AI 调用、system prompt 构建
 * - 只需实例化 WebAgent + 绑定 callbacks + 调用 chat()
 */
import { WebAgent } from "../src/web/index.js";
import type { ToolCallResult } from "../src/core/tool-registry.js";

// ─── DOM 引用 ───
const chatEl = document.getElementById("chat")!;
const inputEl = document.getElementById("input") as HTMLInputElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const tokenEl = document.getElementById("token") as HTMLInputElement;
const modelEl = document.getElementById("model") as HTMLSelectElement;
const dryrunEl = document.getElementById("dryrun") as HTMLInputElement;
const memoryEl = document.getElementById("memory") as HTMLInputElement;
const statusEl = document.getElementById("status")!;

// ─── 复杂交互沙盒 DOM ───
const employeeNameEl = document.getElementById("employeeName") as HTMLInputElement;
const employeeEmailEl = document.getElementById("employeeEmail") as HTMLInputElement;
const employeeRoleEl = document.getElementById("employeeRole") as HTMLSelectElement;
const employeeBudgetEl = document.getElementById("employeeBudget") as HTMLInputElement;
const employeeStatusEl = document.getElementById("employeeStatus") as HTMLSelectElement;
const budgetRowEl = document.getElementById("budgetRow") as HTMLDivElement;
const submitEmployeeBtn = document.getElementById("submitEmployee") as HTMLButtonElement;
const resetEmployeeBtn = document.getElementById("resetEmployee") as HTMLButtonElement;
const formHintEl = document.getElementById("formHint") as HTMLSpanElement;

const filterKeywordEl = document.getElementById("filterKeyword") as HTMLInputElement;
const filterStatusEl = document.getElementById("filterStatus") as HTMLSelectElement;
const employeeTableBodyEl = document.getElementById("employeeTableBody") as HTMLTableSectionElement;
const sortHeaderEls = Array.from(
  document.querySelectorAll("th[data-sort]"),
) as HTMLTableCellElement[];

const openModalBtn = document.getElementById("openModal") as HTMLButtonElement;
const taskModalMaskEl = document.getElementById("taskModalMask") as HTMLDivElement;
const taskTitleEl = document.getElementById("taskTitle") as HTMLInputElement;
const taskPriorityEl = document.getElementById("taskPriority") as HTMLSelectElement;
const taskDueDateEl = document.getElementById("taskDueDate") as HTMLInputElement;
const taskMembersEl = document.getElementById("taskMembers") as HTMLInputElement;
const taskDescEl = document.getElementById("taskDesc") as HTMLTextAreaElement;
const confirmTaskBtn = document.getElementById("confirmTask") as HTMLButtonElement;
const cancelTaskBtn = document.getElementById("cancelTask") as HTMLButtonElement;
const modalResultEl = document.getElementById("modalResult") as HTMLParagraphElement;

type EmployeeStatus = "active" | "onleave" | "inactive";
type EmployeeRole = "developer" | "designer" | "manager";

type Employee = {
  id: string;
  name: string;
  email: string;
  role: EmployeeRole;
  status: EmployeeStatus;
  budget?: number;
  createdAt: string;
};

let employees: Employee[] = [
  {
    id: "u_001",
    name: "陈晨",
    email: "chen.chen@autopilot.dev",
    role: "developer",
    status: "active",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
  },
  {
    id: "u_002",
    name: "王雨",
    email: "wang.yu@autopilot.dev",
    role: "manager",
    status: "onleave",
    budget: 120000,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString(),
  },
  {
    id: "u_003",
    name: "赵宁",
    email: "zhao.ning@autopilot.dev",
    role: "designer",
    status: "active",
    createdAt: new Date().toISOString(),
  },
];

let sortField: "name" | "status" | "createdAt" = "createdAt";
let sortDirection: "asc" | "desc" = "desc";

// ─── 创建 Agent 实例 ───
// baseURL 使用 Vite proxy 路径，代理到 GitHub Models API
const agent = new WebAgent({
  token: import.meta.env.GITHUB_TOKEN ?? "",
  provider: "copilot",
  baseURL: "/api",
});
agent.registerTools(); // 注册内置 Web 工具

// 显示已注册的工具
const tools = agent.getTools();
appendMsg(
  "system",
  `✅ 已注册 ${tools.length} 个 Web 工具：${tools.map((t) => t.name).join(", ")}`,
);

// ─── 绑定 Agent 回调 → 更新 UI ───
agent.callbacks = {
  onRound: (round) => {
    statusEl.textContent = `思考中 (第 ${round + 1} 轮)...`;
  },
  onText: (text) => {
    appendMsg("assistant", text);
  },
  onToolCall: (name, input) => {
    appendMsg("tool-call", `${name}(${JSON.stringify(input)})`);
    statusEl.textContent = `执行工具: ${name}...`;
  },
  onToolResult: (_name, result: ToolCallResult) => {
    const str =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content, null, 2);
    appendMsg("tool-result", str);
  },
  onSnapshot: (snapshot) => {
    const lines = snapshot.split("\n").length;
    appendMsg("tool-result", `📸 页面快照已生成（${lines} 行 / ${snapshot.length} 字符）`);
    statusEl.textContent = "分析页面快照...";
  },
};

// ─── 从 localStorage 恢复 Token ───
const savedToken = localStorage.getItem("ap_token");
if (savedToken) {
  tokenEl.value = savedToken;
  statusEl.textContent = "已连接";
  statusEl.classList.add("connected");
}

// ─── 事件绑定 ───

sendBtn.addEventListener("click", () => handleSend());

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

tokenEl.addEventListener("change", () => {
  if (tokenEl.value) {
    localStorage.setItem("ap_token", tokenEl.value);
    statusEl.textContent = "已连接";
    statusEl.classList.add("connected");
  }
});

// 记忆开关：UI checkbox 变化时同步到 Agent
memoryEl.addEventListener("change", () => {
  agent.setMemory(memoryEl.checked);
  if (memoryEl.checked) {
    appendMsg("system", "🧠 已开启多轮记忆，AI 会记住之前的对话");
  } else {
    appendMsg("system", "🧠 已关闭多轮记忆，对话历史已清空");
  }
});

// 暴露给 HTML 按钮的全局函数
(window as any).sendQuick = sendQuick;
(window as any).handleSend = handleSend;
(window as any).clearHistory = clearHistory;

// ─── 初始化复杂交互沙盒 ───
setupPlayground();

// ─── Chat UI 函数 ───

function appendMsg(type: string, text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `msg ${type}`;

  if (type === "tool-call" || type === "tool-result") {
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = type === "tool-call" ? "🔧 工具调用" : "📋 工具结果";
    div.appendChild(label);
  }

  const content = document.createElement("span");
  content.textContent = text;
  div.appendChild(content);

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function sendQuick(text: string) {
  inputEl.value = text;
  handleSend();
}

function clearHistory() {
  agent.clearHistory();
  appendMsg("system", "🗑️ 对话历史已清空");
}

async function handleSend() {
  const text = inputEl.value.trim();
  console.log(text);
  
  if (!text) return;

  const token = tokenEl.value.trim();
  if (!token) {
    appendMsg("error", "❌ 请先填写 GitHub Token");
    return;
  }
  inputEl.value = "";

  appendMsg("user", text);

  // 同步 UI 设置到 Agent 实例
  agent.setToken(token);
  agent.setModel(modelEl.value);
  agent.setDryRun(dryrunEl.checked);

  try {
    await agent.chat(text);
  } catch (err: any) {
    appendMsg("error", `❌ ${err.message || err}`);
  } finally {
    statusEl.textContent = "已连接";
    statusEl.classList.add("connected");
    inputEl.focus();
  }
}

function setupPlayground(): void {
  employeeRoleEl.addEventListener("change", () => {
    const isManager = employeeRoleEl.value === "manager";
    budgetRowEl.style.display = isManager ? "flex" : "none";
    formHintEl.textContent = isManager
      ? "经理角色需要填写预算。"
      : "提示：角色选“经理”后预算字段会出现。";
  });

  submitEmployeeBtn.addEventListener("click", () => {
    const name = employeeNameEl.value.trim();
    const email = employeeEmailEl.value.trim();
    const role = employeeRoleEl.value as EmployeeRole;
    const status = employeeStatusEl.value as EmployeeStatus;
    const budgetText = employeeBudgetEl.value.trim();

    if (!name || !email) {
      formHintEl.textContent = "请先填写姓名和邮箱。";
      return;
    }

    if (role === "manager" && !budgetText) {
      formHintEl.textContent = "经理角色必须填写预算。";
      return;
    }

    const budget = budgetText ? Number(budgetText) : undefined;
    const next: Employee = {
      id: `u_${Date.now()}`,
      name,
      email,
      role,
      status,
      budget: Number.isFinite(budget) ? budget : undefined,
      createdAt: new Date().toISOString(),
    };

    employees = [next, ...employees];
    renderEmployeeTable();
    resetEmployeeForm();
    formHintEl.textContent = `已提交员工：${next.name}`;
  });

  resetEmployeeBtn.addEventListener("click", () => {
    resetEmployeeForm();
    formHintEl.textContent = "表单已重置。";
  });

  filterKeywordEl.addEventListener("input", () => renderEmployeeTable());
  filterStatusEl.addEventListener("change", () => renderEmployeeTable());

  sortHeaderEls.forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort as "name" | "status" | "createdAt";
      if (sortField === field) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
      } else {
        sortField = field;
        sortDirection = field === "createdAt" ? "desc" : "asc";
      }
      renderEmployeeTable();
    });
  });

  employeeTableBodyEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const removeId = target.getAttribute("data-remove-id");
    if (!removeId) return;
    employees = employees.filter((item) => item.id !== removeId);
    renderEmployeeTable();
  });

  openModalBtn.addEventListener("click", () => {
    taskModalMaskEl.classList.add("open");
    taskModalMaskEl.setAttribute("aria-hidden", "false");
    taskTitleEl.focus();
  });

  cancelTaskBtn.addEventListener("click", closeTaskModal);
  taskModalMaskEl.addEventListener("click", (event) => {
    if (event.target === taskModalMaskEl) closeTaskModal();
  });

  confirmTaskBtn.addEventListener("click", () => {
    console.log(111);
    
    const title = taskTitleEl.value.trim();
    const priority = taskPriorityEl.value;
    const dueDate = taskDueDateEl.value;
    const members = taskMembersEl.value.trim();
    const desc = taskDescEl.value.trim();

    if (!title) {
      modalResultEl.textContent = "弹窗提交失败：任务名不能为空。";
      return;
    }

    modalResultEl.textContent = [
      `已提交任务：${title}`,
      `优先级：${priority}`,
      `截止日期：${dueDate || "未填写"}`,
      `参与人：${members || "未填写"}`,
      `描述：${desc || "未填写"}`,
    ].join(" | ");

    closeTaskModal();
    taskTitleEl.value = "";
    taskDueDateEl.value = "";
    taskMembersEl.value = "";
    taskDescEl.value = "";
  });

  renderEmployeeTable();
}

function closeTaskModal(): void {
  taskModalMaskEl.classList.remove("open");
  taskModalMaskEl.setAttribute("aria-hidden", "true");
}

function resetEmployeeForm(): void {
  employeeNameEl.value = "";
  employeeEmailEl.value = "";
  employeeRoleEl.value = "developer";
  employeeBudgetEl.value = "";
  employeeStatusEl.value = "active";
  budgetRowEl.style.display = "none";
}

function renderEmployeeTable(): void {
  const keyword = filterKeywordEl.value.trim().toLowerCase();
  const statusFilter = filterStatusEl.value as EmployeeStatus | "all";

  const filtered = employees.filter((item) => {
    const matchKeyword =
      !keyword ||
      item.name.toLowerCase().includes(keyword) ||
      item.email.toLowerCase().includes(keyword);
    const matchStatus = statusFilter === "all" || item.status === statusFilter;
    return matchKeyword && matchStatus;
  });

  const sorted = [...filtered].sort((a, b) => {
    const left = a[sortField];
    const right = b[sortField];

    if (sortField === "createdAt") {
      const leftTime = new Date(left).getTime();
      const rightTime = new Date(right).getTime();
      return sortDirection === "asc" ? leftTime - rightTime : rightTime - leftTime;
    }

    const leftText = String(left).toLowerCase();
    const rightText = String(right).toLowerCase();
    if (leftText < rightText) return sortDirection === "asc" ? -1 : 1;
    if (leftText > rightText) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  if (sorted.length === 0) {
    employeeTableBodyEl.innerHTML =
      '<tr><td colspan="6" class="mini">没有匹配数据</td></tr>';
    return;
  }

  employeeTableBodyEl.innerHTML = sorted
    .map((item) => {
      const created = new Date(item.createdAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      const roleLabel =
        item.role === "developer"
          ? "开发"
          : item.role === "designer"
            ? "设计"
            : "经理";
      const statusLabel =
        item.status === "active"
          ? "在职"
          : item.status === "onleave"
            ? "休假"
            : "离职";

      return `
        <tr>
          <td>${item.name}</td>
          <td>${item.email}</td>
          <td>
            <span class="pill">${roleLabel}</span>
            ${item.budget ? `<div class="mini">预算: ${item.budget}</div>` : ""}
          </td>
          <td>${statusLabel}</td>
          <td>${created}</td>
          <td>
            <button data-remove-id="${item.id}" style="background:#312040;color:#f0c0ff;border:1px solid #5a3a70;border-radius:6px;padding:4px 8px;cursor:pointer;">删除</button>
          </td>
        </tr>
      `;
    })
    .join("");
}
