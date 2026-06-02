from __future__ import annotations

import requests

from config import Config


def call_deepseek(prompt: str, model: str | None = None) -> dict:
    if not Config.DEEPSEEK_API_KEY:
        raise RuntimeError("服务端未配置 DEEPSEEK_API_KEY。")

    target_model = model or "deepseek-chat"
    response = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={
            "Authorization": f"Bearer {Config.DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": target_model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.7,
        },
        timeout=60,
    )
    data = response.json()
    if response.status_code >= 400:
        error_message = (
            (data.get("error") or {}).get("message")
            if isinstance(data, dict)
            else response.text
        )
        raise RuntimeError(f"DeepSeek API 调用失败: {error_message or response.text}")

    choices = data.get("choices") or []
    message = (choices[0] or {}).get("message") if choices else {}
    reply = (message or {}).get("content", "").strip()

    return {"reply": reply, "provider": "deepseek", "model": target_model}
