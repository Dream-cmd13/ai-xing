from __future__ import annotations

import requests

from config import Config


def call_gemini(prompt: str, model: str | None = None) -> dict:
    if not Config.GEMINI_API_KEY:
        raise RuntimeError("服务端未配置 GEMINI_API_KEY。")

    target_model = model or "gemini-2.5-flash"
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{target_model}:generateContent",
        params={"key": Config.GEMINI_API_KEY},
        json={
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.7,
                "topP": 0.95,
                "maxOutputTokens": 4096,
            },
        },
        timeout=60,
    )
    data = response.json()
    if response.status_code >= 400:
        raise RuntimeError(
            f"Gemini API 调用失败: {data.get('error', {}).get('message', response.text)}"
        )

    candidates = data.get("candidates") or []
    parts = ((candidates[0] if candidates else {}).get("content") or {}).get("parts") or []
    reply = "".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
    if not reply:
        reply = data.get("text", "").strip()

    return {"reply": reply, "provider": "gemini", "model": target_model}
