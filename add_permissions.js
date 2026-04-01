import fs from 'fs';
import path from 'path';

const componentsDir = path.join(process.cwd(), 'components');
const files = fs.readdirSync(componentsDir).filter(f => f.endsWith('View.tsx') || f === 'OkrReviewDashboard.tsx');

const menuMap = {
  'BusinessDefinitionView.tsx': 'business-definition',
  'ExecutionView.tsx': 'execution',
  'MenuPermissionView.tsx': 'menu-permissions',
  'OkrReviewDashboard.tsx': 'okr-review',
  'OrgView.tsx': 'org',
  'PeriodAlignmentView.tsx': 'execution',
  'ProcessView.tsx': 'process',
  'ReviewView.tsx': 'okr-review',
  'RoleQueryView.tsx': 'roles',
  'StrategyView.tsx': 'okr',
  'SystemConfigView.tsx': 'system-config',
  'TaskCenterView.tsx': 'task-center',
  'UserView.tsx': 'user',
  'WeeklyView.tsx': 'execution',
  'WorkbenchView.tsx': 'workbench'
};

for (const file of files) {
  const filePath = path.join(componentsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  const menuId = menuMap[file] || 'process';

  // Add `const permissions = usePermissions('menuId');` after `const actions = useAppActions();`
  // if it's not already there
  if (!content.includes('const permissions = usePermissions')) {
    content = content.replace('const actions = useAppActions();', `const actions = useAppActions();\n  const permissions = usePermissions('${menuId}');`);
  }

  // Also fix `Cannot redeclare block-scoped variable`
  // Some files might have `const { strategy, businesses } = state;` and then `const strategy = ...`
  // Let's just remove `strategy` and `businesses` from the destructuring if they are redeclared.
  // Actually, it's easier to just let `tsc` tell us and fix them manually or with regex.
  
  fs.writeFileSync(filePath, content);
  console.log(`Added permissions to ${file}`);
}
