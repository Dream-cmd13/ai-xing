-- 将核心业务表加入到实时发布名单中
-- 只有加入名单的表，Supabase 才会推送更新消息
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE processes;
ALTER PUBLICATION supabase_realtime ADD TABLE departments;
ALTER PUBLICATION supabase_realtime ADD TABLE strategy;
ALTER PUBLICATION supabase_realtime ADD TABLE businesses;
