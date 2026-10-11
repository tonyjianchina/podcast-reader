"""准备一轮测试用的夹具(fixture.json)。

- 复制一份干净的数据库到 .qa/test.db(测试绝不碰 data/app.db)
- 顺便造两条"边角状态"的单集: 音频文件丢失 / 处理失败
- 导出前端断言需要的 segments 时间轴
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QA = ROOT / ".qa"
SRC = ROOT / "data" / "app.db"
DST = QA / "test.db"

shutil.copy(SRC, DST)
for suffix in ("-wal", "-shm"):
    p = Path(str(DST) + suffix)
    if p.exists():
        p.unlink()

conn = sqlite3.connect(DST)
conn.row_factory = sqlite3.Row

# 1) 一条音频丢失的单集(用真实内容改路径, 保证正文可读)
ready = conn.execute(
    "SELECT * FROM episodes WHERE state='ready' ORDER BY created_at LIMIT 1"
).fetchone()
bad_id = "badaudio0001"
conn.execute(
    "INSERT OR REPLACE INTO episodes (id, show_id, guid, title, published_at, source_url,"
    " audio_path, audio_url, duration_sec, state, error, created_at, updated_at)"
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (
        bad_id,
        ready["show_id"],
        "qa-bad-audio",
        "【测试】音频文件已丢失的单集",
        ready["published_at"],
        ready["source_url"],
        str(ROOT / "data" / "audio" / "does-not-exist.mp3"),
        "https://example.invalid/nope.mp3",
        600.0,
        "ready",
        None,
        "2020-01-01T00:00:00",
        "2020-01-01T00:00:00",
    ),
)

# 2) 一条失败的单集
failed_id = "failedep001"
conn.execute(
    "INSERT OR REPLACE INTO episodes (id, show_id, guid, title, published_at, source_url,"
    " audio_path, audio_url, duration_sec, state, error, created_at, updated_at)"
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (
        failed_id,
        ready["show_id"],
        "qa-failed",
        "【测试】处理失败的单集",
        ready["published_at"],
        "https://example.invalid/feed",
        None,
        "https://example.invalid/nope.mp3",
        None,
        "failed",
        "测试用错误: 这个 feed 的最新一集没有音频地址",
        "2020-01-01T00:00:00",
        "2020-01-01T00:00:00",
    ),
)
# 坏的音频单集也要有正文: 否则点播放这条路径根本走不到(正文是空的)
conn.execute("DELETE FROM segments WHERE episode_id = ?", (bad_id,))
conn.execute("DELETE FROM paragraphs WHERE episode_id = ?", (bad_id,))
conn.executemany(
    "INSERT INTO segments (episode_id, idx, start_sec, end_sec, text) VALUES (?,?,?,?,?)",
    [
        (bad_id, i, 0.0 + i * 6, 5.0 + i * 6, f"Broken audio test sentence {i}.")
        for i in range(6)
    ],
)
conn.execute(
    "INSERT INTO paragraphs (episode_id, idx, start_seg_idx, end_seg_idx) VALUES (?,?,?,?)",
    (bad_id, 0, 0, 5),
)
conn.commit()

eps = [dict(r) for r in conn.execute("SELECT * FROM episodes ORDER BY created_at DESC")]

ready_eps = [e for e in eps if e["state"] == "ready" and e["id"] not in (bad_id,)]
main = ready_eps[0]
second = ready_eps[1] if len(ready_eps) > 1 else ready_eps[0]

segs = {}
for e in ready_eps[:2]:
    rows = conn.execute(
        "SELECT idx, start_sec, end_sec, text FROM segments WHERE episode_id=? ORDER BY idx",
        (e["id"],),
    ).fetchall()
    segs[e["id"]] = [dict(r) for r in rows]

show_titles = {
    r["id"]: r["title"] for r in conn.execute("SELECT id, title FROM shows")
}

# 3) 一条"短音频"单集: 专供跟时间有关的用例(逐句停、连播、进度条跳转、位置记忆)。
#    用真实音频跑这些要几十秒, 一次 evaluate 有 15s 上限, 跑不动。
#    这里生成 60 秒静音 mp3 + 8 句可控时间轴, 让同样的生产代码在几秒内走完。
import subprocess

SHORT_ID = "shortsynth01"
SHORT_SECS = 60
AUDIO_FILE = QA / "fixtures" / "short.mp3"
AUDIO_FILE.parent.mkdir(parents=True, exist_ok=True)
if not AUDIO_FILE.exists():
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=24000:cl=mono",
         "-t", str(SHORT_SECS), "-q:a", "9", "-acodec", "libmp3lame", str(AUDIO_FILE)],
        check=True, capture_output=True,
    )

conn.execute("DELETE FROM segments WHERE episode_id = ?", (SHORT_ID,))
conn.execute("DELETE FROM paragraphs WHERE episode_id = ?", (SHORT_ID,))
conn.execute("DELETE FROM translations WHERE episode_id = ?", (SHORT_ID,))
starts = [0.0, 6.0, 12.0, 18.0, 24.0, 30.0, 36.0, 42.0]
short_rows = []
for i, st in enumerate(starts):
    en = st + 5.0 if i < len(starts) - 1 else 46.0
    short_rows.append((SHORT_ID, i, st, en, f"Test sentence number {i}."))
conn.executemany(
    "INSERT INTO segments (episode_id, idx, start_sec, end_sec, text) VALUES (?,?,?,?,?)",
    short_rows,
)
conn.execute(
    "INSERT INTO paragraphs (episode_id, idx, start_seg_idx, end_seg_idx) VALUES (?,?,?,?)",
    (SHORT_ID, 0, 0, 7),
)
conn.execute(
    "INSERT INTO episodes (id, show_id, guid, title, published_at, source_url,"
    " audio_path, audio_url, duration_sec, state, error, created_at, updated_at)"
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (
        SHORT_ID,
        ready["show_id"],
        "qa-short",
        "【测试】60 秒短音频(时间轴可控)",
        ready["published_at"],
        "https://example.invalid/short",
        str(AUDIO_FILE),
        "https://example.invalid/short.mp3",
        float(SHORT_SECS),
        "ready",
        None,
        "2021-01-01T00:00:00",
        "2021-01-01T00:00:00",
    ),
)
conn.commit()

fixture = {
    "mainId": main["id"],
    "hiddenId": bad_id,
    "episodes": [
        {
            "id": e["id"],
            "title": e["title"],
            "state": e["state"],
            "show_title": show_titles.get(e["show_id"], ""),
            "seg_count": conn.execute(
                "SELECT COUNT(*) FROM segments WHERE episode_id=?", (e["id"],)
            ).fetchone()[0],
        }
        for e in eps
        if e["id"] != bad_id
    ],
    "failed": {"id": failed_id, "title": "【测试】处理失败的单集"},
    "brokenAudio": {"id": bad_id, "title": "【测试】音频文件已丢失的单集"},
    "titles": {**{e["id"]: e["title"] for e in eps}, SHORT_ID: "【测试】60 秒短音频(时间轴可控)"},
    "segmentsOf": {**segs, SHORT_ID: [
        {"idx": i, "start_sec": st, "end_sec": (st + 5.0 if i < len(starts) - 1 else 46.0),
         "text": f"Test sentence number {i}."}
        for i, st in enumerate(starts)
    ]},
    "shortId": SHORT_ID,
    "shortSegs": [
        {"idx": i, "start_sec": st, "end_sec": (st + 5.0 if i < len(starts) - 1 else 46.0),
         "text": f"Test sentence number {i}."}
        for i, st in enumerate(starts)
    ],
}

(QA / "fixture.json").write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
print(
    json.dumps(
        {
            "db": str(DST),
            "main": main["id"],
            "second": second["id"],
            "failed": failed_id,
            "brokenAudio": bad_id,
            "shortId": SHORT_ID,
            "brokenSegs": 6,
            "segments": {k: len(v) for k, v in segs.items()},
        },
        ensure_ascii=False,
    )
)
