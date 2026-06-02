from __future__ import annotations

from functools import wraps

from flask import g, request

from services.supabase_clients import supabase_user_request


def _extract_bearer_token() -> str:
    auth_header = request.headers.get("Authorization", "").strip()
    if not auth_header.lower().startswith("bearer "):
        raise PermissionError("缺少有效的 Bearer Token。")
    token = auth_header[7:].strip()
    if not token:
        raise PermissionError("登录态无效，请重新登录。")
    return token


def _ensure_authenticated(token: str) -> dict:
    response = supabase_user_request("GET", "/auth/v1/user", jwt_token=token)
    if response.status_code != 200:
        raise PermissionError("登录态校验失败，请重新登录。")
    data = response.json()
    if not data or not data.get("id"):
        raise PermissionError("登录态校验失败，请重新登录。")
    return data


def _ensure_admin(token: str) -> None:
    response = supabase_user_request("POST", "/rest/v1/rpc/is_admin", jwt_token=token, json={})
    if response.status_code != 200:
        raise PermissionError("管理员权限校验失败。")
    if response.json() is not True:
        raise PermissionError("当前账号没有管理员权限。")


def require_auth(admin_only: bool = False):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            token = _extract_bearer_token()
            user = _ensure_authenticated(token)
            if admin_only:
                _ensure_admin(token)
            g.jwt_token = token
            g.auth_user = user
            return func(*args, **kwargs)

        return wrapper

    return decorator
