from __future__ import annotations

from config import Config
from services.providers.deepseek_provider import call_deepseek
from services.providers.gemini_provider import call_gemini


SUPPORTED_PROVIDERS = {"gemini", "deepseek"}


def chat_with_model(prompt: str, provider: str | None = None, model: str | None = None) -> dict:
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt 不能为空。")

    target_provider = (provider or Config.LLM_PROVIDER_DEFAULT).strip().lower()
    if target_provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"暂不支持的 provider: {target_provider}")

    if target_provider == "gemini":
        return call_gemini(prompt=prompt.strip(), model=model)

    if target_provider == "deepseek":
        return call_deepseek(prompt=prompt.strip(), model=model)

    raise ValueError(f"暂不支持的 provider: {target_provider}")
