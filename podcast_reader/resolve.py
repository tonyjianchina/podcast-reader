"""把用户分享的链接解析成可下载的音频目标。

覆盖:
- 直接就是 RSS feed
- Apple Podcasts (podcasts.apple.com/.../id123456) -> iTunes Lookup API
  带 ?i=<trackId> 的单集链接 -> 用 Lookup 找到该集的 guid/音频, 在 feed 里精确选中这一集
- 小宇宙 (xyzfm.link / www.xiaoyuzhoufm.com/episode/xxx) -> 抓网页挖 <meta> / JSON
- 喜马拉雅、任意播客官网 -> 抓网页找 <link type="application/rss+xml"> 或 <audio>
- YouTube 等视频站 -> 交给 yt-dlp 直接处理 (kind="direct"),
  并先用 yt-dlp 只读元数据(标题/频道/封面/上传日期/时长), 同一频道归到同一个节目下

解析出的 feed_url 会缓存在 shows 表, 以后同一节目不再重解析。
"""

from __future__ import annotations

import asyncio
import html
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import feedparser
import httpx

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT = 25.0

APPLE_ID_RE = re.compile(r"/id(\d+)")
# Apple 单集链接的路径里带着单集标题的 slug: /podcast/<slug>/id<show>?i=<track>
APPLE_SLUG_RE = re.compile(r"/podcast/([^/]+)/id\d+")
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
    # kind="feed" 时: 已经精确选中的那一集(Apple ?i= 单集链接); None 表示取最新一集
    entry: dict[str, Any] | None = None
    # kind="direct" 时: 节目分组键(如 "youtube:channel:<id>"); None 表示每个链接单独成一个节目
    show_key: str | None = None
    show_title: str | None = None
    episode_image: str | None = None  # 单集封面(视频缩略图等), 列表里优先于节目封面
    duration_sec: float | None = None


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

    # 视频站直接交给 yt-dlp; 先只读元数据拿标题/频道/封面(读不到也不挡导入)
    if is_video_url(url):
        return await asyncio.to_thread(_video_target, url)

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # Apple Podcasts: 页面里只有节目 id, 必须走 iTunes API
        if "podcasts.apple.com" in host:
            m = APPLE_ID_RE.search(url)
            t = await _from_apple(client, m.group(1)) if m else None
            if not t:
                raise ValueError("无法从 Apple Podcasts 链接解析出 feed(可能已下架)")
            # 单集链接(?i=<trackId>): 精确选中那一集, 不能退化成"最新一集"
            track_id = (parse_qs(urlparse(url).query).get("i") or [""])[0].strip()
            if track_id.isdigit():
                slug = APPLE_SLUG_RE.search(urlparse(url).path)
                t.entry = await _apple_episode(
                    client, m.group(1), track_id, t.url, unquote(slug.group(1)) if slug else None
                )
            return t

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
    return _entry_dict(parsed.entries[0])


def _entry_dict(e: Any) -> dict[str, Any]:
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
        "image_url": (e.get("image") or {}).get("href") if isinstance(e.get("image"), dict) else None,
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


# ------------------------------------------------------- Apple 单集链接


def _norm_title(text: str | None) -> str:
    """标题比较用: 只留字母数字, 小写。Apple 的 slug 和 feed 标题按这个口径对齐。"""
    return re.sub(r"[^0-9a-z]+", "", (text or "").lower())


def _audio_key(url: str | None) -> str:
    """音频地址比较用: 去掉查询串和跟踪前缀(pscrb.fm/rss/p/、dts.podtrac.com/redirect.mp3/ 等)。

    跟踪前缀会把真实地址整个嵌进路径, 所以从最后一个"像域名"的路径段开始取。
    """
    if not url:
        return ""
    p = urlparse(url)
    parts = [x for x in (p.netloc + p.path).split("/") if x]
    start = 0
    for i, part in enumerate(parts[:-1]):
        if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", part, re.IGNORECASE):
            start = i
    return "/".join(parts[start:]).lower()


async def _lookup_track(client: httpx.AsyncClient, show_id: str, track_id: str, slug: str | None) -> dict[str, Any] | None:
    """在 iTunes 里找 trackId 对应的那一集。

    lookup?id=<trackId> 对单集返回 0 条(实测), 所以按节目 id 拉最近 200 集再挑;
    更老的单集用链接里的标题 slug 去 search 一次。
    """
    r = await client.get(
        "https://itunes.apple.com/lookup",
        params={"id": show_id, "entity": "podcastEpisode", "limit": 200},
        timeout=TIMEOUT,
    )
    if r.status_code < 400:
        for item in r.json().get("results") or []:
            if str(item.get("trackId")) == track_id:
                return item
    if slug:
        r = await client.get(
            "https://itunes.apple.com/search",
            params={"term": slug.replace("-", " ")[:200], "entity": "podcastEpisode", "limit": 50},
            timeout=TIMEOUT,
        )
        if r.status_code < 400:
            for item in r.json().get("results") or []:
                if str(item.get("trackId")) == track_id:
                    return item
    return None


def select_entry(
    feed_url: str,
    guid: str | None = None,
    audio_url: str | None = None,
    title: str | None = None,
    published: str | None = None,
    title_prefix: str | None = None,
) -> dict[str, Any] | None:
    """在 feed 里挑出指定的一集: 先比 guid, 再比音频地址, 再比标题(+日期), 最后比标题前缀。"""
    parsed = feedparser.parse(feed_url, agent=UA)
    entries = list(parsed.entries)
    if guid:
        for e in entries:
            if str(e.get("id") or e.get("guid") or "") == guid:
                return _entry_dict(e)
    if audio_url:
        want = _audio_key(audio_url)
        for e in entries:
            for enc in e.get("enclosures") or []:
                href = enc.get("href")
                if href and (href == audio_url or _audio_key(href) == want):
                    return _entry_dict(e)
    if title:
        want_t = _norm_title(title)
        hits = [e for e in entries if _norm_title(e.get("title")) == want_t]
        if len(hits) > 1 and published:
            day = published[:10]
            dated = [e for e in hits if _entry_day(e) == day]
            hits = dated or hits
        if hits:
            return _entry_dict(hits[0])
    if title_prefix:
        want_p = _norm_title(title_prefix)
        if len(want_p) >= 12:
            hits = [e for e in entries if _norm_title(e.get("title")).startswith(want_p)]
            if len(hits) == 1:
                return _entry_dict(hits[0])
    return None


def _entry_day(e: Any) -> str:
    t = e.get("published_parsed") or e.get("updated_parsed")
    return f"{t.tm_year:04d}-{t.tm_mon:02d}-{t.tm_mday:02d}" if t else ""


async def _apple_episode(
    client: httpx.AsyncClient, show_id: str, track_id: str, feed_url: str, slug: str | None
) -> dict[str, Any]:
    """Apple 单集链接 -> feed 里的那一集; feed 里找不到就退回 Lookup 给的音频地址。"""
    item = await _lookup_track(client, show_id, track_id, slug)
    if item:
        entry = await asyncio.to_thread(
            select_entry,
            feed_url,
            item.get("episodeGuid"),
            item.get("episodeUrl"),
            item.get("trackName"),
            item.get("releaseDate"),
        )
        if entry:
            return entry
        if item.get("episodeUrl"):
            return {
                "guid": item.get("episodeGuid") or item["episodeUrl"],
                "title": _clean(item.get("trackName")) or "未命名单集",
                "published_at": item.get("releaseDate"),
                "audio_url": item["episodeUrl"],
                "link": item.get("trackViewUrl"),
                "image_url": item.get("artworkUrl600"),
            }
    # Lookup 里也没有: 用链接里的标题 slug 在 feed 里按前缀找(只接受唯一命中)
    if slug:
        entry = await asyncio.to_thread(select_entry, feed_url, None, None, None, None, slug)
        if entry:
            return entry
    raise ValueError(f"在这个节目里找不到 Apple 单集 i={track_id}(可能已下架); 不会退化成导入最新一集")


# ------------------------------------------------------------ 视频站


def is_video_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host.endswith(h) or host == h for h in VIDEO_HOSTS)


def _https(url: str | None) -> str | None:
    if not url or not isinstance(url, str):
        return None
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("http://"):
        return "https://" + url[len("http://"):]
    return url if url.startswith("https://") else None


def best_thumbnail(info: dict[str, Any]) -> str | None:
    """挑高清 https 缩略图。yt-dlp 的 info['thumbnail'] 已是它认为最好的一张(YouTube 是 maxresdefault.jpg)。"""
    thumbs = [t for t in (info.get("thumbnails") or []) if _https(t.get("url"))]
    best = _https(info.get("thumbnail"))
    if not best and thumbs:
        thumbs.sort(key=lambda t: (t.get("preference") or 0, (t.get("width") or 0) * (t.get("height") or 0)))
        best = _https(thumbs[-1]["url"])
    # 同分辨率有 jpg 就用 jpg(webp 在老浏览器/部分 WebView 里显示不了)
    if best and urlparse(best).path.endswith(".webp"):
        stem = urlparse(best).path.rsplit("/", 1)[-1][: -len(".webp")]
        vid = urlparse(best).path.rstrip("/").split("/")[-2] if "/" in urlparse(best).path else ""
        for t in thumbs:
            path = urlparse(t["url"]).path
            if path.endswith(f"/{vid}/{stem}.jpg") and not urlparse(t["url"]).query:
                return _https(t["url"])
    return best


def video_meta(url: str) -> dict[str, Any]:
    """用 yt-dlp 只读元数据(不下载)。同步函数, 调用方自己放进线程。"""
    from yt_dlp import YoutubeDL

    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False) or {}

    published = None
    ts = info.get("timestamp") or info.get("release_timestamp")
    if ts:
        published = format_datetime(datetime.fromtimestamp(int(ts), tz=timezone.utc))
    elif info.get("upload_date"):
        try:
            d = datetime.strptime(str(info["upload_date"]), "%Y%m%d").replace(tzinfo=timezone.utc)
            published = format_datetime(d)
        except ValueError:
            pass

    channel = _clean(info.get("channel") or info.get("uploader"))
    channel_id = info.get("channel_id") or info.get("uploader_id")
    site = (info.get("extractor_key") or "video").lower()
    return {
        "title": _clean(info.get("title")),
        "channel": channel,
        "uploader": _clean(info.get("uploader")),
        "show_key": f"{site}:channel:{channel_id}" if channel_id else None,
        "image_url": best_thumbnail(info),
        "published_at": published,
        "duration_sec": float(info["duration"]) if info.get("duration") else None,
        "webpage_url": info.get("webpage_url"),
    }


def _video_target(url: str) -> Target:
    try:
        meta = video_meta(url)
    except Exception as exc:  # 元数据读不到不挡导入, 下载阶段 yt-dlp 会给出真正的错误
        print(f"[resolve] 读视频元数据失败, 按无标题导入: {exc}", flush=True)
        return Target(kind="direct", url=url)
    return Target(
        kind="direct",
        url=url,
        title=meta["title"],
        author=meta["uploader"],
        show_key=meta["show_key"],
        show_title=meta["channel"],
        episode_image=meta["image_url"],
        published_at=meta["published_at"],
        duration_sec=meta["duration_sec"],
    )
