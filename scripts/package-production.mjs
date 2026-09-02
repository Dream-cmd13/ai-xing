import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { MIGRATION_MANIFEST } from '../mcp-server/scripts/migrate.mjs';

const execFileAsync = promisify(execFile);
const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'mcp-server/package.json',
  'mcp-server/package-lock.json',
  'mcp-server/.env.example',
  'mcp-server/scripts/migrate.mjs',
  'mcp-server/scripts/backfill-task-period.mjs',
  'deploy/systemd/ai-xing-mcp.service.example',
  'deploy/nginx/mcp-location.conf.example',
  'docs/mcp-production-deployment-preparation.md',
]);
// Read-only production preflight SQL is shipped as an inspection asset, but it
// is deliberately kept outside MIGRATION_MANIFEST and the migration ledger.
const READ_ONLY_PREFLIGHT_FILES = Object.freeze([
  'sql/2026-08-27_mcp_review_data_scan.sql',
  'sql/preflight/2026-09-01_review_task_period_consistency.sql',
]);
const APPROVED_MAINTENANCE_SCRIPTS = new Set([
  'mcp-server/scripts/backfill-task-period.mjs',
]);
const ALLOWED_DIRECTORIES = Object.freeze(['dist', 'mcp-server/src']);
const TEXT_EXTENSIONS = new Set(['.conf', '.css', '.example', '.html', '.ini', '.js', '.json', '.md', '.mjs', '.sql', '.svg', '.txt']);
const SENSITIVE_RULES = Object.freeze([
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['bearer-credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
]);

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    if (entry.isFile()) return [fullPath];
    throw new Error(`发布清单不允许符号链接或特殊文件：${entry.name}`);
  }));
  return nested.flat();
}

async function copyRelativeFile(projectRoot, outputRoot, relativePath) {
  const source = path.join(projectRoot, relativePath);
  if (!await pathExists(source)) throw new Error(`发布必需文件不存在：${relativePath}`);
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function getGitState(projectRoot) {
  const [{ stdout: releaseCommit }, { stdout: worktreeState }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot }),
  ]);
  return { releaseCommit: releaseCommit.trim(), clean: worktreeState.trim().length === 0 };
}

async function validatePackage(outputRoot) {
  const files = await listFiles(outputRoot);
  const allowedSql = new Set([
    ...MIGRATION_MANIFEST.map((name) => `sql/${name}`),
    ...READ_ONLY_PREFLIGHT_FILES,
  ]);
  const findings = [];
  for (const file of files) {
    const relative = normalizeRelative(path.relative(outputRoot, file));
    const segments = relative.toLowerCase().split('/');
    const basename = segments.at(-1);
    if (basename === '.env') findings.push({ rule: 'environment-file', file: relative });
    if (segments.includes('local-test-files')) findings.push({ rule: 'local-test-files', file: relative });
    if (/\.(?:log|tmp)$/i.test(relative)) findings.push({ rule: 'runtime-output', file: relative });
    if (/\/(?:diagnose[^/]*|backfill[^/]*|live-smoke)\.mjs$/i.test(`/${relative}`)
      && !APPROVED_MAINTENANCE_SCRIPTS.has(relative)) {
      findings.push({ rule: 'unsafe-script', file: relative });
    }
    if (relative.toLowerCase().endsWith('.sql') && !allowedSql.has(relative)) {
      findings.push({ rule: 'unknown-sql', file: relative });
    }
    if (TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      const content = await readFile(file, 'utf8');
      for (const [rule, pattern] of SENSITIVE_RULES) {
        if (pattern.test(content)) findings.push({ rule, file: relative });
      }
    }
  }
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`Release rule '${finding.rule}' failed for ${finding.file}\n`);
    throw new Error('发布包安全校验失败。');
  }
  return files;
}

export async function packageProduction({
  outputDirectory,
  projectRoot = defaultProjectRoot,
  requireClean = true,
} = {}) {
  if (!outputDirectory) throw new Error('必须显式提供 release-output 下的输出目录。');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const releaseRoot = path.join(resolvedProjectRoot, 'release-output');
  const outputRoot = path.resolve(resolvedProjectRoot, outputDirectory);
  if (!isInside(releaseRoot, outputRoot)) throw new Error('输出目录必须位于工作区 release-output/ 内。');
  if (await pathExists(outputRoot)) throw new Error('输出目录已存在，拒绝覆盖。');

  const gitState = await getGitState(resolvedProjectRoot);
  if (requireClean && !gitState.clean) throw new Error('正式发布打包要求干净工作区。');

  await mkdir(releaseRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: false });
  for (const relativePath of ALLOWED_FILES) await copyRelativeFile(resolvedProjectRoot, outputRoot, relativePath);
  for (const directory of ALLOWED_DIRECTORIES) {
    const sourceDirectory = path.join(resolvedProjectRoot, directory);
    if (!await pathExists(sourceDirectory)) throw new Error(`发布必需目录不存在：${directory}`);
    for (const sourceFile of await listFiles(sourceDirectory)) {
      await copyRelativeFile(resolvedProjectRoot, outputRoot, path.relative(resolvedProjectRoot, sourceFile));
    }
  }
  for (const fileName of MIGRATION_MANIFEST) {
    await copyRelativeFile(resolvedProjectRoot, outputRoot, path.join('sql', fileName));
  }
  for (const relativePath of READ_ONLY_PREFLIGHT_FILES) {
    await copyRelativeFile(resolvedProjectRoot, outputRoot, relativePath);
  }

  const files = await validatePackage(outputRoot);
  const checksums = {};
  for (const file of files.sort()) {
    const relative = normalizeRelative(path.relative(outputRoot, file));
    checksums[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  const manifest = {
    releaseCommit: gitState.releaseCommit,
    cleanWorktree: gitState.clean,
    files: checksums,
  };
  await writeFile(path.join(outputRoot, 'SHA256SUMS.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { outputRoot, manifest };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('用法：npm run package:production -- release-output/<版本目录>');
  const result = await packageProduction({ outputDirectory: process.argv[2] });
  process.stdout.write(`Production package created with ${Object.keys(result.manifest.files).length} files.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || '发布打包失败。'}\n`);
    process.exitCode = 1;
  });
}
