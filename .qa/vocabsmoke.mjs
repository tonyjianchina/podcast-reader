/* 生词本页面的冒烟用例(独立文件, 不参与 .qa/suite.js 的正式用例集)。
 *
 *   ego-browser nodejs < .qa/vocabsmoke.mjs
 *
 * 只测这一轮新加的东西:
 *   1. 头部有「生词本」入口, 点开默认是不分组的列表(新加的在前, 同词只一条, 每条带出处);
 *      卡片上直接有缓存里的语境义 / 词根拆解, 没缓存的显示「点击查看释义」;
 *      切到「按单集」后按单集分组, 选择记在 localStorage(et.vocabMode), 刷新后仍生效;
 *      上一版存的 'date' 会被迁移成 'list';
 *   2. 同一个词标过两次只出现一条(带 ×2);
 *   3. 点一个词能打开释义卡, 且走 /vocab/<词>/explain 命中缓存(不再花钱查);
 *   4. 「跳到原文这一句」落到原文, 并且当前句正好是标这个词的那一句;
 *   5. 移除要确认, 确认后列表里少一条;
 *   6. 刷新页面(#vocab)仍停在生词本;
 *   7. 全程没有 JS 报错。
 */
const fs = await import("node:fs/promises");

const BASE = "http://127.0.0.1:8788";
const task = await taskSpace("vocab smoke");
const page = task.page("p1");

const results = [];
const ok = (name, pass, extra = "") => {
  results.push({ name, pass, extra });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

try {
await page.goto(BASE + "/");
await page.waitForTimeout(800);
// 模拟上一版留下的 'date'(按日期分组已取消): 应迁移成默认的列表模式(加载时读 localStorage)
await page.evaluate(() => localStorage.setItem("et.vocabMode", "date"));
await page.goto(BASE + "/");
await page.waitForTimeout(1500);

await page.evaluate(() => {
  window.__smoke = [];
  addEventListener("error", (e) => window.__smoke.push("error: " + e.message + " @" + e.lineno));
  addEventListener("unhandledrejection", (e) => window.__smoke.push("rejection: " + (e.reason?.message || e.reason)));
});

// 记录所有 fetch, 用来断言"点词走的是缓存接口"
await page.evaluate(() => {
  const real = window.fetch.bind(window);
  window.__reqs = [];
  window.fetch = (i, o) => {
    const u = typeof i === "string" ? i : (i && i.url) || "";
    window.__reqs.push(u);
    return real(i, o);
  };
});

// ---------- 1. 入口 ----------
const btn = await page.evaluate(() => {
  const b = document.getElementById("vocabBtn");
  if (!b) return { found: false };
  const r = b.getBoundingClientRect();
  return { found: true, visible: r.width > 0 && r.height > 0, ver: document.getElementById("ver")?.textContent || "" };
});
ok("头部有「生词本」入口", btn.found && btn.visible, JSON.stringify(btn));

await page.evaluate(() => document.getElementById("vocabBtn").click());
await page.waitForTimeout(1000);

// ---------- 1b. 默认是不分组的列表 ----------
const lview = await page.evaluate(async () => {
  const api = await (await fetch("/vocab/grouped?by=list")).json();
  return {
    pressed: document.querySelector('#vocabMode [aria-pressed="true"]')?.dataset.mode,
    saved: localStorage.getItem("et.vocabMode"),
    hasList: !!document.querySelector("#vocab .vlist"),
    groups: document.querySelectorAll("#vocab .vg").length,
    apiOrder: (api.items || []).map((x) => x.lemma),
    apiSorted: (api.items || []).every((x, i, a) => i === 0 || String(a[i - 1].created_at) >= String(x.created_at) || /Z$/.test(String(x.created_at))),
    words: [...document.querySelectorAll("#vocab .vlist .vitem")].map((li) => ({
      lemma: li.querySelector(".vword .vw").textContent.trim(),
      count: li.querySelector(".vcount")?.textContent.trim() || "",
      sense: li.querySelector(".vsense")?.textContent.trim() || "",
      roots: li.querySelector(".vroots")?.textContent.replace(/\s+/g, " ").trim() || "",
      pending: li.querySelector(".vpending")?.textContent.trim() || "",
      ep: li.querySelector(".vep")?.textContent.trim() || "",
      jump: li.querySelector('[data-act="jump"]')?.textContent.trim() || "",
      del: !!li.querySelector('[data-act="del"]'),
    })),
  };
});
const lemmas = lview.words.map((w) => w.lemma);
ok("旧的 'date' 迁移成列表模式", lview.pressed === "list" && lview.saved === "list", JSON.stringify({ p: lview.pressed, s: lview.saved }));
ok("默认是不分组的列表", lview.hasList && lview.groups === 0 && lemmas.length > 0, `groups=${lview.groups} n=${lemmas.length}`);
ok("列表顺序 = 接口顺序(新加的在前)", JSON.stringify(lemmas) === JSON.stringify(lview.apiOrder) && lview.apiSorted, lemmas.join(","));
ok("同一个词只出一条", new Set(lemmas).size === lemmas.length);
const lclunky = lview.words.find((w) => w.lemma === "clunky");
ok("重复标记显示 ×2", !!lclunky && lclunky.count === "×2", lclunky ? lclunky.count : "clunky 不见了");
ok("有缓存的词直接显示语境义", !!lclunky && /笨重/.test(lclunky.sense), lclunky ? lclunky.sense : "");
const lexp = lview.words.find((w) => w.lemma === "expansion");
ok("有词根的词显示词根拆解", !!lexp && /词根拆解/.test(lexp.roots) && /ex-/.test(lexp.roots), lexp ? lexp.roots : "");
ok("没缓存的词显示「点击查看释义」", lview.words.some((w) => !w.sense && w.pending === "点击查看释义"),
   lview.words.map((w) => w.lemma + ":" + (w.sense ? "义" : w.pending || "?")).join(" "));
ok("每条都标了出处(列表模式)", lview.words.every((w) => /^出自 .+/.test(w.ep)));
ok("每条都有「跳到原文这一句」和移除", lview.words.every((w) => /跳到原文这一句/.test(w.jump) && w.del));

// 没缓存的词点开: 走原来的释义卡(测试实例没配 key, 只断言卡片打开、走的是同一个接口)
const pendingLemma = (lview.words.find((w) => !w.sense) || {}).lemma;
if (pendingLemma) {
  await page.evaluate((lemma) => {
    const li = [...document.querySelectorAll("#vocab .vitem")].find((x) => x.querySelector(".vword .vw").textContent.trim() === lemma);
    li.querySelector(".vpending").click();
  }, pendingLemma);
  await page.waitForTimeout(1200);
  const pc = await page.evaluate(() => ({ open: document.getElementById("pop").open, word: document.getElementById("pWord").textContent,
    reqs: window.__reqs.filter((u) => u.includes("/explain")) }));
  ok("「点击查看释义」打开释义卡", pc.open && pc.word === pendingLemma && pc.reqs.some((u) => u.includes("/vocab/" + pendingLemma + "/explain")),
     JSON.stringify({ open: pc.open, word: pc.word }));
  await page.evaluate(() => document.getElementById("pop").close());
  await page.waitForTimeout(200);
}

// ---------- 1c. 切到按单集, 选择要记住 ----------
await page.evaluate(() => document.querySelector('#vocabMode [data-mode="episode"]').click());
await page.waitForTimeout(1000);
const sw = await page.evaluate(() => ({
  pressed: document.querySelector('#vocabMode [aria-pressed="true"]')?.dataset.mode,
  saved: localStorage.getItem("et.vocabMode"),
  list: document.querySelectorAll("#vocab .vlist").length,
  sense: [...document.querySelectorAll("#vocab .vg .vsense")].map((x) => x.textContent.trim()).join("|"),
}));
ok("切到按单集并记进 localStorage", sw.pressed === "episode" && sw.saved === "episode" && sw.list === 0, JSON.stringify(sw).slice(0, 120));
ok("按单集时卡片上也有释义", /笨重/.test(sw.sense), sw.sense.slice(0, 60));

const view = await page.evaluate(() => ({
  vocabShown: getComputedStyle(document.getElementById("vocab")).display !== "none",
  listShown: getComputedStyle(document.getElementById("list")).display !== "none",
  hash: location.hash,
  groups: [...document.querySelectorAll("#vocab .vg")].map((g) => ({
    count: g.querySelector(".vc").textContent.trim(),
    words: [...g.querySelectorAll(".vitem")].map((li) => ({
      lemma: li.querySelector(".vword .vw").textContent.trim(),
      meta: li.querySelector(".vcount")?.textContent.trim() || "",
      hasSent: !!li.querySelector(".vs"),
      sentMarked: !!li.querySelector(".vs .vw"),
      jump: !!li.querySelector('[data-act="jump"]'),
    })),
  })),
  status: document.getElementById("status").textContent,
}));
ok("点开后显示生词本视图", view.vocabShown && !view.listShown && view.hash === "#vocab", view.hash);
ok("按单集分组(2 集)", view.groups.length === 2, `groups=${view.groups.length}`);
ok("组内同词只出一条", view.groups.every((g) => new Set(g.words.map((w) => w.lemma)).size === g.words.length));
const dup = view.groups.flatMap((g) => g.words).find((w) => w.lemma === "clunky");
ok("重复标记的词标了次数", !!dup && /×2/.test(dup.meta), dup ? dup.meta : "clunky 不见了");
ok("原句里的那个词被高亮出来", view.groups.some((g) => g.words.some((w) => w.sentMarked)));
ok("每条都有「跳到原文这一句」", view.groups.flatMap((g) => g.words).every((w) => w.jump));
ok("状态栏显示总数", /个生词/.test(view.status), view.status);

// ---------- 2. 点词 -> 释义卡(应命中缓存, 不再花钱) ----------
await page.evaluate(() => {
  const li = [...document.querySelectorAll("#vocab .vitem")]
    .find((x) => x.querySelector(".vword .vw").textContent.trim() === "clunky");
  li.querySelector('[data-act="open"]').click();
});
await page.waitForTimeout(3000);

const card = await page.evaluate(() => ({
  open: document.getElementById("pop").open,
  word: document.getElementById("pWord").textContent,
  body: document.getElementById("pBody").textContent.replace(/\s+/g, " ").slice(0, 140),
  markBtn: document.getElementById("pMark").textContent.trim(),
  reqs: window.__reqs.filter((u) => u.includes("/vocab")),
}));
ok("点词打开释义卡", card.open && card.word === "clunky", JSON.stringify({ open: card.open, word: card.word }));
ok("走的是生词本释义接口", card.reqs.some((u) => u.includes("/vocab/clunky/explain")), card.reqs.join(","));
ok("卡片里是中文释义(缓存命中, 不是报错)", /笨重|不顺手/.test(card.body), card.body.slice(0, 60));
ok("卡片标明已在生词本", /已在生词本/.test(card.markBtn), card.markBtn);
await page.evaluate(() => document.getElementById("pop").close());
await page.waitForTimeout(200);

// ---------- 3. 跳回原文那一句 ----------
await page.evaluate(() => {
  const li = [...document.querySelectorAll("#vocab .vitem")]
    .find((x) => x.querySelector(".vword .vw").textContent.trim() === "expansion");
  li.querySelector('[data-act="jump"]').click();
});
await page.waitForTimeout(2200);

const jumped = await page.evaluate(() => {
  const cur = document.querySelector("article .s.cursor");
  return {
    readerShown: getComputedStyle(document.getElementById("reader")).display !== "none",
    vocabShown: getComputedStyle(document.getElementById("vocab")).display !== "none",
    hash: location.hash,
    curIdx: cur ? cur.dataset.i : null,
    curText: cur ? cur.textContent.slice(0, 70) : "",
    hasWord: cur ? /expansion/i.test(cur.textContent) : false,
    status: document.getElementById("status").textContent,
    // 这一句是否真的滚进视口了(跳转的可见效果)
    inView: (() => {
      if (!cur) return false;
      const r = cur.getBoundingClientRect();
      return r.top > -50 && r.bottom < window.innerHeight + 50;
    })(),
    scrollY: Math.round(window.scrollY),
    vh: window.innerHeight,
    rect: (() => { if (!cur) return null; const r = cur.getBoundingClientRect();
                   return { top: Math.round(r.top), bottom: Math.round(r.bottom) } })(),
  };
});
ok("跳到原文并打开那一集", jumped.readerShown && !jumped.vocabShown && jumped.hash.length > 1, jumped.hash);
ok("落点是标这个词的那一句(idx=3)", jumped.curIdx === "3", `curIdx=${jumped.curIdx} ${jumped.curText.slice(0, 40)}`);
ok("那一句里确实有这个词", jumped.hasWord);
ok("落点在视口内(真的滚过去了)", jumped.inView,
   `scrollY=${jumped.scrollY} vh=${jumped.vh} rect=${JSON.stringify(jumped.rect)}`);

// ---------- 4. 移除(带确认) ----------
await page.evaluate(() => { location.hash = "#vocab" });
await page.waitForTimeout(1200);
const before = await page.evaluate(() => document.querySelectorAll("#vocab .vitem").length);
const target = await page.evaluate(() =>
  [...document.querySelectorAll("#vocab .vitem .vword .vw")].map(x => x.textContent.trim()).pop() || "");
ok("生词本里还有可删的词", !!target, target);
await page.evaluate((lemma) => { window.confirm = () => true }, target);
await page.evaluate((lemma) => {
  const li = [...document.querySelectorAll("#vocab .vitem")]
    .find((x) => x.querySelector(".vword .vw").textContent.trim() === lemma);
  li.querySelector('[data-act="del"]').click();
}, target);
await page.waitForTimeout(1500);
const after = await page.evaluate((lemma) => ({
  n: document.querySelectorAll("#vocab .vitem").length,
  lemmas: [...document.querySelectorAll("#vocab .vitem .vword .vw")].map((x) => x.textContent.trim()),
  status: document.getElementById("status").textContent,
}), target);
ok("移除后列表少一条", after.n === before - 1 && !after.lemmas.includes(target), `${target}: ${before} -> ${after.n} ${after.status}`);

// 取消确认时不该删
await page.evaluate(() => { window.confirm = () => false });
await page.evaluate(() => {
  document.querySelector('#vocab .vitem [data-act="del"]').click();
});
await page.waitForTimeout(600);
const cancelled = await page.evaluate(() => document.querySelectorAll("#vocab .vitem").length);
ok("取消确认则不删", cancelled === after.n, `${after.n} -> ${cancelled}`);

// ---------- 5. 刷新后仍停在生词本 ----------
await page.goto(BASE + "/#vocab");
await page.waitForTimeout(1800);
const reloaded = await page.evaluate(() => ({
  vocabShown: getComputedStyle(document.getElementById("vocab")).display !== "none",
  groups: document.querySelectorAll("#vocab .vg").length,
  status: document.getElementById("status").textContent,
  mode: document.querySelector('#vocabMode [aria-pressed="true"]')?.dataset.mode,
  dated: document.querySelectorAll("#vocab .vg[data-date]").length,
  errors: window.__smoke || [],
}));
ok("刷新后仍在生词本(#vocab 可书签/可刷新)", reloaded.vocabShown && reloaded.groups > 0, JSON.stringify(reloaded).slice(0, 140));
ok("刷新后仍是上次选的按单集", reloaded.mode === "episode" && reloaded.dated === 0, `mode=${reloaded.mode} dated=${reloaded.dated}`);
await page.evaluate(() => localStorage.removeItem("et.vocabMode"));
ok("全程无 JS 报错", reloaded.errors.length === 0, reloaded.errors.join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
// ego 的 node 进程 cwd 不一定在项目根, 所以写文件走绝对路径
const OUTDIR = "/Users/zhengjian/jensen_workspace/个人项目/英语学习/.qa/out";
await fs.mkdir(OUTDIR, { recursive: true }).catch(() => {});
await fs.writeFile(OUTDIR + "/vocabsmoke.json", JSON.stringify(results, null, 2));
process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error("烟测崩了: " + (err && err.stack || err));
  process.exitCode = 2;
}
