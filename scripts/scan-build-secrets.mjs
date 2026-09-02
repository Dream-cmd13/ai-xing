import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = path.resolve(projectRoot, process.argv[2] || 'dist');
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt']);
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['bearer-credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
  ['gemini-browser-binding', /GEMINI_API_KEY|process\.env\.API_KEY/],
];

async function listTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTextFiles(fullPath);
    return entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase()) ? [fullPath] : [];
  }));
  return nested.flat();
}

async function main() {
  const files = await listTextFiles(targetRoot);
  const findings = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const [ruleName, pattern] of rules) {
      if (pattern.test(content)) {
        findings.push({ ruleName, file: path.relative(targetRoot, file) });
      }
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`Sensitive build pattern '${finding.ruleName}' found in ${finding.file}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Build secret scan passed for ${files.length} text assets.`);
}

await main();
