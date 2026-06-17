import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { pinyin } from 'pinyin-pro';

dotenv.config();

function readEnvValue(name) {
  return (process.env[name] || '').trim();
}

function extractProjectRef(url) {
  const matched = url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co$/i);
  return matched ? matched[1] : null;
}

const supabaseUrl = readEnvValue('SUPABASE_URL') || readEnvValue('VITE_SUPABASE_URL');
const serviceRoleEnv = readEnvValue('SUPABASE_SERVICE_ROLE_KEY');
const publishableUrl = readEnvValue('VITE_SUPABASE_URL');
const publishableKey = readEnvValue('VITE_SUPABASE_PUBLISHABLE_KEY');
const defaultPassword = readEnvValue('DEFAULT_USER_PASSWORD') || '888888';

if (!supabaseUrl || !serviceRoleEnv) {
  console.error('❌ 缺少 SUPABASE_URL/VITE_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 环境变量。');
  process.exit(1);
}

if (readEnvValue('SUPABASE_URL') && publishableUrl && readEnvValue('SUPABASE_URL') !== publishableUrl) {
  console.error('❌ 检测到 SUPABASE_URL 与 VITE_SUPABASE_URL 指向了不同项目，请在 .env 中只保留同一套配置。');
  process.exit(1);
}

const supabaseRef = extractProjectRef(supabaseUrl);
const publishableRef = publishableUrl ? extractProjectRef(publishableUrl) : null;

if (supabaseRef && publishableRef && supabaseRef !== publishableRef) {
  console.error('❌ 检测到 Supabase URL 存在项目不一致，请确认 .env 中没有重复或冲突的配置。');
  process.exit(1);
}

if (publishableKey && serviceRoleEnv && publishableKey === serviceRoleEnv) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY 似乎配置成了前端公开 key，请改为 service role key。');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleEnv, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const USERS_TO_CREATE = [
  { name: '段军', departmentName: '运营部', role: 'Employee' },
  { name: '欧艳华', departmentName: '采购部', role: 'Employee' },
  { name: '詹增杰', departmentName: '运营部', role: 'Employee' },
  { name: '黎月新', departmentName: '运营部', role: 'Employee' },
  { name: '吴湘环', departmentName: '运营部', role: 'Employee' },
  { name: '陈建华', departmentName: '业务部', role: 'Employee' },
  { name: '周光宇', departmentName: 'IT部', role: 'Employee' },
  { name: '陈玉娇', departmentName: '品质部', role: 'Employee' },
  { name: '黄樱霞', departmentName: '产品部', role: 'Employee' },
];

const VALID_ROLES = new Set(['Employee', 'Manager', 'Admin']);

function buildMenuPermission(view, create, update) {
  return { view, create, update };
}

function buildCustomPermissions(role) {
  if (role === 'Employee') {
    return {
      workbench: buildMenuPermission(true, true, true),
      process: buildMenuPermission(true, false, false),
      org: buildMenuPermission(true, false, false),
      roles: buildMenuPermission(true, false, false),
      'business-definition': buildMenuPermission(true, false, false),
      okr: buildMenuPermission(true, false, false),
      execution: buildMenuPermission(true, true, true),
      'task-center': buildMenuPermission(true, true, true),
      'okr-review': buildMenuPermission(true, false, false),
      user: buildMenuPermission(false, false, false),
      'menu-permissions': buildMenuPermission(false, false, false),
      'system-config': buildMenuPermission(false, false, false),
    };
  }

  if (role === 'Manager') {
    return {
      workbench: buildMenuPermission(true, true, true),
      process: buildMenuPermission(true, true, true),
      org: buildMenuPermission(true, true, true),
      roles: buildMenuPermission(true, true, true),
      'business-definition': buildMenuPermission(true, true, true),
      okr: buildMenuPermission(true, true, true),
      execution: buildMenuPermission(true, true, true),
      'task-center': buildMenuPermission(true, true, true),
      'okr-review': buildMenuPermission(true, true, true),
      user: buildMenuPermission(false, false, false),
      'menu-permissions': buildMenuPermission(false, false, false),
      'system-config': buildMenuPermission(false, false, false),
    };
  }

  return {};
}

function buildUsername(name) {
  return pinyin(name, { toneType: 'none', type: 'string' })
    .replace(/\s+/g, '')
    .toLowerCase();
}

function buildEmail(username) {
  return `${username}@app.local`;
}

function collectDepartmentEntries(items, parentPath = '') {
  const entries = [];

  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!id || !name) continue;

    const path = parentPath ? `${parentPath} / ${name}` : name;
    entries.push({ id, name, path });

    const children = Array.isArray(item.subDepartments)
      ? item.subDepartments
      : Array.isArray(item.sub_departments)
        ? item.sub_departments
        : [];

    entries.push(...collectDepartmentEntries(children, path));
  }

  return entries;
}

async function loadDepartmentMap() {
  const { data, error } = await supabase.from('departments').select('id, name, sub_departments');

  if (error) {
    throw new Error(`获取部门列表失败: ${error.message}`);
  }

  const departmentsByName = new Map();

  for (const department of data || []) {
    const entries = collectDepartmentEntries([
      {
        id: department.id,
        name: department.name,
        subDepartments: department.sub_departments || [],
      },
    ]);

    for (const entry of entries) {
      const matchedEntries = departmentsByName.get(entry.name) || [];
      matchedEntries.push(entry);
      departmentsByName.set(entry.name, matchedEntries);
    }
  }

  return departmentsByName;
}

function resolveDepartment(departmentName, departmentMap) {
  if (!departmentName) return null;

  const matchedEntries = departmentMap.get(departmentName) || [];
  if (matchedEntries.length === 0) {
    throw new Error(`部门不存在: ${departmentName}`);
  }

  if (matchedEntries.length > 1) {
    const paths = matchedEntries.map((item) => item.path).join('；');
    throw new Error(`部门名称重复，请改用唯一名称: ${departmentName}（匹配到: ${paths}）`);
  }

  return matchedEntries[0];
}

async function ensureUsernameAvailable(username) {
  const { data, error } = await supabase
    .from('users')
    .select('id, username')
    .eq('username', username)
    .limit(1);

  if (error) {
    throw new Error(`检查用户名失败: ${error.message}`);
  }

  if (data && data.length > 0) {
    throw new Error(`用户名已存在: ${username}`);
  }
}

async function createOneUser(user, departmentMap) {
  const name = (user.name || '').trim();
  const role = (user.role || 'Employee').trim();
  const departmentName = (user.departmentName || '').trim();

  if (!name) {
    throw new Error('姓名不能为空。');
  }

  if (!VALID_ROLES.has(role)) {
    throw new Error(`角色不合法: ${role}`);
  }

  const username = buildUsername(name);
  const email = buildEmail(username);
  const departmentEntry = resolveDepartment(departmentName, departmentMap);
  const departmentId = departmentEntry?.id || null;

  await ensureUsernameAvailable(username);

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: defaultPassword,
    email_confirm: true,
    user_metadata: {
      name,
      username,
      role,
    },
  });

  if (authError) {
    throw new Error(`创建认证用户失败: ${authError.message}`);
  }

  const authId = authData.user?.id;
  if (!authId) {
    throw new Error('创建认证用户失败: 未返回 auth_id');
  }

  const userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { error: insertError } = await supabase.from('users').insert([
    {
      id: userId,
      username,
      name,
      role,
      department_id: departmentId,
      auth_id: authId,
      pad_permissions: [],
      reviews: {},
      system_role_ids: [],
      custom_permissions: buildCustomPermissions(role),
      row_version: 0,
    },
  ]);

  if (insertError) {
    await supabase.auth.admin.deleteUser(authId);
    throw new Error(`写入业务用户失败: ${insertError.message}，已回滚认证用户`);
  }

  return {
    userId,
    authId,
    username,
    name,
    role,
    departmentName: departmentEntry?.path || departmentName || '未设置',
    email,
  };
}

async function main() {
  console.log(`🚀 开始批量创建用户，共 ${USERS_TO_CREATE.length} 人`);
  console.log(`🔑 初始密码: ${defaultPassword}`);

  const departmentMap = await loadDepartmentMap();
  const successResults = [];
  const failureResults = [];

  for (const user of USERS_TO_CREATE) {
    try {
      const result = await createOneUser(user, departmentMap);
      successResults.push(result);
      console.log(`✅ 创建成功: ${result.name} / ${result.username} / ${result.departmentName}`);
    } catch (error) {
      failureResults.push({
        name: user.name,
        departmentName: user.departmentName,
        reason: error instanceof Error ? error.message : String(error),
      });
      console.error(`❌ 创建失败: ${user.name} / ${user.departmentName} / ${failureResults.at(-1)?.reason}`);
    }
  }

  console.log('----------------------------------------');
  console.log(`完成。成功 ${successResults.length} 人，失败 ${failureResults.length} 人。`);

  if (successResults.length > 0) {
    console.log('\n成功列表:');
    for (const item of successResults) {
      console.log(`- ${item.name} (${item.username}) / ${item.departmentName} / ${item.email}`);
    }
  }

  if (failureResults.length > 0) {
    console.log('\n失败列表:');
    for (const item of failureResults) {
      console.log(`- ${item.name} / ${item.departmentName} / ${item.reason}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`❌ 批量创建失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
