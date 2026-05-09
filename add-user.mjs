// scripts/add-user.mjs
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { pinyin } from 'pinyin-pro';

// 加载环境变量
dotenv.config();


//使用前先在终端去配置url和key

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ 错误: 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 环境变量。');
  process.exit(1);
}

// 必须使用 Service Role Key，以绕过 RLS 调用 admin API
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// 创建终端交互接口
const rl = readline.createInterface({ input, output });

async function addUser() {
  console.log('=============================================');
  console.log('🚀 欢迎使用 StratFlow AI 新增用户配置向导');
  console.log('=============================================\n');

  try {
    // 1. 获取中文名称并转换为拼音
    const name = await rl.question('👤 请输入用户中文名称 (例如: 张三): ');
    if (!name.trim()) throw new Error('名称不能为空');

    // 转换为无音调的连续拼音作为 username
    const username = pinyin(name, { toneType: 'none', type: 'string' }).replace(/\s+/g, '');
    console.log(`   ✅ 自动生成用户名 (username): ${username}`);

    // 2. 获取并验证部门
    console.log('\n⏳ 正在获取部门列表...');
    const { data: departments, error: deptError } = await supabase
      .from('departments')
      .select('id, name');

    if (deptError) throw new Error(`获取部门失败: ${deptError.message}`);

    console.log('🏢 可用部门列表:');
    departments.forEach((d, index) => {
      console.log(`   [${index + 1}] ${d.name}`);
    });

    const deptInput = await rl.question(`\n🏷️ 请输入部门编号(1-${departments.length}) 或 直接输入部门全称: `);
    
    let departmentId = null;
    let departmentName = '';
    
    // 尝试按数字索引匹配
    const deptIndex = parseInt(deptInput) - 1;
    if (!isNaN(deptIndex) && departments[deptIndex]) {
      departmentId = departments[deptIndex].id;
      departmentName = departments[deptIndex].name;
    } else {
      // 尝试按名称严格匹配
      const matchedDept = departments.find(d => d.name === deptInput.trim());
      if (matchedDept) {
        departmentId = matchedDept.id;
        departmentName = matchedDept.name;
      } else {
        throw new Error('找不到匹配的部门，请重新运行脚本。');
      }
    }
    console.log(`   ✅ 已选择部门: ${departmentName} (${departmentId})`);

    // 3. 询问角色
    let role = 'User'; // 默认为普通用户
    const roleInput = await rl.question('\n🛡️ 请选择角色 (1: 普通用户, 2: 管理员) [默认: 1]: ');
    if (roleInput.trim() === '2') {
      role = 'Admin';
    }
    console.log(`   ✅ 已设置角色: ${role}`);

    const defaultPassword = '888888';
    const email = `${username}@app.local`.toLowerCase();

    // 4. 二次确认
    console.log('\n=============================================');
    console.log('📝 请确认以下用户信息：');
    console.log(`   姓名: ${name}`);
    console.log(`   账号/拼音: ${username}`);
    console.log(`   邮箱: ${email}`);
    console.log(`   初始密码: ${defaultPassword}`);
    console.log(`   角色: ${role}`);
    console.log(`   部门: ${departmentName}`);
    console.log('=============================================');
    
    const confirm = await rl.question('\n确认创建此用户吗？(y/n) [默认: y]: ');
    if (confirm.toLowerCase() === 'n') {
      console.log('🛑 已取消创建。');
      process.exit(0);
    }

    // 5. 在 Supabase Auth 中创建用户
    console.log(`\n⏳ 正在 Auth 系统中创建账号...`);
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: defaultPassword,
      email_confirm: true,
      user_metadata: {
        name: name,
        username: username,
        role: role
      }
    });

    if (authError) {
      throw new Error(`Auth 创建失败: ${authError.message}`);
    }
    
    const authId = authData.user.id;
    console.log(`   ✅ Auth 账号创建成功! (Auth ID: ${authId})`);

    // 6. 在 public.users 业务表中插入记录
    const userId = `user-${Date.now()}`;
    console.log(`⏳ 正在同步写入业务表 (public.users)...`);
    
    const { error: insertError } = await supabase
      .from('users')
      .insert([
        {
          id: userId,
          username: username,
          name: name,
          role: role,
          department_id: departmentId,
          auth_id: authId,
          pad_permissions: [], // 使用默认空数组
          reviews: {},         // 使用默认空对象
          system_role_ids: null,
          custom_permissions: null
        }
      ]);

    if (insertError) {
      // 回滚方案：如果在业务表创建失败，为了保持数据一致性，建议删除 Auth 用户 (视业务需求而定)
      console.error(`   ❌ 业务表记录写入失败: ${insertError.message}`);
      console.log(`   ⏳ 正在回滚：删除已创建的 Auth 账户...`);
      await supabase.auth.admin.deleteUser(authId);
      throw new Error('业务逻辑创建失败，已自动回滚清理Auth。');
    }

    console.log(`\n🎉 成功! 用户 ${name} 已彻底创建完毕。`);
    console.log(`🔑 登录邮箱: ${email}`);
    console.log(`🔑 登录密码: ${defaultPassword}`);

  } catch (err) {
    console.error(`\n❌ 发生错误: ${err.message}`);
  } finally {
    rl.close();
  }
}

// 执行脚本
addUser();