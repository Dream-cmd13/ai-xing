from __future__ import annotations

from flask import Blueprint, jsonify, request

from services.auth_guard import require_auth
from services.llm_service import chat_with_model


ai_bp = Blueprint("ai", __name__)


@ai_bp.post("/chat")
@require_auth(admin_only=False)
def ai_chat():
    payload = request.get_json(silent=True) or {}
    result = chat_with_model(
        prompt=payload.get("prompt", ""),
        provider=payload.get("provider"),
        model=payload.get("model"),
    )
    return jsonify({"success": True, "data": result, **result})
