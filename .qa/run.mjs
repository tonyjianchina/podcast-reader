/* 用 ego-browser 驱动 .qa/suite.js 的场景化端到端用例。
 *
 *   ego-browser nodejs < .qa/run.mjs -- --page=p4 --phases=main,offline
 *
 * 分工:
 *   - 页面里的 .qa/suite.js 负责"像人的操作 + 断言"; 它的驱动是页面内的
 *     (命中测试 + 完整 pointer/mouse 事件序列), 所以一整条用例能在一次 evaluate 里跑完,
 *     不需要回调宿主(宿主在 evaluate 期间进不了页面, 回调必然死锁)。
 *   - 这里只做页面做不到的事: 真实鼠标/键盘设备事件、视口切换、断网、导航与整页刷新。
 *     这些按"相(phase)"组织: 每一相先设好环境, 再跑这一相的用例。
 */

const fs = await import("node:fs/promises");
const path = await import("node:path");

// ego-browser 的脚本进程只继承极少的环境变量(QA_* 全部看不到), 所以配置走命令行参数 + 配置文件:
//   ego-browser nodejs < .qa/run.mjs -- --page=p4 --phases=offline --only=B3
//   .qa/env.json  {"page": "p4", "base": "http://127.0.0.1:8788", "out": "...", "tag": "r1", "phases": "main", "only": "B3,B4"}
// 项目根按脚本自身位置解析, 不写死绝对路径:
// 这个文件在 <ROOT>/.qa/run.mjs, 所以往上两级就是 ROOT。
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fileCfg = await fs
  .readFile(path.join(ROOT, ".qa/env.json"), "utf8")
  .then(JSON.parse)
  .catch(() => ({}));
const argv = process.argv.slice(1).join(" ");
const arg = (name) => {
  const m = new RegExp(`--${name}=([^\\s]+)`).exec(argv);
  return m ? m[1] : undefined;
};
const cfg = {
  page: arg("page") || fileCfg.page || "p1",
  base: arg("base") || fileCfg.base || "http://127.0.0.1:8788",
  out: arg("out") || fileCfg.out || ROOT + "/.qa/out",
  tag: arg("tag") || fileCfg.tag || new Date().toISOString().replace(/[:.]/g, "-"),
  phases: arg("phases") || fileCfg.phases || "main,mobile,coldstart,offline,broken,failed",
  only: arg("only") || fileCfg.only || "",
  suite: arg("suite") || fileCfg.suite || ".qa/suite.js",
  space: Number(arg("space") || fileCfg.space || 216),
};

const BASE = cfg.base;
// out 允许是相对路径(相对项目根), 这样配置里不必写死绝对路径。
const OUT = path.isAbsolute(cfg.out) ? cfg.out : path.resolve(ROOT, cfg.out);
const ONLY = String(cfg.only).split(",").map((s) => s.trim()).filter(Boolean);
const TAG = cfg.tag;
const SPACE = cfg.space;
const PHASES = String(cfg.phases).split(",").map((s) => s.trim()).filter(Boolean);
const PAGE = cfg.page;

const read = (p) => fs.readFile(path.join(ROOT, p), "utf8");
const SUITE_FILE = cfg.suite || ".qa/suite.js";
const [suiteSrc, driverSrc, engineSrc, fixture] = await Promise.all([
  read(SUITE_FILE),
  read(".qa/driver.js"),
  read(".qa/engine.js"),
  read(".qa/fixture.json").then(JSON.parse),
]);

const task = await taskSpace(SPACE);
const page = task.page(PAGE);

const DATA = { base: BASE, expected: fixture, only: ONLY };

const installTrap = () =>
  page
    .evaluate(() => {
      window.__qaErrors = window.__qaErrors || [];
      const push = (s) => {
        if (window.__qaErrors.length < 200) window.__qaErrors.push(String(s).slice(0, 300));
      };
      if (!window.__trapInstalled) {
        window.__trapInstalled = true;
        addEventListener("error", (e) => push("error: " + (e.message || e.type) + " @" + (e.filename || "") + ":" + e.lineno));
        addEventListener("unhandledrejection", (e) => push("unhandledrejection: " + ((e.reason && (e.reason.message || e.reason)) || "?")));
        const ce = console.error.bind(console);
        console.error = (...a) => { push("console.error: " + a.map((x) => (x && x.message) || x).join(" ")); ce(...a); };
      }
      return true;
    })
    .catch(() => {});

async function inject() {
  await installTrap();
  // 页面刚加载: 默认处于"隔离窗口"(宿主还没说可以开始跑用例)
  await page.evaluate(() => { window.__qaIsolated = true; }).catch(() => {});
  await page.evaluate(engineSrc).catch((e) => console.error("[qa] engine inject failed: " + e.message));
  await page.evaluate(suiteSrc).catch((e) => console.error("[qa] suite inject failed: " + e.message));
  await page.evaluate((d) => { window.__QA.setData(d); return true; }, DATA);
}

/** 发一次"真实用户输入"。
 *
 * Chrome 的自动播放策略只认可信(trusted)输入; 用例里的点击是合成的, 拿不到这个许可,
 * 于是 audio.play() 会被拒绝 —— 那测的就不是应用而是浏览器策略了。
 * 真实用户也是靠"第一次点一下页面"拿到许可的, 这里如实复现这一点。
 * 顺带把测试标记写到页面里, 供用例断言("宿主已解锁音频")。
 */
async function grantGesture(reason) {
  await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const pt = await page.evaluate(() => {
    let host = document.getElementById("__qa_gesture_host");
    if (!host) {
      host = document.createElement("div");
      host.id = "__qa_gesture_host";
      host.style.cssText = "position:fixed;right:0;bottom:0;width:10px;height:10px;opacity:.01;z-index:2147483647";
      document.body.appendChild(host);
    }
    const r = host.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.click(pt.x, pt.y, { label: "grant user gesture" }).catch(() => {});
  const activated = await page.evaluate(() => (navigator.userActivation ? navigator.userActivation.hasBeenActive : true));
  await page.evaluate((d) => { window.__qaGesture = d.v; window.__qaGestureReason = d.reason; }, { v: !!activated, reason });
  if (!activated) console.error(`[qa] 警告: ${reason} 之后仍未获得 user activation`);
  return activated;
}

async function drainErrors() {
  return await page.evaluate(() => {
    const out = (window.__qaErrors || []).slice();
    window.__qaErrors = [];
    if (window.__QA) window.__QA.reset();
    return out;
  });
}

async function setViewport(w, h) {
  if (w === null) { await page.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {}); return; }
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 620 });
}

async function setOffline(on) {
  await page.cdp("Network.enable", {}).catch(() => {});
  await page.cdp("Network.emulateNetworkConditions", { offline: !!on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.evaluate((o) => window.dispatchEvent(new Event(o ? "offline" : "online"))).catch(() => {});
}

/** 模拟离线: 把页面里的 fetch / XMLHttpRequest 全部拒掉。
 *
 * 为什么不用 Network.emulateNetworkConditions 或 CDP Fetch 拦截:
 *  - emulateNetworkConditions 连文档导航一起断, 无头环境里 page.goto 直接
 *    ERR_INTERNET_DISCONNECTED, 测的变成浏览器缓存策略;
 *  - CDP Fetch 拦截在无头环境里偶发丢事件, 会把页面挂死。
 * 应用这一层要测的是"接口不可达时怎么办", 所以在 fetch 这一层拒掉最贴切。
 * 注意: 这是测试替身, 不是产品代码; 补丁会跟着页面重载一起消失, 由宿主每次重打。
 */
const BLOCK_SRC = `(() => {
  if (window.__qaNetBlocked) return true;
  window.__qaNetBlocked = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.startsWith("/") || url.includes(location.host)) {
      return Promise.reject(new TypeError("Failed to fetch (QA: network blocked)"));
    }
    return realFetch(input, init);
  };
  const RealXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const x = new RealXHR();
    const open = x.open.bind(x);
    x.open = function (method, url, ...rest) {
      if (String(url).startsWith("/")) {
        setTimeout(() => x.dispatchEvent(new Event("error")), 0);
        return;
      }
      return open(method, url, ...rest);
    };
    return x;
  };
  return true;
})()`;

/** 把 /import 的响应换掉(测试替身)。
 *  真实场景里"粘错链接"要等 DNS/连接超时好几秒, 自动化没必要每次都等 ——
 *  这里让它在 50ms 内返回失败, 被测的仍然是前端的错误提示路径。 */
async function stubImportFailure(on) {
  await page
    .evaluate((enabled) => {
      if (!enabled) {
        if (window.__qaRealFetch) { window.fetch = window.__qaRealFetch; delete window.__qaRealFetch; }
        return true;
      }
      if (window.__qaRealFetch) return true;
      window.__qaRealFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/import")) {
          return Promise.resolve(
            new Response(JSON.stringify({ detail: "导入失败(网络不通): 解析这个链接失败了" }), {
              status: 422,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return window.__qaRealFetch(input, init);
      };
      return true;
    }, on)
    .catch(() => {});
}

async function blockProgrammaticRequests(on) {
  if (on) {
    await page.evaluate(BLOCK_SRC).catch(() => {});
    await page.evaluate(() => { window.__qaHost = { requestsBlocked: true }; }).catch(() => {});
    return;
  }
  // 恢复: 把原生 fetch 还回去。若不恢复, 后面的整页导航因为子资源全被拒而拿不到 load 事件。
  await page
    .evaluate(() => {
      if (!window.__qaNetBlocked) return true;
      delete window.__qaNetBlocked;
      try {
        delete window.fetch;
      } catch (e) {}
      return true;
    })
    .catch(() => {});
}

/** 导航并确认真的到了目标文档。
 *
 * 两个坑(都实测踩过):
 *  1) 页面停在 about:blank 时, 页面里访问 localStorage 会抛 SecurityError ——
 *     后面所有用例都会莫名其妙地失败。所以每次导航后都要校验当前 URL。
 *  2) 同 URL 的 goto 可能只是"改 hash", 不会重新加载文档; 需要拿新版本页面脚本时
 *     必须先经过 about:blank。
 */
async function nav(url, { reload = false, tries = 3 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      // 只等 DOM 就绪: 页面里有外部封面图, 网络慢或代理不通时 load 事件可能十几秒不来,
      // 而应用本身(inline script)在 DOMContentLoaded 就已经可用了。
      const until = "domcontentloaded";
      if (reload) await page.reload({ waitUntil: until });
      else if (url === "about:blank") await page.goto("about:blank", { waitUntil: until });
      else await page.goto(url, { waitUntil: until });
      await page.waitForLoadState(until).catch(() => {});
      const now = await page.evaluate(() => location.href).catch(() => "");
      const want = url === "about:blank" ? "about:blank" : url;
      const path = want.split("?")[0];
      const sameDoc = now && (now === want || now.split("?")[0] === path || now === path);
      if (sameDoc) return true;
      if (url === "about:blank" && now === "about:blank") return true;
      console.error(`[qa] 导航后 URL 不符(第 ${attempt + 1} 次): 期望 ${want} 实际 ${now.slice(0, 60)}`);
    } catch (e) {
      console.error(`[qa] 导航失败(第 ${attempt + 1} 次): ${String(e.message || e).slice(0, 70)} | ${url || "(reload)"}`);
      await page.goto("about:blank").catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

const gotoURL = async (u, { fresh = false } = {}) => {
  await nav(BASE + u);
  if (fresh) {
    // 同 URL 的 goto 可能根本不重新加载文档(尤其只改 hash 时), 那样会拿着上一版的页面脚本,
    // 甚至上一轮的页面状态继续测。这里用 reload 强制重新拉一份 index.html。
    // 注意不要用 about:blank 中转: 那会让文档处在没有源的空白页上, 页面里访问
    // localStorage 会抛 SecurityError, 后面的用例会莫名其妙地全挂(实测踩过)。
    await nav(BASE + u, { reload: true });
  }
  await inject();
};

// ---------------------------------------------------------------- 起手
// 上一轮如果中途退出, 可能把浏览器留在"断网 / 移动视口 / Fetch 拦截开着"的状态, 先复位。
// 实测: 残留的 Fetch.enable 会让后续所有导航卡在 load 事件上, 看起来像服务器挂了。
await page.cdp("Fetch.disable", {}).catch(() => {});
await page.cdp("Network.enable", {}).catch(() => {});
await page.cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
await page.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
await gotoURL("/", { fresh: true });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("et.rate", "0.75");
  localStorage.setItem("et.showzh", "0");
  localStorage.setItem("et.autonext", "0");
  localStorage.setItem("et.autoscroll", "0");
});
await gotoURL("/");

const allCases = await page.evaluate(() => window.__QA.list());
const results = [];
const hostErrors = [];
const t0 = Date.now();
let lastViewport = "desktop";

async function runPhase(label, caseIds, opts = {}) {
  // 离线补丁要在每次重载之后重新打(补丁本身也随文档一起消失)
  if (opts.requestsBlocked) await blockProgrammaticRequests(true);
  await drainErrors();
  await grantGesture("phase " + label);
  for (const id of caseIds) {
    const meta = allCases.find((c) => c.id === id);
    const started = Date.now();
    let rec;
    try {
      // 让页面知道"现在处于用例之间的隔离窗口": 用例内的等待不会以为自己在正常流程里
      await page.evaluate((off) => {
        window.__qaIsolated = false;
        window.__qaResume = false;
        window.__qaHost = { requestsBlocked: off };
      }, !!opts.requestsBlocked).catch(() => {});
      if (opts.requestsBlocked) await blockProgrammaticRequests(true);
      rec = await page.evaluate((i) => window.__QA.runOne(i), id);
      // 用例用 RELOAD_MARKER 告诉宿主"我需要一次真刷新才能测下半段":
      // 宿主整页重载 -> 重新注入 -> 打上 resume 标记 -> 同一条用例再跑一遍(用例自己幂等)。
      // 不用"页面挂住等宿主"的写法: 那会把 evaluate 一直拖到超时。
      if (rec.status === "fail" && /RELOAD_MARKER/.test(rec.error || "")) {
        const hash = await page.evaluate(() => location.hash).catch(() => "");
        await nav(BASE + "/" + hash, { reload: true });
        await inject();
        await grantGesture("resume " + id);
        await page.evaluate(() => {
          window.__qaIsolated = false;
          window.__qaResume = true;
        }).catch(() => {});
        if (opts.requestsBlocked) await blockProgrammaticRequests(true);
        rec = await page.evaluate((i) => window.__QA.runOne(i), id);
      }
    } catch (e) {
      rec = { id, area: meta.area, title: meta.title, repro: meta.repro, status: "fail", error: "宿主执行失败: " + (e.message || e), ms: Date.now() - started, pageErrors: [] };
      hostErrors.push(`${id}: ${e.message}`);
      await inject().catch(() => {});
    }
    console.error(`[qa] ${rec.status === "pass" ? "PASS" : "FAIL"} [${label}] ${rec.id} ${rec.title} (${rec.ms}ms)${rec.error ? " :: " + rec.error : ""}`);
    results.push({ ...rec, phase: label });
    // 用例之间必须把音频停掉, 否则上一条的播放会污染下一条(句边界回调会改状态)
    await page
      .evaluate(() => {
        const a = document.querySelector("#etAudio");
        if (a) {
          // 只暂停+移除, 不要 load(): 清空 src 之后 load() 会立刻抛 error 事件,
          // 应用的 error 处理会因此把播放器状态弄脏(这条正是被测代码要防的情况)
          try { a.pause(); a.removeAttribute("src"); a.remove(); } catch (e) {}
        }
        const pop = document.querySelector("#pop");
        if (pop && pop.open) pop.close();
        // 让应用重新建播放器(它自己有 isConnected 兜底, 这里只是把状态显式复位)
        if (window.__etEngine && window.__etEngine.resetPlayer) window.__etEngine.resetPlayer();
        return true;
      })
      .catch(() => {});
    await page.evaluate(() => { window.__qaIsolated = true; }).catch(() => {});
  }
}
const phaseCases = (p) =>
  allCases
    .filter((c) => c.phase === p)
    .filter((c) => !ONLY.length || ONLY.includes(c.id))
    .map((c) => c.id);

for (const phase of PHASES) {
  if (phase === "main") {
    if (lastViewport !== "desktop") { await setViewport(1280, 738); lastViewport = "desktop"; }
    await gotoURL("/#" + fixture.mainId, { fresh: true });
    await stubImportFailure(true);
    await runPhase("main", phaseCases("main"));
    await stubImportFailure(false);
  } else if (phase.startsWith("reload-")) {
    // 这些相只在"刷新之后"那一半跑: 宿主先把页面整页重载, 再以 resume 身份执行用例
    if (lastViewport !== "desktop") { await setViewport(1280, 738); lastViewport = "desktop"; }
    await gotoURL("/", { fresh: true });
    await runPhase(phase, phaseCases(phase));
  } else if (phase === "mobile") {
    await setViewport(390, 844);
    lastViewport = "mobile";
    await gotoURL("/", { fresh: true });
    await runPhase("mobile", phaseCases("mobile"));
  } else if (phase === "coldstart") {
    // 真正的整页加载: 地址栏里就是 /#<id>, 页面上下文全新
    await gotoURL("/#" + fixture.mainId, { fresh: true });
    await runPhase("coldstart", phaseCases("coldstart"));
  } else if (phase === "offline") {
    if (lastViewport !== "desktop") { await setViewport(1280, 738); lastViewport = "desktop"; }
    await setOffline(false);
    await gotoURL("/#" + fixture.mainId, { fresh: true });
    // 先在线把 /sync 写进 localStorage(应用真实的离线缓存路径)
    await page.evaluate(async () => {
      const d = await (await fetch("/sync", { method: "POST" })).json();
      localStorage.setItem("et.offline", JSON.stringify({ at: Date.now(), data: d }));
      return true;
    });
    const cachedEpisodes = await page.evaluate(() => JSON.parse(localStorage.getItem("et.offline")).data.episodes.length);
    console.error(`[qa] 离线缓存已写入: ${cachedEpisodes} 集`);
    for (const id of phaseCases("offline")) await runPhase("offline", [id], { requestsBlocked: true });
    await blockProgrammaticRequests(false);
  } else if (phase === "auth") {
    // 鉴权相: 清掉本地 token -> 用 ?token= 首次进入(前端会把它存下来并抹掉地址栏)
    const token = cfg.token || "qa-secret-token";
    await nav(BASE + "/");
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await gotoURL("/?token=" + token);
    await runPhase("auth", phaseCases("auth"));
  } else if (phase === "broken" || phase === "failed") {
    const id = phase === "broken" ? fixture.brokenAudio.id : fixture.failed.id;
    await gotoURL("/#" + id, { fresh: true });
    await runPhase(phase, phaseCases(phase));
  } else {
    console.error(`[qa] 未知相: ${phase}`);
  }
}

await setViewport(null);
await setOffline(false);
await blockProgrammaticRequests(false);
// 收尾清理: 停掉音频与应用定时器, 免得页面带着一堆 interval 留给下一轮(实测:
// 残留的定时器会让页面在后续导航时卡住, 看起来像服务器挂了)
await page
  .evaluate(() => {
    document.querySelectorAll("audio").forEach((a) => {
      try { a.pause(); a.removeAttribute("src"); a.remove(); } catch (e) {}
    });
    if (window.__etEngine && window.__etEngine.resetPlayer) window.__etEngine.resetPlayer();
    return true;
  })
  .catch(() => {});
const leftover = await drainErrors();

const report = {
  base: BASE, tag: TAG,
  startedAt: new Date().toISOString(),
  durationMs: Date.now() - t0,
  fixture: { mainId: fixture.mainId, episodes: fixture.episodes, failed: fixture.failed, brokenAudio: fixture.brokenAudio },
  env: { base: BASE, phases: PHASES },
  results, pageErrors: leftover, hostErrors,
};

await fs.mkdir(OUT, { recursive: true });
const file = path.join(OUT, `run-${TAG}.json`);
await fs.writeFile(file, JSON.stringify(report, null, 2));

const fails = results.filter((r) => r.status !== "pass");
console.log(JSON.stringify({
  file, total: results.length, passed: results.length - fails.length, failed: fails.length,
  failures: fails.map((f) => ({ id: f.id, phase: f.phase, title: f.title, error: f.error })),
  hostErrors, pageErrors: leftover.slice(0, 10),
}, null, 1));
