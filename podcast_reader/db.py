"""SQLite 存储层。

设计要点见 DESIGN.md §4:
- segments 存 Whisper 原始转录, 一个字不改, 永久保留。
- paragraphs 只存「句子索引区间」, 段落的文本永远从 segments 拼出来。
  这样从结构上杜绝「AI 改写原文」——因为根本没有第二份文本可以存放它。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from .config import DB_PATH

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS shows (
    id          TEXT PRIMARY KEY,
    feed_url    TEXT UNIQUE NOT NULL,
    title       TEXT,
    author      TEXT,
    image_url   TEXT,
    created_at  TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
    id           TEXT PRIMARY KEY,
    show_id      TEXT REFERENCES shows(id),
    guid         TEXT NOT NULL,
    title        TEXT NOT NULL,
    published_at TEXT,
    source_url   TEXT NOT NULL,
    audio_path   TEXT,
    audio_url    TEXT,
    duration_sec REAL,
    state        TEXT NOT NULL,
    error        TEXT,
    created_at   TEXT,
    updated_at   TEXT,
    UNIQUE(show_id, guid)
);

CREATE TABLE IF NOT EXISTS segments (
    id         INTEGER PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    start_sec  REAL NOT NULL,
    end_sec    REAL NOT NULL,
    text       TEXT NOT NULL,
    UNIQUE(episode_id, idx)
);

CREATE TABLE IF NOT EXISTS paragraphs (
    id            INTEGER PRIMARY KEY,
    episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    idx           INTEGER NOT NULL,
    start_seg_idx INTEGER NOT NULL,
    end_seg_idx   INTEGER NOT NULL,
    UNIQUE(episode_id, idx)
);

-- 逐句中译。和分段一样只存「对第几句的翻译」, 按句生成一次永久缓存:
-- 打开开关是瞬时的, 也不会因为反复切换而重复花钱。
CREATE TABLE IF NOT EXISTS translations (
    id         INTEGER PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    seg_idx    INTEGER NOT NULL,
    text       TEXT NOT NULL,
    model      TEXT,
    created_at TEXT,
    UNIQUE(episode_id, seg_idx)
);

CREATE TABLE IF NOT EXISTS vocab_items (
    id         INTEGER PRIMARY KEY,
    lemma      TEXT NOT NULL,
    surface    TEXT,
    sentence   TEXT,
    episode_id TEXT,
    seg_idx    INTEGER,
    note       TEXT,
    created_at TEXT,
    UNIQUE(lemma, episode_id, seg_idx)
);

CREATE TABLE IF NOT EXISTS explanations (
    key          TEXT PRIMARY KEY,
    lemma        TEXT,
    payload_json TEXT,
    model        TEXT,
    created_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_vocab_lemma ON vocab_items(lemma);
CREATE INDEX IF NOT EXISTS idx_segments_episode ON segments(episode_id, idx);
CREATE INDEX IF NOT EXISTS idx_episodes_state ON episodes(state);
"""


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def init() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)


# ---------------------------------------------------------------- shows


def upsert_show(feed_url: str, title: str | None, author: str | None, image_url: str | None) -> str:
    with db() as conn:
        row = conn.execute("SELECT id FROM shows WHERE feed_url = ?", (feed_url,)).fetchone()
        if row:
            conn.execute(
                "UPDATE shows SET title = COALESCE(?, title), author = COALESCE(?, author),"
                " image_url = COALESCE(?, image_url) WHERE id = ?",
                (title, author, image_url, row["id"]),
            )
            return row["id"]
        sid = new_id()
        conn.execute(
            "INSERT INTO shows (id, feed_url, title, author, image_url, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (sid, feed_url, title, author, image_url, now()),
        )
        return sid


# ------------------------------------------------------------- episodes

# 状态机: pending -> downloading -> transcribing -> segmenting -> translating -> ready
# 任一步失败 -> failed, 可用 retry 回到 pending
STATES = ("pending", "downloading", "transcribing", "segmenting", "translating", "ready", "failed")


def create_episode(
    show_id: str, guid: str, title: str, published_at: str | None, source_url: str, audio_url: str
) -> str:
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM episodes WHERE show_id = ? AND guid = ?", (show_id, guid)
        ).fetchone()
        if row:
            return row["id"]
        eid = new_id()
        ts = now()
        conn.execute(
            "INSERT INTO episodes (id, show_id, guid, title, published_at, source_url,"
            " audio_url, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (eid, show_id, guid, title, published_at, source_url, audio_url, "pending", ts, ts),
        )
        return eid


def set_state(episode_id: str, state: str, error: str | None = None) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE episodes SET state = ?, error = ?, updated_at = ? WHERE id = ?",
            (state, error, now(), episode_id),
        )


def claim_for_state(episode_id: str, state: str) -> bool:
    """原子抢占: 只有当前状态确实是 'pending' 才能改成 state, 返回是否抢到。

    用途: 防止 `et import` 和服务端 worker 两个进程同时处理同一集
    (实测发生过, 白白多跑一遍 8 分钟的转录)。SQLite 的 UPDATE 是原子的,
    受影响行数为 0 就说明别人已经抢走了。
    """
    with db() as conn:
        cur = conn.execute(
            "UPDATE episodes SET state = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
            (state, now(), episode_id),
        )
        return cur.rowcount > 0


def set_audio(episode_id: str, audio_path: str, duration_sec: float | None) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE episodes SET audio_path = ?, duration_sec = ?, updated_at = ? WHERE id = ?",
            (audio_path, duration_sec, now(), episode_id),
        )


def get_episode(episode_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            "SELECT e.*, s.title AS show_title, s.image_url AS show_image, s.feed_url"
            " FROM episodes e LEFT JOIN shows s ON s.id = e.show_id WHERE e.id = ?",
            (episode_id,),
        ).fetchone()
        return dict(row) if row else None


def list_episodes() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT e.*, s.title AS show_title, s.image_url AS show_image,"
            " (SELECT COUNT(*) FROM segments g WHERE g.episode_id = e.id) AS seg_count,"
            " (SELECT COUNT(*) FROM paragraphs p WHERE p.episode_id = e.id) AS para_count"
            " FROM episodes e LEFT JOIN shows s ON s.id = e.show_id"
            " ORDER BY COALESCE(e.published_at, e.created_at) DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def next_pending() -> dict[str, Any] | None:
    """取下一个待处理任务(用于启动时续跑中断的流水线)。"""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM episodes WHERE state NOT IN ('ready','failed')"
            " ORDER BY created_at LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


# ------------------------------------------------------------- segments


def replace_segments(episode_id: str, segs: Iterable[dict[str, Any]]) -> None:
    """字段名统一用 start_sec / end_sec(与表结构、transcribe 模块一致)。

    这里曾用 s["start"]/s["end"]; transcribe 改成 start_sec/end_sec 后没同步,
    重转录跑到落库这一步才炸, 15 分钟的转录白跑。所以这里同时接受两种键名,
    但调用方请统一用 start_sec/end_sec。
    """
    rows = [
        (
            episode_id,
            i,
            float(s["start_sec"] if "start_sec" in s else s["start"]),
            float(s["end_sec"] if "end_sec" in s else s["end"]),
            s["text"],
        )
        for i, s in enumerate(segs)
    ]
    # 先物化再写: 传进来的是生成器时, 中途抛错会留下"删了旧的、没写新的"的空集。
    # 整个替换放进一个事务: 要么全新, 要么原样不动。
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DELETE FROM segments WHERE episode_id = ?", (episode_id,))
            conn.executemany(
                "INSERT INTO segments (episode_id, idx, start_sec, end_sec, text)"
                " VALUES (?,?,?,?,?)",
                rows,
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def get_segments(episode_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT idx, start_sec, end_sec, text FROM segments WHERE episode_id = ? ORDER BY idx",
            (episode_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ----------------------------------------------------------- paragraphs


def replace_paragraphs(episode_id: str, ranges: Iterable[tuple[int, int]]) -> None:
    rows = [(episode_id, i, a, b) for i, (a, b) in enumerate(ranges)]
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DELETE FROM paragraphs WHERE episode_id = ?", (episode_id,))
            conn.executemany(
                "INSERT INTO paragraphs (episode_id, idx, start_seg_idx, end_seg_idx)"
                " VALUES (?,?,?,?)",
                rows,
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def get_paragraphs(episode_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT idx, start_seg_idx, end_seg_idx FROM paragraphs WHERE episode_id = ? ORDER BY idx",
            (episode_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ------------------------------------------------------------ vocab

def add_translations(episode_id: str, items: Iterable[tuple[int, str]], model: str = "") -> None:
    """按句写入中译。已存在的句子不覆盖(避免重复花钱重翻)。"""
    rows = [(episode_id, int(i), t, model, now()) for i, t in items if t and t.strip()]
    if not rows:
        return
    with db() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO translations (episode_id, seg_idx, text, model, created_at)"
            " VALUES (?,?,?,?,?)",
            rows,
        )


def get_translations(episode_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT seg_idx, text FROM translations WHERE episode_id = ? ORDER BY seg_idx",
            (episode_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def translation_stats(episode_id: str) -> tuple[int, int]:
    """(已翻译句数, 总句数)。"""
    with db() as conn:
        got = conn.execute(
            "SELECT COUNT(*) FROM translations WHERE episode_id = ?", (episode_id,)
        ).fetchone()[0]
        total = conn.execute(
            "SELECT COUNT(*) FROM segments WHERE episode_id = ?", (episode_id,)
        ).fetchone()[0]
        return int(got), int(total)


def has_translations(episode_id: str) -> bool:
    """中译是否"够读"了。

    以前只看有没有一行 —— 翻译是按批写的, 一次失败就留下一整集半截中译, 而且再也补不上
    (接口回答"已经翻过", 前端于是把半截中译当完成)。现在要求覆盖 95% 以上才算完成。
    """
    got, total = translation_stats(episode_id)
    if total <= 0:
        return False
    return got >= max(1, int(total * 0.95))


def add_vocab(
    lemma: str, surface: str, sentence: str, episode_id: str | None, seg_idx: int | None, note: str = ""
) -> int:
    """加生词。同 (lemma, 单集, 句) 只留一条, 返回真正属于它的 id。

    坑: SQLite 的 UNIQUE 认为 NULL 互不相等, 所以 episode_id/seg_idx 为 NULL 时
    INSERT OR IGNORE 根本不去重 —— 实测点两次「标记为生词」会存进两行, 返回的 id 还是
    最早那行, 客户端于是永远删不掉自己刚创建的那条。
    改成"先按归一化键查, 没有才插"。
    """
    lemma = (lemma or "").strip().lower()
    if not lemma:
        raise ValueError("lemma 不能为空")
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM vocab_items WHERE lemma = ?"
            " AND COALESCE(episode_id,'') = COALESCE(?,'')"
            " AND COALESCE(CAST(seg_idx AS TEXT),'') = COALESCE(CAST(? AS TEXT),'')"
            " ORDER BY id LIMIT 1",
            (lemma, episode_id, seg_idx),
        ).fetchone()
        if row:
            return int(row["id"])
        cur = conn.execute(
            "INSERT INTO vocab_items (lemma, surface, sentence, episode_id, seg_idx,"
            " note, created_at) VALUES (?,?,?,?,?,?,?)",
            (lemma, surface, sentence, episode_id, seg_idx, note, now()),
        )
        return int(cur.lastrowid or -1)


def remove_vocab(item_id: int) -> None:
    with db() as conn:
        conn.execute("DELETE FROM vocab_items WHERE id = ?", (item_id,))


def list_vocab() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT v.*, e.title AS episode_title FROM vocab_items v"
            " LEFT JOIN episodes e ON e.id = v.episode_id ORDER BY v.created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def vocab_lemmas() -> set[str]:
    with db() as conn:
        rows = conn.execute("SELECT DISTINCT lemma FROM vocab_items").fetchall()
        return {r["lemma"] for r in rows}


def vocab_sentence(lemma: str, episode_id: str | None, seg_idx: int | None) -> str:
    """取「某个生词在某一集某一句」的那句原文。没标过或没记句子就返回空串。

    权威原文始终是 segments, 这里是兜底: 标记那一刻存下的句子。段落一旦重新分段、
    或者上游重转录过, 按 seg_idx 现取可能已经对不上, 那时还有这份历史记录可用。
    """
    if not episode_id or seg_idx is None:
        return ""
    with db() as conn:
        row = conn.execute(
            "SELECT sentence FROM vocab_items WHERE lemma = ? AND episode_id = ?"
            " AND seg_idx = ? LIMIT 1",
            (str(lemma or "").strip().lower(), episode_id, int(seg_idx)),
        ).fetchone()
    return str(row["sentence"] or "") if row else ""


def _explained_keys() -> dict[str, str]:
    """生词 -> 它在释义缓存里的 key(同一个词有多份缓存的取最新那份)。

    释义缓存不存「这个词被划进过哪个句子」, 只有 key = sha256(lemma + 句子), 而句子是
    哈希不回来的。所以这里**不去反推句子**: 列表按词给一个真实存在的缓存 key, 前端点开
    时用这个 key 精确命中缓存, 不会再花一次 API 调用(--> GET /vocab/{lemma}/explain)。
    """
    with db() as conn:
        rows = conn.execute(
            "SELECT key, lemma FROM explanations WHERE lemma IS NOT NULL"
            " AND lemma != '' ORDER BY rowid"
        ).fetchall()
    return {str(r["lemma"]).strip().lower(): r["key"] for r in rows}


def vocab_grouped() -> dict[str, Any]:
    """生词本: 按单集分组, 组内同一个词只出一条并附上它在释义缓存里的 key。

    为什么不在 SQL 里 GROUP BY: 要顺带拿到 e.title / e.published_at / e.source_url,
    再叠一层"按 episode 分组 + 组内按词去重", 一次查完在 Python 里拼更好读。
    """
    with db() as conn:
        rows = conn.execute(
            "SELECT v.id, v.lemma, v.surface, v.sentence, v.episode_id, v.seg_idx,"
            " v.note, v.created_at, e.title AS episode_title, e.published_at,"
            " e.source_url FROM vocab_items v"
            " LEFT JOIN episodes e ON e.id = v.episode_id"
            " ORDER BY v.created_at DESC, v.id DESC"
        ).fetchall()

    keys = _explained_keys()
    groups: list[dict[str, Any]] = []
    where: dict[str, dict[str, Any]] = {}
    for r in rows:
        ep = r["episode_id"] or ""
        if ep not in where:
            group = {
                "episode_id": r["episode_id"],
                "episode_title": r["episode_title"] or "(原单集已删除)",
                "published_at": r["published_at"],
                "source_url": r["source_url"],
                "items": [],
            }
            where[ep] = group
            groups.append(group)
        lemma = str(r["lemma"] or "").strip().lower()
        if not lemma:
            continue
        hit = next((it for it in where[ep]["items"] if it["lemma"] == lemma), None)
        if hit:
            # 同一个词在这一集被标了两次(不同句子): 只留最新那条, 计个数
            hit["count"] += 1
            continue
        where[ep]["items"].append(
            {
                "id": int(r["id"]),
                "lemma": lemma,
                "surface": r["surface"] or lemma,
                "sentence": r["sentence"] or "",
                "seg_idx": r["seg_idx"],
                "note": r["note"] or "",
                "created_at": r["created_at"],
                "count": 1,
                "explanation_key": keys.get(lemma),
            }
        )

    # 分组的先后按「这一集最后一次标词的时间」排: 你最近在弄哪一集, 它就在最上面。
    # 不用 published_at —— 那一列常常是 NULL(小宇宙那些), 拿它排会让分组顺序看起来像随机的。
    groups.sort(
        key=lambda g: (max((it["created_at"] or "") for it in g["items"]), g["episode_id"] or ""),
        reverse=True,
    )
    return {
        "groups": groups,
        "total": sum(len(g["items"]) for g in groups),
        "raw": len(rows),
    }


try:
    from zoneinfo import ZoneInfo

    USER_TZ: Any = ZoneInfo("Asia/Shanghai")
except Exception:  # 没有 tzdata 的环境: 上海不搞夏令时, 固定 +8 等价
    USER_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")


def _parse_ts(ts: Any) -> datetime | None:
    """created_at 转成带时区的时间。

    now() 写的是 time.strftime 的**本机本地时间、不带时区**(不是 UTC), 所以无时区的值
    按本机时区解释; 带 Z / +08:00 之类时区的值(导入的旧数据)按它自己的时区。
    """
    s = str(ts or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.astimezone() if dt.tzinfo is None else dt


def vocab_grouped_by_date() -> dict[str, Any]:
    """生词本: 按「加入的那一天」(用户时区 Asia/Shanghai) 分组, 新的一天在前、组内新的在前。

    同一天里同一个词标了多次(哪怕来自不同单集)只出一条, 留最新那条并计个数;
    每条词带上它所属单集的 episode_id / episode_title, 前端用来显示出处和跳原文。
    """
    with db() as conn:
        rows = conn.execute(
            "SELECT v.id, v.lemma, v.surface, v.sentence, v.episode_id, v.seg_idx,"
            " v.note, v.created_at, e.title AS episode_title FROM vocab_items v"
            " LEFT JOIN episodes e ON e.id = v.episode_id"
        ).fetchall()

    floor = datetime.min.replace(tzinfo=timezone.utc)
    stamped = [(_parse_ts(r["created_at"]), r) for r in rows]
    # 不靠 SQL 的字符串排序: 万一混进带时区的值, 字符串序和真实先后会不一致
    stamped.sort(key=lambda x: (x[0] or floor, int(x[1]["id"])), reverse=True)

    keys = _explained_keys()
    groups: list[dict[str, Any]] = []
    where: dict[str, dict[str, Any]] = {}
    for dt, r in stamped:
        day = dt.astimezone(USER_TZ).strftime("%Y-%m-%d") if dt else ""
        lemma = str(r["lemma"] or "").strip().lower()
        if not lemma:
            continue
        if day not in where:
            where[day] = {"date": day, "items": []}
            groups.append(where[day])
        hit = next((it for it in where[day]["items"] if it["lemma"] == lemma), None)
        if hit:
            hit["count"] += 1
            continue
        where[day]["items"].append(
            {
                "id": int(r["id"]),
                "lemma": lemma,
                "surface": r["surface"] or lemma,
                "sentence": r["sentence"] or "",
                "seg_idx": r["seg_idx"],
                "note": r["note"] or "",
                "created_at": r["created_at"],
                "count": 1,
                "explanation_key": keys.get(lemma),
                "episode_id": r["episode_id"],
                "episode_title": (r["episode_title"] or "(原单集已删除)") if r["episode_id"] else "",
            }
        )
    return {
        "by": "date",
        "groups": groups,
        "total": sum(len(g["items"]) for g in groups),
        "raw": len(rows),
    }


# ------------------------------------------------------ explanations


def explanation_key(lemma: str, sentence: str) -> str:
    raw = f"{lemma.strip().lower()}\x00{sentence.strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get_explanation(lemma: str, sentence: str) -> dict[str, Any] | None:
    key = explanation_key(lemma, sentence)
    with db() as conn:
        row = conn.execute("SELECT * FROM explanations WHERE key = ?", (key,)).fetchone()
        if not row:
            return None
        out = dict(row)
        out["payload"] = json.loads(out.pop("payload_json"))
        return out


def save_explanation(lemma: str, sentence: str, payload: dict[str, Any], model: str) -> None:
    key = explanation_key(lemma, sentence)
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO explanations (key, lemma, payload_json, model, created_at)"
            " VALUES (?,?,?,?,?)",
            (key, lemma.lower(), json.dumps(payload, ensure_ascii=False), model, now()),
        )


def all_explanations() -> dict[str, dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("SELECT key, payload_json FROM explanations").fetchall()
        return {r["key"]: json.loads(r["payload_json"]) for r in rows}
