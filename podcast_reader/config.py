"""全局配置。所有路径与开关集中在这里, 别在别处硬编码。

密钥优先从项目根的 .env 读(格式 `ET_DEEPSEEK_API_KEY=xxx`), 其次读环境变量。
.env 不要提交到任何仓库。
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:  # 环境变量优先
            os.environ[key] = value


_load_dotenv()

DATA = ROOT / "data"
AUDIO_DIR = DATA / "audio"
# ET_DB_PATH 让自动化测试可以完全跑在副本上, 不动 data/app.db 里的真实内容。
# 相对路径按项目根解析。
_db_override = os.environ.get("ET_DB_PATH", "").strip()
DB_PATH = (ROOT / _db_override).resolve() if _db_override else DATA / "app.db"
WEB_DIR = ROOT / "web"
HOTWORDS_FILE = ROOT / "hotwords.txt"

# 服务
HOST = os.environ.get("ET_HOST", "0.0.0.0")
PORT = int(os.environ.get("ET_PORT", "8787"))
# 单一 token; 不设则完全不校验(仅限本机调试)。
# 设了之后: 页面外壳/manifest/图标 仍然公开(否则页面本身就是 401 的 JSON,
# 连"输入 token"的机会都没有), 但外壳里不再注入 token —— 注入等于把 token 发给
# 任何能打开 / 的人(暴露到公网后就是泄露)。首次用 /?token=xxx 打开, 前端记在本地。
TOKEN = os.environ.get("ET_TOKEN", "")

# 转录
WHISPER_MODEL = os.environ.get("ET_WHISPER_MODEL", "mlx-community/whisper-large-v3-mlx")
WHISPER_LANG = os.environ.get("ET_WHISPER_LANG", "en")

# Whisper 每次加载都会向 HuggingFace 校验模型 revision。有代理的环境下这个请求
# 会随机 503 并让整次转录失败, 而模型其实早就在本地缓存里了。所以默认强制离线。
# 需要首次下载模型时, 临时设 ET_HF_ONLINE=1 覆盖。
if os.environ.get("ET_HF_ONLINE") != "1":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

# 释义 (DeepSeek)
DEEPSEEK_API_KEY = os.environ.get("ET_DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE = os.environ.get("ET_DEEPSEEK_BASE", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("ET_DEEPSEEK_MODEL", "deepseek-chat")

# 通知 (Bark)
BARK_URL = os.environ.get("ET_BARK_URL", "")

for _d in (DATA, AUDIO_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def hot_words() -> str:
    """热词表: 喂给 Whisper 的 initial_prompt, 用来纠正专有名词。

    实测例子: 嘉宾名 Krishna 被听成 "Crisola" / "Chris Ola"。
    每发现一个错拼, 就往 hotwords.txt 里加一行, 这是最便宜的准确率提升。
    """
    extra = os.environ.get("ET_HOT_WORDS", "")
    parts: list[str] = []
    if HOTWORDS_FILE.exists():
        for line in HOTWORDS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                parts.append(line)
    if extra:
        parts.append(extra)
    return ", ".join(parts)
