export const MENU_GROUPS = [
  {
    id: 'dashboard',
    label: '',
    items: [
      { id: 'workbench', label: '工作台' }
    ]
  },
  {
    id: 'process-management',
    label: '流程管理',
    items: [
      { id: 'process', label: '流程' },
      { id: 'org', label: '组织' },
      { id: 'roles', label: '岗位规划' }
    ]
  },
  {
    id: 'okr-management',
    label: 'OKR',
    items: [
      { id: 'business-definition', label: '事业定义' },
      { id: 'okr', label: 'OKR战略' },
      { id: 'execution', label: 'OKR执行' },
      { id: 'task-center', label: '任务中心' },
      { id: 'okr-review', label: 'OKR复盘' }
    ]
  },
  {
    id: 'system-settings',
    label: '系统设置',
    items: [
      { id: 'user', label: '用户管理' },
      { id: 'menu-permissions', label: '权限管理' }
    ]
  }
];

export const ALL_MENU_ITEMS = MENU_GROUPS.flatMap(g => g.items);
