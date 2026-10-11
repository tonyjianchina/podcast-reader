# 英语学习 App — 设计文档

> 状态:设计已定稿(经 grilling 逐项收敛)
> 定稿日期:本次会话
> 落地机器:MacBook Pro M5 / 32GB / 629GB 可用

---

## 0. 一句话定义

**一个「把播客/视频单集变成一篇可精读、可标注、可查词的文章」的私人阅读器。**
它不是英语学习 App,也不是播客客户端。英语提升是「读自己真正想看的资讯」的副产品。

### 这个定义排除了什么(anti-goals,同样重要)

| 不做 | 原因 |
|---|---|
| 播客客户端(发现、推荐、订阅生态) | 与现有客户端共存,不重造 |
| 全量自动转录整档节目 | 300 集 ≈ 30 小时算力 + 20~30GB,大概率只读 5 集 |
| 间隔重复 SRS / 每日打卡 | 把「听资讯」变成「做作业」,最终导致弃用 |
| Anki 导出 | 同上,本期不做(只导出 Markdown/CSV) |
| 说话人分离(diarization) | 访谈里谁在说从内容可读出来,不值得多扛一个模型 |
| 词级时间戳对齐 | 读为主,句级高亮够用;词级会牵走注意力 |
| 学习 TTS 跟读 / 发音评分 | 离「听资讯」太远,以后再说 |
| 账号体系 / 多用户 | 单人自用,Tailscale 已在网络层隔离 |
| 小红书导入 | 短内容/图文与「长音频精读」是两种形态,塞进来会变成啥都装的口袋 |

---

## 1. 使用者的真实场景(一切设计的依据)

- 主要听**英文**播客,科技圈与财经圈。
- 在做别的事的时候听(所以「听的入口」永远是播客客户端,不是本 App)。
- 遇到值得细看的一集,**把分享链接发进本 App**。
- 打开 App 的动作是**读**(读为主),音频是辅助:点某一句才出声。
- 偶尔会想把某句重听几遍,或看清某个词到底怎么念。
- 网络环境:在家 Wi-Fi,在外 4G/5G,地铁/隧道会断。
- Mac 常开,Tailscale 已装;iPhone 为主要使用设备。

---

## 2. 主流程

```
分享链接(小宇宙 / Apple Podcasts / 任意播客分享页 / YouTube)
   ↓  解析器:短链 → 网页 → RSS feed URL(一次性解析后缓存)
   ↓  只转「你导入的这一集」,不做轮询、不做全量
下载音频(yt-dlp)→ 存 Mac,原件唯一
   ↓
Whisper 转录(large-v3,强制 language=en,喂热词表)
   ↓  产出 segments:句子 + 起止时间戳(原始转录,一个字不改,永久保留)
   ↓
AI 分段(只允许决定「在哪里换行」)
   ↓
入库(SQLite)→ Bark 推送「《xxx》可以读了」
   ↓
App 里读:点句播放 / 标生词 / AI 查词(缓存)/ 生词本与跨集重逢高亮
```

### 关键推论

- **转录是地基,不是辅助。** 因为默认动作是读,没有转录 = App 是空的。所以不走「先能听、转录慢慢跑」那条路,内容是**转录完才可用**。
- 你等待的是「下载 → 转录 → 排版」这一条链,完成后才通知。
- 播放器不是「从头放到尾」,而是**句子级播放器**。因此时间戳必须精确到句。

---

## 3. 决策记录(Decision Log)

| # | 决策 | 结论 | 理由 / 代价 |
|---|---|---|---|
| D1 | 使用范围 | 只给自己用 | 个性化是核心价值;绕开版权/多租户/计费 |
| D2 | 使用面 | iPhone 原生 App | 「随时随地」;Mac 只做后端 |
| D3 | 平台 | iOS + Expo / React Native / TS | 开发期 Expo Go 扫码,绕开免费签名 7 天过期 |
| D4 | 网络 | Tailscale,Mac 常开 | 免费、不出公网、无需内网穿透配置 |
| D5 | 后端地址 | 设置在 App 里**手填**(固定 IP 或 MagicDNS 名) | 不做服务发现;失败时可归因 |
| D6 | 转录引擎 | **本地 MLX Whisper `large-v3`** | 零边际成本、无时长上限、隐私。**实测约 4 倍实时**(M5 32GB,180 秒音频 43 秒转完),即 1 小时播客约 15 分钟;比设计初估的 10 倍实时慢一倍多 |
| D7 | 转录范围 | **只转导入的那一集** | 用户明确选择;不做轮询、不全量 |
| D8 | 通知 | Bark | 一个 HTTP 请求推锁屏,零成本、无需 APNs 证书 |
| D9 | 导入方式 | 接受任意分享链接,后端尽力解析成 RSS | 用户在客户端里只有分享链接;解析失败给手动填 RSS 的退路 |
| D10 | 内容源 | 播客为主 + YouTube 兼收 | 同一管线 |
| D11 | 释义深度 | 语境义 → 音标词性 → 词根拆解 → 其他常见义 → 关联词/关联句 | 「这句话里是什么意思」排第一,因为多义词+语境是词典做不到的 |
| D12 | 词根 | **只在真有词根可拆时才拆**,口语/短语动词如实说不可拆 | 编词根比不拆更糟(记错);提示词硬约束 |
| D13 | 释义模型 | 云端 API,**默认 DeepSeek**,做成可替换 provider | 查词错一次就记错一次;Mac 算力留给 Whisper |
| D14 | 释义缓存 | 键 = `规范化单词 + 所在句子` 哈希;命中秒开、断网可看 | 一天点几十次且大量重复,不缓存则钱和延迟都爆炸 |
| D15 | 播放对齐 | 句级时间戳;数据模型预留一句多锚点 | 读为主;词级留给以后 |
| D16 | 排版 | 衬线正文、字号可调 16~24、行高默认 1.8(可调 1.55~2.1)、深浅色、生词弱高亮、当前句淡底、**自动滚动默认开,主动滑动后停止跟随** | 读 1 小时正文,排版即产品力 |
| D17 | AI 分段的铁律 | **AI 只输出分隔符位置(句子索引),绝不输出文本** | 防改写污染原文;校验失败即退回机械分段 |
| D18 | 复习机制 | 生词本 + **跨集重逢高亮**;不做 SRS、不做打卡 | 重逢服务听力目标且零成本;SRS 会把兴趣变作业 |
| D19 | 音频存储 | Mac 为唯一原件;iPhone 按需缓存整集,上限 N 集自动清最旧 | 通勤断网必须能读能查词 |
| D20 | 文本/词义同步 | **全量同步到 iPhone**(一年播客文本 ≈ 10~20MB) | 读是唯一核心动作,不能等网络;断网也能读+查词 |
| D21 | 鉴权 | 单一 bearer token | 网络层已隔离,别搞账号体系 |
| D22 | 流水线健壮性 | 每个阶段落库状态,失败可重试、可续跑 | 6 分钟/集的转录不能一崩全废 |
| D23 | 转录参数 | `language=en` 强制 + `initial_prompt` 热词表(`hotwords.txt`) | 实测把嘉宾名 **Krishna 听成 "Crisola"/"Chris Ola"**;专有名词是错拼重灾区,热词表是最便宜有效的修正手段,且必须持续维护 |
| D24 | HuggingFace 加载 | 强制 `HF_HUB_OFFLINE=1`(首次下载模型时用 `ET_HF_ONLINE=1` 覆盖) | 实测 `huggingface_hub` 每次加载都会发校验请求,在有代理的环境下随机 503,把整次转录打挂;模型其实早已缓存 |
| D25 | 阶段划分 | 4 阶段,见 §8 | 先验证转录质量,那是最大风险 |

---

## 4. 数据模型(SQLite)

```sql
-- 节目(RSS 解析结果,feed_url 缓存于此)
shows(
  id TEXT PRIMARY KEY,
  feed_url TEXT UNIQUE NOT NULL,
  title TEXT, author TEXT, image_url TEXT,
  created_at TEXT
)

-- 单集
episodes(
  id TEXT PRIMARY KEY,
  show_id TEXT REFERENCES shows(id),
  guid TEXT NOT NULL,              -- 去重键
  title TEXT NOT NULL,
  published_at TEXT,
  source_url TEXT NOT NULL,        -- 用户分享的原始链接
  audio_path TEXT,                 -- Mac 本地原件
  audio_url TEXT,                  -- 源站地址
  duration_sec REAL,
  state TEXT NOT NULL,             -- pending|downloading|transcribing|segmenting|ready|failed
  error TEXT,
  created_at TEXT, updated_at TEXT,
  UNIQUE(show_id, guid)
)

-- 原始转录:一句话一行。永不修改。
segments(
  id INTEGER PRIMARY KEY,
  episode_id TEXT REFERENCES episodes(id),
  idx INTEGER NOT NULL,            -- 句序
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL,              -- Whisper 原样输出
  UNIQUE(episode_id, idx)
)

-- 仅记录「段落由哪些句组成」,文本永远从 segments 拼出来
paragraphs(
  id INTEGER PRIMARY KEY,
  episode_id TEXT REFERENCES episodes(id),
  idx INTEGER NOT NULL,            -- 段序
  start_seg_idx INTEGER NOT NULL,
  end_seg_idx INTEGER NOT NULL,
  UNIQUE(episode_id, idx)
)

-- 用户标注的生词
vocab_items(
  id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL,             -- 规范化后的词/短语
  surface TEXT,                    -- 原文中的形态
  sentence TEXT,                   -- 语境,记忆钩子
  episode_id TEXT, seg_idx INTEGER,
  note TEXT,
  created_at TEXT,
  UNIQUE(lemma, episode_id, seg_idx)
)

-- 释义缓存(钱和延迟的关键)
explanations(
  key TEXT PRIMARY KEY,            -- sha256(lemma + '\x00' + sentence)
  lemma TEXT, payload_json TEXT, model TEXT, created_at TEXT
)

-- 跨集重逢高亮用的词形索引
CREATE INDEX idx_vocab_lemma ON vocab_items(lemma);
```

**为什么段落表不存文本:** 如果段落表里存一份拼接后的文本,就存在「AI 改写过的文本」和「原始转录」两份数据,迟早会不一致。存索引则段落的文本永远是 `segments` 的忠实拼接,从结构上杜绝污染。

---

## 5. 技术架构

```
┌──────────────────────── Mac(常开,后端)────────────────────────┐
│  FastAPI  (:8787, bearer token)                               │
│    POST /import              {url}     → episode_id           │
│    GET  /episodes                       → 列表+状态            │
│    GET  /episodes/{id}                  → 段落+句子+时间戳      │
│    POST /define              {word,sentence,episode_id}       │
│    GET  /vocab  POST /vocab  DELETE /vocab/{id}               │
│    POST /sync                → 全量文本+词义(给手机)          │
│                                                               │
│  Worker(单并发,DB 持久化状态,可重启续跑)                     │
│    resolve   → 分享链 → RSS feed_url                           │
│    fetch     → yt-dlp 下载音频                                  │
│    transcribe→ mlx-whisper large-v3 → segments                 │
│    segment   → DeepSeek:只输出段落边界索引                      │
│    notify    → Bark                                            │
│                                                               │
│  存储:/data/audio/{show}/{episode}.m4a                        │
│        /data/app.db  (SQLite, WAL)                            │
└───────────────────────────────────────────────────────────────┘
        ▲ Tailscale(私有网络)
        │ HTTPS/HTTP + bearer token
┌───────┴──────────────── iPhone(Expo App)─────────────────────┐
│  列表 → 阅读页(排版/点句播放)→ 释义卡 → 生词本               │
│  本地缓存:全量文本 + 全量词义 + 当前集音频                     │
│  断网可读、可查已缓存的词;新导入需连回 Mac                     │
└───────────────────────────────────────────────────────────────┘
```

**运行环境现状(已核实):** Python 3.14(本项目用 uv 固定 3.12)/ Node v26 / pnpm / ffmpeg / yt-dlp 2025.10.14 / uv。

**技术选型说明:** 后端统一用 Python(FastAPI),因为转录管线(mlx-whisper、feedparser)全在 Python 生态,跨语言拆分会引入无谓的 IPC。Phase 1 的临时阅读界面直接用 FastAPI 吐一个静态页,不引入 Node。

---

## 6. AI 分段:硬约束的实现方式

**问题:** Whisper 输出是一大坨无换行文本(一整集几千词)。读它等于自虐。

**做法(第二版,已实测):**
1. 把 `segments` 按每批 30 句、**只带编号**喂给 DeepSeek,要求返回段落边界
   `[[0,3],[4,7],...]`。模型只吐数字,**根本没有机会回显或改写原文**。
2. 校验是纯数学的:整数、从 0 开始连续覆盖到最后一句、不重叠、不空洞、每段非空。
3. 校验失败 → 把这一批**二分重试**;拆到 4 句还失败才机械分段兜底。
4. 存进 `paragraphs` 表(只存索引)。

**为什么不让模型回显原文再插分隔符(第一版的做法):** 实测 535 句 / 18 批里
**有 4 批**因为模型漏句导致字符对不上而整批作废,退回机械分段;耗时 44 秒。
改成纯序号后:失败批次 **0/18**,耗时 **10 秒**,段落从 114 个(含兜底)降到 87 个,
广告口播、节目开场、正文被正确切开。字符比对这条路太脆,已废弃。

**为什么原始转录必须一字不改:** 任何让模型重新输出原文的做法,都必然出现「顺手润色」——
把 `gonna` 改成 `going to`、把口误修掉、把重复词删掉。而你要拿这个文本核听
「我到底听到了什么」,一旦被润色,核听能力就被污染,查词看到的也可能不是原文。
现在从**结构上**让改写不可能发生:模型只输出数字,段落文本永远由 `segments` 拼接。

---

## 7. 释义卡(产品的第二个核心)

点词 → 按 `sha256(lemma + 句子)` 查缓存 → 未命中才调 DeepSeek → 写缓存 → 返回。

输出结构(固定顺序,因为「当下最需要什么」排在前面):

```
① 在这句话里的意思     ← 多义词 + 语境,词典做不到的部分
② 音标 / 词性
③ 词根词缀拆解          ← 只在真有词根可拆时给;拆不出来就如实说,禁止编造
④ 其他常见义项
⑤ 关联词 / 关联句
```

- 缓存命中:秒开、零成本、断网可用。
- 未命中且断网:显示「需要连接 Mac 才能查询」,不阻塞阅读。
- 释义 JSON 存 `explanations.payload_json`,渲染在客户端。

---

## 8. 路线图

### 阶段 1 — 让管线跑通(纯 Mac,没有 App)
`import → 解析 RSS → 下载音频 → Whisper 转录 → AI 分段 → SQLite → 一个最丑的本地网页用来读`

**目的:尽早验证「转录质量够不够好」。** 如果 Whisper 的文本你读不下去,后面全白做。这是全局最大风险,必须最先验证。

### 阶段 2 — App 骨架
Expo App:内容列表 → 阅读页(排版、点句播放、进度)→ 音频缓存 → 连接 Mac API。

### 阶段 3 — 学习闭环
点词 → 释义卡 → 词义缓存 → 生词本 → 跨集重逢高亮。

### 阶段 4 — 顺手化
Bark 推送 → Tailscale 远程地址配置 → 分享扩展 / 剪贴板自动读取 → 导出 Markdown/CSV。

---

## 9. 待验证的风险

| 风险 | 何时能知道 | 应对 |
|---|---|---|
| ~~Whisper 在真实播客上的转录质量不够读~~ | **已排除**(阶段 1 实测) | Hard Fork "Anthropic's Quest to Give A.I. Morals" 的 3 分钟切片:句子边界、标点、大小写均正确,`Anthropic` 拼对。质量足够精读 |
| 专有名词/人名错拼 | 持续 | `hotwords.txt`,发现一个加一个(已收录 Krishna) |
| 分享链接解析不出 feed(尤其 Spotify) | 阶段 1 | 手动填 RSS 退路;Apple/小宇宙/喜马拉雅 各写规则 |
| DeepSeek 分段返回非法索引 | 阶段 1 | 校验 + 机械分段兜底(已经是设计的一部分) |
| 中文播客混入 | 后期 | 强制 `language=en` 已定;中文内容不作为目标场景 |
| 免费签名 7 天过期 | 阶段 2 | 用 Expo Go 开发;要真机常驻再考虑 $99 开发者账号 |
| 转录期间机器被打满 | 持续 | 约 4 倍实时,1 小时播客约 15 分钟满载。放在你不在用电脑的时候导入 |
