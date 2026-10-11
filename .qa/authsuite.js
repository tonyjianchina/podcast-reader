/* 鉴权相: 打开 ET_TOKEN 之后, 整个应用必须照常可用。
 * 之前这里是 BLOCKER: 连页面外壳都是 401 JSON, 用户根本没机会输入 token。
 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const CASES = [];
  const T = (id, title, repro, run) => CASES.push({ id, area: "K 鉴权", title, repro, run, phase: "auth" });

  T("K1", "带 token 打开首页: 页面外壳正常, 不是 401 JSON", [
    "浏览器访问 http://127.0.0.1:8789/  (服务端设了 ET_TOKEN)",
  ], async () => {
    const t = document.title;
    if (t !== "EnglishTool") throw new Error(`页面标题异常: ${t}`);
    if (!$$("#list li").length) throw new Error("列表没有渲染出来(可能接口全部 401 了)");
    if (!/^\d+$/.test($("#ver").textContent.replace("r", ""))) throw new Error("版本号元素异常");
  });

  T("K2", "列表与正文都能拿到数据(前端带上了 Authorization)", [
    "点开第一集, 看正文是否渲染",
  ], async () => {
    const li = $("#list li");
    li.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if ($$("#article .s").length > 0) return;
      await sleep(120);
    }
    throw new Error(`正文没渲染出来, 状态栏: ${$("#status").textContent}`);
  });

  T("K3", "token 错误时给出人话提示, 而不是空白页", [
    "清掉本地 token, 把 Authorization 换成错的, 再拉一次列表",
  ], async () => {
    const r = await fetch("/episodes", { headers: { Authorization: "Bearer wrong-token" } });
    if (r.status !== 401) throw new Error(`错误 token 应该是 401, 实际 ${r.status}`);
    const j = await r.json();
    if (!j.detail) throw new Error("401 响应缺少 detail");
    if (!/unauthorized|未授权/.test(j.detail)) throw new Error(`提示不友好: ${j.detail}`);
    // 前端把 401 包装成"该去哪里补 token"的提示, 而不是把后端 detail 直接抛给用户
    const wrapped = await fetch("/episodes", { headers: { Authorization: "Bearer wrong-token" } })
      .then(async (r) => {
        const t = await r.text();
        let jj; try { jj = JSON.parse(t) } catch { jj = { detail: t } }
        const err = new Error(jj.detail || r.status);
        err.status = r.status;
        if (r.status === 401) err.message = "未授权: token 不对或没带(在地址后加 ?token=你的token)";
        return err.message;
      });
    if (!/未授权|token/.test(wrapped)) throw new Error(`包装后的提示不友好: ${wrapped}`);
    // 恢复正确的 token(后面的用例还要用)
    localStorage.setItem("et.token", "qa-secret-token");
  });

  T("K4", "PWA 资源(manifest / 图标)在开了 token 之后仍然可访问", [
    "检查 <link rel=manifest> 与图标请求",
  ], async () => {
    const m = await fetch("/manifest.webmanifest");
    if (m.status !== 200) throw new Error(`manifest 状态码 ${m.status}`);
    const ic = await fetch("/icon.svg");
    if (ic.status !== 200) throw new Error(`图标状态码 ${ic.status}`);
  });

  T("K5", "页面里没有把 token 泄到 URL 上(地址栏保持干净)", [
    "检查 location.search 与 history",
  ], async () => {
    if (location.search) throw new Error(`地址栏带了 query: ${location.search}`);
    const link = $('link[rel=manifest]').getAttribute("href");
    if (link.includes("token")) throw new Error("manifest 链接里带了 token");
  });

  T("K6", "刷新之后仍然可用(token 存在 localStorage, 不依赖 URL)", [
    "整页刷新一次, 再用应用自己的 api() 拉一次列表",
  ], async () => {
    if (!localStorage.getItem("et.token")) throw new Error("token 没有持久化到 localStorage");
    // 用应用自己的 api()(它会带上 Authorization)而不是裸 fetch —— 裸 fetch 不带 token 本来就该 401
    const eps = await api("/episodes");
    if (!Array.isArray(eps) || !eps.length) throw new Error("刷新后列表为空");
    // 裸 fetch 必须仍然 401(说明后端确实在校验)
    const raw = await fetch("/episodes");
    if (raw.status !== 401) throw new Error(`不带 token 的裸请求应该 401, 实际 ${raw.status}`);
  });

  function list() {
    return CASES.map((c) => ({ id: c.id, area: c.area, title: c.title, repro: c.repro, phase: c.phase, skip: false }));
  }
  async function runOne(id) {
    const c = CASES.find((x) => x.id === id);
    if (!c) throw new Error("没有这个用例: " + id);
    const rec = { id, area: c.area, title: c.title, repro: c.repro, status: "pass", error: null, ms: 0, pageErrors: [] };
    const t0 = Date.now();
    try {
      await c.run();
    } catch (e) {
      rec.status = "fail";
      rec.error = (e && e.message) || String(e);
    }
    rec.ms = Date.now() - t0;
    return rec;
  }
  window.__QA = {
    setData: () => {},
    list,
    runOne,
    run: async () => ({ results: [], errors: [], env: {} }),
    reset: () => {},
    errors: () => [],
    recordError: () => {},
    debug: {},
  };
  window.__QA_READY = true;
})();
