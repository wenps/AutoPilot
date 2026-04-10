{
  "role": "system",
  "content": "You are AutoPilot, an AI agent controlling the current web page via tools.\n\n## Core Rules\n- **Original Goal Anchor:** The user's original input is provided as `Original Goal` every round. Your plan and each action must NEVER deviate from it. If the page shows 'Create X' but user said 'go to X', navigate INTO existing X, NOT create new.\n- **Goal decomposition:** Distinguish TARGET entity from ACTION. 'go to X and do Y' = locate X → enter X → do Y. 'create X' = make new X. 'edit X' = find existing X → modify. If target not visible, search/filter first — do not pick the nearest similarly-named button.\n- Work from CURRENT snapshot + remaining task. Do not restate.\n- Task reduction: (remaining, prev actions, this-round) → new remaining.\n- Use #hashID from snapshot as selector. Do not guess CSS selectors.\n- Only interactive elements carry #hashID; others are context-only.\n- Bracket tag may show ARIA role ([combobox], [slider]) as interaction hint. listeners=\"...\" = bound events (abbrevs below). Prefer targets with matching listeners.\n- Click target MUST have click signal: clk/pdn/mdn in listeners, onclick attr, native <a>/<button>, or role=button/link. NEVER click elements with only blr/fcs. If text has no click signal, look at its parent/container or nearby sibling that does.\n- Effect check: before planning new actions, confirm previous actions' effects are visible in snapshot. Click failed (snapshot unchanged)? Do NOT repeat. Try: (1) <a>/<button> child inside container; (2) parent/sibling with clk; (3) different approach (search, filter, evaluate programmatically).\n- Batch fill/type/check/select_option freely in one round. Click ends the round — at most ONE click as LAST action.\n- fill/type/select_option auto-focus: these actions automatically click and focus the target before input — do NOT send a separate focus/click before them.\n- Search inputs: after fill, press Enter or click search button. fill alone does not submit.\n- Dropdown/select: prefer dom.select_option. Custom dropdowns: click → next snapshot → click option (two rounds).\n- Steppers: compute delta, click |delta| times. Check/uncheck: target real input control.\n- Confirm-to-apply principle: any multi-step interaction that opens a secondary UI (picker, popover, dropdown panel, modal, dialog, drawer, editor overlay, cascader, transfer box, etc.) is NOT complete after just entering/selecting a value — you MUST click the confirm/OK/apply/save button (or equivalent) to commit the change. The task is only done when the secondary UI is dismissed AND the final value is reflected on the original page/form field in the snapshot.\n- DOM-changing action (click/modal/navigate) ends the round. Actions after a click in same batch are discarded.\n- One-shot preconditions (waits, confirmations, navigation in prev actions) are DONE — strip from REMAINING.\n- Intermediate progress ≠ completion. Keep REMAINING on final goal until end state is visible in snapshot.\n- Never repeat same tool call (same name + args) on same target.\n- page_info.snapshot is internal — auto-refreshed every round, never call directly. Other page_info actions (get_url, get_title, get_viewport, query_all, get_selection) allowed. Do NOT use get_text/get_attr to read what is already visible in snapshot.\n- Omitted children: output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>`, wait for next snapshot.\n- Do NOT verify values unless user explicitly asks.\n- Do NOT interact with AutoPilot UI unless user asks.\n- Completion = visible outcome in snapshot. If snapshot already shows the expected result (color changed, switch toggled, value present, dialog closed, etc.), the task IS done.\n- **CRITICAL: You MUST complete ALL parts of the user's task.** If an operation fails, try alternative approaches (different selector, scroll, dismiss overlay, use evaluate) — never skip. For form tasks, every specified field must be filled.\n- Stop: when task fully achieved (visible in snapshot), output REMAINING: DONE. Do NOT over-verify.\n\n## Listener Abbrevs\nclk=click inp=input chg=change mdn=mousedown pdn=pointerdown kdn=keydown sub=submit fcs=focus blr=blur\n\n## Output\nTool calls + one text line: REMAINING: <new remaining> or REMAINING: DONE\nExample: Task A→B→C. Round1 do A → REMAINING: B→C. Round2 do B → REMAINING: C. Round3 do C → REMAINING: DONE\n\n## Execution Strategy\nYou have two execution modes. **Analyze the snapshot's form structure first**, then choose:\n\n1. **DIRECT**: Simple operations — click a button, fill 1-3 simple fields (text input, checkbox, basic select), simple navigation. Execute directly using DOM tools.\n2. **MICRO-TASK**: Call `dispatch_micro_task` to delegate focused work to a specialized micro-task agent. Use this when:\n   - Form has **4+ fields** to fill\n   - Form contains **complex interactive controls** (color picker, date range picker, cascader, file upload, rich text editor, slider, tree select, transfer list)\n\n### CRITICAL dispatch rules\n- **NEVER mix dispatch_micro_task with DOM tool calls (dom, navigate, evaluate, etc.) in the same round.** A round is either ALL micro-task dispatches OR direct DOM actions — never both.\n- **Every form field visible in the snapshot MUST be covered by a micro-task. Do not skip any field.**\n- You may dispatch **multiple micro-tasks** in the same round (they run sequentially).\n- After dispatching, wait for results before taking further action.\n\n### Micro-task granularity\n- **All text inputs MUST be grouped into ONE micro-task.** Never dispatch separate micro-tasks for individual text fields. The micro-task agent will batch-fill them all in a single round.\n- **Everything else** (dropdown/select, checkbox, radio, color picker, date picker, date range, cascader, file upload, rich text editor, slider, tree select, transfer list, switch, rate, etc.): **each control = its own separate micro-task**\n\nExample — a form with name, email, city (dropdown), color (color picker), tags (checkbox), notes:\n```\n// CORRECT: all text inputs in ONE micro-task\ndispatch_micro_task({ \"task\": \"Fill all text fields: name=John, email=john@test.com, notes=Test note\" })\n// Each non-text control gets its own micro-task\ndispatch_micro_task({ \"task\": \"Open city dropdown and select Beijing\" })\ndispatch_micro_task({ \"task\": \"Check the tag checkbox: Core\" })\ndispatch_micro_task({ \"task\": \"Open color picker and select red (#ff0000)\" })\n```\n```\n// WRONG: never do this — separate micro-tasks for each text field\ndispatch_micro_task({ \"task\": \"Fill name=John\" })        // ← WRONG\ndispatch_micro_task({ \"task\": \"Fill email=john@test.com\" }) // ← WRONG\ndispatch_micro_task({ \"task\": \"Fill notes=Test note\" })    // ← WRONG\n```\n\n### When NOT to use micro-tasks\n- Single click, 1-3 simple field fills, simple navigation → just do it yourself\n- Tasks that require cross-section coordination in the same round\n\n### Micro-task results & recovery\n- Each micro-task returns a success/failure status and execution record\n- Failed micro-tasks include a failure reason — you MUST retry with a different approach, not skip\n- **You MUST dispatch micro-tasks for ALL fields/sections — do not stop after partial completion**\n- **After all micro-tasks complete, you MUST call `assert({})` before outputting REMAINING: DONE.** Do NOT output REMAINING: DONE without calling assert first. This is mandatory in orchestration mode.\n- **If assertion fails:** read the failure reason carefully. Identify which fields/controls were missed or incorrectly set. Then dispatch NEW micro-tasks targeting ONLY the failed/missing parts. Do NOT re-dispatch already successful micro-tasks.\n\n## Extra Instructions\n- [demo] You are operating a routed enterprise admin demo page. Use the visible sidebar menu, breadcrumb, route info card, forms, drawers, nested dialogs, tabs, trees, and tables to navigate and complete tasks. Prefer minimal action arrays and complete independent visible actions in one round. Do not repeat verification calls unless the user explicitly asks for verification.\n\n## Assertion Capability\nYou have an `assert` tool to verify task completion. When called, an independent verification AI will judge whether the task has been fulfilled based on the current snapshot and your actions.\n\n### When to call assert\n- Call `assert` AFTER you believe the task is complete and the expected outcome should be visible in the snapshot.\n- You can include `assert` alongside other tool calls in the same round. The framework will execute all other tools first, wait for page stability, then run the assertion.\n- Do NOT call `assert` on every round — only when you expect the task to pass verification.\n- Avoid calling `assert` immediately after a DOM-changing action in the same round if the effect may not be visible yet; wait for the next round's snapshot.\n\n### How to call\nCall the `assert` tool with no parameters: `assert({})`\nThe framework handles all assertion logic internally."
}
Done steps (do NOT repeat):
✅ 1. dom (action="click", selector="#1dnj7ls") → ✓ 已点击 <li.el-menu-item> "开通应用实例带步骤和弹窗确认的开通流程" [role=menuitem]
✅ 2. dom (action="click", selector="#q2bdpk") → ✓ 已点击 <button.el-button.el-button--primary> "开通新实例" [type=button]
✅ 3. dom (action="click", selector="#m9hdot") → ✓ 已点击 <input#el-id-9707-46.el-select__input> [type=text, role=combobox]

Original Goal: 创建一个实例，然后要选择华东零售

Remaining: 要选择华东零售

## Task Progress
✅ 1. 创建一个实例
□ 2. 要选择华东零售  ← current
Focus on the current task (marked ← current). When it is visibly done in snapshot, update REMAINING to drop it.

Batch fills per round; clicks end the round — at most ONE click (last). Do NOT call page_info (snapshot is auto-refreshed).
Completion = VISIBLE OUTCOME in snapshot, not finishing every sub-step. If snapshot already shows the goal state (color is red, switch is off, value filled, etc.), output REMAINING: DONE — do NOT retry, verify, or click OK/confirm.
Semantic completion: preserve all unresolved user constraints in Remaining until they are visibly satisfied in the snapshot.
Do NOT narrow Remaining into only a shell action if that would drop required entities, values, counts, filters, destinations, selections, or final outcomes.
Before any advance/finalize action, check that all prerequisite constraints are already visible in the snapshot.
Effect check: confirm previous actions' expected effects in snapshot before planning new actions.
Never repeat the same tool call on the same target. If no effect, try a different element.
Click ends the round — actions after a click are discarded. Dropdown: open(click) → next round → pick(click).
If a list shows `... (N children omitted)`, output `SNAPSHOT_HINT: EXPAND_CHILDREN #<ref>` and wait.
Do NOT interact with AI chat UI elements.
Output: REMAINING: <new remaining> or REMAINING: DONE

If fully done, reply summary only (no tools).

Previous executed:
1. dom:{"action":"click","selector":"#m9hdot"}
If any had no visible effect (snapshot unchanged), do NOT repeat — try a child <a>/<button> inside the target, or a sibling/parent with stronger click signal.

Previous planned:
1. dom:{"action":"click","selector":"#m9hdot"}

Previous model output:
REMAINING: 要选择华东零售

CRITICAL — No progress detected:
- Remaining has NOT advanced for 2 consecutive rounds with no confirmed progress.
- The snapshot may ALREADY show your task is complete.
CHECK the snapshot NOW: if the expected outcome is visible (color changed, switch toggled, value present, dialog closed, form submitted, etc.), output REMAINING: DONE immediately with NO tool calls.
Do NOT call page_info, do NOT retry failed actions, do NOT click verify/confirm buttons if the result is already visible.

## Snapshot Changes (since last round)
Lines prefixed with `-` were removed; `+` were added.
- "业务导航 · 模拟真实 B 端项目的多级菜单"
- [button] type="button" listeners="clk" #_
- "快捷指令"
- [span] listeners="clk" #_
- "platform:tenant:app:provision:create"
- [ul] role="menubar"
- [menuitem] listeners="clk" #_
- "场景总览 · 查看全部测试路线和推荐任务"
- "工作台"
- [ul] role="menubar"
- [menuitem] listeners="clk" #_
- "新建发布单 · 深层级变更发布申请页"
- "运营中心"
- [ul] role="menubar"
- [menuitem] listeners="clk" #_
- "供应商准入申请 · 从列表进入抽屉创建申请"
- "采购中心"
- [ul] role="menubar"
- [menuitem] listeners="clk" #_
- "新建企业客户 · 多分组企业客户档案创建页"
... (296 more changes)

## Snapshot
<!-- SNAPSHOT_START -->
[body] class="el-popup-parent--hidden"
  [div] id="app"
    [main]
      [main]
        "平台配置 · 开通应用实例 · 租户中心应用开通页，包含环境配置、步骤流和最终确认弹窗。 · 当前路径 · /platform/tenant-center/application/prov"
        [div] role="navigation" aria-label="Breadcrumb"
          [link] "平台配置" listeners="clk" #t9icsv2
          "/"
          [link] "租户中心" listeners="clk" #tl54rg2
          "/"
          [link] "应用开通" listeners="clk" #1opn3sx
          "/"
          [link] "新建实例" listeners="clk" #29h1f2
        "测试目标： · 适合测试 AI 在深路径页面中打开弹窗、完成实例参数配置并确认开通。"
        [div] class="el-overlay" listeners="clk,mdn" #io8o4q
          [div] class="el-overlay-dialog" role="dialog" aria-label="开通新实例" listeners="clk,mdn" #jdv63u
            [div] class="el-dialog" listeners="kdn" #18zafca
              [button] class="el-dialog__headerbtn" type="button" aria-label="Close this dialog" listeners="clk" #1bb1ojn
                [i] class="el-dialog__close"
              "开通新实例"
              [div] id="el-id-9707-20" class="el-dialog__body"
                [form]
                  [label] "租户" id="el-id-9707-24" for="el-id-9707-46" #go7gzh
                  [div]
                    [div] class="el-tooltip__trigger" listeners="blr,clk,fcs,kdn" #1sa8si0
                      [combobox] id="el-id-9707-46" type="text" readonly listeners="chg,clk,inp,kdn" #m9hdot
                      "请选择租户"
                  [label] "应用名称" id="el-id-9707-30" for="el-id-9707-47" #qbd6de
                  [div]
                    [div] class="el-tooltip__trigger" listeners="blr,clk,fcs,kdn" #ctf3gn
                      [combobox] id="el-id-9707-47" type="text" readonly listeners="chg,clk,inp,kdn" #e69h5i
                      "请选择应用"
                  [label] "实例名称" id="el-id-9707-36" for="el-id-9707-48" #1u1c6hv
                  [div]
                    [div] listeners="blr,clk,fcs" #v71bu6
                      [input] id="el-id-9707-48" type="text" placeholder="请输入实例名称" listeners="chg,inp,kdn" #5xdq29
                  [label] "部署地域" id="el-id-9707-37" for="el-id-9707-49" #g0atlc
                  [div] id="el-id-9707-49" role="radiogroup"
                    [label] #11l7dbb
                      [span] "华北 1" listeners="kdn" #16v9kpg
                      [input] type="radio" value="cn-north-1" name="el-id-9707-38" listeners="blr,chg,clk,fcs" #1kjv18k
                    [label] class="is-checked" #1jcre7g
                      [span] "华东 1" listeners="kdn" #176dfo7
                      [input] type="radio" value="cn-east-1" name="el-id-9707-38" checked listeners="blr,chg,clk,fcs" #ums2dr
                    [label] #1kgmnhd
                      [span] "华南 1" listeners="kdn" #l1884q
                      [input] type="radio" value="cn-south-1" name="el-id-9707-38" listeners="blr,chg,clk,fcs" #gbz7mm
                  [label] "实例规格" id="el-id-9707-39" for="el-id-9707-50" #hrn9qp
                  [div]
                    [div] class="el-tooltip__trigger" listeners="blr,clk,fcs,kdn" #1d6q5c4
                      [combobox] id="el-id-9707-50" type="text" readonly listeners="chg,clk,inp,kdn" #sujzvd
                      "请选择规格"
                  [label] "网络策略" id="el-id-9707-45" for="el-id-9707-51" #138uts6
                  [div] id="el-id-9707-51" role="group"
                    [label] listeners="clk" #1al9vfx
                      [input] type="checkbox" value="private-link" listeners="blr,chg,clk,fcs" #19cyu4y
                      "专线访问"
                    [label] listeners="clk" #stw5jq
                      [input] type="checkbox" value="ip-whitelist" listeners="blr,chg,clk,fcs" #19imhup
                      "IP 白名单"
                    [label] listeners="clk" #19h2y2b
                      [input] type="checkbox" value="sso" listeners="blr,chg,clk,fcs" #1qampxk
                      "单点登录"
              [button] type="button" listeners="clk" #hq91ho
                "取消"
              [button] type="button" listeners="clk" #zha5dz
                "下一步确认"
        "实例开通向导 · 选择租户 · 确定实例归属租户 · 选择应用 · 配置应用和版本 · 3 · 设置规格 · 填写容量和网络参数 · 4 · 确认开通 · 完成审批并提交"
        "已开通实例"
        [div] class="is-scrolling-left"
          [div]
            [table]
              [thead]
                [tr]
                  [th] class="is-leaf" listeners="clk,mdn" #2ah1xi
                    "租户"
                  [th] class="is-leaf" listeners="clk,mdn" #1jkfwm5
                    "应用"
                  [th] class="is-leaf" listeners="clk,mdn" #16r5rc
                    "实例名称"
                  [th] class="is-leaf" listeners="clk,mdn" #162vnr
                    "地域"
                  [th] class="is-leaf" listeners="clk,mdn" #2a4fxm
                    "状态"
          [div]
            [div]
              [table]
                [tbody] #1ue6ipj
                  [tr] listeners="clk" #ofgoh5
                    [td]
                      "华东零售事业部"
                    [td]
                      "统一消息中心"
                    [td]
                      "msg-center-prod"
                    [td]
                      "华东 1"
                    [td]
                      [span] listeners="clk" #13y68pu
                        "运行中"
                  [tr] listeners="clk" #166o3de
                    [td]
                      "南区供应链共享中心"
                    [td]
                      "工作流引擎"
                    [td]
                      "workflow-core"
                    [td]
                      "华南 1"
                    [td]
                      [span] listeners="clk" #994x5n
                        "初始化中"
        [button] type="button" listeners="clk" #q2bdpk
          "开通新实例"
        [div]
          [div] listeners="blr,clk,fcs" #pc9cdn
            [input] id="el-id-9707-23" type="text" placeholder="搜索租户 / 实例名称" listeners="chg,inp,kdn" #e8txc
        "操作提示 · 推荐动作 · 点击“开通新实例”，在弹窗中依次选择租户、应用、规格和网络策略。 · 验证方式 · 成功后会弹出确认框，确认后写入实例列表和最近操作记录。 · 适合测试 · AI 对深层路径导航、弹窗表单、二次确认和结果验证的完"
      "业务导航 · 模拟真实 B 端项目的多级菜单"
      [button] type="button" listeners="clk" #191igep
        "快捷指令"
      [span] listeners="clk" #lmf2sh
        "platform:tenant:app:provision:create"
      [ul] role="menubar"
        [menuitem] listeners="clk" #y081cs
          "场景总览 · 查看全部测试路线和推荐任务"
      "工作台"
      [ul] role="menubar"
        [menuitem] listeners="clk" #18y472z
          "新建发布单 · 深层级变更发布申请页"
      "运营中心"
      [ul] role="menubar"
        [menuitem] listeners="clk" #jbj15q
          "供应商准入申请 · 从列表进入抽屉创建申请"
      "采购中心"
      [ul] role="menubar"
        [menuitem] listeners="clk" #shzhu5
          "新建企业客户 · 多分组企业客户档案创建页"
      "主数据中心"
      [ul] role="menubar"
        [menuitem] class="is-active" listeners="clk" #1dnj7ls
          "开通应用实例 · 带步骤和弹窗确认的开通流程"
      "平台配置"
      [ul] role="menubar"
        [menuitem] listeners="clk" #g82f3
          "新建对账批次 · 抽屉 + Tab + 二次确认的对账批次创建页"
      "财务中心"
      [ul] role="menubar"
        [menuitem] listeners="clk" #8srswy
          "工单升级申请 · 列表筛选后进入抽屉，再弹窗选群组"
      "服务台"
      [ul] role="menubar"
        [menuitem] listeners="clk" #fv03xd
          "权限包模板 · 树形权限 + Tab + 资源组抽屉配置页"
      "安全中心"
      [ul] role="menubar"
        [menuitem] listeners="clk" #1u0ebys
          "Element 测试台 · Tab + 常用组件集中测试页面"
      "组件实验室"
    [span] listeners="clk" #1o51c6
      "已连接"
    [h1] "AutoPilot v2 · B 端多路由复杂场景 Demo"
    [label] listeners="clk" #ve0owq
      [input] type="checkbox" listeners="blr,chg,clk,fcs" #83b2kd
      "Dry-run"
    [label] listeners="clk" #ve3uep
      [input] type="checkbox" listeners="blr,chg,clk,fcs" #cs0z8u
      "Memory"
    [div]
      [div] listeners="blr,clk,fcs" #azlssx
        [input] id="el-id-9707-11" type="password" placeholder="MiniMax Token" listeners="chg,inp,kdn" val="sk-e21cb60f1a3e47ce935ed77f754c8d96" #ta7a6m
        [i] listeners="clk,mdn" #w02v33
    [div]
      [div] class="el-tooltip__trigger" listeners="blr,clk,fcs,kdn" #1ivt7f2
        [combobox] id="el-id-9707-12" class="is-small" type="text" readonly listeners="chg,clk,inp,kdn" #17nz5cz
        "MiniMax-M2.5"
    [div]
      [div] class="el-tooltip__trigger" listeners="blr,clk,fcs,kdn" #lfnp3r
        [combobox] id="el-id-9707-13" class="is-small" type="text" readonly listeners="chg,clk,inp,kdn" #1c5otom
        "json"
  [div] id="el-popper-container-9707"
    [div] id="el-id-9707-26" class="el-popper" role="tooltip" listeners="kdn" #3r1t85
      [div]
        [div]
          [listbox] id="el-id-9707-25" #y4dp8k
            [option] id="el-id-9707-27" listeners="clk" #xuo6wh
              "华北一区"
            [option] id="el-id-9707-28" listeners="clk" #xul1ei
              "华东零售事业部"
            [option] id="el-id-9707-29" listeners="clk" #ez8wqf
              "南区供应链共享中心"
<!-- SNAPSHOT_END --></button>