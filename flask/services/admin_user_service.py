from __future__ import annotations

import time
import urllib.parse

from config import Config
from services.supabase_clients import supabase_admin_request


def _ensure_ok(response, default_message: str) -> dict:
    payload = response.json() if response.content else {}
    if response.status_code >= 400:
        message = payload.get("msg") or payload.get("message") or payload.get("error_description")
        if not message and isinstance(payload.get("error"), dict):
            message = payload["error"].get("message")
        raise RuntimeError(message or default_message)
    return payload


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _check_username_unique(username: str) -> None:
    response = supabase_admin_request(
        "GET",
        f"/rest/v1/users?select=id,username&username=eq.{_quote(username)}&limit=1",
    )
    payload = _ensure_ok(response, "检查用户名唯一性失败。")
    if payload:
        raise ValueError("该账号已存在，请使用其他账号。")


def _check_department_exists(department_id: str | None) -> None:
    if not department_id:
        return
    response = supabase_admin_request(
        "GET",
        f"/rest/v1/departments?select=id&id=eq.{_quote(department_id)}&limit=1",
    )
    payload = _ensure_ok(response, "校验部门失败。")
    if not payload:
        raise ValueError("所选部门不存在，请刷新后重试。")


def _build_email(username: str) -> str:
    return f"{username.lower()}@app.local"


def create_user(username: str, name: str, role: str, department_id: str | None = None) -> dict:
    normalized_username = (username or "").strip().lower()
    normalized_name = (name or "").strip()
    normalized_role = (role or "").strip()

    if not normalized_username or not normalized_name:
        raise ValueError("用户名和姓名不能为空。")
    if normalized_role not in {"Employee", "Manager", "Admin"}:
        raise ValueError("角色不合法。")

    _check_username_unique(normalized_username)
    _check_department_exists(department_id)

    email = _build_email(normalized_username)
    auth_response = supabase_admin_request(
        "POST",
        "/auth/v1/admin/users",
        json={
            "email": email,
            "password": Config.DEFAULT_USER_PASSWORD,
            "email_confirm": True,
            "user_metadata": {
                "name": normalized_name,
                "username": normalized_username,
                "role": normalized_role,
            },
        },
    )
    auth_payload = _ensure_ok(auth_response, "创建认证账号失败。")
    auth_user = auth_payload.get("user") or {}
    auth_id = auth_user.get("id")
    if not auth_id:
        raise RuntimeError("创建认证账号失败，未返回用户标识。")

    user_id = f"user-{int(time.time() * 1000)}"
    try:
        insert_response = supabase_admin_request(
            "POST",
            "/rest/v1/users",
            json={
                "id": user_id,
                "username": normalized_username,
                "name": normalized_name,
                "role": normalized_role,
                "department_id": department_id or None,
                "pad_permissions": [],
                "reviews": {},
                "system_role_ids": [],
                "custom_permissions": {},
                "auth_id": auth_id,
                "updated_at": int(time.time() * 1000),
                "row_version": 0,
            },
            extra_headers={"Prefer": "return=representation"},
        )
        _ensure_ok(insert_response, "写入业务用户失败。")
    except Exception:
        supabase_admin_request("DELETE", f"/auth/v1/admin/users/{auth_id}")
        raise

    return {
        "userId": user_id,
        "authId": auth_id,
        "email": email,
        "temporaryPassword": Config.DEFAULT_USER_PASSWORD,
    }


def reset_password(auth_id: str) -> dict:
    normalized_auth_id = (auth_id or "").strip()
    if not normalized_auth_id:
        raise ValueError("authId 不能为空。")

    response = supabase_admin_request(
        "PUT",
        f"/auth/v1/admin/users/{normalized_auth_id}",
        json={"password": Config.DEFAULT_USER_PASSWORD},
    )
    _ensure_ok(response, "重置密码失败。")
    return {"authId": normalized_auth_id, "temporaryPassword": Config.DEFAULT_USER_PASSWORD}
