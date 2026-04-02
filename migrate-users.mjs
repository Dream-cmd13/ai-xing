// scripts/migrate-users.mjs
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

// 从环境变量获取配置
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

async function migrateUsers() {
  console.log('🚀 开始用户迁移任务 (统一初始密码为: 888888)...');

  // 1. 获取所有还没有 auth_id 的业务用户
  const { data: users, error: fetchError } = await supabase
    .from('users')
    .select('*')
    .is('auth_id', null);

  if (fetchError) {
    console.error('❌ 获取用户列表失败:', fetchError);
    return;
  }

  if (!users || users.length === 0) {
    console.log('✅ 没有需要迁移的用户，所有用户均已关联 auth_id。');
    return;
  }

  console.log(`📊 找到 ${users.length} 个待迁移用户。`);

  let successCount = 0;
  let failCount = 0;

  // 2. 遍历用户，在 Supabase Auth 中创建账号
  for (const user of users) {
    try {
      // 构造邮箱：使用 username 拼接虚拟域名
      const email = `${user.username}@app.local`.toLowerCase();
      
      // ⚠️ 核心修改：忽略旧密码，统一设置为 888888
      const password = '888888';

      console.log(`⏳ 正在迁移用户 [${user.username}] -> 邮箱: ${email}`);

      // 调用 Admin API 创建 Auth 用户
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: true, // 强制标记为邮箱已验证
        user_metadata: {
          name: user.name,
          username: user.username,
          role: user.role
        }
      });

      if (authError) {
        if (authError.message.includes('already exists')) {
            console.log(`⚠️ 用户邮箱 ${email} 已在 Auth 中存在，请手动检查。`);
        } else {
            console.error(`❌ 创建 Auth 用户 [${user.username}] 失败:`, authError.message);
        }
        failCount++;
        continue;
      }

      const newAuthId = authData.user.id;

      // 3. 将生成的 auth_id 回写到业务 users 表
      const { error: updateError } = await supabase
        .from('users')
        .update({ auth_id: newAuthId })
        .eq('id', user.id);

      if (updateError) {
        console.error(`❌ 回写 auth_id 给用户 [${user.username}] 失败:`, updateError.message);
        failCount++;
      } else {
        console.log(`✅ 成功迁移用户 [${user.username}]`);
        successCount++;
      }

    } catch (err) {
      console.error(`❌ 迁移用户 [${user.username}] 时发生未知异常:`, err);
      failCount++;
    }
  }

  console.log('----------------------------------------');
  console.log(`🎉 迁移完成! 成功: ${successCount}, 失败: ${failCount}`);
  
  if (successCount > 0) {
      console.log('💡 提示: 请通知所有已迁移的用户，他们的初始登录密码已被重置为 888888。');
  }
}

// 执行主函数
migrateUsers();