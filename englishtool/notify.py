"""Bark 推送。转录好了推一条到你 iPhone 锁屏, 点开直接进 App。"""

from __future__ import annotations

import httpx

from .config import BARK_URL


async def notify(title: str, body: str = "", url: str | None = None) -> bool:
    if not BARK_URL:
        print(f"[notify] 未配置 ET_BARK_URL, 跳过推送: {title}", flush=True)
        return False
    endpoint = BARK_URL.rstrip("/") + "/push"
    payload = {"title": title, "body": body, "group": "EnglishTool"}
    if url:
        payload["url"] = url
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(endpoint, json=payload)
        ok = r.status_code < 400
        if not ok:
            print(f"[notify] 失败 {r.status_code}: {r.text[:200]}", flush=True)
        return ok
    except Exception as exc:  # 推送失败绝不能影响主流程
        print(f"[notify] 异常: {exc}", flush=True)
        return False
