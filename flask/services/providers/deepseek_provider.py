from __future__ import annotations

from openai import OpenAI

from config import Config


def call_deepseek(prompt: str, model: str | None = None) -> dict:
    if not Config.DEEPSEEK_API_KEY:
        raise RuntimeError("服务端未配置 DEEPSEEK_API_KEY。")

    target_model = model or Config.DEEPSEEK_DEFAULT_MODEL
    client = OpenAI(
        api_key=Config.DEEPSEEK_API_KEY,
        base_url=Config.DEEPSEEK_BASE_URL,
    )

    try:
        completion = client.chat.completions.create(
            model=target_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
        )
    except Exception as exc:
        raise RuntimeError(f"DeepSeek API 调用失败: {exc}") from exc

    choice = completion.choices[0] if completion.choices else None
    message = choice.message if choice else None
    reply = (message.content or "").strip() if message else ""

    return {"reply": reply, "provider": "deepseek", "model": target_model}
