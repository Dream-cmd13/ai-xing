from __future__ import annotations

import requests

from config import Config


def _join_url(path: str) -> str:
    return f"{Config.SUPABASE_URL}{path}"


def _build_headers(apikey: str, bearer: str | None = None, extra: dict | None = None) -> dict:
    headers = {
        "apikey": apikey,
        "Content-Type": "application/json",
    }
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    if extra:
        headers.update(extra)
    return headers


def supabase_user_request(
    method: str,
    path: str,
    jwt_token: str,
    json: dict | None = None,
    extra_headers: dict | None = None,
    params: dict | None = None,
):
    return requests.request(
        method=method,
        url=_join_url(path),
        headers=_build_headers(Config.SUPABASE_ANON_KEY, jwt_token, extra_headers),
        json=json,
        params=params,
        timeout=30,
    )


def supabase_admin_request(
    method: str,
    path: str,
    json: dict | None = None,
    extra_headers: dict | None = None,
    params: dict | None = None,
):
    return requests.request(
        method=method,
        url=_join_url(path),
        headers=_build_headers(
            Config.SUPABASE_SERVICE_ROLE_KEY,
            Config.SUPABASE_SERVICE_ROLE_KEY,
            extra_headers,
        ),
        json=json,
        params=params,
        timeout=30,
    )
