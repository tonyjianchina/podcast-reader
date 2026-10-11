"""逐句中译。

用途:遇到整句读不懂时, 有个中文垫底, 不至于卡死在那一句上。

设计要点:
- **按句生成, 一次存库, 永久缓存**。反复开关「显示翻译」不会重复花钱。
- **两句对齐**。因为 UI 要把中译放在对应英文句子的下面, 所以翻译必须严格按句返回,
  不能合成一整段——那会失去与音频时间轴的对齐。
- 分批请求, 每批之间复用同一个 client; 单批失败只丢这一批, 不整集重来。
"""

from __future__ import annotations

import json
import re
from typing import Iterable

import httpx

from .config import DEEPSEEK_API_KEY, DEEPSEEK_BASE, DEEPSEEK_MODEL

BATCH = 25

PROMPT = """你在为中文母语者翻译英文播客的文字稿。下面按编号给出连续的若干句。

要求:
1. 逐句翻译成**自然、口语化的简体中文**。像播客听众能听懂的中文, 不要翻译腔,
   不要把 "you know" 硬译成「你知道」——这类填充词可以自然吸收或省略。
2. 必须**一句对一句**, 输出的数组长度和输入完全一致, 顺序一致。
3. 保留专有名词的通行译法(如 Anthropic 保留英文或译「Anthropic 公司」皆可, 前后一致即可);
   人名、公司名一般保留英文原样更清楚。
4. 术语保持一致。若某个词在本批首次出现, 优先用中文读者熟悉的译法。
5. 只输出 JSON 数组, 不要解释, 不要 markdown 代码块。

输入:
__LINES__

输出(长度必须等于 __N__):
["第一句的中译", "第二句的中译"]
"""


def _to_lines(texts: list[str]) -> str:
    return "\n".join(f"{i}. {t}" for i, t in enumerate(texts))


def _parse(content: str, n: int) -> list[str] | None:
    content = content.strip()
    content = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", content).strip()
    m = re.search(r"\[.*\]", content, re.DOTALL)
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, list) or len(raw) != n:
        return None
    out = [str(x).strip() for x in raw]
    # 明确拒绝"整批合成一句话"的情况: 那样会破坏与句子的对齐
    if any(not s for s in out):
        return None
    return out


async def _ask(client: httpx.AsyncClient, texts: list[str]) -> list[str] | None:
    body = PROMPT.replace("__LINES__", _to_lines(texts)).replace("__N__", str(len(texts)))
    try:
        r = await client.post(
            f"{DEEPSEEK_BASE.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": DEEPSEEK_MODEL,
                "messages": [{"role": "user", "content": body}],
                "temperature": 0.3,
                "max_tokens": 4000,
            },
            timeout=180,
        )
    except httpx.HTTPError as exc:
        print(f"[translate] 请求异常: {type(exc).__name__}", flush=True)
        return None
    if r.status_code >= 400:
        print(f"[translate] API 错误 {r.status_code}: {r.text[:160]}", flush=True)
        return None
    content = r.json()["choices"][0]["message"]["content"] or ""
    return _parse(content, len(texts))


async def _batch(client: httpx.AsyncClient, texts: list[str]) -> list[str] | None:
    """一批翻译。数目对不上就二分重试, 拆到单句还失败就放弃这一批。"""
    got = await _ask(client, texts)
    if got is not None:
        return got
    if len(texts) <= 1:
        print("[translate] 单句仍失败, 跳过", flush=True)
        return None
    mid = len(texts) // 2
    head = await _batch(client, texts[:mid]) or [""] * mid
    tail = await _batch(client, texts[mid:]) or [""] * (len(texts) - mid)
    return head + tail


async def translate_all(
    texts: Iterable[str], on_progress=None
) -> list[tuple[int, str]]:
    """返回 [(seg_idx, 中译), ...]。失败/为空的句子直接不返回, 前端留空即可。"""
    texts = list(texts)
    if not texts:
        return []
    if not DEEPSEEK_API_KEY:
        print("[translate] 未配置 ET_DEEPSEEK_API_KEY, 跳过翻译", flush=True)
        return []

    out: list[tuple[int, str]] = []
    total = (len(texts) + BATCH - 1) // BATCH
    async with httpx.AsyncClient() as client:
        for b, base in enumerate(range(0, len(texts), BATCH)):
            batch = texts[base : base + BATCH]
            got = await _batch(client, batch)
            if got:
                out.extend(
                    (base + i, t) for i, t in enumerate(got) if t and t.strip()
                )
            if on_progress:
                on_progress(b + 1, total)
    return out
