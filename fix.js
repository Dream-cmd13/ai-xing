import fs from 'fs';
import path from 'path';

const componentsDir = path.join(process.cwd(), 'components');
const files = fs.readdirSync(componentsDir).filter(f => f.endsWith('View.tsx') || f === 'OkrReviewDashboard.tsx');

for (const file of files) {
  const filePath = path.join(componentsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Find the leftover interface part
  // It usually looks like:
  // ;
  //   setTasks: ...
  // }
  // const ComponentName: React.FC = () => {
  
  const leftoverRegex = /(?:;|\n)[^}]*\}\n\nconst\s+\w+:\s*React\.FC\s*=\s*\(\)\s*=>\s*\{/m;
  const match = content.match(leftoverRegex);
  
  if (match) {
    // Replace the leftover part with just the component definition
    const compDefRegex = /const\s+\w+:\s*React\.FC\s*=\s*\(\)\s*=>\s*\{/;
    const compDefMatch = match[0].match(compDefRegex);
    if (compDefMatch) {
      content = content.replace(match[0], '\n' + compDefMatch[0]);
    }
  } else {
    // Maybe it doesn't have a newline before const
    const leftoverRegex2 = /(?:;|\n)[^}]*\}\nconst\s+\w+:\s*React\.FC\s*=\s*\(\)\s*=>\s*\{/m;
    const match2 = content.match(leftoverRegex2);
    if (match2) {
      const compDefRegex = /const\s+\w+:\s*React\.FC\s*=\s*\(\)\s*=>\s*\{/;
      const compDefMatch = match2[0].match(compDefRegex);
      if (compDefMatch) {
        content = content.replace(match2[0], '\n' + compDefMatch[0]);
      }
    }
  }

  // Now, add destructuring for state variables right after `const state = useAppStore();`
  const destructureStr = `
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;
`;
  if (!content.includes('const { processes, departments')) {
    content = content.replace('const state = useAppStore();', `const state = useAppStore();${destructureStr}`);
  }

  // Some components might use `state` directly, e.g., `state.processes`. That's fine.
  // But some used the destructured props like `processes`, `departments`.
  // The destructuring above will provide them.

  fs.writeFileSync(filePath, content);
  console.log(`Fixed ${file}`);
}
