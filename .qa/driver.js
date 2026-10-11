/* 页面侧驱动: 把"像人一样的操作"桥接给 Node 侧执行。
 *
 * 页面里不能直接发真实输入事件, 所以这里只是一个 RPC 客户端:
 *   await __D.request({op, args})  ->  Node 用 page.mouse / page.keyboard / CDP 执行
 *
 * 纯 DOM 读取(坐标、命中元素)在页面里同步完成, 不需要来回。
 */
(() => {
  const D = (window.__D = window.__D || {});
  D.seq = 1;
  D.pending = new Map();
  D.inbox = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 等页面稳定: DOMContentLoaded 之后没有新的导航请求, 且有一帧空闲 */
  async function settle(ms = 300) {
    await sleep(ms);
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (document.readyState !== "complete") {
        await sleep(100);
        continue;
      }
      if (D.navigating) {
        await sleep(150);
        continue;
      }
      const t1 = Date.now();
      await sleep(120);
      if (t1 - t0 > 700) break;
    }
    await sleep(120);
  }

  function request(op, args = {}) {
    const id = D.seq++;
    return new Promise((resolve, reject) => {
      D.pending.set(id, { resolve, reject });
      D.inbox.push({ id, op, args });
      setTimeout(() => {
        if (D.pending.has(id)) {
          D.pending.delete(id);
          reject(new Error(`驱动操作 ${op} 超时(30s)`));
        }
      }, 30000);
    });
  }
  D.reply = (id, result, error) => {
    const p = D.pending.get(id);
    if (!p) return false;
    D.pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
    return true;
  };

  // ---- 同步 DOM 读取 ----
  function point(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const rects = [...el.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
    rects.sort((a, b) => b.width * b.height - a.width * a.height);
    const r = rects[0] || el.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1)) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  /** 原生完整点击: 先滚进视口, 移动, 按下, 抬起 */
  async function click(x, y, { scroll = true } = {}) {
    if (scroll) {
      // 已由调用方算好坐标; 这里只做一次可见性保证
    }
    await request("mouse_move", { x, y });
    await request("mouse_down", { x, y });
    await sleep(30);
    await request("mouse_up", { x, y });
    await sleep(80);
  }

  D.ext = {
    // 同步
    eval: (fn, arg) => fn(arg),
    point,
    pointFor: (sel) => point(sel),
    rect(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    },
    topAt(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      if (el.classList.contains("s")) return "s";
      return (el.className && String(el.className)) || el.tagName;
    },
    wordPoint(word) {
      const cands = [...document.querySelectorAll("#article .w")].filter((el) => {
        if (word && el.dataset.w.toLowerCase() !== String(word).toLowerCase()) return false;
        if (el.classList.contains("marked")) return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      });
      const el = cands[0];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: el.dataset.w };
    },
    // 异步(走 Node)
    mouse(x, y) {
      return request("mouse_move", { x, y });
    },
    click(x, y, opts) {
      return click(x, y, opts);
    },
    async clickSel(sel) {
      const p = point(sel);
      if (!p) throw new Error(`找不到可点元素 ${sel}`);
      await click(p.x, p.y);
      await sleep(60);
    },
    /** 合成点击(走页面自身的 on* 处理链, 不经过命中测试) */
    async syntheticClick(sel) {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`找不到元素 ${sel}`);
      el.scrollIntoView({ block: "center" });
      await sleep(250);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
      await sleep(400);
    },
    mouseDown(x, y) {
      return request("mouse_down", { x, y });
    },
    mouseMove(x, y) {
      return request("mouse_move", { x, y });
    },
    mouseUp(x, y) {
      return request("mouse_up", { x, y });
    },
    key(k) {
      return request("key", { key: k });
    },
    type(t) {
      return request("type", { text: t });
    },
    async goto(url, opts = {}) {
      D.navigating = true;
      try {
        await request("goto", { url, hard: !!opts.hard });
      } finally {
        D.navigating = false;
      }
      await settle(500);
    },
    async reload() {
      D.navigating = true;
      try {
        await request("reload", {});
      } finally {
        D.navigating = false;
      }
      await settle(600);
    },
    async back() {
      await request("back", {});
      await settle(600);
    },
    async forward() {
      await request("forward", {});
      await settle(600);
    },
    viewport(w, h) {
      return request("viewport", { w, h });
    },
    offline(on) {
      return request("offline", { on: !!on });
    },
    sleep,
    /** 宿主是否已经发过真实用户输入(音频能否播放的前提) */
    gestureReady: () => !!window.__qaGesture,
    /** 宿主是否已经切断接口请求(模拟离线) */
    offlineReady: () => !!(window.__qaHost && window.__qaHost.requestsBlocked),
  };
  window.__D_READY = true;
})();
