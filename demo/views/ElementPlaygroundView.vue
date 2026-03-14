<template>
  <el-card shadow="never" class="playground-card">
    <template #header>
      <div class="header-row">
        <div>
          <h3>Element 组件测试台</h3>
          <p>集中验证常用组件交互：Tab、表单、表格、树、弹窗、抽屉。</p>
        </div>
        <el-tag type="success">AI 测试专用</el-tag>
      </div>
    </template>

    <el-tabs v-model="activeTab" type="border-card">
      <el-tab-pane label="表单组件" name="form">
        <el-form :model="form" label-width="110px" class="form-grid">
          <el-form-item label="用户名">
            <el-input v-model="form.username" placeholder="请输入用户名" />
          </el-form-item>
          <el-form-item label="邮箱">
            <el-input v-model="form.email" placeholder="请输入邮箱" />
          </el-form-item>
          <el-form-item label="城市">
            <el-select v-model="form.city" placeholder="请选择城市" style="width: 100%">
              <el-option label="北京" value="beijing" />
              <el-option label="上海" value="shanghai" />
              <el-option label="深圳" value="shenzhen" />
            </el-select>
          </el-form-item>
          <el-form-item label="日期范围">
            <el-date-picker
              v-model="form.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="功能开关">
            <el-switch v-model="form.enabled" />
          </el-form-item>
          <el-form-item label="优先级">
            <el-radio-group v-model="form.priority">
              <el-radio label="low">低</el-radio>
              <el-radio label="medium">中</el-radio>
              <el-radio label="high">高</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="标签">
            <el-checkbox-group v-model="form.tags">
              <el-checkbox label="核心" />
              <el-checkbox label="灰度" />
              <el-checkbox label="高风险" />
            </el-checkbox-group>
          </el-form-item>
          <el-form-item label="满意度">
            <el-rate v-model="form.rate" />
          </el-form-item>
          <el-form-item label="阈值">
            <el-slider v-model="form.threshold" :max="100" />
          </el-form-item>
          <el-form-item label="主题色">
            <el-color-picker v-model="form.color" />
          </el-form-item>
          <el-form-item label="备注" class="span-2">
            <el-input v-model="form.note" type="textarea" :rows="3" placeholder="请输入备注" />
          </el-form-item>
          <el-form-item class="span-2">
            <el-space>
              <el-button type="primary" @click="onSubmit">提交</el-button>
              <el-button @click="onReset">重置</el-button>
            </el-space>
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="数据组件" name="data">
        <el-space direction="vertical" fill :size="16" style="width: 100%">
          <el-input v-model="search" placeholder="搜索姓名" clearable />
          <el-table :data="filteredRows" border style="width: 100%" @selection-change="onSelectionChange">
            <el-table-column type="selection" width="55" />
            <el-table-column prop="name" label="姓名" />
            <el-table-column prop="role" label="角色" />
            <el-table-column prop="city" label="城市" />
            <el-table-column prop="status" label="状态">
              <template #default="scope">
                <el-tag :type="scope.row.status === '启用' ? 'success' : 'info'">{{ scope.row.status }}</el-tag>
              </template>
            </el-table-column>
          </el-table>

          <el-tree
            :data="treeData"
            show-checkbox
            node-key="id"
            default-expand-all
            :props="{ children: 'children', label: 'label' }"
          />

          <el-pagination
            background
            layout="total, prev, pager, next"
            :total="68"
            :page-size="10"
          />
        </el-space>
      </el-tab-pane>

      <el-tab-pane label="反馈组件" name="feedback">
        <el-space wrap>
          <el-button type="success" @click="openDialog = true">打开 Dialog</el-button>
          <el-button type="primary" @click="openDrawer = true">打开 Drawer</el-button>
          <el-button type="warning" @click="notify">通知</el-button>
          <el-button type="danger" @click="confirmAction">确认框</el-button>
        </el-space>

        <el-alert
          title="测试说明"
          type="info"
          show-icon
          style="margin-top: 16px"
          description="这个 Tab 用于验证 AI 对反馈类组件（Dialog/Drawer/MessageBox/Notification）的打开、填写与确认。"
        />
      </el-tab-pane>
    </el-tabs>
  </el-card>

  <el-dialog v-model="openDialog" title="发布确认" width="520px">
    <el-form :model="dialogForm" label-width="90px">
      <el-form-item label="发布单号">
        <el-input v-model="dialogForm.releaseNo" placeholder="如 REL-2026-001" />
      </el-form-item>
      <el-form-item label="执行人">
        <el-input v-model="dialogForm.operator" placeholder="请输入执行人" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="openDialog = false">取消</el-button>
      <el-button type="primary" @click="openDialog = false">确认</el-button>
    </template>
  </el-dialog>

  <el-drawer v-model="openDrawer" title="资源组配置" direction="rtl" size="420px">
    <el-form :model="drawerForm" label-width="90px">
      <el-form-item label="资源组">
        <el-select v-model="drawerForm.group" placeholder="请选择资源组" style="width: 100%">
          <el-option label="华东核心组" value="east-core" />
          <el-option label="全国运营组" value="nation-ops" />
          <el-option label="安全审计组" value="security-audit" />
        </el-select>
      </el-form-item>
      <el-form-item label="说明">
        <el-input v-model="drawerForm.remark" type="textarea" :rows="4" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="openDrawer = false">保存</el-button>
      </el-form-item>
    </el-form>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'

const activeTab = ref('form')
const openDialog = ref(false)
const openDrawer = ref(false)
const search = ref('')

const form = reactive({
  username: '',
  email: '',
  city: '',
  dateRange: [] as string[] | Date[],
  enabled: true,
  priority: 'medium',
  tags: [] as string[],
  rate: 3,
  threshold: 35,
  color: '#409EFF',
  note: '',
})

const dialogForm = reactive({
  releaseNo: '',
  operator: '',
})

const drawerForm = reactive({
  group: '',
  remark: '',
})

const rows = [
  { name: '张三', role: '前端工程师', city: '上海', status: '启用' },
  { name: '李四', role: '测试工程师', city: '北京', status: '停用' },
  { name: '王五', role: '产品经理', city: '深圳', status: '启用' },
  { name: '赵六', role: '运维工程师', city: '杭州', status: '启用' },
]

const filteredRows = computed(() => {
  const q = search.value.trim()
  if (!q) return rows
  return rows.filter((r) => r.name.includes(q) || r.role.includes(q) || r.city.includes(q))
})

const treeData = [
  {
    id: 1,
    label: '平台配置',
    children: [
      { id: 11, label: '开通应用实例' },
      { id: 12, label: '租户管理' },
    ],
  },
  {
    id: 2,
    label: '财务中心',
    children: [
      { id: 21, label: '对账批次' },
      { id: 22, label: '结算单' },
    ],
  },
]

function onSelectionChange(_rows: unknown[]) {
  // 保留回调用于 AI 测试表格选择动作。
}

function onSubmit() {
  ElMessage.success('表单已提交')
}

function onReset() {
  form.username = ''
  form.email = ''
  form.city = ''
  form.dateRange = []
  form.enabled = true
  form.priority = 'medium'
  form.tags = []
  form.rate = 3
  form.threshold = 35
  form.color = '#409EFF'
  form.note = ''
  ElMessage.info('已重置')
}

function notify() {
  ElNotification({ title: '提示', message: '这是一个通知示例', type: 'success' })
}

async function confirmAction() {
  try {
    await ElMessageBox.confirm('确认执行危险操作吗？', '二次确认', {
      type: 'warning',
      confirmButtonText: '确认',
      cancelButtonText: '取消',
    })
    ElMessage.success('已确认')
  } catch {
    ElMessage.info('已取消')
  }
}
</script>

<style scoped>
.playground-card {
  margin-top: 14px;
  border-radius: 12px;
}

.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.header-row h3 {
  margin: 0;
  font-size: 18px;
}

.header-row p {
  margin: 6px 0 0;
  color: #606266;
  font-size: 13px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
}

.span-2 {
  grid-column: span 2;
}
</style>
