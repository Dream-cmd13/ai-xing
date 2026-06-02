from __future__ import annotations

from flask import Blueprint, jsonify, request

from services.admin_user_service import create_user, reset_password
from services.auth_guard import require_auth


admin_users_bp = Blueprint("admin_users", __name__)


@admin_users_bp.post("/users")
@require_auth(admin_only=True)
def create_admin_user():
    payload = request.get_json(silent=True) or {}
    data = create_user(
        username=payload.get("username", ""),
        name=payload.get("name", ""),
        role=payload.get("role", ""),
        department_id=payload.get("departmentId"),
    )
    return jsonify({"success": True, "data": data})


@admin_users_bp.post("/users/reset-password")
@require_auth(admin_only=True)
def reset_admin_user_password():
    payload = request.get_json(silent=True) or {}
    data = reset_password(auth_id=payload.get("authId") or payload.get("auth_id") or "")
    return jsonify({"success": True, "data": data})
