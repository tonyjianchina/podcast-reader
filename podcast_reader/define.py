"""生词释义:语境义 + 音标词性 + 词根 + 其他义项 + 关联词句。

缓存键 = sha256(lemma + 所在句子)。理由见 DESIGN.md §3 D14:
一天点几十次且大量重复, 不缓存则钱和延迟都会爆炸。
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from .config import DEEPSEEK_API_KEY, DEEPSEEK_BASE, DEEPSEEK_MODEL
from .db import get_explanation, save_explanation

SYSTEM = """你是一位给中文母语者讲英语的老师, 服务对象在听英文科技/财经播客。
你的解释要精准、简短、可记忆, 不要客套话。

输出必须是严格的 JSON, 不要 markdown 代码块, 结构如下:
{
  "lemma": "词的原形(如 ran -> run; 短语保持原样)",
  "sense_here": "这个词/短语在给定句子里的确切意思, 用中文, 一句话说清, 并点明它为什么是这个意思",
  "pos": "词性(如 动词 / 名词 / 形容词)",
  "ipa": "英式或美式音标, 形式如 /rʌn/",
  "roots": {
    "available": true 或 false,
    "parts": [{"part": "词根/词缀", "meaning": "含义"}],
    "memory": "一句帮助记忆的联想, 中文"
  },
  "other_senses": [{"sense": "常见义项", "zh": "中文"}],
  "related": {
    "words": [{"word": "关联词", "why": "为什么关联(同根/近义/搭配), 中文"}],
    "sentences": ["一个地道例句(英文)", "另一个例句"]
  },
  "caution": "如果有易混点或常见误用就写一句, 没有则空字符串"
}

硬性要求:
1. sense_here 必须紧扣给定句子, 不要给通用词典释义。这是最重要的字段。
2. roots.available 只有在真的有词根词缀可拆、且拆解**真实可靠**时才为 true。
   短语动词(give up / figure out)、口语词、日耳曼语源短词通常拆不出来, 此时必须为 false,
   parts 留空数组。**严禁编造词根**, 编错比不拆更糟。
3. other_senses 最多 3 条, 只列真正常见且与该词在播客里出现相关的义项;没有就给空数组。
4. related.words 最多 4 个, related.sentences 最多 2 句, 都要贴合科技/财经语境。
5. 全部中文解释用简体中文。"""


def _extract_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    return None


async def define(word: str, sentence: str, *, use_cache: bool = True) -> dict[str, Any]:
    """返回 {payload, cached, model}。payload 结构见 SYSTEM。"""
    if use_cache:
        hit = get_explanation(word, sentence)
        if hit:
            return {"payload": hit["payload"], "cached": True, "model": hit["model"]}

    if not DEEPSEEK_API_KEY:
        raise RuntimeError("未配置 ET_DEEPSEEK_API_KEY, 无法查询词义")

    user = f"单词/短语: {word}\n它所在的句子: {sentence}\n\n请按 JSON 结构输出。"

    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{DEEPSEEK_BASE.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": DEEPSEEK_MODEL,
                    "messages": [
                        {"role": "system", "content": SYSTEM},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.3,
                    "response_format": {"type": "json_object"},
                },
                timeout=120,
            )
    except httpx.HTTPError as exc:
        # 连不上/超时也要变成人话, 而不是 500 Internal Server Error
        raise RuntimeError(f"连不上释义服务: {type(exc).__name__}") from exc
    if r.status_code >= 400:
        raise RuntimeError(f"DeepSeek 返回 {r.status_code}: {r.text[:300]}")

    try:
        content = r.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        # 上游返回了非 JSON, 或者结构变了(常见于网关错误页)
        raise RuntimeError("释义服务返回了无法解析的内容") from exc
    payload = _extract_json(content or "")
    if not payload:
        raise RuntimeError("模型返回的不是合法 JSON")

    payload.setdefault("lemma", word)
    save_explanation(word, sentence, payload, DEEPSEEK_MODEL)
    return {"payload": payload, "cached": False, "model": DEEPSEEK_MODEL}

