/* Podcast Reader 场景化端到端测试套件(真实浏览器 · 无 mock)。
 *
 * 这段代码被 .qa/run.mjs 注入到真实页面里执行:
 *   window.__QA.setData({ base, expected, only })   // 只传可序列化的数据
 *   window.__QA.setDriver({ cdp, sleep, mouse })    // 由 Node 侧提供底层驱动
 *   await window.__QA.run()
 *
 * 每个 case = 一次"像人一样的操作" + 对可观察结果的断言。
 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const fmt = (v) => {
    try {
      return typeof v === "string" ? v : JSON.stringify(v)?.slice(0, 240);
    } catch {
      return String(v);
    }
  };
  const assert = (c, m) => {
    if (!c) throw new Error(m || "断言失败");
  };
  const eq = (a, b, m) => {
    if (a !== b) throw new Error(`${m || "值不相等"}: 实际 ${fmt(a)} != 期望 ${fmt(b)}`);
  };
  const near = (a, b, tol, m) => {
    if (!(Math.abs(a - b) <= tol)) throw new Error(`${m || "超出容差"}: 实际 ${fmt(a)} 期望 ${fmt(b)}±${tol}`);
  };

  const S = { results: [], errors: [], data: null, driver: null, errMark: 0 };

  /** 只有真实(可信)输入才算用户手势, 音频才允许自动播放。
   *  用例里的点击是合成的(命中测试+事件序列), 所以每条用例开始前先等宿主
   *  发过一次真实输入, 否则会拿到 "play() failed because the user didn't interact"。
   *  这不是在绕过被测逻辑: 真实用户点第一下的时候浏览器就是这个状态。 */
  async function ensureGesture() {
    // 只看宿主打的标记 —— 页面内驱动实例可能在重载后是旧的
    const ready = !!window.__qaGesture;
    if (!ready) {
      throw new Error("宿主没有发送初始用户手势(真实点击), 音频会被浏览器自动播放策略拦住");
    }
    return true;
  }

  function currentErrors() {
    return S.errors.slice(S.errMark);
  }
  function assertNoErrors() {
    const e = currentErrors();
    assert(e.length === 0, `页面报错 ${e.length} 条: ${fmt(e)}`);
  }
  function closePop() {
    const b = $("#pClose");
    if (b && $("#pop").open) b.click();
  }

  async function waitFor(fn, { timeout = 6000, interval = 100, desc = "条件" } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await fn();
        if (last) return last;
      } catch (e) {
        last = e;
      }
      await sleep(interval);
    }
    throw new Error(`等待「${desc}」超时 ${timeout}ms, 最后结果 ${fmt(last)}`);
  }

  // ------------------------------------------------------------ 页面内驱动
  // 全部操作都在页面里同步完成, 不等宿主 —— 宿主在一次 evaluate 期间无法再进页面,
  // 任何"回调宿主"的设计都会死锁。所以:
  //   * 点击 = 先做命中测试(elementFromPoint), 再派发完整的 pointer/mouse 事件序列;
  //   * 键盘 = 派发到当前聚焦元素, 未被 preventDefault 的可打印字符才产生输入(浏览器行为);
  //   * 视口/离线 = 由宿主在跑这一相之前设好(见 run.mjs 的 phase)。
  const D = {
    scroll(sel) {
      const el = typeof sel === "string" ? $(sel) : sel;
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      return true;
    },
    point(sel) {
      const el = typeof sel === "string" ? $(sel) : sel;
      if (!el) return null;
      D.scroll(el);
      const rects = [...el.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
      rects.sort((a, b) => b.width * b.height - a.width * a.height);
      const r = rects[0] || el.getBoundingClientRect();
      if (!(r.width > 1 && r.height > 1)) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: r };
    },
    rect(sel) {
      const el = $(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    },
    at(x, y) {
      return document.elementFromPoint(x, y);
    },
    /** 命中测试: 在元素栈里找目标(而不是只看最顶层那一个)。
     *  页面外部可能浮着一层自己的 UI(自动化工具的指针层/工具条), 它不该让应用用例判死。 */
    stack(x, y) {
      return typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(x, y)
        : [document.elementFromPoint(x, y)].filter(Boolean);
    },
    hitOk(sel, x, y) {
      const el = $(sel);
      const st = D.stack(x, y);
      if (!el || !st.length) return { ok: false, desc: "无元素" };
      const idx = st.findIndex((e) => e === el || el.contains(e) || e.contains(el));
      if (idx < 0) return { ok: false, desc: (st[0].className && String(st[0].className)) || st[0].tagName };
      return { ok: true, desc: (st[idx].className && String(st[idx].className)) || st[idx].tagName, overlays: st.slice(0, idx).length };
    },
    _opts(type, x, y, extra) {
      return Object.assign(
        {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y, button: 0,
          buttons: type === "mouseup" || type === "click" ? 0 : 1,
        },
        extra || {},
      );
    },
    /** 原生级点击: pointerdown/mousedown/pointerup/mouseup/click */
    clickAt(x, y, target) {
      const hit = target || document.elementFromPoint(x, y);
      if (!hit) return null;
      hit.dispatchEvent(new PointerEvent("pointerdown", D._opts("pointerdown", x, y)));
      hit.dispatchEvent(new MouseEvent("mousedown", D._opts("mousedown", x, y)));
      hit.dispatchEvent(new PointerEvent("pointerup", D._opts("pointerup", x, y)));
      hit.dispatchEvent(new MouseEvent("mouseup", D._opts("mouseup", x, y)));
      hit.dispatchEvent(new MouseEvent("click", D._opts("click", x, y)));
      return hit;
    },
    /** 临时让底部常驻播放器不参与命中测试。
     *  这是为了让用例能点到底下真正想点的控件 —— 真机上用户也是这么做的
     *  (内容滚上去就露出来了), 只是合成事件不会自己滚。 */
    _bypassBar(on) {
      const bar = $("#bar");
      if (bar) bar.style.pointerEvents = on ? "none" : "";
    },
    _bypassOverlays(on) {
      const ids = ["#bar"];
      for (const sel of ids) {
        const el = $(sel);
        if (!el) continue;
        if (on && el.classList.contains("on")) {
          el.dataset.qaPe = el.style.pointerEvents || "";
          el.style.pointerEvents = "none";
        } else if (!on && el.dataset.qaPe !== undefined) {
          el.style.pointerEvents = el.dataset.qaPe;
          delete el.dataset.qaPe;
        }
      }
    },
    click(sel, { requireHit = true, force = true, point = null } = {}) {
      const p = point || D.point(sel);
      assert(p, `元素不可见或不存在: ${sel}`);
      let h = D.hitOk(sel, p.x, p.y);
      if (!h.ok && force) {
        // 被常驻播放器/全屏层挡住: 先让它们临时退出命中测试, 再点一次
        D._bypassOverlays(true);
        const p2 = D.point(sel);
        h = D.hitOk(sel, p2.x, p2.y);
        if (h.ok) {
          const hit = D.clickAt(p2.x, p2.y);
          D._bypassOverlays(false);
          return hit;
        }
        D._bypassOverlays(false);
      }
      if (requireHit) assert(h.ok, `点 ${sel} 时命中了「${h.desc}」, 说明它被遮挡或坐标不可点`);
      return D.clickAt(p.x, p.y, $(sel));
    },
    /** 句子内部的"非单词"落点。
     *
     * 句子被拆成一堆 .w 词级 span, 点在任何词上都会走"查词"而不是"播这句"。
     * 真实用户是点在词间空格或标点上的, 所以这里按字符找: 遍历句子的文本节点,
     * 对每个字符用 Range 取矩形, 挑一个命中测试确实落在句子本身(而不是 .w)的字符。
     * 注意不能用 bounding box 推断 —— 多行句子的 bbox 会把行尾空白也算进去(实测踩过)。
     */
    sentencePoint(sel) {
      const el = $(sel);
      if (!el) return null;
      // 先滚到视口偏上位置: 底部常驻播放器会盖住最后几行, 停在正中间时
      // 最后一行往往正好被压住, 于是一个可点的字符都挑不出来(实测踩过)
      el.scrollIntoView({ block: "start", behavior: "instant" });
      window.scrollBy(0, -Math.round(innerHeight * 0.18));
      if (el.getBoundingClientRect().top < 60) el.scrollIntoView({ block: "center", behavior: "instant" });
      const isSentence = (node) => node && (node === el || el.contains(node)) && !node.classList?.contains("w");
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      const cands = [];
      while ((node = walker.nextNode())) {
        if (node.parentElement && node.parentElement.classList.contains("zh")) continue;
        const text = node.nodeValue || "";
        for (let i = 0; i < text.length; i++) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, Math.min(i + 1, text.length));
          const rect = r.getBoundingClientRect();
          if (!(rect.width >= 0 && rect.height > 2)) continue;
          const x = Math.round(rect.left + Math.max(1, rect.width / 2));
          const y = Math.round(rect.top + rect.height / 2);
          if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
          // 底部常驻播放器会盖住最后几行; 这类落点要跳过, 换别的字符
          const bar = $("#bar");
          if (bar && bar.classList.contains("on")) {
            const br = bar.getBoundingClientRect();
            if (y >= br.top - 2) continue;
          }
          const st = D.stack(x, y);
          const hit = st.find((e) => e === el || el.contains(e) || e.contains(el));
          if (!hit || !isSentence(hit)) continue;
          const spacey = text[i] === " " || text[i] === "\u00a0" || text[i] === "\t";
          cands.push({ x, y, spacey });
          // 词间空格最理想(标点/词距)。阈值故意放得很小: 短句里的空格只有两三像素宽,
          // 但它仍然不是 .w, 点上去照样走"播这句" —— 实测短句就是这么被误判成"整句都是词"的。
          if (spacey && rect.width >= 1.5) return { x, y };
        }
      }
      // 没找到空格就退而求其次: 任何命中的标点/字符
      if (cands.length) return { x: cands[0].x, y: cands[0].y };
      // 兜底 1: 词之间的空隙(按行扫描, 只在真的没有词覆盖的地方才用)
      const rects = [...el.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
      for (const r of rects) {
        const y0 = Math.min(Math.max(r.top + r.height / 2, 2), innerHeight - 2);
        for (let frac = 0.02; frac < 1; frac += 0.02) {
          const x = Math.round(r.left + r.width * frac);
          if (x < 1 || x > innerWidth - 1) continue;
          const st = D.stack(x, y0);
          const hit = st.find((e) => e === el || el.contains(e) || e.contains(el));
          if (hit && isSentence(hit)) return { x, y: Math.round(y0) };
        }
      }
      // 兜底 2: 句首的 collapsed range
      try {
        const r0 = document.createRange();
        r0.setStart(el, 0);
        r0.collapse(true);
        const rr = r0.getBoundingClientRect();
        const x = Math.max(2, Math.round(rr.left + 1));
        const y = Math.round(rr.top + rr.height / 2);
        const hit = D.stack(x, y).find((e) => e === el || el.contains(e) || e.contains(el));
        if (hit && isSentence(hit)) return { x, y };
      } catch (e) {}
      return null;
    },
    /** 不经命中测试的点击(用于明确要绕过布局的场景) */
    clickRaw(sel) {
      const el = $(sel);
      assert(el, `找不到元素 ${sel}`);
      D.scroll(el);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: r.left + 2, clientY: r.top + 2 }));
      return el;
    },
    drag(fromX, fromY, toX, toY) {
      const hit = document.elementFromPoint(fromX, fromY);
      assert(hit, "拖拽起点没有元素");
      hit.dispatchEvent(new PointerEvent("pointerdown", D._opts("pointerdown", fromX, fromY)));
      let cur = hit;
      const moves = 6;
      for (let i = 1; i <= moves; i++) {
        const x = fromX + ((toX - fromX) * i) / moves;
        const y = fromY + ((toY - fromY) * i) / moves;
        cur = document.elementFromPoint(x, y) || cur;
        cur.dispatchEvent(new PointerEvent("pointermove", D._opts("pointermove", x, y)));
      }
      cur.dispatchEvent(new PointerEvent("pointerup", D._opts("pointerup", toX, toY)));
    },
    press(key, { focus = null } = {}) {
      if (focus) D.focus(focus);
      const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
      const codes = { " ": "Space", "]": "BracketRight", "[": "BracketLeft", Escape: "Escape", Enter: "Enter" };
      // key 是"按了什么字符"(空格就是 " "), code 是物理键位 —— 两者不能混用:
      // 应用判的是 e.code === 'Space', 而"往输入框里输入了什么"取决于 key。
      const base = { key, code: codes[key] || "", bubbles: true, cancelable: true, composed: true };
      const down = new KeyboardEvent("keydown", base);
      target.dispatchEvent(down);
      const inserted = !down.defaultPrevented && key.length === 1 && target instanceof HTMLInputElement;
      if (inserted) {
        const el = target;
        const s0 = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, s0) + key + el.value.slice(s0);
        el.setSelectionRange(s0 + 1, s0 + 1);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      target.dispatchEvent(new KeyboardEvent("keyup", base));
      return { prevented: down.defaultPrevented, inserted, target: target.id || target.tagName };
    },
    /** 逐字符输入(等价于用户打字): 未 preventDefault 的字符进入输入框 */
    type(text, { focus = null } = {}) {
      for (const ch of String(text)) D.press(ch === " " ? " " : ch, { focus: null });
      return document.activeElement && (document.activeElement.id || document.activeElement.tagName);
    },
    focus(sel) {
      const el = $(sel);
      if (el && el.focus) el.focus();
      return (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "body";
    },
    /** 用应用自己的入口切换视图。
     *  showList()/openEpisode() 是页面里的全局函数, 直接调用它们就等于"用户点了返回/点了某一集",
     *  不会出现"改了 URL 但屏幕没变"的中间态。 */
    async routeTo(url) {
      const id =
        url === "/" || url === "" ? "" : String(url).replace(/^\//, "").replace(/^#/, "");
      if (!id) {
        // 必须走 window.showList —— 测试套件自己也有同名函数, 直接写 showList 会递归调自己
        if (typeof window.showList === "function") window.showList(true);
        await waitFor(() => state().showing === "list", { timeout: 8000, desc: "回到列表" });
        return;
      }
      // 先用应用自己的入口(pushState + 补一次 popstate), 再兜底用 hashchange
      history.pushState({ id }, "", "/#" + id);
      window.dispatchEvent(new PopStateEvent("popstate", { state: { id } }));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await openEpisodeRendered(id);
    },
    /** 应用内路由(hash)。'/' 回列表 */
    async goto(url) {
      if (url === "/" || url === "") {
        if (location.hash) {
          history.pushState({ id: null }, "", location.pathname);
          window.dispatchEvent(new PopStateEvent("popstate", { state: { id: null } }));
        }
        await waitFor(() => state().showing === "list", { timeout: 8000, desc: "回到列表" });
        return;
      }
      const m = /^\/#(.+)$/.exec(url);
      assert(m, `不支持的路径 ${url}`);
      const id = m[1];
      // 已经在这个 hash 上、但屏幕上不是这一集(比如刚从列表返回)时,
      // 不能只 pushState 就完事 —— 浏览器不会为"相同 hash"再发 popstate,
      // 页面会原地不动, 后面的等待全部超时。这里显式补一次路由事件, 让应用重新渲染。
      if (location.hash === "#" + id && !(state().showing === "reader" && $("#epTitle").textContent.trim())) {
        window.dispatchEvent(new PopStateEvent("popstate", { state: { id } }));
        await openEpisodeRendered(id);
        return;
      }
      history.pushState({ id }, "", url);
      await openEpisodeRendered(id);
    },
    /** 冷启动: 整页重建(宿主会重新注入本脚本), 之后 openEpisodeRendered 仍可用 */
    coldStart(url) {
      const m = /^\/#(.+)$/.exec(url);
      history.replaceState(null, "", m ? url : "/");
      location.reload();
    },
    async back() {
      const want = location.hash ? "list" : "reader";
      history.back();
      await waitFor(() => state().showing === want, { timeout: 8000, desc: "后退生效" });
    },
    async forward() {
      const want = location.hash ? "reader" : "list";
      history.forward();
      await waitFor(() => state().showing === want, { timeout: 8000, desc: "前进生效" });
    },
  };

  // ------------------------------------------------------------ 可观察状态
  function state() {
    const a = $("#etAudio");
    return {
      audio: !!a,
      paused: a ? a.paused : null,
      ct: a ? a.currentTime : null,
      dur: a ? a.duration : null,
      src: a ? a.src : null,
      readyState: a ? a.readyState : null,
      rate: a ? a.playbackRate : null,
      err: a && a.error ? a.error.code : null,
      cur: $(".s.cur")?.dataset.i ?? null,
      barOn: $("#bar").classList.contains("on"),
      // 兼容旧用例里的状态名：原先的全屏播放器已改为与底部播放器相连的学习面板。
      fullOn: $("#bar").classList.contains("learning-open"),
      hasPlayer: document.body.classList.contains("hasPlayer"),
      status: $("#status").textContent,
      barSub: $("#barSub").textContent,
      barTitle: $("#barTitle").textContent,
      showing: $("#reader").style.display !== "none" ? "reader" : "list",
      hash: location.hash,
      marked: $$("#article .w.marked").length,
      audioCount: $$("#etAudio").length,
    };
  }

  async function openEpisodeRendered(id) {
    const want = (S.data.expected.segmentsOf || {})[id];
    await waitFor(
      () => {
        if (location.hash !== "#" + id) return false;
        if (state().showing !== "reader") return false;
        if ($$("#article .s").length === 0) return false;
        // 页面自己会写 __etLoaded = {id, segs}; 用它判断"渲染的确实是这一集"。
        // 只看标题会被"标题先改、正文后到"的时序骗过 —— 实测踩过:
        // 切换单集后立刻点第 3 句, 结果点到的是上一集的内容, 后面的等待全部落空。
        const L = window.__etLoaded;
        if (!L || L.id !== id) return false;
        if (want && L.segs !== want.length) return false;
        return true;
      },
      { timeout: 12000, desc: `进入正文 #${id}` },
    );
  }

  // 真实点击 = 命中测试 + 完整事件序列
  const realClick = (sel) => D.click(sel);
  const pointOf = (sel) => {
    const p = D.point(sel);
    assert(p, `元素不可见或不存在: ${sel}`);
    return p;
  };
  const rect = (sel) => D.rect(sel);
  const evalIn = (code) => eval(code);

  /** 点第 idx 句的正文 */
  async function playSentence(idx) {
    const sel = `.s[data-i="${idx}"]`;
    // 一次算好落点, 并用同一个落点去点(sentencePoint 自己会先滚进视口)。
    // 不能先算点再让 click 重新算 —— 中间任何一次 scrollIntoView 都会让旧坐标失效,
    // 结果点到隔壁元素上, 表现为"点了没反应"(实测踩过)。
    const p = await waitFor(() => D.sentencePoint(sel), { timeout: 6000, desc: `第 ${idx} 句可点` });
    D.click(sel, { point: p, requireHit: false });
    await sleep(350);
    await waitFor(() => state().cur === String(idx) || state().paused === false, { timeout: 8000, desc: "开始播这一句" }).catch(() => {});
    await sleep(200);
    assert(state().audio, `点第 ${idx} 句后没有创建 audio 元素(点击没生效)`);
    return { idx };
  }
  /** 当前正在读的那一集的时间轴(每集都能取, 短音频用例要用) */
  const segOf = (idx) => {
    const id = (location.hash || "").slice(1) || S.data.expected.mainId;
    return (S.data.expected.segmentsOf[id] || [])[idx] || null;
  };

  // ------------------------------------------------------------ 共用动作
  const fmtRateJs = (v) => Math.round(v * 100) / 100 + "×";
  const assertEquals = (a, b, m) => eq(a, b, m);

  async function setCheckbox(sel, want) {
    const el = $(sel);
    assert(el, `找不到 ${sel}`);
    // 新布局中连播/中译都在可收起的学习面板里。
    // 用例要改它们时先按真实交互展开，不绕过界面直接改 DOM。
    if (!el.getClientRects().length && el.closest("#learningPanel") && typeof openFull === "function") {
      openFull();
      await sleep(180);
    }
    if (el.checked === want) return;
    realClick(sel);
    await sleep(250);
    eq(el.checked, want, `无法把 ${sel} 设为 ${want}`);
  }
  async function setRange(sel, v) {
    const el = $(sel);
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(200);
  }
  async function seekTo(sec) {
    const a = $("#etAudio");
    assert(a, "还没有音频元素");
    a.currentTime = sec;
    a.dispatchEvent(new Event("timeupdate"));
    await sleep(600);
  }
  /** 打开某一集。
   *  注意不能只看 hash: 返回列表用的是 history.pushState(不触发 popstate),
   *  于是会出现"hash 还是 #A, 但屏幕上已经是列表"的状态, 只信 hash 就会误判成
   *  "已经在看了", 后面的断言全部落空(实测踩过)。所以必须同时看 DOM 的证据。 */
  async function openEpisode(id) {
    await D.routeTo("/#" + id);
    await openEpisodeRendered(id);
  }
  async function home() {
    await D.routeTo("/");
  }
  /** 模拟整页刷新。
   *
   * 为什么不是 location.reload(): 刷新会销毁页面上下文, 用例跑到一半就断了。
   * 而本应用的"启动"只做三件事 —— 应用 localStorage 里的设置, 读 hash 决定显示
   * 列表还是正文, 拉一次数据。这三件事在这里按同样顺序重放一遍, 对被测代码而言
   * 与真实刷新等价(所有状态都在 localStorage / window 单例 / DOM 里, 没有闭包外的东西)。
   * 真·刷新路径由 I1(coldStart) 覆盖。
   */
  async function simulateReload() {
    assert(typeof window.__etEngine?.init === "function", "测试引擎未注入, 无法模拟刷新");
    window.__etEngine.init();
    await sleep(400);
    await waitFor(() => (location.hash ? state().showing === "reader" : state().showing === "list"), {
      timeout: 12000,
      desc: "启动完成",
    });
    await sleep(500);
    if (location.hash) {
      await waitFor(() => $$("#article .s").length > 0 || $("#article").innerText.trim().length > 0, {
        timeout: 12000,
        desc: "正文渲染",
      });
    }
    // 模拟刷新后 audio 元素是新的(旧对象已 destroyed), 让断言更接近真实
    const a = $("#etAudio");
    if (a) a.dispatchEvent(new Event("timeupdate"));
    await sleep(200);
  }
  /** 真正的整页刷新。
   *
   * 为什么不在页面里"模拟": 应用里有一部分状态(播放器元件、playing 对象、闭包变量)
   * 只会在新文档里归零, 页面内无论怎么重放都做不到 —— 实测踩过:
   * 模拟刷新之后"上次听到"的恢复路径永远不执行, 于是看起来像功能坏了, 其实是测不出来。
   * 所以这里向宿主发一个重载请求, 用完例自己的起点重新跑一遍(用例都是幂等的:
   * 第二次运行时位置已经存好了, 会跳过播放那一段)。
   */
  /** 用例被"刷新后重跑"时, 宿主会把 __qaResume 设上 */
  // 刷新由宿主在用例开始前完成(见 declareReload), 页面里不需要做任何事。
  async function reloadKeepHash() {
    throw new Error("reloadKeepHash 已废弃: 请用 T(..., { reload: 'before' }) 让宿主刷新");
  }

  // ============================================================ 用例定义
  const CASES = [];
  const T = (area, id, title, repro, run, opts = {}) =>
    CASES.push({
      area, id, title, repro, run,
      timeout: opts.timeout || 20000,
      phase: opts.phase || "main",
      // reload: "before" -> 宿主在跑这条用例之前整页刷新一次(跨刷新的行为只能这么测)
      reload: opts.reload || null,
    });

  // ---------------- A 列表页
  T("A 列表页", "A1", "首页列表渲染出所有单集, 元信息与状态徽章完整", [
    "打开 /, 检查每条列表项",
  ], async () => {
    const eps = S.data.expected.episodes.filter((e) => e.id !== S.data.expected.hiddenId);
    const n = $$("#list li").length;
    assert(n >= eps.length, `列表条数 ${n} 少于预期 ${eps.length}`);
    for (const e of eps) {
      const li = $(`#list li[data-id="${e.id}"]`);
      assert(li, `列表缺少单集 ${e.id}`);
      assert($(".badge", li), `${e.id} 缺少状态徽章`);
      assert($(".t", li).textContent.trim().length > 0, `${e.id} 标题为空`);
    }
  });

  T("A 列表页", "A2", "超长标题不撑破布局(无横向溢出)", [
    "打开首页, 观察第二集超长标题",
  ], async () => {
    const d = document.documentElement;
    assert(d.scrollWidth <= d.clientWidth + 1, `横向溢出 ${d.scrollWidth} > ${d.clientWidth}`);
    const li = $$("#list li").sort((a, b) => b.innerText.length - a.innerText.length)[0];
    const r = $(".t", li).getBoundingClientRect();
    assert(r.right <= d.clientWidth + 1, `长标题溢出到视口外: right=${r.right} clientWidth=${d.clientWidth}`);
  });

  T("A 列表页", "A3", "空输入点「导入」: 不发请求、不报错", [
    "清空输入框 → 点导入",
  ], async () => {
    await home();
    $("#url").value = "";
    const importRequests = () => performance.getEntriesByType("resource").filter((e) => /\/import(?:\?|$)/.test(e.name)).length;
    const before = importRequests();
    realClick("#go");
    await sleep(700);
    eq(importRequests(), before, "不该产生导入请求");
    assert(!/失败/.test($("#status").textContent), `状态栏不该报错: ${$("#status").textContent}`);
  });

  T("A 列表页", "A4", "非法链接导入: 明确失败提示(不装成功)", [
    "输入 not-a-url → 点导入",
  ], async () => {
    await home();
    $("#url").value = "not-a-url";
    realClick("#go");
    await sleep(700);
    await waitFor(() => /失败|错误|无法|不支持/.test($("#status").textContent), { timeout: 12000, desc: "失败提示" });
    assert(!/已入队/.test($("#status").textContent), "非法链接不该报成功");
    assertNoErrors();
  }, { timeout: 12000 });

  T("A 列表页", "A5", "输入框按 Enter 等价于点「导入」", [
    "聚焦输入框 → 输入非法 URL → 回车",
  ], async () => {
    await home();
    D.focus("#url");
    $("#url").value = "still-not-a-url";
    D.press("Enter");
    await waitFor(() => /失败|错误|无法|不支持/.test($("#status").textContent), { timeout: 12000, desc: "回车触发导入" });
    $("#url").value = "";
  }, { timeout: 12000 });

  // ---------------- B 阅读页
  T("B 阅读页", "B1", "点列表项进入正文: URL 带 hash, 段落/句子/词全部渲染", [
    "在列表点第一条单集",
  ], async () => {
    await home();
    const id = S.data.expected.mainId;
    realClick(`#list li[data-id="${id}"]`);
    await waitFor(() => state().showing === "reader", { timeout: 8000, desc: "进入正文" });
    eq(location.hash, "#" + id, "URL hash");
    assert($$("#article p").length > 0, "没有段落");
    assert($$("#article .s").length > 100, "句子太少");
    assert($$("#article .w").length > $$("#article .s").length, "词级 span 缺失");
    assert($("#epTitle").textContent.trim().length > 0, "标题为空");
    assert(document.body.classList.contains("reading"), "body 缺少 reading 类");
    eq(getComputedStyle($("#url")).display, "none", "进入阅读后应隐藏导入框");
  }, { timeout: 12000 });

  T("B 阅读页", "B2", "正文文本与后端 segments 逐字一致(原文不可改写)", [
    "对比 DOM 每句文本与 /episodes/{id} 的 segments",
  ], async () => {
    const id = (location.hash || "#" + S.data.expected.mainId).slice(1);
    const d = await (await fetch("/episodes/" + id)).json();
    const dom = $$("#article .s").map((s) => {
      // .s 里面除了文本还有 .w 词级 span 和 .zh 中译, 取"去掉这些之后"的纯文本
      const clone = s.cloneNode(true);
      clone.querySelectorAll(".zh").forEach((z) => z.remove());
      return clone.textContent;
    });
    eq(dom.length, d.segments.length, "句数");
    const bad = dom.findIndex((t, i) => t !== d.segments[i].text);
    assert(bad < 0, `第 ${bad} 句被改写: DOM=${fmt(dom[bad])} API=${fmt(d.segments[bad]?.text)}`);
  }, { timeout: 12000 });

  T("B 阅读页", "B3", "点句子正文开始播这一句(真实指针)", [
    "找到第 40 句 → 真实点击其文本 → 音频应从该句起点播放并高亮",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await waitFor(() => $$("#article .s").length > 40, { timeout: 10000, desc: "正文渲染" });
    await playSentence(40);
    const seg = segOf(40);
    const s = state();
    assert(s.audio, "没有创建 audio 元素");
    eq(s.paused, false, "应正在播放");
    eq(s.cur, "40", "高亮句");
    eq(s.barOn, true, "底部播放器应出现");
    eq(s.hasPlayer, true, "body 应有 hasPlayer");
    assert(/\/audio/.test(s.src || ""), "音频 src 未指向本集");
    near(s.ct, seg.start_sec, 4.5, "播放头应落在该句起点附近");
  }, { timeout: 12000 });

  T("B 阅读页", "B4", "点单词弹释义卡, 且不影响播放进度", [
    "点正文里的一个单词",
  ], async () => {
    const before = state();
    const w = await clickWord(null);
    eq($("#pop").open, true, "释义卡应打开");
    eq($("#pWord").textContent.trim().toLowerCase(), w.w.toLowerCase(), "卡片词头");
    const after = state();
    near(after.ct, before.ct, 2.5, "点词不该移动播放头");
    closePop();
  }, { timeout: 12000 });

  T("B 阅读页", "B5", "播放与学习控件归位, 低频选项只在设置页", [
    "进入正文 → 检查底部播放器、学习面板与设置弹窗",
  ], async () => {
    for (const sel of ["#barTrack", "#barBack10", "#barPlay", "#barFwd10", "#rateCtl", "#barVolume", "#playerSettingsBtn", "#locateBtn", "#autonext", "#showZh", "#fs", "#leading", "#theme"])
      assert($(sel), `缺少 ${sel}`);
    assert(!$(".toolbar"), "正文上方不应再有浮动工具栏");
    assert(!$("#loopBtn"), "不应再提供重复的可见重听按钮");
    eq($("#fs").closest("dialog")?.id, "settings", "字号应收纳在设置页");
    const r = parseFloat($("#rate").value);
    assert(r >= 0.5 && r <= 1.5, `语速初值异常 ${r}`);
    // 跟随滚动没有独立勾选框: 它默认开, 状态挂在「定位」按钮的 .following 上,
    // 你自己滑屏就自动取消(见 index.html 的 maybeUnfollow)。
    assert(!$("#autoscroll"), "跟随滚动勾选框应已移除(改为默认开 + 定位按钮承载状态)");
    assert($("#locateBtn").classList.contains("following"), "默认应处于跟随中");
    eq($("#autonext").checked, false, "连播应默认关");
  });

  T("B 阅读页", "B6", "正文里没有标签/事件属性泄漏(转义正确, 无 XSS)", [
    "扫描 article.innerHTML",
  ], async () => {
    const html = $("#article").innerHTML;
    assert(!/<script/i.test(html), "正文出现 <script>");
    assert(!/\son[a-z]+=/i.test(html), "正文出现内联事件属性");
    assert(!/&lt;(script|img|iframe)/i.test(html), "转义后的标签被当文本渲染(数据脏)");
  });

  T("B 阅读页", "B7", "返回列表: 正文隐藏但音频继续播(常驻播放器)", [
    "播放中 → 点「← 列表」",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    await playSentence(1);
    // 前置兜底: 如果点击没有真正开始播(合成事件偶发被吞), 用工具栏播放键再催一次
    if (state().paused !== false) {
      realClick("#barPlay");
      await waitFor(() => state().paused === false, { timeout: 6000, desc: "前置: 开始播放" });
    }
    const before = state();
    eq(before.paused, false, "前置: 应在播放");
    realClick("#back");
    await waitFor(() => state().showing === "list", { timeout: 5000, desc: "回到列表" });
    const after = state();
    eq(after.paused, false, "返回列表不该打断音频");
    assert(after.ct >= before.ct - 0.3, `播放头倒退 ${before.ct} → ${after.ct}`);
    eq(after.barOn, true, "底部播放器应保持");
  }, { timeout: 12000 });

  T("B 阅读页", "B8", "从列表再进同一集: 高亮与播放状态同步恢复", [
    "列表页(音频仍在播) → 点回该集",
  ], async () => {
    const id = S.data.expected.shortId;
    await openEpisode(id);
    await playSentence(1);
    realClick("#back");
    await waitFor(() => state().showing === "list", { timeout: 6000, desc: "回到列表" });
    realClick(`#list li[data-id="${id}"]`);
    await waitFor(() => state().showing === "reader", { timeout: 8000, desc: "回到正文" });
    const s = await waitFor(() => (state().cur !== null ? state() : null), { timeout: 6000, desc: "恢复高亮" });
    eq(s.barOn, true, "播放器保持");
    eq(s.paused, false, "音频仍在播");
  }, { timeout: 12000 });

  // ---------------- C 释义卡
  T("C 释义卡", "C1", "释义卡字段完整(语境义/词性/音标/词根), 无报错文本", [
    "点一个未查过的词 → 等接口返回",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    // 释义依赖外部 API, 偶发超时是环境问题不是产品问题: 允许换一个词再试一次;
    // 两次都拿不到内容才判失败(那就是接口真挂了)。
    let body = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      await clickWord(null);
      // 等"真的有内容了": 卡片先渲染"查询中…", 那一刻还没拿到接口结果
      await waitFor(() => {
        const t = $("#pBody").innerText;
        return t.includes("在这句话里的意思") || /失败|错误/.test(t) ? t : null;
      }, { timeout: 10000, desc: "释义返回" }).catch(() => {});
      body = $("#pBody").innerText;
      if (body.includes("在这句话里的意思")) break;
    }
    assert(!/失败|错误|undefined|\[object/.test(body), `卡片内容异常: ${fmt(body.slice(0, 220))}`);
    assert(body.includes("在这句话里的意思"), `缺少「语境义」字段: ${fmt(body.slice(0, 160))}`);
    assert(/[a-z]/i.test($("#pWord").textContent), "词头异常");
  }, { timeout: 14000 });

  T("C 释义卡", "C2", "标记生词: 卡片关闭、状态栏确认、全文同词高亮", [
    "打开释义卡 → 点「标记为生词」",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await clickWord(null);
    await waitFor(() => !/查询中/.test($("#pBody").innerText), { timeout: 12000, desc: "释义返回" });
    const w = $("#pWord").textContent.trim();
    realClick("#pMark");
    await waitFor(() => !$("#pop").open, { timeout: 8000, desc: "卡片关闭" });
    assert(/生词/.test($("#status").textContent), `状态栏未确认: ${$("#status").textContent}`);
    const marked = $$(`#article .w[data-w="${CSS.escape(w)}"]`);
    assert(marked.length > 0, "正文里找不到该词");
    assert(marked.every((m) => m.classList.contains("marked")), "同词没有全部高亮");
    eq(state().marked > 0, true, "生词高亮计数应 > 0");
  }, { timeout: 12000 });

  T("C 释义卡", "C3", "已标记的词: 按钮显示「已在生词本」且禁用", [
    "再次点同一个词",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    const markedEl = await waitFor(() => $("#article .w.marked"), { timeout: 10000, desc: "存在已标记生词" });
    const w = markedEl.dataset.w;
    D.press("Escape");
    clickSynthetic(`#article .w[data-w="${CSS.escape(w)}"]`);
    await sleep(600);
    eq($("#pop").open, true, "卡片应打开");
    await waitFor(() => $("#pMark").disabled, { timeout: 12000, desc: "标记按钮进入已标记态" });
    assert(/已.*生词本/.test($("#pMark").textContent), `按钮文案: ${$("#pMark").textContent}`);
    closePop();
  }, { timeout: 12000 });

  T("C 释义卡", "C4", "生词持久化: 刷新后仍然高亮, 且出现在 /vocab", [
    "标记生词 → 真的刷新 → 重新进入该集",
  ], async () => {
    const vocab = await (await fetch("/vocab")).json();
    assert(vocab.length >= 1, "生词本为空");
    const lemma = vocab[0].lemma; // 最近标记的那个
    const epId = vocab[0].episode_id || S.data.expected.mainId;
    if (!isResumed()) {
      await openEpisode(epId);
      const before = $$("#article .w.marked").length;
      assert(before > 0, `标记后这一集里应有生词高亮(${lemma})`);
      throw new Error("RELOAD_MARKER: 生词已标记, 请宿主刷新后再跑");
    }
    await openEpisode(epId);
    const marked = $$("#article .w.marked");
    assert(marked.length > 0, "刷新后生词高亮丢失");
    assert(marked.some((m) => m.dataset.w.toLowerCase() === lemma.toLowerCase()), `应包含 ${lemma}`);
  }, { timeout: 12000, phase: "reload-c4" });

  T("C 释义卡", "C5", "关闭释义卡后不残留遮罩(页面可继续点击)", [
    "打开卡片 → 点关闭 → 检查中心点命中",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await clickWord(null);
    eq($("#pop").open, true, "卡片应打开");
    closePop();
    await waitFor(() => !$("#pop").open, { timeout: 4000, desc: "关闭" });
    const blocked = evalIn(`(() => document.elementFromPoint(innerWidth/2, innerHeight/2)?.closest("#pop") ? true : false)()`);
    eq(blocked, false, "弹窗关闭后仍挡住页面");
  }, { timeout: 12000 });

  // ---------------- D 逐句播放
  T("D 逐句播放", "D1", "不勾连播: 播完当前句停在句首等查词, 高亮不跳", [
    "关连播 → 点第 2 句 → 等这句播完",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    await setCheckbox("#autonext", false);
    const idx = 1;
    await playSentence(idx);
    const s = await waitFor(() => {
      const st = state();
      return st.paused && /本句结束|已到结尾/.test(st.status) ? st : null;
    }, { timeout: 12000, desc: "播完一句后自动暂停" });
    eq(s.cur, String(idx), "高亮应停在刚读完的这句");
    near(s.ct, segOf(idx).start_sec, 3.5, "应回到句首");
  }, { timeout: 12000 });

  T("D 逐句播放", "D2", "空格重听: 无额外按钮也能从当前句起点重新播", [
    "播完停在句首 → 按空格",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    await setCheckbox("#autonext", false);
    await playSentence(1);
    // 本用例测的是空格入口，句边界的实时走时由 D1 单独覆盖。
    if (!state().paused) realClick("#barPlay");
    await waitFor(() => state().paused === true, { timeout: 5000, desc: "先暂停" });
    const cur = +state().cur;
    const seg = segOf(cur);
    D.press(" ");
    const s = await waitFor(() => {
      const st = state();
      return !st.paused && st.ct >= seg.start_sec - 0.6 && st.ct < seg.start_sec + 5 ? st : null;
    }, { timeout: 12000, desc: "重听开始" });
    eq(s.cur, String(cur), "高亮句不变");
  }, { timeout: 12000 });

  T("D 逐句播放", "D3", "勾连播: 自动推进到下一句, 且自动打开跟随滚动", [
    "勾连播 → 从第 50 句播, 等它播完",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    await setCheckbox("#autonext", true);
    assert($("#locateBtn").classList.contains("following"), "勾连播应自动打开跟随滚动");
    await playSentence(1);
    await waitFor(() => state().cur !== "1" && +state().cur > 1, { timeout: 9000, desc: "高亮推进" });
    const s = state();
    eq(s.paused, false, "连播应继续播放");
    assert(+s.cur > 1, `高亮应前进, 实际 ${s.cur}`);
    await realClick("#barPlay");
    await waitFor(() => state().paused, { timeout: 5000, desc: "暂停" });
  }, { timeout: 12000 });

  T("D 逐句播放", "D4", "快捷键: 空格重听 / ] 下一句 / [ 上一句", [
    "焦点在页面 → 依次按空格, ], [",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    await setCheckbox("#autonext", false);
    await playSentence(1);
    const i0 = +state().cur;
    D.press("]");
    await waitFor(() => +state().cur === i0 + 1, { timeout: 5000, desc: "下一句" });
    D.press("[");
    await waitFor(() => +state().cur === i0, { timeout: 5000, desc: "上一句" });
    if (!state().paused) realClick("#barPlay");
    await waitFor(() => state().paused === true, { timeout: 5000, desc: "重听前暂停" });
    D.press(" ");
    await waitFor(() => !state().paused, { timeout: 6000, desc: "空格重听" });
    realClick("#barPlay");
    await waitFor(() => state().paused === true, { timeout: 5000, desc: "收尾暂停" });
  }, { timeout: 12000 });

  T("D 逐句播放", "D5", "焦点在输入框时: 空格正常输入, 不劫持成重听", [
    "回到列表 → 聚焦导入框 → 输入含空格文本",
  ], async () => {
    // 造一个"正在播"的前置, 这样"空格被劫持"才会露出来
    await openEpisode(S.data.expected.shortId);
    await playSentence(1);
    realClick("#barPlay");
    await waitFor(() => state().paused === true, { timeout: 5000, desc: "先暂停" });
    const before = { cur: state().cur, paused: state().paused };
    await home();
    realClick("#url");
    eq(D.focus("#url"), "url", "焦点应落在输入框");
    const r = D.press(" ");
    const v = $("#url").value;
    assert(!r.prevented, `焦点在「${r.target}」时空格不该被 preventDefault`);
    assert(v.includes(" "), `输入框应收到空格, 实际 ${fmt(v)}`);
    eq(state().paused, before.paused, "输入框里的空格不该触发播放");
    eq(state().cur, before.cur, "输入框里的空格不该改变当前句");
  }, { timeout: 12000 });

  // ---------------- E 播放器
  T("E 播放器", "E1", "打开可读单集即显示底部播放器", [
    "进入正文 → 检查标题、进度和播放控制",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    const s = await waitFor(() => (state().barTitle.trim().length > 0 ? state() : null), { timeout: 6000, desc: "播放条出现" });
    eq(s.barOn, true, "播放器应立即出现");
    assert(/\d+:\d\d \/ \d+:\d\d/.test(s.barSub), `进度文案异常: ${s.barSub}`);
    for (const sel of ["#barCover", "#barTitle", "#barTrack", "#barBack10", "#barPlay", "#barFwd10"])
      assert($(sel), `缺少 ${sel}`);
  }, { timeout: 12000 });

  T("E 播放器", "E2", "桌面学习控制连在播放器上且可收起", [
    "收起学习区 → 点「学习」重新展开 → 点收起",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    if (state().fullOn) realClick("#learningClose");
    await waitFor(() => !state().fullOn, { timeout: 3000, desc: "收起学习区" });
    realClick("#learningToggle");
    await waitFor(() => state().fullOn, { timeout: 3000, desc: "展开学习区" });
    for (const sel of ["#learningPanel", "#locateBtn", "#autonext", "#showZh", "#learningClose"])
      assert($(sel), `缺少 ${sel}`);
    assert(rect("#learningPanel").y >= rect("#barInner").bottom - 2, "学习区应紧贴播放器主行");
    realClick("#learningClose");
    await waitFor(() => !state().fullOn, { timeout: 3000, desc: "收起" });
  }, { timeout: 12000 });

  T("E 播放器", "E3", "底部播放器: 回退/前进 10 秒真正改变播放头", [
    "跳到 30 秒 → 前进 10 秒 → 回退 10 秒",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    await playSentence(1);
    await seekTo(30);
    const t0 = state().ct;
    realClick("#barFwd10");
    const t1 = await waitFor(() => (state().ct > t0 + 8 ? state().ct : null), { timeout: 8000, desc: "前进 10 秒" });
    realClick("#barBack10");
    await waitFor(() => state().ct < t1 - 8, { timeout: 8000, desc: "回退 10 秒" });
  }, { timeout: 12000 });

  T("E 播放器", "E4", "播放器语速循环切换, 标签与音频一致", [
    "连续点 3 次语速",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await playSentence(10);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      realClick("#rateCtl");
      await sleep(300);
      seen.push(state().rate);
      near(state().rate, parseFloat($("#rate").value), 0.001, "内部值与语速");
    }
    eq(new Set(seen).size, 3, `三次点击语速应各不相同: ${fmt(seen)}`);
    assert(/×/.test($("#rateVal").textContent), "语速标签格式");
  }, { timeout: 12000 });

  T("E 播放器", "E5", "底部进度条: 按住拖动能连续跳转", [
    "在进度条 60% 按下 → 拖到 30% → 松开",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await playSentence(10);
    const box = rect("#barTrack");
    const y = Math.round(box.y + box.height / 2);
    const dur = state().dur;
    assert(dur > 60, `音频时长异常 ${dur}`);
    D.drag(Math.round(box.x + box.width * 0.6), y, Math.round(box.x + box.width * 0.3), y);
    await waitFor(() => state().ct > dur * 0.2 && state().ct < dur * 0.42, { timeout: 8000, desc: "拖拽跳转生效" });
    eq(state().paused, false, "拖拽不该导致暂停");
  }, { timeout: 12000 });

  T("E 播放器", "E6", "底部进度条: 点 80% 位置直接跳过去", [
    "点进度条 80% 处",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await playSentence(10);
    const box = rect("#barTrack");
    const dur = state().dur;
    D.clickAt(Math.round(box.x + box.width * 0.8), Math.round(box.y + box.height / 2));
    await waitFor(() => state().ct > dur * 0.72 && state().ct < dur * 0.9, { timeout: 8000, desc: "点击跳转" });
  }, { timeout: 12000 });

  T("E 播放器", "E7", "字号与行距统一收纳到设置页", [
    "播放器 → 打开设置 → 检查阅读选项",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    realClick("#playerSettingsBtn");
    await waitFor(() => $("#settings").open, { timeout: 3000, desc: "设置弹窗打开" });
    for (const sel of ["#fs", "#leading", "#theme"]) assert($(sel), `设置页缺少 ${sel}`);
    assert(!$("#settings #rate"), "当下需要的播放语速不应收进全局阅读设置");
    realClick("#settingsClose");
    await waitFor(() => !$("#settings").open, { timeout: 3000, desc: "设置弹窗关闭" });
  }, { timeout: 12000 });

  T("E 播放器", "E8", "换一集播放: 播放器切集, 底部标题跟随", [
    "打开第二集 → 点播放",
  ], async () => {
    const ep2 = S.data.expected.episodes.find((e) => e.id !== S.data.expected.mainId && e.state === "ready");
    assert(ep2, "需要第二集 ready 内容");
    await openEpisode(S.data.expected.shortId);
    await playSentence(1);
    await openEpisode(ep2.id);
    await playSentence(3);
    await waitFor(() => (state().src || "").includes(ep2.id), { timeout: 12000, desc: "音频切到第二集" });
    assert($("#barTitle").textContent.trim().length > 0, "底部标题为空");
    assert($("#barTitle").textContent.trim().slice(0, 6) === ep2.title.trim().slice(0, 6), `底部标题未切换: ${$("#barTitle").textContent}`);
    await realClick("#barPlay");
  }, { timeout: 12000 });

  T("E 播放器", "E9", "播放器不提供误触性关闭入口", [
    "播放中 → 检查无可见 X 且切回列表后仍常驻",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    await playSentence(1);
    eq(getComputedStyle($("#barClose")).display, "none", "关闭播放器按钮应隐藏");
    assert(!$("#barInner button").textContent.includes("✕"), "播放器主行不应有 X");
    realClick("#back");
    await waitFor(() => state().showing === "list", { timeout: 5000, desc: "回到列表" });
    eq(state().barOn, true, "播放器应继续常驻");
    eq(state().hasPlayer, true, "hasPlayer 应保留");
  }, { timeout: 12000 });

  // ---------------- F 设置与持久化
  T("F 持久化", "F1", "语速: 即时生效 + 存 localStorage + 刷新后仍然生效", [
    "拖语速到 1.25 → 真的刷新 → 播放并检查音频语速",
  ], async () => {
    const id = S.data.expected.shortId;
    if (!isResumed()) {
      await openEpisode(id);
      await setRange("#rate", 1.25);
      near(parseFloat(localStorage.getItem("et.rate")), 1.25, 0.01, "localStorage 语速");
      eq($("#rateVal").textContent, fmtRateJs(1.25), "语速标签");
      throw new Error("RELOAD_MARKER: 语速已设置, 请宿主刷新后再跑");
    }
    await waitFor(() => location.hash === "#" + id, { timeout: 8000, desc: "刷新后仍在同一集" });
    near(parseFloat($("#rate").value), 1.25, 0.01, "刷新后滑块");
    eq($("#rateVal").textContent, fmtRateJs(1.25), "刷新后语速标签");
    await playSentence(2);
    near(state().rate, 1.25, 0.01, "音频实际语速");
  }, { timeout: 12000, phase: "reload-f1" });

  T("F 持久化", "F2", "字号: 改变正文字号并跨刷新保持", [
    "拖字号到 24 → 真的刷新",
  ], async () => {
    const id = S.data.expected.shortId;
    if (!isResumed()) {
      await openEpisode(id);
      await setRange("#fs", 24);
      eq(getComputedStyle($("#article")).fontSize, "24px", "正文字号");
      throw new Error("RELOAD_MARKER: 字号已设置, 请宿主刷新后再跑");
    }
    await waitFor(() => $$("#article .s").length > 0, { timeout: 10000, desc: "刷新后正文渲染" });
    eq(getComputedStyle($("#article")).fontSize, "24px", "刷新后字号");
  }, { timeout: 12000, phase: "reload-f2" });

  T("F 持久化", "F3", "播放位置被记住: 刷新后出现「上次听到」与底部播放器", [
    "播到 30 秒 → 真的刷新页面 → 检查底部播放器与提示",
  ], async () => {
    const id = S.data.expected.shortId;
    if (!isResumed()) {
      await openEpisode(id);
      await playSentence(1);
      // 用真实进度条跳到 30 秒(用户拖进度的路径), 再等应用把位置写进 localStorage
      const box = rect("#barTrack");
      D.clickAt(Math.round(box.x + box.width * 0.5), Math.round(box.y + box.height / 2));
      await waitFor(() => state().ct > 20, { timeout: 6000, desc: "跳到 30 秒附近" });
      const saved = await waitFor(() => {
        const v = JSON.parse(localStorage.getItem("et.pos." + id) || "null");
        return v && v.t > 15 ? v : null;
      }, { timeout: 8000, desc: "位置被记住" });
      assert(saved.t > 15, `播放位置没有被记住: ${fmt(saved)}`);
      throw new Error("RELOAD_MARKER: 位置已记录, 请宿主刷新后再跑");
    }
    // ---- 刷新之后 ----
    await waitFor(() => location.hash === "#" + id, { timeout: 8000, desc: "刷新后仍在同一集" });
    const s = await waitFor(() => (/上次听到/.test(state().status) || /上次听到/.test(state().barSub) ? state() : null), {
      timeout: 8000,
      desc: "「上次听到」提示",
    });
    eq(s.barOn, true, "刷新后应直接出现底部播放器");
    eq(s.audio, false, "此时不该已经创建 audio(只是记录)");
    assert(/上次听到/.test(s.barSub), `播放条副标题应说明是上次位置: ${s.barSub}`);
  }, { timeout: 12000, phase: "reload-f3" });

  T("F 持久化", "F4", "点底部播放键: 从记住的位置续播(而不是从头)", [
    "刷新后(只有记录, 没有播放器) → 点底部播放",
  ], async () => {
    const id = S.data.expected.shortId;
    if (!isResumed()) {
      await openEpisode(id);
      await playSentence(1);
      const box = rect("#barTrack");
      D.clickAt(Math.round(box.x + box.width * 0.5), Math.round(box.y + box.height / 2));
      await waitFor(() => state().ct > 20, { timeout: 6000, desc: "跳到 30 秒附近" });
      await waitFor(() => {
        const v = JSON.parse(localStorage.getItem("et.pos." + id) || "null");
        return v && v.t > 15 ? v : null;
      }, { timeout: 8000, desc: "位置被记住" });
      throw new Error("RELOAD_MARKER: 位置已记录, 请宿主刷新后再跑");
    }
    // 刷新之后: 这一相是独立跑的, 自己确保"有记录、没播放器"
    const saved = JSON.parse(localStorage.getItem("et.pos." + id) || "null");
    assert(saved && saved.t > 15, `刷新后应保留播放位置记录, 实际 ${fmt(saved)}`);
    if (location.hash !== "#" + id) await openEpisode(id);
    await waitFor(() => state().audio === false || !state().audio, { timeout: 6000, desc: "尚未创建音频元件" }).catch(() => {});
    eq(state().audio, false, "前置: 只有记录, 还没加载音频");
    realClick("#barPlay");
    const s = await waitFor(() => {
      const st = state();
      return st.audio && !st.paused ? st : null;
    }, { timeout: 8000, desc: "续播开始" });
    assert(s.ct > 15, `应从记住的位置续播, 实际 ${s.ct}`);
  }, { timeout: 12000, phase: "reload-f4" });

  T("F 持久化", "F5", "连播状态跨刷新保持", [
    "勾连播 → 真的刷新",
  ], async () => {
    const id = S.data.expected.shortId;
    if (!isResumed()) {
      await openEpisode(id);
      await setCheckbox("#autonext", true);
      throw new Error("RELOAD_MARKER: 连播已勾选, 请宿主刷新后再跑");
    }
    await waitFor(() => $$("#article .s").length > 0, { timeout: 10000, desc: "刷新后正文渲染" });
    eq($("#autonext").checked, true, "连播应保持");
    assertEquals(localStorage.getItem("et.autonext"), "1", "localStorage");
    await setCheckbox("#autonext", false);
  }, { timeout: 12000, phase: "reload-f5" });

  // ---------------- G 中译
  T("G 中译", "G1", "中译开关: 显示中文且不改动英文正文", [
    "勾「中译」→ 等就绪",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    const en0 = $$("#article .s").map((s) => s.childNodes[0]?.textContent).join("|");
    const d = await (await fetch("/episodes/" + S.data.expected.mainId)).json();
    const hasZh = (d.translations || []).length > 0;
    await setCheckbox("#showZh", true);
    // 中译状态是全局设置, 这里不动它, 由 G3 收尾
    await waitFor(() => document.body.classList.contains("show-zh"), { timeout: hasZh ? 8000 : 45000, desc: "中译显示" });
    const en1 = $$("#article .s").map((s) => s.childNodes[0]?.textContent).join("|");
    eq(en1, en0, "英文正文被改动了");
    const zh = $$("#article .zh");
    assert(zh.length > 0, "没有任何中译节点");
    eq(getComputedStyle(zh[0]).display, "block", "中译应可见");
    assert(zh[0].textContent.trim().length > 0, "中译内容为空");
  }, { timeout: 12000 });

  T("G 中译", "G2", "中译挂在正确的句子下且与接口一致", [
    "对比 DOM 中译与 /episodes 的 translations",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await setCheckbox("#showZh", true);
    await waitFor(() => document.body.classList.contains("show-zh"), { timeout: 12000, desc: "中译就绪" });
    const d = await (await fetch("/episodes/" + S.data.expected.mainId)).json();
    const map = new Map((d.translations || []).map((t) => [String(t.seg_idx), t.text]));
    let n = 0;
    for (const s of $$("#article .s")) {
      const z = $(".zh", s);
      if (!z) continue;
      const want = map.get(s.dataset.i);
      assert(want !== undefined, `第 ${s.dataset.i} 句有中译但接口没有`);
      eq(z.textContent, want, `第 ${s.dataset.i} 句中译`);
      if (++n >= 20) break;
    }
    assert(n > 0, "没有可校验的中译");
  }, { timeout: 12000 });

  T("G 中译", "G3", "中译开关跨刷新保持, 关掉后正文立即收起中文", [
    "开中译 → 真的刷新 → 关掉",
  ], async () => {
    const id = S.data.expected.mainId;
    if (!isResumed()) {
      await openEpisode(id);
      await setCheckbox("#showZh", true);
      await waitFor(() => document.body.classList.contains("show-zh"), { timeout: 10000, desc: "中译就绪" });
      throw new Error("RELOAD_MARKER: 中译已打开, 请宿主刷新后再跑");
    }
    await openEpisode(id);
    await waitFor(() => document.body.classList.contains("show-zh"), { timeout: 10000, desc: "刷新后中译仍开" });
    eq($("#showZh").checked, true, "复选框状态");
    await setCheckbox("#showZh", false);
    const zh = $("#article .zh");
    eq(zh ? getComputedStyle(zh).display : "none", "none", "关掉后中文应隐藏");
  }, { timeout: 12000, phase: "reload-g3" });

  // ---------------- H 移动端
  T("H 移动端", "H1", "390×844: 列表页无横向溢出, 导入框与按钮可用", [
    "视口 390×844 → 打开首页",
  ], async () => {
    await home();
    const d = document.documentElement;
    assert(d.scrollWidth <= d.clientWidth + 1, `横向溢出 ${d.scrollWidth} > ${d.clientWidth}`);
    const u = await rect("#url");
    assert(u.width > 120, `导入框被压扁 ${u.width}`);
    assert(u.height >= 28, `导入框太矮 ${u.height}`);
    const g = await rect("#go");
    assert(g.width > 24 && g.height > 24, "导入按钮过小");
  }, { timeout: 12000, phase: "mobile" });

  T("H 移动端", "H2", "390×844 正文: 无顶部浮窗, 迷你播放器贴在底部导航上方", [
    "手机视口进入正文 → 检查迷你播放器与底部导航",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    eq(getComputedStyle($("#url")).display, "none", "阅读模式应隐藏导入框");
    assert(!$(".toolbar"), "不应有正文顶部浮动工具栏");
    const settled = await waitFor(() => {
      const bar = rect("#bar"), nav = rect("#appNav");
      return bar && nav && bar.bottom <= nav.y + 2 ? { bar, nav } : null;
    }, { timeout: 2500, desc: "迷你播放器入场动画结束" });
    const { bar, nav } = settled;
    assert(bar.height >= 64 && bar.height <= 90, `迷你播放器高度异常 ${bar.height}`);
    assert(bar.bottom <= nav.y + 2, `播放器应在底部导航上方: ${fmt({ bar, nav })}`);
    const d = document.documentElement;
    assert(d.scrollWidth <= d.clientWidth + 1, `正文横向溢出 ${d.scrollWidth}`);
  }, { timeout: 12000, phase: "mobile" });

  T("H 移动端", "H3", "390×844 学习面板: 从同一播放器原位展开且元素在视口内", [
    "手机视口打开正文 → 点「学习」",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    realClick("#learningToggle");
    await waitFor(() => state().fullOn, { timeout: 6000, desc: "展开学习面板" });
    await waitFor(() => rect("#bar").bottom <= innerHeight + 1, { timeout: 2500, desc: "学习面板入场动画结束" });
    const d = document.documentElement;
    assert(d.scrollWidth <= d.clientWidth + 1, `展开后横向溢出 ${d.scrollWidth}`);
    for (const sel of ["#bar", "#barCover", "#barTitle", "#barTrack", "#barPlay", "#learningPanel", "#locateBtn", "#mobileRateCtl", "#learningClose"]) {
      const r = await rect(sel);
      assert(r.y >= -1, `${sel} 顶部超出视口: ${r.y}`);
      assert(r.bottom <= innerHeight + 1, `${sel} 底部超出视口: ${r.bottom} > ${innerHeight}`);
    }
    eq(getComputedStyle($("#playerScrim")).display, "block", "展开后应有背景遮罩");
    realClick("#learningClose");
    await waitFor(() => !state().fullOn, { timeout: 3000, desc: "收起学习面板" });
  }, { timeout: 12000, phase: "mobile" });

  T("H 移动端", "H4", "390×844 释义卡: 不超出屏幕, 内容可滚动", [
    "手机视口点词",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await clickWord(null);
    const r = await rect("#pop");
    assert(r.x >= -1 && r.x + r.width <= innerWidth + 1, `弹窗超出屏幕宽 ${fmt(r)}`);
    assert(r.height <= innerHeight + 1, `弹窗高于屏幕 ${r.height} > ${innerHeight}`);
    closePop();
    await sleep(300);
  }, { timeout: 12000, phase: "mobile" });

  // ---------------- I 路由/健壮性
  T("I 路由", "I1", "冷启动直达 /#<id>: 整页首次加载就进入正文", [
    "浏览器地址栏直接打开 /#<mainId>(宿主已做整页加载)",
  ], async () => {
    assert(location.hash === "#" + S.data.expected.mainId, `宿主应已把地址设为 /#${S.data.expected.mainId}, 实际 ${location.hash}`);
    await waitFor(() => state().showing === "reader", { timeout: 12000, desc: "冷启动进正文" });
    assert($("#epTitle").textContent.trim().length > 0, "标题为空");
    assert($$("#article .s").length > 100, "正文未渲染");
    assert($("#list").style.display === "none", "列表不该同时可见");
  }, { timeout: 12000, phase: "coldstart" });

  T("I 路由", "I2", "访问不存在的 #<id>: 落回列表, 不白屏、不报错", [
    "访问 /#deadbeef0000",
  ], async () => {
    history.pushState({ id: "deadbeef0000" }, "", "/#deadbeef0000");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { id: "deadbeef0000" } }));
    await sleep(2500);
    eq(state().showing, "list", "应落回列表");
    assert($("#list").innerText.trim().length > 0, "列表空白");
    assertNoErrors();
  }, { timeout: 12000 });

  T("I 路由", "I3", "后退/前进: 列表与正文正确切换, hash 同步", [
    "进正文 → 返回列表 → history.back() → forward()",
  ], async () => {
    await home();
    await openEpisode(S.data.expected.mainId);
    await realClick("#back");
    await waitFor(() => state().showing === "list", { timeout: 6000, desc: "返回列表" });
    eq(location.hash, "", "返回列表后 hash 应清掉");
    await D.back();
    await sleep(600);
    eq(location.hash, "#" + S.data.expected.mainId, "后退后应回到该集的 hash");
  }, { timeout: 12000 });

  T("I 路由", "I4", "断网: 只读内容走离线缓存, 写操作必须失败", [
    "先缓存 /sync → 断网 → 刷新到正文 → 试写 /vocab",
  ], async () => {
    // 离线缓存的内容是宿主在断网之前写进去的(模拟"昨天在线看过, 今天在地铁上打开")
    const cached = await evalIn(`(() => { const c = localStorage.getItem("et.offline"); return c ? JSON.parse(c).data.episodes.length : 0 })()`);
    assert(cached > 0, "宿主没有预先写入离线缓存");
    const offlineReady =
      (window.__D && window.__D.ext && window.__D.ext.offlineReady()) ||
      !!(window.__qaHost && window.__qaHost.requestsBlocked);
    assert(offlineReady, "宿主应已切断接口请求(模拟离线)");
    // 1) 写操作必须失败(不能假装标记成功)
    const r = await evalIn(`fetch("/vocab", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({lemma:"zzz-offline-test"})}).then(()=>"ok").catch(()=>"fail")`);
    eq(r, "fail", "离线写操作必须失败(不能假装成功)");
    // 2) 离线打开某一集: 走应用自己的启动路径, 正文与中译都要能从本地读出来
    if (!isResumed()) throw new Error("RELOAD_MARKER: 离线缓存已就绪, 请宿主刷新后再跑");
    // 离线之后应用要走 localStorage 里的 /sync 缓存把正文渲染出来
    const n = await waitFor(() => {
      const c = $$("#article .s").length;
      return state().showing === "reader" && c > 0 ? c : null;
    }, { timeout: 9000, desc: "离线仍能读到正文" });
    assert(n > 100, `离线渲染的句子数偏少: ${n}`);
    // 3) 离线时列表也要能出来(本地缓存)
    await evalIn(`(typeof showList === "function") && showList(true)`);
    await waitFor(() => $$("#list li").length > 0, { timeout: 6000, desc: "离线列表" });
  }, { timeout: 12000, phase: "offline" });

  T("I 路由", "I5", "音频缺失时给出人话提示(不是静默)", [
    "打开音频路径坏掉的单集 → 点播放",
  ], async () => {
    const bad = S.data.expected.brokenAudio;
    assert(bad, "缺少坏音频单集");
    assert(location.hash === "#" + bad.id, `宿主应已打开 /#${bad.id}`);
    await waitFor(() => state().showing === "reader" && $$("#article .s").length > 0, { timeout: 12000, desc: "进入单集(有正文)" });
    await playSentence(0);
    const txt = await waitFor(() => {
      const t = $("#status").textContent;
      return /失败|错误|丢失|无法/.test(t) ? t : null;
    }, { timeout: 12000, desc: "音频错误提示" }).catch(() => $("#status").textContent);
    assert(/失败|错误|丢失|无法/.test(txt), `没有给出音频错误提示, 状态栏是: ${fmt(txt)}`);
    assert(!/undefined|\[object/.test(txt), `提示不友好: ${fmt(txt)}`);
  }, { timeout: 12000, phase: "broken" });

  T("I 路由", "I6", "失败态单集: 显示原因与重试按钮, 不白屏", [
    "打开 failed 的单集",
  ], async () => {
    const f = S.data.expected.failed;
    assert(f, "缺少 failed 单集");
    assert(location.hash === "#" + f.id, `宿主应已打开 /#${f.id}`);
    await waitFor(() => /失败|重试/.test($("#article").innerText), { timeout: 12000, desc: "失败态文案" });
    assert($("#rt"), "缺少重试按钮");
  }, { timeout: 12000, phase: "failed" });

  T("I 路由", "I7", "PWA: manifest 与 SVG 图标可访问且字段完整", [
    "请求 /manifest.webmanifest 与 /icon.svg",
  ], async () => {
    const m = await fetch("/manifest.webmanifest");
    eq(m.status, 200, "manifest 状态码");
    const j = await m.json();
    for (const k of ["name", "short_name", "start_url", "display", "icons"]) assert(j[k], `manifest 缺少 ${k}`);
    assert(Array.isArray(j.icons) && j.icons.length > 0, "manifest icons 为空");
    const ic = await fetch("/icon.svg");
    eq(ic.status, 200, "图标状态码");
    assert((ic.headers.get("content-type") || "").includes("svg"), "图标 content-type");
    eq($('link[rel=manifest]').getAttribute("href"), "/manifest.webmanifest", "HTML manifest 链接");
  });

  T("I 路由", "I8", "/health 暴露 worker 状态", ["请求 /health"], async () => {
    const r = await fetch("/health");
    eq(r.status, 200, "状态码");
    const j = await r.json();
    eq(j.ok, true, "ok 字段");
    assert("running" in j && "queued" in j, "缺少 worker 字段");
  });

  // ---------------- J 细节/可访问性
  T("J 细节", "J1", "释义卡是模态框: Esc 可关, 打开时焦点不跑丢", [
    "打开卡片 → 按 Esc",
  ], async () => {
    await openEpisode(S.data.expected.mainId);
    await clickWord(null);
    eq($("#pop").open, true, "卡片应打开");
    const act = document.activeElement;
    assert(act === document.body || $("#pop").contains(act) || act === null, `焦点跑到了 ${act?.id || act?.tagName}`);
    // 原生 <dialog> 的 Esc 由浏览器实现(发出 cancel 事件), 合成按键拿不到, 用同一路径验证:
    const cancelable = $("#pop").dispatchEvent(new Event("cancel", { cancelable: true }));
    assert(cancelable, "dialong 没有处理 cancel 事件");
    // 用户能点到的关闭路径: 按钮
    if ($("#pop").open) closePop();
    await waitFor(() => !$("#pop").open, { timeout: 5000, desc: "关闭释义卡" });
  }, { timeout: 12000 });

  T("J 细节", "J2", "没有无文本、无 title 的裸按钮", ["扫描所有 button"], async () => {
    const bad = $$("button").filter((b) => !b.textContent.trim() && !b.title && !b.getAttribute("aria-label"));
    eq(bad.length, 0, `裸按钮: ${bad.map((b) => b.id || b.className).join(",")}`);
  });

  T("J 细节", "J3", "对比度: 正文与次要文字达到 WCAG AA", ["计算正文颜色与背景的对比度"], async () => {
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const bg = getComputedStyle(document.body).backgroundColor;
    const r1 = ratio(getComputedStyle($("#article")).color, bg);
    assert(r1 >= 4.5, `正文对比度 ${r1.toFixed(2)}:1 不足 4.5`);
    const dim = getComputedStyle($("#status")).color;
    const r2 = ratio(dim, bg);
    assert(r2 >= 3, `次要文字对比度 ${r2.toFixed(2)}:1 不足 3`);
  });

  T("J 细节", "J4", "快速连点同一句 5 次: 不产生多个音频元素, 状态不错乱", [
    "连续 5 次点同一句",
  ], async () => {
    await openEpisode(S.data.expected.shortId);
    for (let i = 0; i < 5; i++) {
      D.click(`.s[data-i="3"]`);
      await sleep(80);
    }
    await sleep(1500);
    const s = state();
    eq(s.audioCount, 1, "audio 元素数量");
    eq(s.cur, "3", "高亮应停在所点句");
    eq(s.paused, false, "应仍在播放");
    await realClick("#barPlay");
  }, { timeout: 12000 });

  T("J 细节", "J5", "整轮下来页面没有 console.error / 未捕获异常", [
    "检查错误收集器",
  ], async () => {
    assertNoErrors();
  });

  // ------------------------------------------------------------ 内部工具
  async function clickWord(word) {
    const sel = word ? `#article .w[data-w="${CSS.escape(word)}"]:not(.marked)` : "#article .w:not(.marked)";
    // 应用会把 I / a / the 这类虚词的点击留给「播这一句」，
    // 因此不能随手取第一个 .w；要选与产品规则一致的可查词。
    const target = word
      ? $(sel)
      : $$(sel).find((el) => String(el.dataset.w || "").replace(/[^A-Za-z'’\-]/g, "").length >= 4);
    const found = D.point(target);
    assert(found, `正文里找不到可点的词 ${word || "(任意)"}`);
    const el = document.elementFromPoint(found.x, found.y)?.closest(".w");
    D.clickAt(found.x, found.y);
    await sleep(900);
    return { ...found, w: el ? el.dataset.w : word };
  }
  const clickSynthetic = (sel) => D.clickRaw(sel);

  // ------------------------------------------------------------ 运行器
  /** 单个用例: 每次独立调用, 避免一次性长 evaluate 被宿主超时打断 */
  /** 把"输入类"的临时状态清干净: 输入框、选区、滚动位置。
   *  上一条用例往输入框里打过字、或把页面滚到过别处, 不该影响下一条。 */
  function resetTransient() {
    // 手机学习面板是 fixed 底部层: 上一条用例如果留在展开状态, 会挡住整页
    if ($("#bar").classList.contains("learning-open") && typeof closeFull === "function") closeFull();
    const url = $("#url");
    if (url) {
      url.value = "";
      try { url.blur() } catch (e) {}
    }
    if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) {
      try { document.activeElement.blur() } catch (e) {}
    }
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    window.scrollTo(0, 0);
  }

  /** 每条用例开始/结束时的隔离动作。
   *  audio 是页面级单例, 上个用例留下的播放会继续往下跑 —— 不清理就会出现
   *  "上一条的暂停逻辑改了这条的状态"这种串味失败(实测踩过)。 */
  function setIsolation(on) {
    window.__qaIsolated = !!on;
  }
  async function waitIsolation() {
    // 宿主在跑一条用例之前会把 __qaIsolated 设为 false(隔离窗口结束);
    // 页面刚加载(undefined)时直接放行。
    let n = 0;
    while (window.__qaIsolated !== false && n++ < 40) await sleep(50);
    return window.__qaIsolated === false;
  }

  /** 本条用例是不是"刚刚刷新过、正在跑后半段" */
  const isResumed = () => window.__qaResume === true;

  async function runOne(id) {
    const c = CASES.find((x) => x.id === id);
    if (!c) throw new Error("没有这个用例: " + id);
    await waitIsolation();
    const rec = { id: c.id, area: c.area, title: c.title, repro: c.repro, status: "pass", error: null, ms: 0, pageErrors: [] };
    S.errMark = S.errors.length;
    const t0 = Date.now();
    try {
      // 每条用例都从"干净的一屏"开始:
      // 1) 关掉上一例可能留下的模态框 —— 它是 fixed 定位, 会盖住正文,
      //    让下面所有 elementFromPoint 都命中弹窗(实测踩过: 一条用例没关卡片,
      //    后面整片用例的命中测试全废, 报出来的却是"点不到句子")。
      closePop();
      resetTransient();
      await sleep(150);
      await ensureGesture();
      await Promise.race([
        c.run(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`用例超时 ${c.timeout}ms`)), c.timeout)),
      ]);
      const errs = currentErrors();
      if (errs.length) {
        rec.status = "fail";
        rec.error = "运行时错误: " + errs.join(" | ");
        rec.pageErrors = errs;
      }
    } catch (e) {
      rec.status = "fail";
      rec.error = (e && e.message) || String(e);
      rec.pageErrors = currentErrors();
    } finally {
      rec.ms = Date.now() - t0;
      try {
        if ($("#pop").open) $("#pop").close();
      } catch {}
      try {
        const a = $("#etAudio");
        if (a && !a.paused) a.pause();
      } catch {}
    }
    return rec;
  }

  function list() {
    return CASES.map((c) => ({
      id: c.id, area: c.area, title: c.title, repro: c.repro, timeout: c.timeout, phase: c.phase,
      skip: !!(S.data && S.data.only && S.data.only.length && !S.data.only.includes(c.id)),
    }));
  }

  async function run() {
    S.results = [];
    for (const c of CASES) {
      if (c.phase !== (S.data.phase || "main")) continue;
      if (S.data.only && S.data.only.length && !S.data.only.includes(c.id)) continue;
      S.results.push(await runOne(c.id));
    }
    return { results: S.results, errors: S.errors, env: { url: location.href, viewport: [innerWidth, innerHeight] } };
  }

  window.__QA = {
    suite: CASES,
    setData: (d) => {
      S.data = d;
    },
    setDriver: (d) => {
      S.driver = d;
    },
    run,
    runOne,
    list,
    // 调试用: 直接检查页面内驱动的取点结果
    debug: {
      sentencePoint: (sel) => D.sentencePoint(sel),
      point: (sel) => D.point(sel),
      rect: (sel) => D.rect(sel),
      stack: (x, y) => D.stack(x, y),
      clickAt: (x, y) => D.clickAt(x, y),
      state,
    },
    env: () => ({ url: location.href, viewport: [innerWidth, innerHeight] }),
    state,
    recordError: (e) => S.errors.push(String(e).slice(0, 300)),
    reset: () => {
      S.errors.length = 0;
      S.errMark = 0;
    },
    errors: () => S.errors,
  };
  window.__QA_READY = true;
})();
