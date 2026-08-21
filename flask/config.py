import os
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
load_dotenv()


def _parse_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


class Config:
    DEBUG = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    PORT = int(os.getenv("PORT", "5000"))

    SUPABASE_URL = (os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL") or "").rstrip("/")
    SUPABASE_ANON_KEY = (
        os.getenv("SUPABASE_ANON_KEY")
        or os.getenv("SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("VITE_SUPABASE_ANON_KEY")
        or ""
    )
    SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
    DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    DEEPSEEK_DEFAULT_MODEL = os.getenv("DEEPSEEK_DEFAULT_MODEL", "deepseek-v4-flash").strip()
    DEFAULT_USER_PASSWORD = os.getenv("DEFAULT_USER_PASSWORD", "888888")
    LLM_PROVIDER_DEFAULT = os.getenv("LLM_PROVIDER_DEFAULT", "gemini").strip().lower()
    CORS_ALLOW_ORIGINS = _parse_csv(os.getenv("CORS_ALLOW_ORIGINS", "*"))

    @classmethod
    def validate(cls) -> None:
        required = {
            "SUPABASE_URL": cls.SUPABASE_URL,
            "SUPABASE_ANON_KEY": cls.SUPABASE_ANON_KEY,
            "SUPABASE_SERVICE_ROLE_KEY": cls.SUPABASE_SERVICE_ROLE_KEY,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

        # AI provider keys are validated when /api/ai/chat is called. Admin
        # operations such as password reset must not depend on an LLM key.
