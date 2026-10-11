"""Whisper 转录 (MLX, Apple Silicon)。

输出句级时间戳的 segments。句级而不是词级, 理由见 DESIGN.md §3 D15。

关键参数:
- language="en" 强制英文。代码切换检测在专有名词上容易抖, 强制更稳。
- initial_prompt 喂热词表(hotwords.txt)。专有名词是错拼重灾区:
  实测把嘉宾名 Krishna 听成了 "Crisola" / "Chris Ola"。这是最便宜的准确率提升。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import WHISPER_LANG, WHISPER_MODEL, hot_words

# 每块 4 分钟。实测 Whisper 在长文件上的时间戳会漂移到数秒, 分块后偏差被限制在块内。
CHUNK_SEC = 240.0
# 块间重叠 12 秒, 用来找接缝(重复句), 避免丢句或重复
CHUNK_OVERLAP = 12.0


def _transcribe_sync(
    audio_path: Path,
    *,
    model: str,
    language: str,
    initial_prompt: str,
) -> dict[str, Any]:
    import mlx_whisper

    return mlx_whisper.transcribe(
        str(audio_path),
        path_or_hf_repo=model,
        language=language,
        initial_prompt=initial_prompt,
        word_timestamps=False,
        condition_on_previous_text=False,  # 防止一段幻觉污染后面整段
        verbose=None,
    )


def _clean(text: str) -> str:
    return " ".join(text.split()).strip()


def transcribe(
    audio_path: Path,
    *,
    model: str | None = None,
    language: str | None = None,
    prompt: str | None = None,
) -> list[dict[str, Any]]:
    """返回 [{start, end, text}, ...], 每个元素是一句话。

    **长音频分块转录**(见 `transcribe_chunked`):不分块时 Whisper 的时间戳会在
    长文件上漂移, 实测某一集在 3 分钟附近偏了 4 秒 —— 表现就是"文本读到的地方和
    听到的对不上"。分块后每块独立对齐, 偏差被限制在块内。
    """
    return transcribe_chunked(
        audio_path,
        model=model,
        language=language,
        prompt=prompt,
    )


def _probe_duration(path: Path) -> float | None:
    import shutil
    import subprocess

    exe = shutil.which("ffprobe")
    if not exe:
        return None
    try:
        res = subprocess.run(
            [exe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=120,
        )
        return float(res.stdout.strip())
    except Exception:
        return None


def _write_wav(src: Path, dst: Path, start: float, dur: float) -> bool:
    """切出一段 16k 单声道 wav。返回是否成功。"""
    import shutil
    import subprocess

    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    try:
        res = subprocess.run(
            [exe, "-y", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}",
             "-i", str(src), "-ar", "16000", "-ac", "1", str(dst)],
            capture_output=True, text=True, timeout=1800,
        )
        return res.returncode == 0 and dst.exists() and dst.stat().st_size > 1024
    except Exception:
        return False


def _norm(t: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "", t.lower())


def transcribe_chunked(
    audio_path: Path,
    *,
    model: str | None = None,
    language: str | None = None,
    prompt: str | None = None,
    chunk_sec: float = CHUNK_SEC,
    overlap_sec: float = CHUNK_OVERLAP,
    offset_sec: float = 0.0,
) -> list[dict[str, Any]]:
    """分块转录后拼接。`offset_sec` 用于只转录某个片段时把时间戳平移回全片坐标。

    每块单独跑一次 Whisper 并把时间戳加回块偏移, 因此块内不累积漂移。
    块之间留 `overlap_sec` 重叠, 拼接时用「与前一块尾部重复的句子」作为接缝,
    避免在接缝处丢句或重复。
    """
    total = _probe_duration(audio_path)
    if not total or total <= chunk_sec + 5:
        # 短音频不用分块, 分块反而会因为切断句子而变差
        return split_multi_sentence(transcribe_range(
            audio_path, 0.0, total or 0.0, model=model, language=language,
            prompt=prompt, offset=offset_sec,
        ))

    import tempfile

    merged: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="et-asr-") as td:
        start = 0.0
        idx = 0
        while start < total - 1:
            dur = min(chunk_sec + overlap_sec, total - start)
            wav = Path(td) / f"chunk{idx:03d}.wav"
            if not _write_wav(audio_path, wav, start, dur):
                print(f"[transcribe] 切块失败 {start:.0f}s, 退回整文件转录", flush=True)
                return split_multi_sentence(transcribe_range(
                    audio_path, 0.0, total, model=model, language=language,
                    prompt=prompt, offset=offset_sec,
                ))
            part = transcribe_range(
                wav, start, start + dur, model=model, language=language,
                prompt=prompt, offset=start + offset_sec,
            )
            merged = _merge(merged, part, keep_from=start + offset_sec, overlap=overlap_sec)
            print(
                f"[transcribe] 块 {idx + 1}: {start:.0f}~{start + dur:.0f}s -> {len(part)} 句"
                f"(累计 {len(merged)})",
                flush=True,
            )
            idx += 1
            # 下一块从「本块结束 - 重叠」开始, 但至少前进 chunk_sec, 避免死循环
            start = start + chunk_sec
    # 全部分块合并之后再拆多句段: 这样跨块的碎片也能并回正确的前一句
    return split_multi_sentence(merged)


def _similar(a: str, b: str) -> float:
    """两段文字的相似度(0~1)。"""
    from difflib import SequenceMatcher

    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _merge(
    base: list[dict[str, Any]],
    part: list[dict[str, Any]],
    keep_from: float | None = None,
    overlap: float = 0.0,
) -> list[dict[str, Any]]:
    """把 part 接到 base 上, 并保证时间戳**单调不倒退**。

    做法: 按「本块自己的局部时间」裁切。
      - 本块从 chunk_start 开始, 其中前 `overlap` 秒与前一块重叠。
      - 只有起点 **早于** chunk_start 的句子才可能是前一块的内容, 直接丢掉。
      - 起点晚于 chunk_start 的句子一律保留(哪怕它和前一块最后一句内容重合)。

    不能只按「前一块最后一句的结束时间」裁: Whisper 偶尔给出跨块边界的幽灵片段
    (实测有一句 start=971.8 却结束在 973s 之后), 它的 end 会把裁切线推进下一块内部,
    于是下一块的句子被留下, 而它们的时间更早 -> 时间戳倒退(实测出现 7 处)。
    """
    if not base:
        return list(part)
    if not part:
        return list(base)

    # 本块实际最早从哪秒开始 —— 比外部传进来的块起点更准(切块可能对齐到帧边界)。
    local_start = min(p["start_sec"] for p in part)
    if keep_from is None:
        keep_from = local_start

    # 规则 1: 起点早于本块起点的句子属于前一块。
    kept = [p for p in part if p["start_sec"] >= keep_from - 0.05]
    if not kept:
        return list(base)

    # 规则 2: 本块开始的位置一定晚于前一块 —— 前一块里起点晚于本块起点的,
    # 只可能是 Whisper 的幽灵片段(起始时间被记到了下一块内部), 丢掉。
    trimmed = [b for b in base if b["start_sec"] < local_start - 0.05]
    if not trimmed:
        trimmed = list(base)

    merged = trimmed + kept

    return _drop_stub_segments(_dedupe(trimmed + kept))


def split_multi_sentence(
    segs: list[dict[str, Any]], min_words: int = 3
) -> list[dict[str, Any]]:
    """把"一个片段里装了多句话"的段拆成单句, 时间按字数比例分配。

    Whisper 经常把连续的几句话并成一条(实测占 11~17%, 最夸张的一条 30 秒塞了 7 句)。
    后果不只是翻译变成"一整段": 高亮和跟随滚动都以段为单位, 于是"整段一起亮、整段一起滚"
    —— 这正是"定位不是每句话"的根源。所以必须在数据层拆开, 光靠 CSS 调间距治不了。

    只按标点拆、不改一个字; 时间按字符数比例分配, 误差通常在 1 秒内。
    太短的碎片(少于 min_words 个词)不单独成句, 并回前一条, 免得出现 "of it." 这种噪音。
    """
    import re

    out: list[dict[str, Any]] = []
    for s in segs:
        text = (s.get("text") or "").strip()
        span = float(s["end_sec"]) - float(s["start_sec"])
        # 句末标点 + 空格 + 大写/引号/括号 = 新一句的开始
        parts = re.split(r'(?<=[.!?])\s+(?=[A-Z"\'(\[])', text) if text else []
        parts = [p.strip() for p in parts if p.strip()]
        if len(parts) <= 1 or span <= 0:
            out.append(s)
            continue
        # 先累积、够长才落成一条: 这样 "of it." 这类跨段碎片会和它**后面**的句子
        # 合成一条(并回前面会让时间戳跳回上一段, 破坏单调性)。
        parts2: list[str] = []
        buf: list[str] = []
        for part in parts:
            buf.append(part)
            if len(part.split()) >= min_words:
                parts2.append(" ".join(buf))
                buf = []
        if buf:
            if parts2:
                parts2[-1] = parts2[-1] + " " + " ".join(buf)
            else:
                parts2.append(" ".join(buf))

        if len(parts2) <= 1:
            out.append({**s, "text": parts2[0] if parts2 else text})
            continue
        total_chars = sum(len(m) for m in parts2) or 1
        t = float(s["start_sec"])
        for i, m in enumerate(parts2):
            share = span * (len(m) / total_chars)
            end = float(s["end_sec"]) if i == len(parts2) - 1 else t + share
            out.append({"start_sec": round(t, 2), "end_sec": round(end, 2), "text": m})
            t = end
    return out


# 一条"句子"最长不该超过这么多秒; 超过就是 Whisper 把一段没听清的内容
# (广告/音乐/无人声)压成了一条, 文本往往只有一两个词。
MAX_SEG_SEC = 15.0


def _drop_stub_segments(segs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """丢掉"长时间跨度 + 极少文字"的空壳句。

    实测踩过: 一段被 Whisper 判为无语音的广告, 输出成 [167.4-197.4] "Thank you."
    —— 一条 30 秒的句子只有两个词。它会让高亮在那 30 秒里死死停在同一条上,
    看起来就是"文本和声音完全对不上"。丢掉它, 高亮会停在上一条真实句子上,
    等真实内容回来再接上, 体验反而连贯。
    """
    out: list[dict[str, Any]] = []
    for s in segs:
        span = s["end_sec"] - s["start_sec"]
        words = len(s["text"].split())
        if span > MAX_SEG_SEC and words <= 6:
            continue
        out.append(s)
    return out


def _dedupe(segs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按时间排序, 去掉重叠区产生的重复句, 并保证时间戳单调不倒退。

    只跟"紧邻上一条"比较是不够的: 拼接后顺序可能是 [960.0, 971.8, 960.0, ...],
    第二条 960.0 与紧邻的 971.8 既不重复也不倒退, 于是漏掉。所以先排序、再顺序清理。
    同一句话在重叠区会出现两次且断句略有不同, 保留内容更完整的那条。
    """
    ordered = sorted(segs, key=lambda x: (x["start_sec"], -len(x["text"])))

    out: list[dict[str, Any]] = []
    for seg in ordered:
        if out:
            prev = out[-1]
            near = abs(seg["start_sec"] - prev["start_sec"]) < 0.6
            if _similar(_norm(prev["text"]), _norm(seg["text"])) >= 0.55:
                # 重复: 完整的那条已经在前面(排序时长的优先), 直接跳过
                if near or len(seg["text"]) <= len(prev["text"]):
                    continue
                out.pop()
            elif near and len(seg["text"]) < len(prev["text"]):
                continue
        out.append(seg)
    return out


def transcribe_range(
    audio_path: Path,
    _start: float,
    _end: float,
    *,
    model: str | None = None,
    language: str | None = None,
    prompt: str | None = None,
    offset: float = 0.0,
) -> list[dict[str, Any]]:
    """转录一个音频文件, 并把时间戳整体平移 offset。"""
    result = _transcribe_sync(
        audio_path,
        model=model or WHISPER_MODEL,
        language=language or WHISPER_LANG,
        initial_prompt=prompt if prompt is not None else hot_words(),
    )
    segs: list[dict[str, Any]] = []
    for s in result.get("segments") or []:
        text = _clean(s.get("text") or "")
        if not text:
            continue
        segs.append(
            {
                "start_sec": float(s["start"]) + offset,
                "end_sec": float(s["end"]) + offset,
                "text": text,
            }
        )
    return segs
