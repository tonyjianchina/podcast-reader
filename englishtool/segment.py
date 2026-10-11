"""把 Whisper 的无换行文本变成「一篇能读的文章」。

铁律(见 DESIGN.md §6):**AI 只决定在哪里换行, 绝不允许改动任何一个字。**

实现方式不是靠提示词祈祷, 而是靠输出格式本身让「改写」不可能发生:
1. 只把句子的**编号**发给模型, 让它返回段落边界 [[起, 止], ...]。
   模型根本没有机会回显或改写原文——它只吐数字。
2. 校验是纯数学的: 必须是整数、必须从 0 开始连续覆盖到最后一句、不许重叠或空洞。
3. 任何异常(超时、限额、格式错、越界) -> 把这一批**二分重试**;
   小到一定程度还失败才退回机械分段。宁可段落难看, 也绝不让文章缺内容或错乱。

(第一版用的是「让模型原样回显并在分段处插 | 」, 实测 18 批里有 4 批因为模型漏句
 导致字符对不上而整批作废。改成纯序号后校验不再依赖文本比对。)
"""

from __future__ import annotations

import json
import re
from typing import Iterable

import httpx

from .config import DEEPSEEK_API_KEY, DEEPSEEK_BASE, DEEPSEEK_MODEL

# 一次请求携带多少句。太大模型会偷懒漏句, 太小会丢失话题连贯性。
BATCH = 30
# 二分重试的下限: 小于这个句数就不再拆, 直接机械分段兜底
MIN_BATCH = 4
# 机械分段的兜底长度
FALLBACK_EVERY = 4

PROMPT = """你是播客文字稿的排版助手。下面按编号给出了一集播客的连续句子。

你的唯一任务:决定哪些**相邻句子**应该合成一个自然段, 返回段落边界。

严格规则:
1. 你**只能输出编号**, 不允许输出、改写、引用、评论任何原文内容。
2. 必须从第 0 句开始, 连续的、不重叠的覆盖到最后一号, 不能漏掉任何一句。
3. **每段 2~5 句**。超过 5 句的段落是不合格的, 请在合适的位置切开。
   宁可切得多一点, 也不要出现又长又厚的段落 —— 读者是在手机上看。
4. 在话题转换、说话人切换、逻辑推进处切段。
5. **广告/赞助口播必须独立成段**, 并且与其他内容分开。
   识别特征:提到品牌名、网址、"slash"、促销码、"supported by"、"sponsored"、
   "use code"、"go to ...com"、"get started with" 等。一段广告里如果有多个品牌,
   每个品牌各自成段。
6. 主持人串场、问候、道别("I'm Max Reed", "Thank you", "we'll be right back")
   各自独立成段, 不要和正文粘在一起。
7. 不要输出解释、不要用 markdown 代码块。

输出格式(只输出这个 JSON 数组, 不要别的东西):
[[0,3],[4,7],[8,12]]

句子:
__LINES__
"""


def _mechanical(texts: list[str], every: int = FALLBACK_EVERY) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    n = len(texts)
    i = 0
    while i < n:
        j = min(i + every - 1, n - 1)
        ranges.append((i, j))
        i = j + 1
    return ranges


def _to_lines(texts: list[str]) -> str:
    return "\n".join(f"{i}. {t}" for i, t in enumerate(texts))


def _parse_ranges(content: str, n: int) -> list[tuple[int, int]] | None:
    """解析并严格校验模型返回的段落边界。返回 None 表示这一批作废。"""
    content = content.strip()
    content = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", content).strip()
    m = re.search(r"\[.*\]", content, re.DOTALL)
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, list) or not raw:
        return None

    ranges: list[tuple[int, int]] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            return None
        try:
            a, b = int(item[0]), int(item[1])
        except (TypeError, ValueError):
            return None
        ranges.append((a, b))

    # 纯数学校验: 连续覆盖 [0, n-1], 不重叠、不越界、每段非空
    if ranges[0][0] != 0 or ranges[-1][1] != n - 1:
        return None
    for i, (a, b) in enumerate(ranges):
        if a > b or a < 0 or b >= n:
            return None
        if i and a != ranges[i - 1][1] + 1:
            return None
    return ranges


async def _ask(client: httpx.AsyncClient, texts: list[str]) -> list[tuple[int, int]] | None:
    if not texts:
        return []
    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [{"role": "user", "content": PROMPT.replace("__LINES__", _to_lines(texts))}],
        "temperature": 0,
        "max_tokens": 2000,
    }
    headers = {"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"}
    try:
        r = await client.post(
            f"{DEEPSEEK_BASE.rstrip('/')}/chat/completions",
            json=payload,
            headers=headers,
            timeout=180,
        )
    except httpx.HTTPError as exc:
        print(f"[segment] 请求异常: {type(exc).__name__}", flush=True)
        return None
    if r.status_code >= 400:
        print(f"[segment] API 错误 {r.status_code}: {r.text[:160]}", flush=True)
        return None
    content = r.json()["choices"][0]["message"]["content"] or ""
    return _parse_ranges(content, len(texts))


async def _batch_ranges(
    client: httpx.AsyncClient, texts: list[str], depth: int = 0
) -> list[tuple[int, int]]:
    """处理一批。失败就二分重试, 拆到 MIN_BATCH 还失败才机械分段。"""
    got = await _ask(client, texts)
    if got is not None:
        return got

    if len(texts) <= MIN_BATCH:
        print(f"[segment] {len(texts)} 句仍失败, 机械分段兜底", flush=True)
        return _mechanical(texts)

    mid = len(texts) // 2
    head = await _batch_ranges(client, texts[:mid], depth + 1)
    tail = await _batch_ranges(client, texts[mid:], depth + 1)
    return head + [(a + mid, b + mid) for a, b in tail]


async def paragraph_ranges(texts: Iterable[str]) -> list[tuple[int, int]]:
    """返回 [(start_seg_idx, end_seg_idx), ...], 覆盖全部句子且不重叠。"""
    texts = list(texts)
    if not texts:
        return []
    if not DEEPSEEK_API_KEY:
        print("[segment] 未配置 ET_DEEPSEEK_API_KEY, 使用机械分段", flush=True)
        return _mechanical(texts)

    all_ranges: list[tuple[int, int]] = []
    async with httpx.AsyncClient() as client:
        for base in range(0, len(texts), BATCH):
            batch = texts[base : base + BATCH]
            got = await _batch_ranges(client, batch)
            all_ranges.extend((a + base, b + base) for a, b in got)

    # 最终兜底: 万一拼接后仍有空洞, 整个退回机械分段(不允许出现半个字丢失)
    if (
        not all_ranges
        or all_ranges[0][0] != 0
        or all_ranges[-1][1] != len(texts) - 1
        or any(a > b for a, b in all_ranges)
    ):
        print("[segment] 最终校验失败, 整体退回机械分段", flush=True)
        return _mechanical(texts)
    return all_ranges


def render(texts: list[str], ranges: list[tuple[int, int]]) -> str:
    """把句子 + 段落区间渲染成文章纯文本(仅用于调试与导出)。"""
    return "\n\n".join(" ".join(texts[a : b + 1]) for a, b in ranges)
