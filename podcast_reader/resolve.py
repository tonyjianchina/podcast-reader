"""把用户分享的链接解析成可下载的音频目标。

覆盖:
- 直接就是 RSS feed
- Apple Podcasts (podcasts.apple.com/.../id123456) -> iTunes Lookup API
- 小宇宙 (xyzfm.link / www.xiaoyuzhoufm.com/episode/xxx) -> 抓网页挖 <meta> / JSON
- 喜马拉雅、任意播客官网 -> 抓网页找 <link type="application/rss+xml"> 或 <audio>
- YouTube 等视频站 -> 交给 yt-dlp 直接处理 (kind="direct")

解析出的 feed_url 会缓存在 shows 表, 以后同一节目不再重解析。
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import feedparser
import httpx

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT = 25.0

APPLE_ID_RE = re.compile(r"/id(\d+)")
FEED_LINK_RE = re.compile(
    r"""<link[^>]+type=["']application/rss\+xml["'][^>]*>""", re.IGNORECASE
)
HREF_RE = re.compile(r"""href=["']([^"']+)["']""", re.IGNORECASE)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
AUDIO_URL_RE = re.compile(
    r"""["'](https?://[^"'\\\s]+?\.(?:mp3|m4a|aac|ogg|opus|wav)(?:\?[^"'\\\s]*)?)["']""",
    re.IGNORECASE,
)
VIDEO_HOSTS = (
    "youtube.com",
    "youtu.be",
    "bilibili.com",
    "vimeo.com",
)


@dataclass
class Target:
    """一次导入的最终目标。"""

    kind: str  # "feed" | "direct"
    url: str  # feed URL 或音频/视频页面 URL
    title: str | None = None
    author: str | None = None
    image_url: str | None = None
    audio_url: str | None = None  # kind="direct" 且已知时
    guid: str | None = None
    published_at: str | None = None


def _clean(text: str | None) -> str | None:
    if not text:
        return None
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(text).strip() or None


def _looks_like_feed(body: bytes, ctype: str) -> bool:
    head = body[:400].lstrip().lower()
    if head.startswith(b"<?xml") or head.startswith(b"<rss") or head.startswith(b"<feed"):
        return True
    return "xml" in ctype and b"<rss" in body[:4000].lower()


async def _get(client: httpx.AsyncClient, url: str) -> httpx.Response:
    return await client.get(url, follow_redirects=True, headers={"User-Agent": UA})


async def _parse_feed(url: str, body: bytes | None = None) -> Target | None:
    """确认 url 是一个可用的播客 feed。"""
    if body is None:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await _get(client, url)
            if r.status_code >= 400:
                return None
            body = r.content
    parsed = feedparser.parse(body)
    if not parsed.entries:
        return None
    meta = parsed.feed
    return Target(
        kind="feed",
        url=url,
        title=_clean(meta.get("title")),
        author=_clean(meta.get("author") or meta.get("itunes_author")),
        image_url=(meta.get("image") or {}).get("href") if isinstance(meta.get("image"), dict) else None,
    )


async def _from_apple(client: httpx.AsyncClient, show_id: str) -> Target | None:
    r = await client.get(
        "https://itunes.apple.com/lookup",
        params={"id": show_id, "entity": "podcast"},
        timeout=TIMEOUT,
    )
    if r.status_code >= 400:
        return None
    results = r.json().get("results") or []
    for item in results:
        feed = item.get("feedUrl")
        if feed:
            t = await _parse_feed(feed)
            if t:
                t.title = t.title or _clean(item.get("collectionName"))
                t.author = t.author or _clean(item.get("artistName"))
                t.image_url = t.image_url or item.get("artworkUrl600")
                return t
    return None


async def _from_page(client: httpx.AsyncClient, url: str, body: str) -> Target | None:
    """从网页里挖 feed 地址, 或退化到直接音频地址。"""
    for m in FEED_LINK_RE.finditer(body):
        href = HREF_RE.search(m.group(0))
        if href:
            cand = html.unescape(href.group(1))
            if cand.startswith("//"):
                cand = "https:" + cand
            t = await _parse_feed(cand)
            if t:
                title = TITLE_RE.search(body)
                t.title = t.title or _clean(title.group(1) if title else None)
                return t

    # 有些站把 feed 放在 JSON 里
    m = re.search(r'"(?:feedUrl|feed_url|rss)"\s*:\s*"(https?://[^"]+)"', body)
    if m:
        t = await _parse_feed(html.unescape(m.group(1)))
        if t:
            return t

    # 退化: 页面里直接有音频文件
    m = AUDIO_URL_RE.search(body)
    if m:
        title = TITLE_RE.search(body)
        return Target(
            kind="direct",
            url=url,
            title=_clean(title.group(1) if title else None),
            audio_url=html.unescape(m.group(1)),
        )
    return None


async def resolve(raw_url: str) -> Target:
    """入口: 任意分享链接 -> Target。失败抛 ValueError。"""
    url = raw_url.strip()
    if not url:
        raise ValueError("空链接")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    host = (urlparse(url).hostname or "").lower()

    # 视频站直接交给 yt-dlp
    if any(host.endswith(h) or host == h for h in VIDEO_HOSTS):
        return Target(kind="direct", url=url)

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Apple Podcasts: 页面里只有节目 id, 必须走 iTunes API
        if "podcasts.apple.com" in host:
            m = APPLE_ID_RE.search(url)
            if m:
                t = await _from_apple(client, m.group(1))
                if t:
                    return t
            raise ValueError("无法从 Apple Podcasts 链接解析出 feed(可能已下架)")

        r = await _get(client, url)
        if r.status_code >= 400:
            raise ValueError(f"抓取失败: HTTP {r.status_code}")

        ctype = r.headers.get("content-type", "")
        if _looks_like_feed(r.content, ctype):
            t = await _parse_feed(str(r.url), r.content)
            if t:
                return t

        t = await _from_page(client, str(r.url), r.text)
        if t:
            return t

    raise ValueError("解析不出播客源。请在该播客客户端里复制「RSS 订阅地址」手动填入。")


def latest_entry(feed_url: str) -> dict[str, Any]:
    """取 feed 里最新一集(你分享链接时, 想要的通常就是刚听到的那集)。"""
    parsed = feedparser.parse(feed_url, agent=UA)
    if not parsed.entries:
        raise ValueError("feed 里没有单集")
    e = parsed.entries[0]
    audio_url = None
    for enc in e.get("enclosures") or []:
        if enc.get("href"):
            audio_url = enc["href"]
            break
    if not audio_url:
        for link in e.get("links") or []:
            if link.get("rel") == "enclosure" or "audio" in (link.get("type") or ""):
                audio_url = link.get("href")
                break
    return {
        "guid": e.get("id") or e.get("guid") or e.get("link") or e.get("title"),
        "title": _clean(e.get("title")) or "未命名单集",
        "published_at": e.get("published") or e.get("updated"),
        "audio_url": audio_url,
        "link": e.get("link"),
    }


def find_entry_by_audio(feed_url: str, audio_url: str) -> dict[str, Any]:
    """当直接拿到了音频地址时, 反查它属于哪一集(拿正确的标题与发布时间)。"""
    parsed = feedparser.parse(feed_url, agent=UA)
    for e in parsed.entries:
        for enc in e.get("enclosures") or []:
            if enc.get("href") == audio_url:
                return {
                    "guid": e.get("id") or e.get("guid") or audio_url,
                    "title": _clean(e.get("title")) or "未命名单集",
                    "published_at": e.get("published") or e.get("updated"),
                    "audio_url": audio_url,
                    "link": e.get("link"),
                }
    return {
        "guid": audio_url,
        "title": "未命名单集",
        "published_at": None,
        "audio_url": audio_url,
        "link": None,
    }
