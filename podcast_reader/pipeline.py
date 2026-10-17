"""流水线编排:resolve -> fetch -> transcribe -> segment -> notify。

每个阶段的完成都落库(episodes.state), 所以进程被杀掉之后重启能接着把没做完的做完——
6 分钟/集的转录不能一崩全废(见 DESIGN.md D22)。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from . import db, fetch, notify, resolve, segment, transcribe, translate

# 全局单并发:转录吃满 GPU, 并行只会互相拖慢
_queue: asyncio.Queue[str] = asyncio.Queue()
_running = False
_current: str | None = None
# worker 任务活着 = 真的在跑。以前只有一个启动时置 True 的 _running 布尔量,
# worker 崩掉之后 /health 还在报 running:true, 前端那句「worker 未运行」永远不会出现 ——
# 表现就是"导入一直排队, 界面什么也不说"。
_worker_task: asyncio.Task[None] | None = None


def status() -> dict[str, Any]:
    alive = _worker_task is not None and not _worker_task.done()
    return {"current": _current, "queued": _queue.qsize(), "running": bool(_running and alive)}


def healthy() -> bool:
    """worker 是否真的活着。挂了就是挂了, 不装健康。

    注意: Task.exception() 在任务**还没结束**时会抛 InvalidStateError, 不是返回 None。
    必须先判 done()。之前漏了这一步, 结果 worker 正常运行时 /health 反而 500。
    """
    t = _worker_task
    if t is None or not status()["running"]:
        return False
    if not t.done():
        return True
    if t.cancelled():
        return False
    return t.exception() is None


def attach_worker(task: "asyncio.Task[None]") -> None:
    global _worker_task, _running
    _worker_task = task
    _running = True

    def _done(t: "asyncio.Task[None]") -> None:
        global _running
        _running = False
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            # worker 死了必须留下证据, 不能静默
            print(f"[worker] 已退出(异常): {type(exc).__name__}: {exc}", flush=True)
        else:
            print("[worker] 已退出(正常返回)", flush=True)

    task.add_done_callback(_done)


async def import_url(url: str) -> dict[str, Any]:
    """解析链接并入库, 返回 {episode_id, title, state}。"""
    target = await resolve.resolve(url)

    if target.kind == "feed":
        # Apple 单集链接已在 resolve 里精确选好那一集; 其余情况取最新一集
        entry = target.entry or resolve.latest_entry(target.url)
        show_id = db.upsert_show(target.url, target.title, target.author, target.image_url)
        audio_url = entry.get("audio_url")
        if not audio_url:
            raise ValueError("这一集在 feed 里没有音频地址")
    else:
        if target.show_key:
            # 视频站: 同一频道归到同一个节目下
            show_id = db.upsert_show(
                target.show_key, target.show_title or "直接导入", target.author, target.image_url
            )
        else:
            show_id = db.upsert_show(
                f"direct:{target.url}", target.title or "直接导入", target.author, target.image_url
            )
        audio_url = target.audio_url or target.url
        entry = {
            "guid": target.guid or audio_url,
            "title": target.title or "未命名单集",
            "published_at": target.published_at,
            "image_url": target.episode_image,
            "duration_sec": target.duration_sec,
        }

    episode_id = db.create_episode(
        show_id=show_id,
        guid=str(entry["guid"]),
        title=entry["title"],
        published_at=entry.get("published_at"),
        source_url=url,
        audio_url=audio_url,
        image_url=entry.get("image_url"),
        duration_sec=entry.get("duration_sec"),
    )
    await _queue.put(episode_id)
    return {"episode_id": episode_id, "title": entry["title"], "state": "queued"}


async def _run_one(episode_id: str) -> None:
    """处理一集。**调用前必须已经抢占**(见 worker 与 cli)。

    抢占的作用是防止两个进程(服务端 worker 与 `et import`)同时处理同一集——
    实测发生过, 代价是多跑一遍 8 分钟的转录。
    """
    global _current
    ep = db.get_episode(episode_id)
    if not ep:
        return
    _current = episode_id
    try:
        # 1) 下载音频(已有则跳过, 便于续跑)
        audio_path = ep.get("audio_path")
        duration = ep.get("duration_sec")
        if not audio_path or not await asyncio.to_thread(Path(audio_path).exists):
            db.set_state(episode_id, "downloading")
            path, duration = await fetch.download(
                ep["audio_url"], ep.get("show_title") or "show", ep["title"], episode_id
            )
            audio_path = str(path)
            db.set_audio(episode_id, audio_path, duration)

        # 2) 转录
        segs = db.get_segments(episode_id)
        if not segs:
            db.set_state(episode_id, "transcribing")
            segs = await asyncio.to_thread(transcribe.transcribe, Path(audio_path))
            if not segs:
                raise RuntimeError("转录结果为空")
            # 去掉"长时间跨度 + 极少文字"的空壳句(Whisper 会把一段广告压成一条),
            # 否则高亮会在那几十秒里死死停在同一条上, 看起来就是文本和声音对不上。
            segs = transcribe._drop_stub_segments(segs)
            db.replace_segments(episode_id, segs)
            segs = db.get_segments(episode_id)

        # 3) 分段
        paras = db.get_paragraphs(episode_id)
        if not paras:
            db.set_state(episode_id, "segmenting")
            ranges = await segment.paragraph_ranges([s["text"] for s in segs])
            db.replace_paragraphs(episode_id, ranges)

        # 4) 逐句中译(失败不影响可读, 只是没有中文垫底)
        if not db.has_translations(episode_id):
            db.set_state(episode_id, "translating")
            try:
                pairs = await translate.translate_all([s["text"] for s in segs])
                db.add_translations(episode_id, pairs, translate.DEEPSEEK_MODEL)
            except Exception as exc:
                print(f"[pipeline] 翻译失败(不影响阅读): {exc}", flush=True)
            got, total = db.translation_stats(episode_id)
            if total and got < total:
                print(f"[pipeline] 中译不完整: {got}/{total} 句(下次打开会继续补)", flush=True)

        db.set_state(episode_id, "ready")

        # 5) 通知
        minutes = int((duration or 0) // 60)
        await notify.notify(
            "可以读了",
            f"《{ep['title']}》转录完成{f'({minutes} 分钟)' if minutes else ''}",
        )
    except Exception as exc:
        print(f"[pipeline] {episode_id} 失败: {exc}", flush=True)
        db.set_state(episode_id, "failed", str(exc)[:500])
    finally:
        _current = None


async def retranscribe(episode_id: str) -> None:
    """用当前的分块方案重新转录一集, 替换掉旧的 segments。

    用途: 老转录可能带 Whisper 的时间戳漂移(实测 3 分钟附近偏 4 秒), 表现为
    "文本高亮和听到的声音对不上"。重转录会重建 segments 和 paragraphs;
    用户标注的释义缓存按「词+句子」存的, 不受影响。
    """
    ep = db.get_episode(episode_id)
    if not ep or not ep.get("audio_path"):
        raise RuntimeError("这一集还没有音频, 无法重转录")
    audio_path = Path(ep["audio_path"])
    if not await asyncio.to_thread(audio_path.exists):
        raise RuntimeError("音频文件已不在磁盘上")

    db.set_state(episode_id, "transcribing")
    segs = await asyncio.to_thread(transcribe.transcribe, audio_path)
    if not segs:
        db.set_state(episode_id, "failed", "重转录结果为空")
        raise RuntimeError("重转录结果为空")
    db.replace_segments(episode_id, segs)

    # 句子变了, 段落和逐句中译必须重做(它们都是按句号索引的)
    db.set_state(episode_id, "segmenting")
    ranges = await segment.paragraph_ranges([s["text"] for s in segs])
    db.replace_paragraphs(episode_id, ranges)

    import sqlite3

    with db.db() as conn:
        conn.execute("DELETE FROM translations WHERE episode_id = ?", (episode_id,))
    db.set_state(episode_id, "translating")
    try:
        pairs = await translate.translate_all([s["text"] for s in segs])
        db.add_translations(episode_id, pairs, translate.DEEPSEEK_MODEL)
    except Exception as exc:
        print(f"[retranscribe] 翻译失败(不影响阅读): {exc}", flush=True)

    db.set_state(episode_id, "ready")
    await notify.notify("已重新转录", f"《{ep['title']}》的时间轴已校准")


async def worker() -> None:
    """常驻 worker。

    启动时把上次被杀掉时没做完的任务重新入队(续跑, 见 D22)。
    注意: 这里必须一次性把中断的任务取干净再重置状态,
    否则 next_pending() 会反复返回同一集, 变成启动时空转的死循环。
    """
    global _running
    _running = True

    with db.db() as conn:
        rows = conn.execute(
            "SELECT id FROM episodes WHERE state NOT IN ('ready','failed')"
        ).fetchall()
        ids = [r["id"] for r in rows]
    # 续跑: 只把中断的单集回退成 pending 再入队, **不在这里抢占**。
    # 抢占统一由下面的主循环做(claim_for_state 只认 pending)。
    # 以前这里先抢一次(pending -> downloading)再入队, 主循环再抢第二次时状态已经
    # 不是 pending, 抢占失败, 这集被静默跳过, 永远卡在 downloading。
    # 同一 id 被重复入队也不会重复处理: 第二次抢占时状态已不是 pending。
    # 各步骤自己检查已有产物(音频/句子/段落/译文), 所以从断点继续, 不会重做。
    resumed = 0
    for episode_id in ids:
        db.set_state(episode_id, "pending")
        await _queue.put(episode_id)
        resumed += 1
    if ids:
        print(f"[worker] 续跑中断的任务: {resumed}/{len(ids)} 个", flush=True)

    while True:
        episode_id = await _queue.get()
        try:
            # 队列里的 id 只是「候选」; 真正开工前再原子抢一次,
            # 免得 `et import` 已经把它做完了我们还重跑一遍。
            if db.claim_for_state(episode_id, "downloading"):
                await _run_one(episode_id)
        except Exception as exc:
            print(f"[worker] 未捕获异常: {exc}", flush=True)
        finally:
            _queue.task_done()


def enqueue_existing(episode_id: str) -> None:
    """把一个已存在的单集重新丢进队列(重试用)。必须在事件循环内调用。"""
    db.set_state(episode_id, "pending")
    _queue.put_nowait(episode_id)


def enqueue_translation(episode_id: str) -> bool:
    """给一集已经 ready 的内容补生成中译(用户打开翻译开关时触发)。

    返回 False 表示已经有翻译或没有文本, 不用重复做。
    """
    ep = db.get_episode(episode_id)
    if not ep or not db.get_segments(episode_id):
        return False
    if db.has_translations(episode_id):
        return False
    db.set_state(episode_id, "pending")
    _queue.put_nowait(episode_id)
    return True
