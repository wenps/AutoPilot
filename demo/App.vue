<template>
  <div class="app-container">
    <!-- ======= 顶栏 ======= -->
    <el-header class="topbar">
      <div class="topbar-left">
        <h1>AutoPilot · Element Plus 交互验证</h1>
        <el-tag :type="connected ? 'success' : 'danger'" size="small">
          {{ connected ? '已连接' : '未连接' }}
        </el-tag>
      </div>
      <div class="topbar-right">
        <el-input
          v-model="token"
          type="password"
          placeholder="DeepSeek Token"
          size="small"
          style="width: 260px"
          show-password
          @change="onTokenChange"
        />
        <el-select v-model="model" size="small" style="width: 160px">
          <el-option label="deepseek-chat" value="deepseek-chat" />
          <el-option label="deepseek-reasoner" value="deepseek-reasoner" />
        </el-select>
        <el-select v-model="streamMode" size="small" style="width: 100px">
          <el-option label="stream" value="stream" />
          <el-option label="json" value="json" />
        </el-select>
        <el-checkbox v-model="dryRun" size="small">Dry-run</el-checkbox>
        <el-checkbox v-model="memory" size="small" @change="onMemoryChange">Memory</el-checkbox>
      </div>
    </el-header>

    <!-- ======= 主内容区 ======= -->
    <el-main class="main-content">
      <el-tabs v-model="activeTab" type="border-card">
        <!-- ===== Tab 1: 表单交互 ===== -->
        <el-tab-pane label="表单组件" name="form">
          <el-row :gutter="20">
            <el-col :span="12">
              <el-card header="基础表单">
                <el-form :model="form" label-width="100px" size="default">
                  <el-form-item label="用户名">
                    <el-input v-model="form.username" placeholder="请输入用户名" clearable />
                  </el-form-item>
                  <el-form-item label="密码">
                    <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password />
                  </el-form-item>
                  <el-form-item label="邮箱">
                    <el-input v-model="form.email" placeholder="example@mail.com" />
                  </el-form-item>
                  <el-form-item label="个人简介">
                    <el-input v-model="form.bio" type="textarea" :rows="3" placeholder="介绍一下你自己" />
                  </el-form-item>
                  <el-form-item label="年龄">
                    <el-input-number v-model="form.age" :min="1" :max="120" />
                  </el-form-item>
                  <el-form-item>
                    <el-button type="primary" @click="onFormSubmit">提交</el-button>
                    <el-button @click="onFormReset">重置</el-button>
                  </el-form-item>
                </el-form>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="选择器">
                <el-form label-width="100px" size="default">
                  <el-form-item label="城市">
                    <el-select v-model="form.city" placeholder="请选择城市" clearable filterable>
                      <el-option label="北京" value="beijing" />
                      <el-option label="上海" value="shanghai" />
                      <el-option label="广州" value="guangzhou" />
                      <el-option label="深圳" value="shenzhen" />
                      <el-option label="杭州" value="hangzhou" />
                      <el-option label="成都" value="chengdu" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="多选标签">
                    <el-select v-model="form.tags" multiple placeholder="请选择标签" collapse-tags>
                      <el-option label="前端" value="frontend" />
                      <el-option label="后端" value="backend" />
                      <el-option label="全栈" value="fullstack" />
                      <el-option label="DevOps" value="devops" />
                      <el-option label="AI" value="ai" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="级联选择">
                    <el-cascader
                      v-model="form.cascaderValue"
                      :options="cascaderOptions"
                      placeholder="请选择地区"
                      clearable
                    />
                  </el-form-item>
                  <el-form-item label="日期">
                    <el-date-picker
                      v-model="form.date"
                      type="date"
                      placeholder="选择日期"
                    />
                  </el-form-item>
                  <el-form-item label="日期范围">
                    <el-date-picker
                      v-model="form.dateRange"
                      type="daterange"
                      range-separator="至"
                      start-placeholder="开始日期"
                      end-placeholder="结束日期"
                    />
                  </el-form-item>
                  <el-form-item label="时间">
                    <el-time-picker
                      v-model="form.time"
                      placeholder="选择时间"
                    />
                  </el-form-item>
                </el-form>
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="切换与选择">
                <el-form label-width="100px" size="default">
                  <el-form-item label="开关">
                    <el-switch
                      v-model="form.switchVal"
                      active-text="开启"
                      inactive-text="关闭"
                    />
                  </el-form-item>
                  <el-form-item label="单选框">
                    <el-radio-group v-model="form.radio">
                      <el-radio value="option1">选项一</el-radio>
                      <el-radio value="option2">选项二</el-radio>
                      <el-radio value="option3">选项三</el-radio>
                    </el-radio-group>
                  </el-form-item>
                  <el-form-item label="单选按钮">
                    <el-radio-group v-model="form.radioButton">
                      <el-radio-button value="red">红色</el-radio-button>
                      <el-radio-button value="green">绿色</el-radio-button>
                      <el-radio-button value="blue">蓝色</el-radio-button>
                    </el-radio-group>
                  </el-form-item>
                  <el-form-item label="复选框">
                    <el-checkbox-group v-model="form.checkboxes">
                      <el-checkbox label="阅读" value="read" />
                      <el-checkbox label="编程" value="code" />
                      <el-checkbox label="运动" value="sport" />
                      <el-checkbox label="音乐" value="music" />
                    </el-checkbox-group>
                  </el-form-item>
                  <el-form-item label="评分">
                    <el-rate v-model="form.rate" show-text />
                  </el-form-item>
                  <el-form-item label="滑块">
                    <el-slider v-model="form.slider" show-input />
                  </el-form-item>
                  <el-form-item label="颜色选择">
                    <el-color-picker v-model="form.color" />
                  </el-form-item>
                </el-form>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="穿梭框 Transfer">
                <el-transfer
                  v-model="form.transferValue"
                  :data="transferData"
                  :titles="['待选', '已选']"
                  filterable
                  filter-placeholder="搜索"
                />
              </el-card>
            </el-col>
          </el-row>
        </el-tab-pane>

        <!-- ===== Tab 2: 数据展示 ===== -->
        <el-tab-pane label="数据展示" name="data">
          <el-row :gutter="20">
            <el-col :span="24">
              <el-card header="数据表格">
                <div style="margin-bottom: 12px; display: flex; gap: 10px; align-items: center;">
                  <el-input
                    v-model="tableSearch"
                    placeholder="搜索姓名..."
                    clearable
                    size="small"
                    style="width: 200px"
                  />
                  <el-button type="primary" size="small" @click="onAddRow">新增行</el-button>
                  <el-button type="danger" size="small" @click="onDeleteSelected">删除选中</el-button>
                </div>
                <el-table
                  :data="paginatedTableData"
                  stripe
                  border
                  style="width: 100%"
                  @selection-change="onSelectionChange"
                >
                  <el-table-column type="selection" width="55" />
                  <el-table-column prop="name" label="姓名" sortable />
                  <el-table-column prop="age" label="年龄" sortable width="100" />
                  <el-table-column prop="email" label="邮箱" />
                  <el-table-column prop="city" label="城市" width="120">
                    <template #default="{ row }">
                      <el-tag>{{ row.city }}</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column prop="status" label="状态" width="100">
                    <template #default="{ row }">
                      <el-tag :type="row.status === '活跃' ? 'success' : 'info'">
                        {{ row.status }}
                      </el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column label="操作" width="180" fixed="right">
                    <template #default="{ row }">
                      <el-button size="small" @click="onEditRow(row)">编辑</el-button>
                      <el-button size="small" type="danger" @click="onRemoveRow(row)">删除</el-button>
                    </template>
                  </el-table-column>
                </el-table>
                <el-pagination
                  v-model:current-page="pagination.page"
                  v-model:page-size="pagination.pageSize"
                  :page-sizes="[5, 10, 20]"
                  :total="filteredTableData.length"
                  layout="total, sizes, prev, pager, next, jumper"
                  style="margin-top: 12px; justify-content: flex-end"
                />
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="标签 Tags">
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                  <el-tag
                    v-for="tag in dynamicTags"
                    :key="tag"
                    closable
                    @close="handleTagClose(tag)"
                  >
                    {{ tag }}
                  </el-tag>
                  <el-input
                    v-if="tagInputVisible"
                    ref="tagInputRef"
                    v-model="tagInputValue"
                    size="small"
                    style="width: 100px"
                    @keyup.enter="handleTagConfirm"
                    @blur="handleTagConfirm"
                  />
                  <el-button v-else size="small" @click="showTagInput">+ 新标签</el-button>
                </div>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="进度展示">
                <div style="display: flex; flex-direction: column; gap: 16px;">
                  <div>
                    <span>线形进度条</span>
                    <el-progress :percentage="progressVal" />
                  </div>
                  <div>
                    <span>条纹进度条</span>
                    <el-progress :percentage="progressVal" striped striped-flow />
                  </div>
                  <div style="display: flex; gap: 20px;">
                    <el-progress type="circle" :percentage="progressVal" />
                    <el-progress type="dashboard" :percentage="progressVal" />
                  </div>
                  <el-slider v-model="progressVal" :max="100" />
                </div>
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="徽章 Badge">
                <div style="display: flex; gap: 30px; align-items: center;">
                  <el-badge :value="12" class="badge-item">
                    <el-button>消息</el-button>
                  </el-badge>
                  <el-badge :value="3" type="primary" class="badge-item">
                    <el-button>评论</el-button>
                  </el-badge>
                  <el-badge value="new" class="badge-item">
                    <el-button>新功能</el-button>
                  </el-badge>
                  <el-badge :value="200" :max="99" class="badge-item">
                    <el-button>通知</el-button>
                  </el-badge>
                  <el-badge is-dot class="badge-item">
                    <el-button>未读</el-button>
                  </el-badge>
                </div>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="描述列表">
                <el-descriptions :column="2" border>
                  <el-descriptions-item label="项目名称">AutoPilot</el-descriptions-item>
                  <el-descriptions-item label="版本">0.0.21</el-descriptions-item>
                  <el-descriptions-item label="作者">AI Agent Team</el-descriptions-item>
                  <el-descriptions-item label="许可证">MIT</el-descriptions-item>
                  <el-descriptions-item label="描述" :span="2">
                    浏览器内嵌 AI Agent SDK：让 AI 通过 tool-calling 操作网页
                  </el-descriptions-item>
                </el-descriptions>
              </el-card>
            </el-col>
          </el-row>
        </el-tab-pane>

        <!-- ===== Tab 3: 反馈组件 ===== -->
        <el-tab-pane label="反馈组件" name="feedback">
          <el-row :gutter="20">
            <el-col :span="12">
              <el-card header="对话框 Dialog">
                <el-button type="primary" @click="dialogVisible = true">打开对话框</el-button>
                <el-button type="warning" @click="confirmDialogVisible = true">确认对话框</el-button>

                <el-dialog v-model="dialogVisible" title="对话框标题" width="500px">
                  <el-form :model="dialogForm" label-width="80px">
                    <el-form-item label="活动名称">
                      <el-input v-model="dialogForm.name" placeholder="请输入活动名称" />
                    </el-form-item>
                    <el-form-item label="活动类型">
                      <el-select v-model="dialogForm.type" placeholder="请选择">
                        <el-option label="线上" value="online" />
                        <el-option label="线下" value="offline" />
                        <el-option label="混合" value="hybrid" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="开关">
                      <el-switch v-model="dialogForm.delivery" />
                    </el-form-item>
                  </el-form>
                  <template #footer>
                    <el-button @click="dialogVisible = false">取消</el-button>
                    <el-button type="primary" @click="onDialogConfirm">确定</el-button>
                  </template>
                </el-dialog>

                <el-dialog v-model="confirmDialogVisible" title="确认操作" width="400px">
                  <span>确定要执行此操作吗？此操作不可撤销。</span>
                  <template #footer>
                    <el-button @click="confirmDialogVisible = false">取消</el-button>
                    <el-button type="danger" @click="onConfirmAction">确认</el-button>
                  </template>
                </el-dialog>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="抽屉 Drawer">
                <el-button @click="drawerVisible = true">打开抽屉</el-button>
                <el-drawer v-model="drawerVisible" title="抽屉面板" size="400px">
                  <el-form label-width="80px">
                    <el-form-item label="标题">
                      <el-input v-model="drawerForm.title" placeholder="请输入标题" />
                    </el-form-item>
                    <el-form-item label="优先级">
                      <el-radio-group v-model="drawerForm.priority">
                        <el-radio value="high">高</el-radio>
                        <el-radio value="medium">中</el-radio>
                        <el-radio value="low">低</el-radio>
                      </el-radio-group>
                    </el-form-item>
                    <el-form-item label="描述">
                      <el-input v-model="drawerForm.desc" type="textarea" :rows="4" />
                    </el-form-item>
                    <el-form-item>
                      <el-button type="primary" @click="drawerVisible = false">保存</el-button>
                    </el-form-item>
                  </el-form>
                </el-drawer>
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="消息提示组合">
                <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                  <el-button @click="showMessage('success')">成功消息</el-button>
                  <el-button @click="showMessage('warning')">警告消息</el-button>
                  <el-button @click="showMessage('error')">错误消息</el-button>
                  <el-button @click="showMessage('info')">信息消息</el-button>
                  <el-button type="primary" @click="showNotification">通知</el-button>
                  <el-button type="warning" @click="showMsgBox">MessageBox</el-button>
                </div>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="Alert 警报">
                <div style="display: flex; flex-direction: column; gap: 10px;">
                  <el-alert title="成功提示" type="success" show-icon />
                  <el-alert title="警告提示" type="warning" show-icon />
                  <el-alert title="错误提示" type="error" show-icon />
                  <el-alert title="信息提示" type="info" show-icon description="这是一段描述文字" />
                </div>
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="24">
              <el-card header="Popconfirm 气泡确认 & Tooltip">
                <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap;">
                  <el-popconfirm
                    title="确定要删除吗？"
                    confirm-button-text="确认"
                    cancel-button-text="取消"
                    @confirm="onPopconfirm"
                  >
                    <template #reference>
                      <el-button type="danger">删除（气泡确认）</el-button>
                    </template>
                  </el-popconfirm>

                  <el-tooltip content="这是tooltip提示" placement="top">
                    <el-button>悬停提示</el-button>
                  </el-tooltip>

                  <el-popover placement="bottom" :width="200" trigger="click">
                    <template #reference>
                      <el-button>点击弹出</el-button>
                    </template>
                    <div>
                      <p>这是 Popover 的内容区域</p>
                      <el-button size="small" type="primary">操作</el-button>
                    </div>
                  </el-popover>
                </div>
              </el-card>
            </el-col>
          </el-row>
        </el-tab-pane>

        <!-- ===== Tab 4: 导航组件 ===== -->
        <el-tab-pane label="导航组件" name="nav">
          <el-row :gutter="20">
            <el-col :span="24">
              <el-card header="面包屑 Breadcrumb">
                <el-breadcrumb separator="/">
                  <el-breadcrumb-item>首页</el-breadcrumb-item>
                  <el-breadcrumb-item>组件</el-breadcrumb-item>
                  <el-breadcrumb-item>导航</el-breadcrumb-item>
                  <el-breadcrumb-item>面包屑</el-breadcrumb-item>
                </el-breadcrumb>
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="下拉菜单 Dropdown">
                <div style="display: flex; gap: 16px; flex-wrap: wrap;">
                  <el-dropdown @command="onDropdownCommand">
                    <el-button type="primary">
                      下拉菜单<el-icon class="el-icon--right"><arrow-down /></el-icon>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="action1">选项一</el-dropdown-item>
                        <el-dropdown-item command="action2">选项二</el-dropdown-item>
                        <el-dropdown-item command="action3" divided>选项三</el-dropdown-item>
                        <el-dropdown-item command="action4" disabled>选项四（禁用）</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>

                  <el-dropdown split-button type="success" @command="onDropdownCommand" @click="showMessage('success')">
                    拆分按钮
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="split1">操作 A</el-dropdown-item>
                        <el-dropdown-item command="split2">操作 B</el-dropdown-item>
                        <el-dropdown-item command="split3">操作 C</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="步骤条 Steps">
                <el-steps :active="stepsActive" finish-status="success" align-center>
                  <el-step title="创建账号" description="填写基本信息" />
                  <el-step title="验证邮箱" description="确认邮箱地址" />
                  <el-step title="设置偏好" description="选择偏好设置" />
                  <el-step title="完成" description="开始使用" />
                </el-steps>
                <div style="margin-top: 12px; text-align: center;">
                  <el-button @click="stepsActive = Math.max(0, stepsActive - 1)">上一步</el-button>
                  <el-button type="primary" @click="stepsActive = Math.min(3, stepsActive + 1)">下一步</el-button>
                </div>
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="折叠面板 Collapse">
                <el-collapse v-model="activeCollapse">
                  <el-collapse-item title="一致性 Consistency" name="1">
                    <p>与现实生活一致：与现实生活的流程、逻辑保持一致，遵循用户习惯的语言和概念。</p>
                  </el-collapse-item>
                  <el-collapse-item title="反馈 Feedback" name="2">
                    <p>控制反馈：通过界面样式和交互动效让用户可以清晰的感知自己的操作。</p>
                  </el-collapse-item>
                  <el-collapse-item title="效率 Efficiency" name="3">
                    <p>简化流程：设计简洁直觉的操作流程。</p>
                  </el-collapse-item>
                  <el-collapse-item title="可控 Controllability" name="4">
                    <p>用户决策：根据场景可给予用户操作建议或安全提示，但不能代替用户做决策。</p>
                  </el-collapse-item>
                </el-collapse>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="时间线 Timeline">
                <el-timeline>
                  <el-timeline-item timestamp="2026-02-28" placement="top" type="primary">
                    <h4>集成 Element Plus Demo</h4>
                    <p>在 AutoPilot demo 中引入 Element Plus 全量组件以验证交互</p>
                  </el-timeline-item>
                  <el-timeline-item timestamp="2026-02-25" placement="top" type="success">
                    <h4>完成核心 Agent Loop</h4>
                    <p>实现增量消费模型和快照优先级机制</p>
                  </el-timeline-item>
                  <el-timeline-item timestamp="2026-02-20" placement="top" type="warning">
                    <h4>工具注册系统</h4>
                    <p>实现 ToolRegistry 与 5 个内置浏览器工具</p>
                  </el-timeline-item>
                  <el-timeline-item timestamp="2026-02-15" placement="top" type="info">
                    <h4>项目启动</h4>
                    <p>初始化项目结构和基础架构</p>
                  </el-timeline-item>
                </el-timeline>
              </el-card>
            </el-col>
          </el-row>
        </el-tab-pane>

        <!-- ===== Tab 5: 按钮与其他 ===== -->
        <el-tab-pane label="按钮与其他" name="buttons">
          <el-row :gutter="20">
            <el-col :span="24">
              <el-card header="按钮组合">
                <div style="display: flex; flex-direction: column; gap: 16px;">
                  <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                    <el-button>默认按钮</el-button>
                    <el-button type="primary">主要按钮</el-button>
                    <el-button type="success">成功按钮</el-button>
                    <el-button type="info">信息按钮</el-button>
                    <el-button type="warning">警告按钮</el-button>
                    <el-button type="danger">危险按钮</el-button>
                  </div>
                  <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                    <el-button plain>朴素按钮</el-button>
                    <el-button type="primary" plain>主要按钮</el-button>
                    <el-button type="success" plain>成功按钮</el-button>
                    <el-button type="info" plain>信息按钮</el-button>
                    <el-button type="warning" plain>警告按钮</el-button>
                    <el-button type="danger" plain>危险按钮</el-button>
                  </div>
                  <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                    <el-button round>圆角按钮</el-button>
                    <el-button type="primary" round>主要按钮</el-button>
                    <el-button type="success" round>成功按钮</el-button>
                    <el-button :loading="btnLoading" type="primary" @click="handleBtnLoading">加载中</el-button>
                    <el-button type="primary" disabled>禁用按钮</el-button>
                    <el-button type="primary" size="large">大按钮</el-button>
                    <el-button type="primary" size="small">小按钮</el-button>
                  </div>
                  <div>
                    <el-button-group>
                      <el-button type="primary">上一页</el-button>
                      <el-button type="primary">下一页</el-button>
                    </el-button-group>
                  </div>
                </div>
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="树形组件 Tree">
                <el-tree
                  :data="treeData"
                  show-checkbox
                  default-expand-all
                  node-key="id"
                  highlight-current
                  :props="{ children: 'children', label: 'label' }"
                  @check-change="onTreeCheckChange"
                />
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="自动补全 Autocomplete">
                <el-form label-width="100px">
                  <el-form-item label="搜索建议">
                    <el-autocomplete
                      v-model="autocompleteVal"
                      :fetch-suggestions="querySearch"
                      placeholder="请输入关键词"
                      clearable
                      @select="onAutoSelect"
                    />
                  </el-form-item>
                </el-form>

                <el-divider content-position="left">Avatar & Space</el-divider>
                <el-space wrap>
                  <el-avatar :size="50">UA</el-avatar>
                  <el-avatar :size="50" style="background: #409eff">EP</el-avatar>
                  <el-avatar :size="50" style="background: #67c23a">AP</el-avatar>
                </el-space>

                <el-divider content-position="left">Skeleton</el-divider>
                <el-skeleton :rows="3" animated />
              </el-card>
            </el-col>
          </el-row>

          <el-row :gutter="20" style="margin-top: 20px">
            <el-col :span="12">
              <el-card header="数字统计 Statistic">
                <el-row :gutter="20">
                  <el-col :span="12">
                    <el-statistic title="日活用户" :value="268500" />
                  </el-col>
                  <el-col :span="12">
                    <el-statistic title="月活跃" :value="138">
                      <template #suffix>
                        <span style="font-size: 14px">万</span>
                      </template>
                    </el-statistic>
                  </el-col>
                </el-row>
              </el-card>
            </el-col>

            <el-col :span="12">
              <el-card header="图片预览 Image">
                <div style="display: flex; gap: 10px;">
                  <el-image
                    style="width: 100px; height: 100px"
                    src="https://picsum.photos/200/200?random=1"
                    fit="cover"
                    :preview-src-list="['https://picsum.photos/800/600?random=1', 'https://picsum.photos/800/600?random=2']"
                    :initial-index="0"
                  />
                  <el-image
                    style="width: 100px; height: 100px"
                    src="https://picsum.photos/200/200?random=2"
                    fit="cover"
                  />
                </div>
              </el-card>
            </el-col>
          </el-row>
        </el-tab-pane>

        <el-tab-pane label="Prompt 验证" name="prompt-check">
          <el-row :gutter="20">
            <el-col :span="16">
              <el-card header="同名项 + 关联元素切换验证">

                <el-form label-width="100px" size="default">
                  <el-form-item label="仓库路径">
                    <div class="prompt-check-row" :class="{ 'is-blurred': promptDemoTopBlurred }">
                      <div class="path-cell">
                        <el-input model-value="/team/repo-b" readonly />
                      </div>
                      <span
                        class="path-open path-open-decoy"
                        role="button"
                        tabindex="0"
                        aria-label="打开"
                        @mouseenter="onPromptDemoTopHover"
                        @mousedown="onPromptDemoTopMouseDown"
                        @click="onPromptDemoTopClick"
                        @keydown.enter.prevent="onPromptDemoTopClick('enter')"
                      >
                        <span class="open-level">L2</span>
                        <span class="open-shell">更多</span>
                        <span class="open-core">打开</span>
                      </span>
                    </div>
                  </el-form-item>

                  <el-form-item label="仓库路径">
                    <div class="prompt-check-row">
                      <el-input model-value="/team/repo-b" readonly />
                      <span
                        class="path-open path-open-real"
                        role="button"
                        tabindex="0"
                        aria-label="打开详情"
                        data-level="4"
                        @click="onPromptDemoRealOpen('/team/repo-b')"
                      >
                        <span class="open-level">L4</span>
                        <span class="open-chain">
                          <span>操作</span>
                          <span>进入</span>
                          <span class="open-core">打开</span>
                        </span>
                      </span>
                    </div>
                  </el-form-item>
                </el-form>

                <div class="prompt-check-actions">
                  <el-button size="small" @click="clearPromptDemoEvents">清空事件日志</el-button>
                </div>
              </el-card>
            </el-col>

            <el-col :span="8">
              <el-card header="事件日志">
                <div class="prompt-check-log">
                  <div v-if="promptDemoEvents.length === 0" class="prompt-check-empty">暂无事件</div>
                  <div v-for="(event, idx) in promptDemoEvents" :key="`${event}-${idx}`" class="prompt-check-log-item">
                    {{ event }}
                  </div>
                </div>
              </el-card>
            </el-col>
          </el-row>

          <el-dialog v-model="promptDemoDialogVisible" title="仓库详情" width="520px">
            <el-descriptions :column="1" border>
              <el-descriptions-item label="路径">{{ promptDemoSelectedPath }}</el-descriptions-item>
              <el-descriptions-item label="状态">已打开</el-descriptions-item>
            </el-descriptions>
            <template #footer>
              <el-button @click="promptDemoDialogVisible = false">关闭</el-button>
            </template>
          </el-dialog>
        </el-tab-pane>
      </el-tabs>
    </el-main>

    <!-- ======= 底部聊天面板 ======= -->
    <div class="dock" data-autopilot-ignore>
      <div class="dock-toggle" @click="dockExpanded = !dockExpanded">
        {{ dockExpanded ? '▲ 聊天面板 ▲' : '▼ 聊天面板 ▼' }}
      </div>
      <div v-show="dockExpanded" ref="chatContainer" class="chat-panel">
        <div v-for="(msg, i) in messages" :key="i" :class="['msg', msg.type]">
          {{ msg.text }}
        </div>
      </div>
      <div class="quick-actions">
        <el-button size="small" @click="sendQuick('把用户名填为 test_user，密码填为 123456')">填表单</el-button>
        <el-button size="small" @click="sendQuick('在城市选择器中选择上海')">选城市</el-button>
        <el-button size="small" @click="sendQuick('把单选框选为选项二，然后打开开关')">改单选+开关</el-button>
        <el-button size="small" @click="sendQuick('切换到数据展示tab，然后在表格搜索框输入张')">搜索表格</el-button>
        <el-button size="small" @click="sendQuick('打开对话框，然后在活动名称输入框填写 团建活动')">操作弹窗</el-button>
        <el-button size="small" @click="sendQuick('点击下一步按钮两次，让步骤条到第三步')">步骤条</el-button>
        <el-button size="small" @click="sendQuick('把评分设为4星，然后设置滑块值为75')">评分滑块</el-button>
        <el-button size="small" @click="sendQuick('切换到 Prompt 验证 tab，点击仓库路径 /team/repo-b 对应的打开按钮，查看弹窗内容')">Prompt验证</el-button>
        <el-button size="small" @click="clearHistory">清空记忆</el-button>
      </div>
      <div class="input-bar">
        <el-input
          v-model="chatInput"
          placeholder="输入要执行的网页操作"
          @keyup.enter="handleSend"
        />
        <el-button type="primary" @click="handleSend">发送</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, nextTick, onMounted, watch } from 'vue'
import { ElMessage, ElNotification, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { WebAgent } from '../src/web/index.js'
import type { ToolCallResult } from '../src/core/tool-registry.js'

// ===== Agent =====
const agent = new WebAgent({
  token: import.meta.env.DEEPSEEK_TOKEN ?? '',
  provider: 'deepseek',
  model: 'deepseek-chat',
  baseURL: '/api',
  stream: true,
})
agent.registerTools()
agent.setSystemPrompt('demo', [
  'You are operating the Element Plus demo page.',
  'Prefer minimal action arrays and complete independent visible actions in one round.',
  'Do not repeat verification calls unless the user explicitly asks for verification.',
].join(' '))

// ===== 连接状态 =====
const connected = ref(false)
const token = ref('')
const model = ref('deepseek-chat')
const streamMode = ref('json')
const dryRun = ref(false)
const memory = ref(false)

// ===== 聊天 =====
const messages = ref<{ type: string; text: string }[]>([])
const chatInput = ref('')
const chatContainer = ref<HTMLElement>()
const dockExpanded = ref(true)

// ===== 当前激活 Tab =====
const activeTab = ref('form')

// ===== 表单数据 =====
const form = reactive({
  username: '',
  password: '',
  email: '',
  bio: '',
  age: 25,
  city: '',
  tags: [] as string[],
  cascaderValue: [] as string[],
  date: '',
  dateRange: null as [Date, Date] | null,
  time: '',
  switchVal: false,
  radio: 'option1',
  radioButton: 'red',
  checkboxes: [] as string[],
  rate: 0,
  slider: 30,
  color: '#409eff',
  transferValue: [] as number[],
})

// ===== 级联选项 =====
const cascaderOptions = [
  {
    value: 'zhejiang',
    label: '浙江省',
    children: [
      { value: 'hangzhou', label: '杭州市', children: [{ value: 'xihu', label: '西湖区' }] },
      { value: 'ningbo', label: '宁波市', children: [{ value: 'jiangbei', label: '江北区' }] },
    ],
  },
  {
    value: 'jiangsu',
    label: '江苏省',
    children: [
      { value: 'nanjing', label: '南京市', children: [{ value: 'xuanwu', label: '玄武区' }] },
      { value: 'suzhou', label: '苏州市', children: [{ value: 'gusu', label: '姑苏区' }] },
    ],
  },
  {
    value: 'guangdong',
    label: '广东省',
    children: [
      { value: 'guangzhou', label: '广州市', children: [{ value: 'tianhe', label: '天河区' }] },
      { value: 'shenzhen', label: '深圳市', children: [{ value: 'nanshan', label: '南山区' }] },
    ],
  },
]

// ===== 穿梭框 =====
const transferData = Array.from({ length: 15 }, (_, i) => ({
  key: i,
  label: `选项 ${i + 1}`,
  disabled: i % 5 === 0,
}))

// ===== 表格 =====
const tableSearch = ref('')
const selectedRows = ref<any[]>([])
const pagination = reactive({ page: 1, pageSize: 10 })
const tableSeeds = [
  { name: '张三', age: 28, email: 'zhangsan@test.com', city: '北京', status: '活跃' },
  { name: '李四', age: 35, email: 'lisi@test.com', city: '上海', status: '离线' },
  { name: '王五', age: 22, email: 'wangwu@test.com', city: '广州', status: '活跃' },
  { name: '赵六', age: 31, email: 'zhaoliu@test.com', city: '深圳', status: '活跃' },
  { name: '钱七', age: 27, email: 'qianqi@test.com', city: '杭州', status: '离线' },
  { name: '孙八', age: 40, email: 'sunba@test.com', city: '成都', status: '活跃' },
  { name: '周九', age: 33, email: 'zhoujiu@test.com', city: '南京', status: '离线' },
  { name: '吴十', age: 29, email: 'wushi@test.com', city: '武汉', status: '活跃' },
] as const

const tableData = ref(
  Array.from({ length: 300 }, (_, i) => {
    const seed = tableSeeds[i % tableSeeds.length]
    return {
      name: `${seed.name}${Math.floor(i / tableSeeds.length) + 1}`,
      age: Math.min(60, Math.max(18, seed.age + ((i % 5) - 2))),
      email: `${seed.email.replace('@', `+${i + 1}@`)}`,
      city: seed.city,
      status: i % 3 === 0 ? '离线' : '活跃',
    }
  }),
)
const filteredTableData = computed(() => {
  if (!tableSearch.value) return tableData.value
  return tableData.value.filter(r => r.name.includes(tableSearch.value))
})

const paginatedTableData = computed(() => {
  const start = (pagination.page - 1) * pagination.pageSize
  const end = start + pagination.pageSize
  return filteredTableData.value.slice(start, end)
})

watch(tableSearch, () => {
  pagination.page = 1
})

watch(
  () => [filteredTableData.value.length, pagination.pageSize],
  () => {
    const maxPage = Math.max(1, Math.ceil(filteredTableData.value.length / pagination.pageSize))
    if (pagination.page > maxPage) {
      pagination.page = maxPage
    }
  },
)

// ===== 动态标签 =====
const dynamicTags = ref(['标签一', '标签二', '标签三'])
const tagInputVisible = ref(false)
const tagInputValue = ref('')
const tagInputRef = ref()

// ===== 进度条 =====
const progressVal = ref(40)

// ===== Dialog =====
const dialogVisible = ref(false)
const confirmDialogVisible = ref(false)
const dialogForm = reactive({ name: '', type: '', delivery: false })

// ===== Drawer =====
const drawerVisible = ref(false)
const drawerForm = reactive({ title: '', priority: 'medium', desc: '' })

// ===== Steps =====
const stepsActive = ref(1)

// ===== Collapse =====
const activeCollapse = ref(['1'])

// ===== Button loading =====
const btnLoading = ref(false)

// ===== Prompt 验证 Demo =====
const promptDemoDialogVisible = ref(false)
const promptDemoSelectedPath = ref('')
const promptDemoEvents = ref<string[]>([])
const promptDemoTopBlurred = ref(false)
const promptDemoTopTouched = ref(false)
let promptDemoBlurTimer: number | undefined

// ===== Tree =====
const treeData = [
  {
    id: 1,
    label: '一级 1',
    children: [
      {
        id: 11,
        label: '二级 1-1',
        children: [
          { id: 111, label: '三级 1-1-1' },
          { id: 112, label: '三级 1-1-2' },
        ],
      },
    ],
  },
  {
    id: 2,
    label: '一级 2',
    children: [
      { id: 21, label: '二级 2-1' },
      { id: 22, label: '二级 2-2' },
    ],
  },
  {
    id: 3,
    label: '一级 3',
    children: [
      { id: 31, label: '二级 3-1' },
      { id: 32, label: '二级 3-2' },
    ],
  },
]

// ===== Autocomplete =====
const autocompleteVal = ref('')
const restaurants = [
  { value: 'Element Plus' },
  { value: 'Vue.js' },
  { value: 'React' },
  { value: 'Angular' },
  { value: 'Svelte' },
  { value: 'TypeScript' },
  { value: 'AutoPilot' },
  { value: 'Vite' },
  { value: 'Webpack' },
]

// ===== 方法 =====
function appendMsg(type: string, text: string) {
  messages.value.push({ type, text })
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

agent.callbacks = {
  onRound: (round) => {
    appendMsg('system', `系统思考中 (第 ${round + 1} 轮)...`)
  },
  onText: (text) => appendMsg('assistant', text),
  onToolCall: (name, input) => appendMsg('tool-call', `${name}(${JSON.stringify(input)})`),
  onToolResult: (_name, result: ToolCallResult) => {
    const content = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content, null, 2)
    appendMsg('tool-result', content)
  },
  onMetrics: (metrics) => {
    appendMsg('system', `📊 ${JSON.stringify(metrics)}`)
  },
}

onMounted(() => {
  const savedToken = localStorage.getItem('ap_token')
  if (savedToken) {
    token.value = savedToken
    connected.value = true
  }
  appendMsg('system', `✅ 已注册工具：${agent.getTools().map(t => t.name).join(', ')}`)
})

function onTokenChange() {
  if (token.value.trim()) {
    localStorage.setItem('ap_token', token.value.trim())
    connected.value = true
  }
}

function onMemoryChange(val: boolean) {
  agent.setMemory(val)
  if (!val) agent.clearHistory()
  appendMsg('system', val ? '🧠 记忆已开启' : '🧠 记忆已关闭并清空')
}

async function handleSend() {
  const text = chatInput.value.trim()
  if (!text) return
  if (!token.value.trim()) {
    appendMsg('error', '请先填写 Token')
    return
  }
  chatInput.value = ''
  appendMsg('user', text)
  agent.setToken(token.value.trim())
  agent.setModel(model.value)
  agent.setStream(streamMode.value === 'stream')
  agent.setDryRun(dryRun.value)
  try {
    await agent.chat(text)
  } catch (error) {
    appendMsg('error', `执行失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function sendQuick(text: string) {
  chatInput.value = text
  handleSend()
}

function clearHistory() {
  agent.clearHistory()
  appendMsg('system', '已清空历史')
}

// 表单
function onFormSubmit() {
  ElMessage.success(`提交成功：${form.username}`)
}

function onFormReset() {
  form.username = ''
  form.password = ''
  form.email = ''
  form.bio = ''
  form.age = 25
  ElMessage.info('表单已重置')
}

// 表格
function onSelectionChange(rows: any[]) {
  selectedRows.value = rows
}

function onAddRow() {
  tableData.value.push({
    name: `新用户${tableData.value.length + 1}`,
    age: 20,
    email: `user${tableData.value.length + 1}@test.com`,
    city: '未知',
    status: '活跃',
  })
  ElMessage.success('已新增一行')
}

function onDeleteSelected() {
  if (selectedRows.value.length === 0) {
    ElMessage.warning('请先选择要删除的行')
    return
  }
  tableData.value = tableData.value.filter(r => !selectedRows.value.includes(r))
  selectedRows.value = []
  ElMessage.success('已删除选中行')
}

function onEditRow(row: any) {
  ElMessageBox.prompt('修改姓名', '编辑', { inputValue: row.name }).then(({ value }) => {
    row.name = value
    ElMessage.success('修改成功')
  }).catch(() => {})
}

function onRemoveRow(row: any) {
  const index = tableData.value.indexOf(row)
  if (index === -1) return
  tableData.value.splice(index, 1)
  ElMessage.success('已删除')
}

// 动态标签
function handleTagClose(tag: string) {
  dynamicTags.value.splice(dynamicTags.value.indexOf(tag), 1)
}

function showTagInput() {
  tagInputVisible.value = true
  nextTick(() => tagInputRef.value?.focus())
}

function handleTagConfirm() {
  if (tagInputValue.value) {
    dynamicTags.value.push(tagInputValue.value)
  }
  tagInputVisible.value = false
  tagInputValue.value = ''
}

// Dialog
function onDialogConfirm() {
  dialogVisible.value = false
  ElMessage.success(`活动「${dialogForm.name}」已保存`)
}

function onConfirmAction() {
  confirmDialogVisible.value = false
  ElMessage.success('操作已确认')
}

// 消息
function showMessage(type: 'success' | 'warning' | 'error' | 'info') {
  ElMessage({ message: `这是一条${type}消息`, type })
}

function showNotification() {
  ElNotification({ title: '通知标题', message: '这是一条通知消息', type: 'success' })
}

function showMsgBox() {
  ElMessageBox.confirm('此操作将永久删除该数据，是否继续？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning',
  }).then(() => {
    ElMessage.success('删除成功')
  }).catch(() => {
    ElMessage.info('已取消')
  })
}

// Popconfirm
function onPopconfirm() {
  ElMessage.success('已确认删除')
}

// Dropdown
function onDropdownCommand(command: string) {
  ElMessage.info(`选择了：${command}`)
}

// Button loading
function handleBtnLoading() {
  btnLoading.value = true
  setTimeout(() => { btnLoading.value = false }, 2000)
}

// Tree
function onTreeCheckChange(data: any, checked: boolean) {
  if (checked) {
    ElMessage.info(`选中了：${data.label}`)
  }
}

// Autocomplete
function querySearch(queryString: string, cb: (results: { value: string }[]) => void) {
  const results = queryString
    ? restaurants.filter(r => r.value.toLowerCase().includes(queryString.toLowerCase()))
    : restaurants
  cb(results)
}

function onAutoSelect(item: { value: string }) {
  ElMessage.success(`选择了：${item.value}`)
}

function onPromptDemoRealOpen(path: string) {
  promptDemoSelectedPath.value = path
  promptDemoDialogVisible.value = true
  promptDemoEvents.value.unshift(`OPEN_OK ${path}`)
}

function onPromptDemoTopHover() {
  if (promptDemoBlurTimer !== undefined) {
    window.clearTimeout(promptDemoBlurTimer)
  }
  promptDemoTopBlurred.value = true
  promptDemoEvents.value.unshift('HOVER_TOP_OPEN')
  promptDemoBlurTimer = window.setTimeout(() => {
    promptDemoTopBlurred.value = false
  }, 500)
}

function onPromptDemoTopMouseDown() {
  promptDemoEvents.value.unshift('TOP_MOUSEDOWN_NOOP')
}

function onPromptDemoTopClick(trigger: 'click' | 'enter' = 'click') {
  promptDemoTopTouched.value = true
  promptDemoEvents.value.unshift(`TOP_${trigger.toUpperCase()}_NOOP`)
  ElMessage.info('仅触发预览事件，未打开仓库详情')
}

function clearPromptDemoEvents() {
  promptDemoEvents.value = []
}
</script>

<style>
/* 全局样式 */
html, body {
  margin: 0;
  padding: 0;
  background: #f5f7fa;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.app-container {
  padding-bottom: 300px;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 20px !important;
  height: auto !important;
  flex-wrap: wrap;
  gap: 8px;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.topbar-left h1 {
  margin: 0;
  font-size: 16px;
  color: #303133;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.main-content {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px !important;
}

/* 聊天面板 */
.dock {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: #fff;
  border-top: 1px solid #dcdfe6;
  max-height: 46vh;
  display: flex;
  flex-direction: column;
  z-index: 200;
  box-shadow: 0 -2px 12px rgba(0,0,0,0.08);
}

.dock-toggle {
  text-align: center;
  font-size: 12px;
  color: #909399;
  padding: 4px;
  cursor: pointer;
  background: #fafafa;
  border-bottom: 1px solid #ebeef5;
}

.chat-panel {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.msg {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
}
.msg.user { align-self: flex-end; background: #ecf5ff; color: #409eff; }
.msg.assistant { align-self: flex-start; background: #f4f4f5; color: #303133; }
.msg.tool-call { align-self: flex-start; background: #f0f9eb; border-left: 3px solid #67c23a; color: #303133; }
.msg.tool-result { align-self: flex-start; background: #ecf5ff; border-left: 3px solid #409eff; color: #303133; }
.msg.system { align-self: flex-start; background: #fdf6ec; color: #e6a23c; }
.msg.error { align-self: flex-start; background: #fef0f0; color: #f56c6c; }

.quick-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-top: 1px solid #ebeef5;
}

.input-bar {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid #ebeef5;
}

.badge-item {
  margin-right: 8px;
}

/* Element Plus 卡片间距 */
.el-card {
  margin-bottom: 0;
}

.el-card__header {
  padding: 12px 16px;
  font-weight: 600;
  font-size: 14px;
}

.prompt-check-row {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
}

.path-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.path-hint {
  font-size: 11px;
  color: #909399;
}

.path-open {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  color: #606266;
  line-height: 30px;
  user-select: none;
}

.prompt-check-row.is-blurred .path-open {
  filter: blur(1.2px);
}

.path-open-decoy {
  cursor: pointer;
}

.path-open-real {
  cursor: pointer;
}

.open-level {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  line-height: 1;
  color: #909399;
  background: #f4f4f5;
}

.open-shell {
  color: #909399;
}

.open-chain {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.open-core {
  color: #303133;
}

.prompt-check-actions {
  margin-top: 10px;
}

.prompt-check-log {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 120px;
}

.prompt-check-empty {
  font-size: 12px;
  color: #909399;
}

.prompt-check-log-item {
  font-size: 12px;
  line-height: 1.4;
  padding: 6px 8px;
  border-radius: 6px;
  background: #f4f4f5;
  color: #303133;
}
</style>
