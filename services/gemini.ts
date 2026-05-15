import { isSupabaseConfigured, supabase } from "../supabase";
import { AISettings } from "../types";

const callAI = async (settings: AISettings | undefined, prompt: string): Promise<string> => {
  try {
    // Check if Supabase is configured
    if (!isSupabaseConfigured()) {
      console.error("Supabase configuration missing. Please set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) in Settings.");
      return "AI 调用失败: Supabase 配置缺失。请在系统设置中配置 Supabase URL 和 Anon Key。";
    }

    // The Edge Function 'ai-chat' handles the Gemini API call securely
    const { data, error } = await supabase.functions.invoke('ai-chat', {
      body: { prompt }
    });

    if (error) {
      console.error("Supabase Edge Function error:", error);
      
      // Handle specific error codes
      if (error.message?.includes('401')) {
        return "AI 调用失败: 401 Unauthorized。请确保 Edge Function 部署时使用了 --no-verify-jwt 参数，或者您已通过 Supabase Auth 登录。";
      }
      
      if (error.message?.includes('Failed to send a request')) {
        return "AI 调用失败: 无法发送请求到 Edge Function。请检查网络连接，或确保函数已正确部署。";
      }

      return `AI 调用失败: ${error.message || '未知错误'}`;
    }

    if (!data || !data.reply) {
      console.error("AI response missing reply field:", data);
      return "AI 响应异常: 返回数据格式不正确";
    }

    return data.reply;
  } catch (e: any) {
    console.error("AI call failed:", e);
    
    // Check for network errors
    if (e.message?.includes('Failed to fetch') || e.name === 'TypeError') {
      return "AI 调用失败: 网络请求被拦截或域名解析失败。请检查代理设置或 Supabase URL 是否正确。";
    }

    return `AI 调用失败: ${e.message || '未知错误'}`;
  }
};

export const checkOKRQuality = async (settings: AISettings | undefined, objective: string, krs: string[]): Promise<string> => {
  const prompt = `
    作为战略管理专家，请检查以下 OKR 的设置质量：
    目标 (O): ${objective}
    关键结果 (KRs): ${krs.join('; ')}
    
    请根据 SMART 原则评估其“可衡量性”和“挑战性”，并给出具体的修改意见。
    如果包含模糊词汇（如“努力”、“加强”），请明确指出。
    返回 Markdown 格式。
  `;
  return await callAI(settings, prompt);
};

export const checkStrategyQuality = async (settings: AISettings | undefined, type: '使命' | '愿景', content: string): Promise<string> => {
  const prompt = `
    作为企业战略顾问，请对以下企业的${type}进行质量诊断：
    内容: "${content}"
    
    评估标准：
    1. 愿景是否具备前瞻性、感召力和清晰的方向感？
    2. 使命是否明确了组织存在的意义、业务领域及对客户的价值？
    请给出简明扼要的改进建议。
    返回 Markdown 格式。
  `;
  return await callAI(settings, prompt);
};

export const checkPADQuality = async (settings: AISettings | undefined, plan: string, action: string, deliverable: string): Promise<string> => {
  const prompt = `
    请审核以下周度 PAD 工作计划：
    计划 (Plan): ${plan}
    行动 (Action): ${action}
    交付物 (Deliverable): ${deliverable}
    
    分析计划与交付物是否匹配，行动是否能支撑目标的达成。给出一条具体改进建议。
  `;
  return await callAI(settings, prompt);
};
