"""下载音频。统一走 yt-dlp 的 Python API:

播客直链、YouTube、以及各种奇怪的站点它都能处理, 比手写 httpx 下载更省事
(还能自动处理重定向、分片、m4a/mp3 转换)。
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .config import AUDIO_DIR


def _slug(text: str, limit: int = 60) -> str:
    keep = [c if (c.isalnum() or c in "-_") else "-" for c in text]
    out = "".join(keep).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return (out[:limit] or "episode")


def ffprobe_duration(path: Path) -> float | None:
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    try:
        res = subprocess.run(
            [exe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        return float(res.stdout.strip())
    except Exception:
        return None


def _download_sync(url: str, outtmpl: str, audio_only: bool) -> dict[str, Any]:
    from yt_dlp import YoutubeDL

    def hook(d: dict[str, Any]) -> None:
        if d.get("status") == "finished":
            print(f"[fetch] 下载完成: {d.get('filename')}", flush=True)

    opts: dict[str, Any] = {
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "retries": 3,
        "fragment_retries": 3,
        "noplaylist": True,
    }
    if audio_only:
        opts["format"] = "bestaudio/best"
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    return info or {}


async def download(
    audio_url: str, show_title: str, episode_title: str, episode_id: str
) -> tuple[Path, float | None]:
    """下载到 data/audio/<show>/<episode_id>-<slug>.<ext>, 返回 (路径, 时长秒)。"""
    show_dir = AUDIO_DIR / _slug(show_title, 40)
    show_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{episode_id}-{_slug(episode_title)}"
    outtmpl = str(show_dir / f"{stem}.%(ext)s")

    info = await asyncio.to_thread(_download_sync, audio_url, outtmpl, True)

    # yt-dlp 可能改变扩展名, 用 requested_downloads / 文件扫描找回真实路径
    path: Path | None = None
    for d in (info.get("requested_downloads") or []):
        fp = d.get("filepath")
        if fp and Path(fp).exists():
            path = Path(fp)
            break
    if path is None:
        found = sorted(show_dir.glob(f"{stem}.*"), key=lambda p: p.stat().st_mtime, reverse=True)
        path = found[0] if found else None
    if path is None or not path.exists():
        raise RuntimeError(f"下载后找不到文件: {outtmpl}")

    # 时长以「实测」为准, 不能信 yt-dlp 的 info['duration']。
    # 实测踩过的坑: 同一集播客 info 报 3019.89 秒, ffprobe 实测 3495.995 秒,
    # 差 476 秒。用错值会把最后一段对话当成"超出音频"直接截掉。
    duration = ffprobe_duration(path) or info.get("duration")
    return path, (float(duration) if duration else None)
