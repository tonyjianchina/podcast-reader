"""FastAPI 后端。自用, 单一 token, 不做账号体系。

阶段 1 的临时阅读界面由 / 提供(web/index.html),
目的是尽快验证「转录质量够不够读」。
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from . import db, define, pipeline
from .config import TOKEN, WEB_DIR

# 自动化测试开关: 见 lifespan。
NO_WORKER = os.environ.get("ET_NO_WORKER") == "1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    # ET_NO_WORKER=1 只给自动化测试用: 让服务只提供接口, 不起流水线 worker,
    # 免得测试进程顺手去下载/转录真实内容。
    task = None if NO_WORKER else asyncio.create_task(pipeline.worker())
    if task:
        pipeline.attach_worker(task)
    try:
        yield
    finally:
        if task:
            task.cancel()


app = FastAPI(title="EnglishTool", lifespan=lifespan)


# 这些路径不校验 token:
# - /health 是探活;
# - / 是页面外壳本身。如果连外壳都 401, 浏览器里只会看到一坨 JSON, 用户连
#   "把 token 填进去"的机会都没有(实测: 设了 ET_TOKEN 之后整个 App 打不开)。
#   外壳里通过 __ET_TOKEN__ 把 token 注入给前端, 之后的接口请求才带得上。
PUBLIC_PATHS = ("/health", "/", "/manifest.webmanifest", "/icon.svg")


def _supplied_token(request: Request) -> str:
    raw = request.headers.get("authorization", "")
    scheme, _, value = raw.partition(" ")
    # RFC 7235: 认证方案大小写不敏感, 所以 bearer / Bearer / BEARER 都认
    if scheme.lower() == "bearer":
        return value.strip()
    return (value.strip() or raw.strip()) if raw else ""


@app.middleware("http")
async def auth(request: Request, call_next):
    if TOKEN and request.url.path not in PUBLIC_PATHS:
        supplied = _supplied_token(request) or request.query_params.get("token", "")
        if supplied != TOKEN:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# ------------------------------------------------------------------ 页面


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    if TOKEN:
        # 只注入到页面里, 不进日志、不进 URL。前端 api() 会带在 Authorization 头上。
        html = html.replace("__ET_TOKEN__", TOKEN)
    return HTMLResponse(html)


@app.get("/health")
async def health() -> dict[str, Any]:
    # ok 表示"接口本身可用"; worker 是否活着看 running(ET_NO_WORKER=1 的测试实例
    # 里 worker 故意不跑, 但这不是不健康)。
    return {"ok": True, "worker_healthy": pipeline.healthy(), **pipeline.status()}


# --------------------------------------------------- PWA(加到 iPhone 主屏)
# 有了这两条, Safari 里「添加到主屏幕」之后是全屏无地址栏的, 像原生 App。

@app.get("/manifest.webmanifest")
async def manifest() -> Response:
    return FileResponse(
        WEB_DIR / "manifest.webmanifest", media_type="application/manifest+json"
    )


@app.get("/icon.svg")
async def icon() -> Response:
    return FileResponse(WEB_DIR / "icon.svg", media_type="image/svg+xml")


# ------------------------------------------------------------------ 导入


def _text(payload: dict[str, Any], key: str) -> str:
    """取一个必须是字符串的字段。

    以前直接 .strip(), 于是 {"url": 123} 会抛 AttributeError 变成 500 ——
    客户端传错类型是客户端的问题, 应该是 4xx, 不该被当成服务端故障。
    """
    v = payload.get(key)
    if v is None:
        return ""
    if not isinstance(v, str):
        raise HTTPException(400, f"{key} 必须是字符串")
    return v.strip()


@app.post("/import")
async def import_endpoint(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    url = _text(payload, "url")
    if not url:
        raise HTTPException(400, "缺少 url")
    try:
        return await pipeline.import_url(url)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except (httpx.HTTPError, OSError) as exc:
        # 网络层面的失败是"够不着", 不是服务端 bug
        raise HTTPException(422, f"导入失败(网络不通): {exc}") from exc
    except Exception as exc:
        raise HTTPException(500, f"导入失败: {exc}") from exc


# ------------------------------------------------------------------ 单集


@app.get("/episodes")
async def episodes() -> list[dict[str, Any]]:
    return [{k: v for k, v in e.items() if k != "audio_path"} for e in db.list_episodes()]


@app.get("/episodes/{episode_id}")
async def episode(episode_id: str) -> dict[str, Any]:
    ep = db.get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "单集不存在")
    segs = db.get_segments(episode_id)
    paras = db.get_paragraphs(episode_id)
    return {
        "episode": {k: v for k, v in ep.items() if k != "audio_path"},
        "segments": segs,
        "paragraphs": paras,
        "translations": db.get_translations(episode_id),
        "has_audio": bool(ep.get("audio_path")),
        "vocab_lemmas": sorted(db.vocab_lemmas()),
    }


@app.post("/episodes/{episode_id}/translate")
async def start_translate(episode_id: str) -> dict[str, Any]:
    """补生成中译。已经有(足够)的直接返回, 不重复花钱。"""
    if not db.get_episode(episode_id):
        raise HTTPException(404, "单集不存在")
    if not pipeline.enqueue_translation(episode_id):
        if db.has_translations(episode_id):
            got, total = db.translation_stats(episode_id)
            return {"status": "already_done", "translated": got, "total": total}
        raise HTTPException(409, "还没有文本, 无法翻译")
    return {"status": "queued"}


@app.post("/episodes/{episode_id}/retry")
async def retry(episode_id: str) -> dict[str, Any]:
    if not db.get_episode(episode_id):
        raise HTTPException(404, "单集不存在")
    if not pipeline.status()["running"]:
        raise HTTPException(503, "后台 worker 没有在运行, 重试不会被执行")
    pipeline.enqueue_existing(episode_id)
    return {"ok": True}


# ------------------------------------------------------------------ 音频


@app.get("/episodes/{episode_id}/audio")
async def audio(episode_id: str, request: Request) -> Response:
    ep = db.get_episode(episode_id)
    if not ep or not ep.get("audio_path"):
        raise HTTPException(404, "音频不存在")
    path = Path(ep["audio_path"])
    if not path.exists():
        raise HTTPException(404, "音频文件已丢失")
    return FileResponse(path, media_type="audio/mpeg", filename=path.name)


@app.get("/episodes/{episode_id}/audio.info")
async def audio_info(episode_id: str) -> dict[str, Any]:
    """给前端拿音频大小, 决定是否缓存。"""
    ep = db.get_episode(episode_id)
    if not ep or not ep.get("audio_path"):
        raise HTTPException(404, "音频不存在")
    path = Path(ep["audio_path"])
    if not path.exists():
        raise HTTPException(404, "音频文件已丢失")
    return {"size": path.stat().st_size, "duration": ep.get("duration_sec")}


# ------------------------------------------------------------------ 释义


@app.post("/define")
async def define_endpoint(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    word = _text(payload, "word")
    sentence = _text(payload, "sentence")
    if not word or not sentence:
        raise HTTPException(400, "需要 word 与 sentence")
    try:
        return await define.define(word, sentence, use_cache=bool(payload.get("use_cache", True)))
    except RuntimeError as exc:
        # 503 = 上游/配置问题, 不是本服务的 bug。前端据此显示人话。
        raise HTTPException(503, str(exc)) from exc
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        raise HTTPException(503, f"查询词义失败(上游异常): {type(exc).__name__}") from exc


# ------------------------------------------------------------------ 生词


@app.get("/vocab")
async def vocab() -> list[dict[str, Any]]:
    return db.list_vocab()


@app.get("/vocab/grouped")
async def vocab_grouped() -> dict[str, Any]:
    """生词本页面用: 按单集分组 + 组内按词去重 + 带释义缓存 key。

    刻意不返回释义正文 —— 生词会越攒越多, 一次把所有释义塞进响应是白流量;
    点开某个词时再走 /vocab/{lemma}/explain 精确命中缓存。
    """
    return db.vocab_grouped()


@app.get("/vocab/{lemma}/explain")
async def vocab_explain(lemma: str, episode_id: str = "", seg_idx: int | None = None) -> dict[str, Any]:
    """生词本里点开一个词: 先按「标记时那句话」命中缓存, 缓存没有才花钱查。

    句子优先用调用方给的 seg_idx 现取 —— 它是最权威的原文; 取不到就退回
    vocab_items.sentence(标记那一刻存下来的那份)。
    """
    word = (lemma or "").strip()
    if not word:
        raise HTTPException(400, "缺少 lemma")

    # 句子优先用 seg_idx 现取(segments 才是权威原文), 取不到再退回标记那一刻存的那份。
    sentence = ""
    if episode_id and seg_idx is not None:
        sentence = next(
            (str(s["text"] or "") for s in db.get_segments(episode_id)
             if int(s["idx"]) == int(seg_idx)),
            "",
        )
    if not sentence:
        sentence = db.vocab_sentence(word, episode_id, seg_idx)
    if not sentence:
        raise HTTPException(404, "这个词没有留下原句, 无法按语境释义")

    try:
        return await define.define(word, sentence)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        raise HTTPException(503, f"查询词义失败(上游异常): {type(exc).__name__}") from exc


@app.post("/vocab")
async def add_vocab(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    lemma = _text(payload, "lemma")
    if not lemma:
        raise HTTPException(400, "缺少 lemma")
    seg_idx = payload.get("seg_idx")
    if seg_idx is not None:
        try:
            seg_idx = int(seg_idx)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "seg_idx 必须是整数") from exc
    episode_id = payload.get("episode_id")
    if episode_id is not None and not isinstance(episode_id, str):
        raise HTTPException(400, "episode_id 必须是字符串")
    item_id = db.add_vocab(
        lemma=lemma,
        surface=_text(payload, "surface") or lemma,
        sentence=_text(payload, "sentence"),
        episode_id=episode_id,
        seg_idx=seg_idx,
        note=_text(payload, "note"),
    )
    return {"id": item_id}


@app.delete("/vocab/{item_id}")
async def delete_vocab(item_id: int) -> dict[str, Any]:
    db.remove_vocab(item_id)
    return {"ok": True}


# ------------------------------------------------------------------ 同步


@app.post("/sync")
async def sync() -> dict[str, Any]:
    """App 启动时拉一次:全量文本 + 全量词义(一年播客文本也就 10~20MB)。"""
    out: list[dict[str, Any]] = []
    for ep in db.list_episodes():
        if ep["state"] != "ready":
            continue
        out.append(
            {
                "episode": {k: v for k, v in ep.items() if k != "audio_path"},
                "segments": db.get_segments(ep["id"]),
                "paragraphs": db.get_paragraphs(ep["id"]),
                "translations": db.get_translations(ep["id"]),
            }
        )
    return {
        "episodes": out,
        "vocab": db.list_vocab(),
        "explanations": db.all_explanations(),
    }
