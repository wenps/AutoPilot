<template>
  <div class="app-container">
    <el-header class="topbar">
      <div class="topbar-left">
        <h1>AutoPilot · B 端多路由复杂场景 Demo</h1>
        <el-tag :type="connected ? 'success' : 'danger'" size="small">
          {{ connected ? '已连接' : '未连接' }}
        </el-tag>
      </div>
      <div class="topbar-right">
        <el-input
          v-model="token"
          type="password"
          placeholder="MiniMax Token"
          size="small"
          style="width: 260px"
          show-password
          @change="onTokenChange"
        />
        <el-select v-model="model" size="small" style="width: 200px">
          <el-option label="MiniMax-M2.5" value="MiniMax-M2.5" />
          <el-option label="MiniMax-M2.5-highspeed" value="MiniMax-M2.5-highspeed" />
          <el-option label="MiniMax-M2.1" value="MiniMax-M2.1" />
        </el-select>
        <el-select v-model="streamMode" size="small" style="width: 100px">
          <el-option label="stream" value="stream" />
          <el-option label="json" value="json" />
        </el-select>
        <el-checkbox v-model="dryRun" size="small">Dry-run</el-checkbox>
        <el-checkbox v-model="memory" size="small" @change="onMemoryChange">Memory</el-checkbox>
      </div>
    </el-header>

    <el-main class="main-content">
      <el-container class="route-layout">
        <el-aside class="route-sidebar" width="280px">
          <el-card shadow="never" class="route-nav-card">
            <template #header>
              <div class="sidebar-header">
                <div>
                  <div class="sidebar-title">业务导航</div>
                  <div class="sidebar-subtitle">模拟真实 B 端项目的多级菜单</div>
                </div>
                <div class="sidebar-header-actions">
                  <el-button size="small" @click="quickDrawerVisible = true">快捷指令</el-button>
                  <el-tag type="primary" size="small">{{ currentRouteMeta?.code || 'workspace:overview' }}</el-tag>
                </div>
              </div>
            </template>

            <div v-for="group in sidebarGroups" :key="group.title" class="menu-group">
              <div class="menu-group-title">{{ group.title }}</div>
              <el-menu :default-active="route.path" router class="route-menu">
                <el-menu-item v-for="item in group.children" :key="item.path" :index="item.path">
                  <div class="menu-item-main">
                    <span>{{ item.title }}</span>
                    <small>{{ item.caption }}</small>
                  </div>
                </el-menu-item>
              </el-menu>
            </div>
          </el-card>
        </el-aside>

        <el-main class="route-main">
          <el-card class="route-meta-card" shadow="never">
            <div class="route-meta-top">
              <div>
                <div class="route-section">{{ currentRouteMeta?.section || '工作台' }}</div>
                <h2>{{ currentRouteMeta?.title || '场景总览' }}</h2>
                <p>{{ currentRouteMeta?.description || '用于测试 AI 跨菜单导航、深层页面定位和复杂创建链路。' }}</p>
              </div>
              <div class="route-path-box">
                <span class="route-path-label">当前路径</span>
                <strong>{{ route.path }}</strong>
              </div>
            </div>

            <div class="route-breadcrumbs">
              <el-breadcrumb separator="/">
                <el-breadcrumb-item v-for="(item, idx) in currentRouteMeta?.breadcrumbs || []" :key="`${item}-${idx}`">
                  {{ item }}
                </el-breadcrumb-item>
              </el-breadcrumb>
            </div>

            <div class="route-scenario">
              <span class="route-scenario-label">测试目标：</span>
              <span>{{ currentRouteMeta?.scenario }}</span>
            </div>
          </el-card>

          <router-view />
        </el-main>
      </el-container>
    </el-main>

    <!-- 快捷指令抽屉 -->
    <el-drawer v-model="quickDrawerVisible" title="快捷指令" direction="rtl" size="360px">
      <div class="quick-drawer-list">
        <div
          v-for="action in quickActions"
          :key="action.label"
          class="quick-drawer-item"
          @click="sendQuick(action.prompt)"
        >
          <div class="quick-drawer-item-label">{{ action.label }}</div>
          <div class="quick-drawer-item-desc">{{ action.prompt }}</div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, nextTick, onMounted, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { ElMessage, ElNotification, ElMessageBox } from 'element-plus'
import { WebAgent } from '../src/web/index.js'

import { demoMenuGroups, getDemoRouteMeta } from './router'

// ===== Agent =====
const agent = new WebAgent({
  token: (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.MINIMAX_TOKEN ?? '',
  provider: 'minimax',
  model: 'MiniMax-M2.5-highspeed',
  stream: false,
  panel: {
    enableMask: true,
    expanded: false,
    title: 'AutoPilot',
    placeholder: '输入要执行的网页操作...',
  },
})
agent.registerTools()
agent.setSystemPrompt('demo', [
  'You are operating a routed enterprise admin demo page.',
  'Use the visible sidebar menu, breadcrumb, route info card, forms, drawers, nested dialogs, tabs, trees, and tables to navigate and complete tasks.',
  'Prefer minimal action arrays and complete independent visible actions in one round.',
  'Do not repeat verification calls unless the user explicitly asks for verification.',
].join(' '))

const route = useRoute()
const sidebarGroups = demoMenuGroups
const currentRouteMeta = computed(() => getDemoRouteMeta(route))
const quickActions = computed(() => [
  {
    label: '总览路线',
    prompt: '先查看左侧业务导航，确认有哪些深层级测试页面。',
  },
  {
    label: '创建发布单',
    prompt: '进入运营中心的“新建发布单”页面，创建一个名为「支付域夜间灰度发布」的发布单，并提交审批。',
  },
  {
    label: '准入申请',
    prompt: '进入采购中心的供应商准入申请页，点击“新建准入申请”，创建一个华东区域的物流供应商申请并提交。',
  },
  {
    label: '企业客户',
    prompt: '进入主数据中心的新建企业客户页面，创建企业客户“星云零售集团”，并填写结算与联系人信息。',
  },
  {
    label: '开通实例',
    prompt: '进入平台配置的开通应用实例页面，点击“开通新实例”，为租户“华北一区”开通 BI 分析平台实例并确认。',
  },
  {
    label: '对账批次',
    prompt: '进入财务中心的新建对账批次页面，创建一个名为「2026-03 华东渠道对账批次」的批次，并确认生成。',
  },
  {
    label: '工单升级',
    prompt: '进入服务台的工单升级申请页面，搜索支付，对支付工单发起升级，并选择支付故障升级群后提交。',
  },
  {
    label: '权限模板',
    prompt: '进入安全中心的新建权限模板页面，创建一个“区域运营管理员模板”，切到资源组页并添加一个资源组。',
  },
  {
    label: '组件压测',
    prompt: '进入组件实验室的 Element 测试台，依次切换三个 Tab，填写并提交表单，选择一行表格数据，再打开并确认 Dialog 与 Drawer。',
  },
])

// ===== 连接状态 =====
const connected = ref(false)
const token = ref('')
const model = ref('MiniMax-M2.5')
const streamMode = ref('json')
const dryRun = ref(false)
const memory = ref(false)

// ===== 快捷指令抽屉 =====
const quickDrawerVisible = ref(false)

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

// ===== 搜索回车触发验证 =====
const enterSearchQuery = ref('')
const enterSearchAppliedQuery = ref('')
const enterSearchApplied = ref(false)
const enterSearchEvents = ref<string[]>([])
const enterSearchData = [
  { name: 'autopilot', lang: 'TypeScript', stars: 128 },
  { name: 'vue-next', lang: 'TypeScript', stars: 4200 },
  { name: 'react', lang: 'JavaScript', stars: 21000 },
  { name: 'angular', lang: 'TypeScript', stars: 9500 },
  { name: 'svelte', lang: 'JavaScript', stars: 7600 },
  { name: 'vite', lang: 'TypeScript', stars: 6300 },
  { name: 'webpack', lang: 'JavaScript', stars: 6400 },
  { name: 'esbuild', lang: 'Go', stars: 3700 },
]
const enterSearchResults = computed(() => {
  if (!enterSearchApplied.value || !enterSearchAppliedQuery.value) return enterSearchData
  const q = enterSearchAppliedQuery.value.toLowerCase()
  return enterSearchData.filter(r => r.name.toLowerCase().includes(q) || r.lang.toLowerCase().includes(q))
})
function onEnterSearch() {
  enterSearchAppliedQuery.value = enterSearchQuery.value
  enterSearchApplied.value = true
  enterSearchEvents.value.unshift(`SEARCH "${enterSearchQuery.value}" → ${enterSearchResults.value.length} results`)
}
function onClearEnterSearch() {
  enterSearchQuery.value = ''
  enterSearchAppliedQuery.value = ''
  enterSearchApplied.value = false
  enterSearchEvents.value.unshift('CLEAR')
}
function onResetEnterSearch() {
  enterSearchQuery.value = ''
  enterSearchAppliedQuery.value = ''
  enterSearchApplied.value = false
  enterSearchEvents.value = []
}

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

// ===== Agent 回调 =====
// Panel 通过 wirePanel 自动处理消息展示，这里只扩展额外回调（不要覆盖整个 callbacks 对象）
agent.callbacks.onMetrics = (metrics) => {
  console.log('📊 Metrics:', metrics)
}

onMounted(() => {
  const savedToken = localStorage.getItem('ap_token')
  if (savedToken) {
    token.value = savedToken
    connected.value = true
  }
  // 面板中添加工具信息
  agent.panel?.addMessage('tool', `✅ 已注册工具：${agent.getTools().map(t => t.name).join(', ')}`)
})

function onTokenChange() {
  if (token.value.trim()) {
    localStorage.setItem('ap_token', token.value.trim())
    connected.value = true
    agent.setToken(token.value.trim())
  }
}

// 保持 agent 配置与顶栏选项实时同步（用户可能直接在 Panel 中发送消息）
watch(model, (v) => agent.setModel(v))
watch(streamMode, (v) => agent.setStream(v === 'stream'))
watch(dryRun, (v) => agent.setDryRun(v))

function onMemoryChange(val: boolean) {
  agent.setMemory(val)
  if (!val) agent.clearHistory()
  agent.panel?.addMessage('tool', val ? '🧠 记忆已开启' : '🧠 记忆已关闭并清空')
}

function sendQuick(text: string) {
  if (!token.value.trim()) {
    ElMessage.warning('请先填写 Token')
    return
  }
  quickDrawerVisible.value = false
  // 同步最新配置到 agent
  agent.setToken(token.value.trim())
  agent.setModel(model.value)
  agent.setStream(streamMode.value === 'stream')
  agent.setDryRun(dryRun.value)
  // 通过面板发送（自动展开面板 + 显示消息）
  if (agent.panel) {
    agent.panel.show()
    agent.panel.onSend?.(text)
  }
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
    city: '北京',
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
  padding-bottom: 40px;
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
  max-width: 1580px;
  margin: 0 auto;
  padding: 20px !important;
}

.route-layout {
  gap: 20px;
  align-items: flex-start;
}

.route-sidebar {
  position: sticky;
  top: 20px;
}

.route-nav-card {
  border-radius: 16px;
}

.sidebar-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 16px;
  font-weight: 700;
  color: #303133;
}

.sidebar-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}

.menu-group + .menu-group {
  margin-top: 18px;
}

.menu-group-title {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #909399;
}

.route-menu {
  border-right: 0;
}

.menu-item-main {
  display: flex;
  flex-direction: column;
  line-height: 1.4;
}

.menu-item-main small {
  color: #909399;
}

.route-main {
  padding: 0 !important;
}

.route-meta-card {
  margin-bottom: 20px;
  border-radius: 16px;
}

.route-meta-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.route-meta-top h2 {
  margin: 8px 0;
  font-size: 28px;
  color: #303133;
}

.route-meta-top p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: #606266;
}

.route-section {
  display: inline-flex;
  padding: 4px 10px;
  border-radius: 999px;
  background: #ecf5ff;
  color: #409eff;
  font-size: 12px;
  font-weight: 600;
}

.route-path-box {
  min-width: 260px;
  padding: 14px 16px;
  border-radius: 12px;
  background: #f7f9fc;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.route-path-label {
  font-size: 12px;
  color: #909399;
}

.route-breadcrumbs {
  margin-top: 16px;
}

.route-scenario {
  margin-top: 14px;
  font-size: 13px;
  line-height: 1.6;
  color: #606266;
}

.route-scenario-label {
  font-weight: 700;
  color: #303133;
}

/* 快捷指令抽屉 */
.quick-drawer-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.quick-drawer-item {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #ebeef5;
  cursor: pointer;
  transition: all 0.2s;
}

.quick-drawer-item:hover {
  border-color: #409eff;
  background: #ecf5ff;
}

.quick-drawer-item-label {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
}

.quick-drawer-item-desc {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
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
