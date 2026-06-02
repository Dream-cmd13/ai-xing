import { chatWithAI } from "./backendGateway";
import { AISettings } from "../types";

const resolveSelectedModel = (settings: AISettings | undefined) => {
  const selectedId = settings?.selectedModelId;
  const configs = settings?.configs || [];
  const selectedConfig = configs.find((config) => config.id === selectedId) || configs[0];

  if (!selectedConfig) {
    throw new Error("未设置可用的大模型，请先在系统设置中选择模型。");
  }

  if (selectedConfig.type !== "gemini" && selectedConfig.type !== "deepseek") {
    throw new Error("当前后端仅支持 Gemini 或 DeepSeek 模型。");
  }

  return {
    provider: selectedConfig.type,
    model: selectedConfig.modelName,
  };
};

const callAI = async (settings: AISettings | undefined, prompt: string): Promise<string> => {
  try {
    const { provider, model } = resolveSelectedModel(settings);
    const result = await chatWithAI({ prompt, provider, model });
    if (!result.reply) {
      console.error("AI response missing reply field:", result);
      return "AI 响应异常: 返回数据格式不正确";
    }
    return result.reply;
  } catch (e: any) {
    console.error("AI call failed:", e);
    
    if (e.message?.includes('Failed to fetch') || e.name === 'TypeError') {
      return "AI 调用失败: 网络请求被拦截或后端地址不可达。请检查代理设置或后端服务地址。";
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
