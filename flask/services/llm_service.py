from __future__ import annotations

from config import Config
from services.providers.deepseek_provider import call_deepseek
from services.providers.gemini_provider import call_gemini


SUPPORTED_PROVIDERS = {"gemini", "deepseek"}


def _resolve_provider_and_model(provider: str | None, model: str | None) -> tuple[str, str | None]:
    requested_provider = (provider or Config.LLM_PROVIDER_DEFAULT).strip().lower()
    if requested_provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"暂不支持的 provider: {requested_provider}")

    if requested_provider == "gemini":
        if Config.GEMINI_API_KEY:
            return "gemini", model
        if Config.DEEPSEEK_API_KEY:
            fallback_model = None if not model or model.startswith("gemini") else model
            return "deepseek", fallback_model
        raise RuntimeError("服务端未配置 GEMINI_API_KEY。")

    if requested_provider == "deepseek":
        if Config.DEEPSEEK_API_KEY:
            return "deepseek", model
        if Config.GEMINI_API_KEY:
            fallback_model = None if not model or model.startswith("deepseek") else model
            return "gemini", fallback_model
        raise RuntimeError("服务端未配置 DEEPSEEK_API_KEY。")

    raise ValueError(f"暂不支持的 provider: {requested_provider}")


def chat_with_model(prompt: str, provider: str | None = None, model: str | None = None) -> dict:
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt 不能为空。")

    target_provider, target_model = _resolve_provider_and_model(provider, model)

    if target_provider == "gemini":
        return call_gemini(prompt=prompt.strip(), model=target_model)

    if target_provider == "deepseek":
        return call_deepseek(prompt=prompt.strip(), model=target_model)

    raise ValueError(f"暂不支持的 provider: {target_provider}")
