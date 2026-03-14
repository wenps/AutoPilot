import { createRouter, createWebHistory, type RouteLocationNormalizedLoaded, type RouteRecordRaw } from 'vue-router'
import WorkspaceOverviewView from './views/WorkspaceOverviewView.vue'
import ChangeReleaseCreateView from './views/ChangeReleaseCreateView.vue'
import SupplierOnboardingCreateView from './views/SupplierOnboardingCreateView.vue'
import CustomerCreateView from './views/CustomerCreateView.vue'
import AppProvisionCreateView from './views/AppProvisionCreateView.vue'
import FinanceReconciliationBatchCreateView from './views/FinanceReconciliationBatchCreateView.vue'
import ServiceDeskEscalationCreateView from './views/ServiceDeskEscalationCreateView.vue'
import PermissionPackageCreateView from './views/PermissionPackageCreateView.vue'
import ElementPlaygroundView from './views/ElementPlaygroundView.vue'

export type DemoRouteMeta = {
  title: string
  section: string
  code: string
  description: string
  scenario: string
  breadcrumbs: string[]
}

export type DemoMenuGroup = {
  title: string
  children: Array<{
    title: string
    path: string
    caption: string
  }>
}

export const demoMenuGroups: DemoMenuGroup[] = [
  {
    title: '工作台',
    children: [
      {
        title: '场景总览',
        path: '/workspace/overview',
        caption: '查看全部测试路线和推荐任务',
      },
    ],
  },
  {
    title: '运营中心',
    children: [
      {
        title: '新建发布单',
        path: '/operations/change/release/create',
        caption: '深层级变更发布申请页',
      },
    ],
  },
  {
    title: '采购中心',
    children: [
      {
        title: '供应商准入申请',
        path: '/procurement/supplier/onboarding/request/create',
        caption: '从列表进入抽屉创建申请',
      },
    ],
  },
  {
    title: '主数据中心',
    children: [
      {
        title: '新建企业客户',
        path: '/master-data/customer/corporate/profile/create',
        caption: '多分组企业客户档案创建页',
      },
    ],
  },
  {
    title: '平台配置',
    children: [
      {
        title: '开通应用实例',
        path: '/platform/tenant-center/application/provisioning/create',
        caption: '带步骤和弹窗确认的开通流程',
      },
    ],
  },
  {
    title: '财务中心',
    children: [
      {
        title: '新建对账批次',
        path: '/finance/reconciliation/statement/batch/create',
        caption: '抽屉 + Tab + 二次确认的对账批次创建页',
      },
    ],
  },
  {
    title: '服务台',
    children: [
      {
        title: '工单升级申请',
        path: '/service-desk/ticket/workbench/escalation/create',
        caption: '列表筛选后进入抽屉，再弹窗选群组',
      },
    ],
  },
  {
    title: '安全中心',
    children: [
      {
        title: '权限包模板',
        path: '/security/access-control/package/template/create',
        caption: '树形权限 + Tab + 资源组抽屉配置页',
      },
    ],
  },
  {
    title: '组件实验室',
    children: [
      {
        title: 'Element 测试台',
        path: '/labs/element/playground',
        caption: 'Tab + 常用组件集中测试页面',
      },
    ],
  },
]

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/workspace/overview',
  },
  {
    path: '/workspace/overview',
    component: WorkspaceOverviewView,
    meta: {
      title: '场景总览',
      section: '工作台',
      code: 'workspace:overview',
      description: '总览路由地图、推荐测试口令和当前场景说明。',
      scenario: '先熟悉左侧菜单和各条深层业务路径，再让 AI 按路径进入具体创建页。',
      breadcrumbs: ['工作台', '场景总览'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/operations/change/release/create',
    component: ChangeReleaseCreateView,
    meta: {
      title: '新建发布单',
      section: '运营中心',
      code: 'ops:change:release:create',
      description: '真实 B 端风格的发布单创建页，含变更信息、窗口安排、执行步骤。',
      scenario: '适合测试 AI 导航到深层菜单后，按字段要求填写并提交发布单。',
      breadcrumbs: ['运营中心', '变更管理', '发布单', '新建发布单'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/procurement/supplier/onboarding/request/create',
    component: SupplierOnboardingCreateView,
    meta: {
      title: '供应商准入申请',
      section: '采购中心',
      code: 'purchase:supplier:onboarding:create',
      description: '先到申请列表，再通过右上角按钮进入抽屉式创建流程。',
      scenario: '适合测试 AI 先筛选、再打开抽屉、最后填写并提交供应商准入申请。',
      breadcrumbs: ['采购中心', '供应商管理', '准入申请', '新建申请'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/master-data/customer/corporate/profile/create',
    component: CustomerCreateView,
    meta: {
      title: '新建企业客户',
      section: '主数据中心',
      code: 'mdm:customer:corp:create',
      description: '企业客户建档页，包含基础、结算、联系人和标签配置。',
      scenario: '适合测试 AI 在多分组表单中按业务要求连续填写多个字段并完成创建。',
      breadcrumbs: ['主数据中心', '客户资料', '企业客户', '新建企业客户'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/platform/tenant-center/application/provisioning/create',
    component: AppProvisionCreateView,
    meta: {
      title: '开通应用实例',
      section: '平台配置',
      code: 'platform:tenant:app:provision:create',
      description: '租户中心应用开通页，包含环境配置、步骤流和最终确认弹窗。',
      scenario: '适合测试 AI 在深路径页面中打开弹窗、完成实例参数配置并确认开通。',
      breadcrumbs: ['平台配置', '租户中心', '应用开通', '新建实例'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/finance/reconciliation/statement/batch/create',
    component: FinanceReconciliationBatchCreateView,
    meta: {
      title: '新建对账批次',
      section: '财务中心',
      code: 'finance:reconciliation:batch:create',
      description: '对账批次创建页，包含筛选列表、抽屉 Tab 和最终确认弹窗。',
      scenario: '适合测试 AI 进入深层财务路由后，打开抽屉、切换 Tab、配置规则并确认生成批次。',
      breadcrumbs: ['财务中心', '对账管理', '批次作业', '新建对账批次'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/service-desk/ticket/workbench/escalation/create',
    component: ServiceDeskEscalationCreateView,
    meta: {
      title: '工单升级申请',
      section: '服务台',
      code: 'service-desk:ticket:escalation:create',
      description: '工单工作台升级页，支持列表筛选、按行发起升级、抽屉内再开群组弹窗。',
      scenario: '适合测试 AI 先筛选列表，再对某一行打开升级抽屉，并在内层弹窗选择群组后提交。',
      breadcrumbs: ['服务台', '工单中心', '工作台', '工单升级申请'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/security/access-control/package/template/create',
    component: PermissionPackageCreateView,
    meta: {
      title: '权限包模板',
      section: '安全中心',
      code: 'security:access:package-template:create',
      description: '权限包模板页，包含树形菜单勾选、数据范围配置和资源组抽屉。',
      scenario: '适合测试 AI 在复杂权限页面切换 Tab、配置资源组并最终保存模板。',
      breadcrumbs: ['安全中心', '访问控制', '权限包管理', '新建权限模板'],
    } satisfies DemoRouteMeta,
  },
  {
    path: '/labs/element/playground',
    component: ElementPlaygroundView,
    meta: {
      title: 'Element 测试台',
      section: '组件实验室',
      code: 'lab:element:playground',
      description: '集中展示 Tab、表单、表格、树、弹窗、抽屉等常用 Element 组件。',
      scenario: '适合给 AI 做通用组件压测：切换 Tab、填写表单、操作表格、打开弹窗并确认。',
      breadcrumbs: ['组件实验室', 'Element 测试台'],
    } satisfies DemoRouteMeta,
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

export function getDemoRouteMeta(route: RouteLocationNormalizedLoaded): DemoRouteMeta | null {
  const meta = route.meta as Partial<DemoRouteMeta>
  if (!meta?.title) return null
  return {
    title: meta.title,
    section: meta.section ?? '',
    code: meta.code ?? '',
    description: meta.description ?? '',
    scenario: meta.scenario ?? '',
    breadcrumbs: Array.isArray(meta.breadcrumbs) ? meta.breadcrumbs : [],
  }
}
