import fs from 'fs';
import path from 'path';

const componentsDir = path.join(process.cwd(), 'components');
const files = fs.readdirSync(componentsDir).filter(f => f.endsWith('View.tsx') || f === 'OkrReviewDashboard.tsx');

for (const file of files) {
  const filePath = path.join(componentsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Check if it has an interface Props
  const interfaceRegex = /interface\s+(\w+Props)\s*{[^}]*}/m;
  const match = content.match(interfaceRegex);
  
  if (match) {
    const interfaceName = match[1];
    const interfaceText = match[0];
    
    // Find the component definition
    const componentRegex = new RegExp(`const\\s+(\\w+):\\s*React\\.FC<${interfaceName}>\\s*=\\s*\\(\\{([^}]+)\\}\\)\\s*=>\\s*{`);
    const compMatch = content.match(componentRegex);
    
    if (compMatch) {
      const componentName = compMatch[1];
      const propsList = compMatch[2].split(',').map(p => p.trim());
      
      // Remove interface
      content = content.replace(interfaceText, '');
      
      // Replace component definition
      const newDef = `const ${componentName}: React.FC = () => {`;
      content = content.replace(compMatch[0], newDef);
      
      // Add imports if not present
      const importsToAdd = `
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';
`;
      if (!content.includes('useAppStore')) {
        content = content.replace(/import React[^;]*;/, `$&${importsToAdd}`);
      }
      
      // Add hooks inside component
      const hooksToAdd = `
  const state = useAppStore();
  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const { 
    handleSave, saveStateDirectly, executeAtomicOperation, 
    handleSetDepartments: setDepartments, handleSetUsers: setUsers, 
    handleSetSystemRoles: setSystemRoles, handleSetAISettings: setAISettings, 
    handleSetBusinesses: setBusinesses, setProcessData, updateProcessProps, 
    addProcess, deleteProcessFn: deleteProcess, publishProcess, rollbackProcess, 
    handleSetTasks: setTasks, handleSetStrategy: setStrategy 
  } = actions;
  const isSaving = state.isSaving;
  const showSaveSuccess = state.showSaveSuccess;
  const isDirty = state.isDirty;
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;
`;
      content = content.replace(newDef, `${newDef}${hooksToAdd}`);
      
      fs.writeFileSync(filePath, content);
      console.log(`Refactored ${file}`);
    }
  }
}
