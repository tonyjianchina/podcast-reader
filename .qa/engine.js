/* 测试引擎: 让"刷新页面"可以在不销毁页面上下文的前提下被真实地模拟。
 *
 * 为什么需要它:
 *   web/index.html 的 <script> 是整页脚本, 所有状态都在"脚本级 let/const"里。
 *   用例想测「设置/播放位置/生词 跨刷新还在吗」, 就必须让这些脚本级状态回到初始值。
 *   而 location.reload() 会连测试脚本一起销毁, 用例跑到一半就断了。
 *
 * 做法:
 *   把启动逻辑(storage -> 界面; hash -> 列表/正文; 拉数据)原样重放一遍,
 *   并显式复现"新文档"的语义: 旧 audio 元素销毁、滚动归零、列表和阅读器回到初始可见性。
 *   对被测代码来说, 这与真实刷新等价 —— 它没有任何跨文档之外的状态。
 *   真·整页刷新由 run.mjs 的 coldstart 相覆盖(浏览器地址栏直接加载 /#<id>)。
 */
(() => {
  if (window.__etEngine) return;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const engine = {
    /** 让应用忘掉当前的播放器实例(等价于"关闭页面再打开") */
    resetPlayer() {
      const a = $("#etAudio");
      if (a) {
        try { a.pause(); a.removeAttribute("src"); a.remove(); } catch (e) {}
      }
      return true;
    },
    async init() {
      // 1) 新文档: 销毁播放器, 回到初始 DOM 状态
      engine.resetPlayer();
      document.body.classList.remove("hasPlayer", "reading", "show-zh");
      $("#bar").classList.remove("on");
      $("#full").classList.remove("on");
      document.querySelectorAll("#article .s.cur").forEach((e) => e.classList.remove("cur"));
      const pop = $("#pop");
      if (pop && pop.open) pop.close();

      // 2) 应用持久化设置(与 index.html 启动顺序一致)
      if ($("#rate") && $("#rateVal")) {
        const rate = parseFloat(localStorage.getItem("et.rate") || "0.75");
        $("#rate").value = rate;
        $("#rateVal").textContent = rate.toFixed(2).replace(/0$/, "") + "×";
      }
      if ($("#autonext")) $("#autonext").checked = localStorage.getItem("et.autonext") === "1";
      if ($("#autoscroll")) $("#autoscroll").checked = localStorage.getItem("et.autoscroll") === "1";

      // 3) hash -> 列表 or 正文(冷启动的真实分支)
      const hash = location.hash.slice(1);
      const article = $("#article");
      if (article) article.innerHTML = "";
      if ($("#list")) $("#list").style.display = hash ? "none" : "block";
      if ($("#reader")) $("#reader").style.display = hash ? "block" : "none";
      if ($("#back")) $("#back").style.display = hash ? "" : "none";
      if ($("#postBody")) $("#postBody").innerHTML = "";

      if (!hash) {
        if (typeof loadList === "function") await loadList();
      } else {
        // 重新渲染这一集: 与 openEpisode 完全同一条代码路径
        if (typeof openEpisode === "function") await openEpisode(hash, false);
      }
      await sleep(120);
      window.scrollTo(0, 0);
      return { hash, articleSentences: $$("#article .s").length };
    },
  };

  window.__etEngine = engine;
  window.__etEngineReady = true;
})();
