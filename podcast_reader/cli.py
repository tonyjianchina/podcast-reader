"""命令行入口。

  uv run et serve                  启动后端 + 阅读界面
  uv run et import <链接>           导入一集(不启动服务, 直接跑流水线)
  uv run et list                   列出已导入内容
  uv run et define <词> "<句子>"     单独试一下释义卡
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from . import db, pipeline


async def _import(url: str) -> None:
    db.init()
    r = await pipeline.import_url(url)
    print(f"已入队: {r['title']}  ({r['episode_id']})")

    # 抢占: 如果服务端 worker 也在跑, 让它来做, 我们不要重跑一遍
    if not db.claim_for_state(r["episode_id"], "downloading"):
        print("已有另一个进程在处理这一集, 跳过。用 `et list` 看状态。")
        return

    print("现在跑流水线(下载 -> 转录 -> 分段)…")
    await pipeline._run_one(r["episode_id"])
    fresh = db.get_episode(r["episode_id"])
    if fresh:
        n = len(db.get_segments(fresh["id"]))
        p = len(db.get_paragraphs(fresh["id"]))
        print(f"状态: {fresh['state']}  句子: {n}  段落: {p}")
        if fresh.get("error"):
            print("错误:", fresh["error"])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="et")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("serve", help="启动后端与阅读界面")
    p_imp = sub.add_parser("import", help="导入一集并立刻处理")
    p_imp.add_argument("url")
    sub.add_parser("list", help="列出内容")
    p_re = sub.add_parser("retranscribe", help="用分块方案重转录一集(校准时间轴)")
    p_re.add_argument("episode_id")
    p_def = sub.add_parser("define", help="试一下释义卡")
    p_def.add_argument("word")
    p_def.add_argument("sentence")

    args = ap.parse_args(argv)

    if args.cmd == "serve":
        import uvicorn

        from .config import HOST, PORT

        uvicorn.run("podcast_reader.app:app", host=HOST, port=PORT, log_level="info")
        return 0

    if args.cmd == "import":
        asyncio.run(_import(args.url))
        return 0

    if args.cmd == "retranscribe":
        db.init()
        asyncio.run(pipeline.retranscribe(args.episode_id))
        print("完成。用 et list 看状态。")
        return 0

    if args.cmd == "list":
        db.init()
        for e in db.list_episodes():
            print(f"{e['state']:12} {e['id']}  {e['title'][:60]}")
        return 0

    if args.cmd == "define":
        from . import define

        db.init()
        out = asyncio.run(define.define(args.word, args.sentence))
        import json

        print(json.dumps(out["payload"], ensure_ascii=False, indent=2))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
