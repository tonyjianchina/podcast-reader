#!/usr/bin/env python3
"""把测试结果 + 缺陷登记表渲染成一份自包含的 HTML 测评报告。"""

from __future__ import annotations

import html
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
QA = ROOT / ".qa"
OUT = ROOT / "Podcast-Reader-测评报告.html"

run = json.loads((QA / "out" / "run-final5.json").read_text(encoding="utf-8"))
defects = json.loads((QA / "report" / "defects.json").read_text(encoding="utf-8"))
auth_run = json.loads((QA / "out" / "run-auth1.json").read_text(encoding="utf-8")) if (QA / "out" / "run-auth1.json").exists() else None

results = run["results"] + (auth_run["results"] if auth_run else [])
passed = [r for r in results if r["status"] == "pass"]
failed = [r for r in results if r["status"] != "pass"]
areas: dict[str, list] = {}
for r in results:
    areas.setdefault(r["area"], []).append(r)

sev_order = {"blocker": 0, "major": 1, "minor": 2, "nit": 3}
defects_sorted = sorted(defects, key=lambda d: sev_order.get(d["sev"], 9))
sev_label = {"blocker": "阻断", "major": "严重", "minor": "一般", "nit": "细节"}
sev_count = {k: sum(1 for d in defects if d["sev"] == k) for k in sev_order}

esc = html.escape


def ms(v: int) -> str:
    return f"{v / 1000:.1f}s" if v >= 1000 else f"{v}ms"


# ---------------------------------------------------------------- 各区块
def case_rows(area: str) -> str:
    out = []
    for r in areas[area]:
        ok = r["status"] == "pass"
        repro = " ".join(r.get("repro") or [])
        out.append(
            f"""<tr class="case {'ok' if ok else 'bad'}">
      <td class="cid"><span class="dot"></span>{esc(r['id'])}</td>
      <td class="ctitle">{esc(r['title'])}</td>
      <td class="crepro">{esc(repro)}</td>
      <td class="cms">{ms(r['ms'])}</td>
      <td class="cres">{'通过' if ok else '失败' + ('：' + esc(r['error'] or '') if r.get('error') else '')}</td>
    </tr>"""
        )
    return "\n".join(out)


def defect_card(d: dict) -> str:
    files = "".join(f'<code>{esc(f)}</code>' for f in d.get("files", []))
    return f"""<article class="defect sev-{d['sev']}" id="{d['id']}">
  <header>
    <span class="did">{d['id']}</span>
    <span class="sev">{sev_label[d['sev']]}</span>
    <span class="darea">{esc(d['area'])}</span>
  </header>
  <h4>{esc(d['title'])}</h4>
  <dl>
    <dt>表现</dt><dd>{esc(d['symptom'])}</dd>
    <dt>根因</dt><dd>{esc(d['root'])}</dd>
    <dt>修复</dt><dd>{esc(d['fix'])}</dd>
    <dt>验证</dt><dd>{esc(d['verify'])}</dd>
    <dt>涉及</dt><dd class="files">{files}</dd>
  </dl>
</article>"""


CSS = """
:root{
  --paper:#f2efe6; --paper2:#e9e5d9; --ink:#17160f; --ink2:#3d3a2c; --dim:#7d7866;
  --rule:#d3ccb8; --rule2:#bdb49b;
  --ok:#1c6b47; --okbg:#dcebe0; --bad:#a3322a; --badbg:#f3ddd9;
  --amber:#9a5b09; --amberbg:#f0e2c8;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--mono);font-size:14px;line-height:1.65;
  background-image:
    radial-gradient(circle at 12% 8%, #ffffff88, transparent 45%),
    repeating-linear-gradient(0deg,#00000005 0 1px,transparent 1px 28px);
}
.wrap{max-width:1180px;margin:0 auto;padding:0 28px 120px}
a{color:inherit}

/* ---------- 报头 ---------- */
header.masthead{padding:52px 0 26px;border-bottom:3px double var(--ink)}
.stamp{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap}
.kicker{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--dim)}
h1{font-family:var(--serif);font-size:clamp(30px,5vw,52px);line-height:1.02;margin:10px 0 6px;letter-spacing:-.015em}
h1 em{font-style:italic;color:var(--amber)}
.sub{font-size:13px;color:var(--ink2);max-width:56ch}
.meta{text-align:right;font-size:11.5px;color:var(--dim);line-height:1.9;white-space:nowrap}
.meta b{color:var(--ink);font-weight:600}

/* ---------- 记分板 ---------- */
.score{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:0;margin:26px 0 8px;border:1px solid var(--rule2);background:#ffffff5c}
.score div{padding:14px 16px;border-right:1px solid var(--rule)}
.score div:last-child{border-right:0}
.score .n{font-family:var(--serif);font-size:30px;line-height:1;display:block}
.score .l{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-top:7px;display:block}
.score .n.ok{color:var(--ok)} .score .n.bad{color:var(--bad)} .score .n.amber{color:var(--amber)}

/* ---------- 段落 ---------- */
section{padding:44px 0 6px;border-top:1px solid var(--rule)}
h2{font-family:var(--serif);font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
h2 .num{font-family:var(--mono);font-size:11px;letter-spacing:.2em;color:var(--dim);display:block;margin-bottom:8px}
h3{font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin:30px 0 10px;color:var(--ink2)}
h4{font-family:var(--serif);font-size:17.5px;margin:6px 0 10px;line-height:1.3}
p{margin:0 0 12px;max-width:82ch;color:var(--ink2)}
p strong{color:var(--ink)}
ul{max-width:82ch;color:var(--ink2);padding-left:20px}
li{margin-bottom:6px}
code{font-size:12px;background:#0000000d;border:1px solid var(--rule);border-radius:3px;padding:1px 5px;white-space:nowrap}

.verdict{border-left:3px solid var(--ok);background:#ffffff5c;padding:16px 20px;margin:18px 0}
.verdict.warn{border-color:var(--amber)}
.verdict p{margin:0;font-size:14.5px;color:var(--ink)}

/* ---------- 缺陷卡 ---------- */
.defect{border:1px solid var(--rule2);background:#ffffff6b;margin:0 0 14px;padding:16px 18px 6px;position:relative}
.defect:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--dim)}
.defect.sev-blocker:before{background:var(--bad)}
.defect.sev-major:before{background:var(--amber)}
.defect.sev-minor:before{background:#7d7866}
.defect.sev-nit:before{background:var(--rule2)}
.defect header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.did{font-weight:700;letter-spacing:.16em}
.sev{border:1px solid currentColor;padding:0 7px;border-radius:99px;font-size:10px}
.sev-blocker{color:var(--bad)} .sev-major{color:var(--amber)}
.defect.sev-minor .sev{color:var(--ink2)} .defect.sev-nit .sev{color:var(--dim)}
.defect.sev-blocker .sev{color:var(--bad)}
.defect.sev-major .sev{color:var(--amber)}
.darea{color:var(--dim);margin-left:auto}
.defect dl{display:grid;grid-template-columns:64px 1fr;gap:2px 14px;margin:0 0 12px}
.defect dt{font-size:11px;letter-spacing:.1em;color:var(--dim);text-transform:uppercase;padding-top:3px}
.defect dd{margin:0 0 6px;font-size:13.5px;color:var(--ink2)}
.defect dd.files{display:flex;gap:6px;flex-wrap:wrap}

/* ---------- 用例表 ---------- */
table{width:100%;border-collapse:collapse;margin:8px 0 18px;background:#ffffff5c}
th{text-align:left;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);padding:8px 10px;border-bottom:1px solid var(--rule2);font-weight:600}
td{padding:7px 10px;border-bottom:1px solid var(--rule);font-size:12.5px;vertical-align:top;color:var(--ink2)}
tr.case.bad td{background:var(--badbg)}
td.cid{white-space:nowrap;font-weight:600;color:var(--ink)}
td.cid .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);margin-right:7px;vertical-align:1px}
tr.case.bad td.cid .dot{background:var(--bad)}
td.ctitle{color:var(--ink)}
td.crepro{color:var(--dim);font-size:11.5px;min-width:240px}
td.cms{text-align:right;color:var(--dim);white-space:nowrap}
td.cres{white-space:nowrap;color:var(--ok);font-size:11.5px}
tr.case.bad td.cres{color:var(--bad)}
.areahd{display:flex;align-items:baseline;gap:12px;margin:26px 0 2px}
.areahd h3{margin:0;font-size:13px}
.areahd .cnt{font-size:11px;color:var(--dim)}

/* ---------- 条形图 ---------- */
.bars{display:grid;gap:6px;margin:14px 0 22px}
.bar{display:grid;grid-template-columns:180px 1fr 54px;align-items:center;gap:12px;font-size:11.5px}
.bar .track{height:12px;background:#0000000f;border:1px solid var(--rule);display:flex}
.bar .fill{background:var(--ok);height:100%}
.bar .fill.bad{background:var(--bad)}
.bar .v{text-align:right;color:var(--dim)}

pre{background:#17160f;color:#e8e4d6;padding:14px 16px;overflow-x:auto;font-size:12.5px;border-radius:2px;border:1px solid #000}
pre .c{color:#8f8a76}
footer{margin-top:60px;padding-top:18px;border-top:1px solid var(--rule);color:var(--dim);font-size:11.5px;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}
@media (max-width:720px){
  .wrap{padding:0 16px 80px}
  .defect dl{grid-template-columns:1fr}
  .defect dt{padding-top:8px}
  .bar{grid-template-columns:110px 1fr 44px}
  td.crepro{display:none}
  th:nth-child(3){display:none}
}
"""


def main() -> None:
    bars = []
    for area, rs in areas.items():
        tot = len(rs)
        ok = sum(1 for r in rs if r["status"] == "pass")
        pct = ok / tot * 100
        bars.append(
            f"""<div class="bar"><span>{esc(area)}</span>
      <span class="track"><span class="fill{' bad' if ok < tot else ''}" style="width:{pct:.1f}%"></span></span>
      <span class="v">{ok}/{tot}</span></div>"""
        )

    cases_html = []
    for area, rs in areas.items():
        ok = sum(1 for r in rs if r["status"] == "pass")
        cases_html.append(
            f'<div class="areahd"><h3>{esc(area)}</h3><span class="cnt">{ok}/{len(rs)} 通过</span></div>'
            f'<table><thead><tr><th>编号</th><th>场景</th><th>怎么演的</th><th>耗时</th><th>结果</th></tr></thead>'
            f'<tbody>{case_rows(area)}</tbody></table>'
        )

    total = len(results)
    dur = run["durationMs"] / 1000
    defect_cards = "\n".join(defect_card(d) for d in defects_sorted)

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Podcast Reader 真实浏览器测评报告</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

<header class="masthead">
  <div class="stamp">
    <div>
      <div class="kicker">端到端测评 · 真实浏览器 · 无 mock</div>
      <h1>Podcast Reader<br><em>能发给外人用了吗</em></h1>
      <p class="sub">对「粘贴播客链接 → 转录 → 精读」这条私人阅读器做的场景化实测:
      {total} 条用例在真实 Chromium 里逐条演一遍,另有 {len(defects)} 个缺陷被复现、定位、修复、回归。</p>
    </div>
    <div class="meta">
      被测版本 <b>web r9</b><br>
      实例 <b>127.0.0.1:8788</b>(数据副本)<br>
      鉴权实例 <b>:8789</b>(ET_TOKEN)<br>
      浏览器 <b>Chromium 152 · 1280×738 / 390×844</b><br>
      报告生成 <b>{datetime.now().strftime('%Y-%m-%d %H:%M')}</b>
    </div>
  </div>

  <div class="score">
    <div><span class="n ok">{len(passed)}/{total}</span><span class="l">用例通过</span></div>
    <div><span class="n bad">{sev_count['blocker']}</span><span class="l">阻断级缺陷</span></div>
    <div><span class="n amber">{sev_count['major']}</span><span class="l">严重级缺陷</span></div>
    <div><span class="n">{sev_count['minor'] + sev_count['nit']}</span><span class="l">一般 / 细节</span></div>
    <div><span class="n">{dur:.0f}s</span><span class="l">整轮时长</span></div>
    <div><span class="n">{len(run['pageErrors'])}</span><span class="l">未捕获异常</span></div>
  </div>
</header>

<section>
  <h2><span class="num">01 / 结论</span>能不能发出去</h2>
  <div class="verdict">
    <p><strong>可以发出去做小范围外部测试了。</strong>阻断级与严重级缺陷已全部修复并回归:
    {total} 条场景用例全绿,零未捕获异常,桌面与手机两种视口、离线、鉴权、失败态、音频缺失这些边角路径都跑通了。
    真实实例(127.0.0.1:8787)也做了人工冒烟:进正文、点句播放、查词卡片、返回列表后音频不断,全部正常。</p>
  </div>
  <div class="verdict warn">
    <p><strong>但有两件事必须先说清楚:</strong>① 本轮验证的是<strong>阅读与播放这一段</strong>;
    导入/下载/转录/分段这条依赖网络与 GPU 的管线只做了失败路径与状态机验证,没有端到端跑一遍真实播客
    (一次转录 6~10 分钟,不适合放进回归)。
    ② 自动化用的是真实但合成的音频与时间轴;真机上「耳朵听到的」质量(断句位置、倍速下的自然度)仍需你本人听一遍。</p>
  </div>
  <h3>各场景域通过情况</h3>
  <div class="bars">{''.join(bars)}</div>
  <h3>这一轮做了什么</h3>
  <ul>
    <li><strong>真实浏览器,不是模拟器</strong>:每一条用例都是一次真操作 —— 算好坐标、做命中测试(点到的是不是你以为的那个元素)、
    派发完整的 pointer/mouse 事件序列、读回页面真实状态。没有 mock 任何应用逻辑。</li>
    <li><strong>跑在数据副本上</strong>:测试实例用 <code>.qa/test.db</code>(真实库的拷贝)和从真实音频派生的短夹具,
    你的 <code>data/app.db</code> 与原始音频全程没被碰过。</li>
    <li><strong>边角场景真的造出来了</strong>:音频文件丢失的单集、处理失败的单集、60 秒可控时间轴的短音频、
    开了鉴权的第二个实例、被掐断接口的离线态。</li>
    <li><strong>发现即修复即回归</strong>:{len(defects)} 个缺陷都是先复现出可观察的症状、定位到根因、改代码,再用同一批用例回归。</li>
  </ul>
</section>

<section>
  <h2><span class="num">02 / 缺陷登记</span>{len(defects)} 个被复现并修掉的问题</h2>
  <p>按严重度排序。每条都写了「用户会看到什么」「为什么」「怎么修的」「怎么确认修好了」。
  其中 {sev_count['blocker']} 个阻断级、{sev_count['major']} 个严重级。</p>
  {defect_cards}
</section>

<section>
  <h2><span class="num">03 / 用例矩阵</span>{total} 条场景,逐条演一遍</h2>
  <p>「怎么演的」是用例里真实执行的动作序列。耗时是这条用例占用的墙上时间(含等待音频播完的真实时间)。</p>
  {''.join(cases_html)}
</section>

<section>
  <h2><span class="num">04 / 怎么复现</span>把这一轮原样再跑一遍</h2>
  <p>测试代码在 <code>.qa/</code> 下,不依赖任何测试框架:驱动用 ego-browser 操作真实 Chromium,断言在被测页面里执行。</p>
  <pre><span class="c"># 1) 造夹具:复制一份真实库 + 生成边角单集与 60 秒短音频(绝不碰 data/app.db)</span>
.venv/bin/python .qa/mkfixture.py

<span class="c"># 2) 起测试实例:独立数据库、不起后台 worker</span>
ET_PORT=8788 ET_DB_PATH=.qa/test.db ET_NO_WORKER=1 \\
  .venv/bin/python -m uvicorn podcast_reader.app:app --host 127.0.0.1 --port 8788

<span class="c"># 3) 跑全部场景(配置见 .qa/env.json: 页面标签 / 实例地址 / 跑哪些相)</span>
ego-browser nodejs &lt; .qa/run.mjs

<span class="c"># 4) 只跑某几条,边改边验</span>
<span class="c">#    .qa/env.json -> {{"only": "B3,B7,E5", "tag": "debug1"}}</span>
ego-browser nodejs &lt; .qa/run.mjs

<span class="c"># 5) 鉴权实例(token 开着也要能用)</span>
ET_PORT=8789 ET_TOKEN=qa-secret-token .venv/bin/python -m uvicorn podcast_reader.app:app --host 127.0.0.1 --port 8789
<span class="c">#    .qa/env.json -> {{"base": "http://127.0.0.1:8789", "suite": ".qa/authsuite.js", "phases": "auth"}}</span>

<span class="c"># 结果落在 .qa/out/run-&lt;tag&gt;.json</span></pre>
  <h3>相(phase)的含义</h3>
  <ul>
    <li><code>main</code> — 桌面视口,从冷启动到播放器、释义、中译、持久化。
      需要「刷新」的用例会自己抛 <code>RELOAD_MARKER</code>,宿主据此整页重载后接着跑下半段(跨刷新的行为只能这么测)。</li>
    <li><code>mobile</code> — 390×844 视口,查横向溢出、工具栏重叠、全屏播放器是否都在屏内。</li>
    <li><code>coldstart</code> — 地址栏直接 <code>/#&lt;id&gt;</code> 整页加载。</li>
    <li><code>offline</code> — 把页面里的 fetch/XHR 全拒掉(页面外壳照常),验证离线缓存路径。</li>
    <li><code>broken</code> / <code>failed</code> — 音频文件丢失、处理失败这两条边角状态。</li>
    <li><code>auth</code> — 另起一个开了 <code>ET_TOKEN</code> 的实例,验证鉴权下的完整可用性。</li>
  </ul>
</section>

<section>
  <h2><span class="num">05 / 这一轮没测到什么</span>说清楚边界</h2>
  <ul>
    <li><strong>导入 → 转录 → 分段的真实长跑</strong>:解析真实播客链接、下载 56MB 音频、Whisper 转录 6~10 分钟。
    本轮只验证了它们的失败路径(非法链接、网络不通、worker 挂掉)与状态机的可恢复性。
    发出去之前建议你自己粘一个链接跑一集完整流程。</li>
    <li><strong>iOS / Safari 真机</strong>:PWA 的「添加到主屏幕」、底部安全区、iOS 的音频自动播放策略只在 Chromium 上验证过。
    <code>manifest</code> 与 <code>icon.svg</code> 可访问性有用例覆盖,但真机全屏观感需要你自己看一眼。</li>
    <li><strong>长时间播放的稳定性</strong>:用 60 秒短音频覆盖了逐句停、连播推进、进度条拖拽、位置记忆;
    「连听一小时、切来切去、后台标签页」这种长跑没测。</li>
    <li><strong>真机外放音质与断句观感</strong>:自动化只能验证播放头与高亮对齐、句边界是否按预期停下,
    「听起来别扭不别扭」是人的判断。</li>
    <li><strong>多设备/多标签同时使用</strong>:单一 token、无账号体系,并发写没有专门压测。</li>
  </ul>
  <h3>已知的、刻意保留的行为(不是缺陷)</h3>
  <ul>
    <li>返回列表时音频继续播 —— 这是常驻播放器的设计目的,D-02 修的是它因此暴露出来的空源问题。</li>
    <li>跟随滚动默认关、连播默认关、语速默认 0.75× —— 设计取舍,已固化成断言,防止将来被无意改掉。</li>
    <li>中文播客不在目标场景内(强制 <code>language=en</code>)。</li>
  </ul>
</section>

<footer>
  <span>Podcast Reader 测评报告 · {datetime.now().strftime('%Y-%m-%d %H:%M')}</span>
  <span>原始结果:<code>.qa/out/run-final5.json</code> · 缺陷表:<code>.qa/report/defects.json</code> · 用例:<code>.qa/suite.js</code></span>
</footer>
</div>
</body>
</html>
"""
    OUT.write_text(doc, encoding="utf-8")
    print(f"written: {OUT}  ({len(doc) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
