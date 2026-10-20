/* ==========================================================================
   pi-observer 原型 · 交互
   单页外壳：会话切换、筛选、Turn 折叠、分页、详情弹窗、亮暗主题。
   所有行为都是纯前端模拟，没有网络请求，也没有任何写操作。
   ========================================================================== */

(function () {
  "use strict";

  var THEME_KEY = "pi-observer-theme";
  var FILTER_KEY = "pi-observer-filters";

  function storeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function text(selector, value) {
    var el = document.querySelector(selector);
    if (el && value != null) el.textContent = value;
  }

  /* ---------------------------------------------------------------- 标签页
     用法：
       <div data-tabgroup>
         <div class="tabs"><button data-tab="a">…</button><button data-tab="b">…</button></div>
         <div data-panel="a">…</div>
         <div data-panel="b">…</div>
       </div>
  */
  function initTabs(root) {
    root.querySelectorAll("[data-tabgroup]").forEach(function (group) {
      var tabs = Array.prototype.slice.call(group.querySelectorAll("[data-tab]"));
      var panels = Array.prototype.slice.call(group.querySelectorAll("[data-panel]"));
      function show(name) {
        tabs.forEach(function (t) { t.classList.toggle("on", t.dataset.tab === name); });
        panels.forEach(function (p) { p.classList.toggle("on", p.dataset.panel === name); });
      }
      tabs.forEach(function (t) {
        t.addEventListener("click", function () { show(t.dataset.tab); });
      });
      var initial = tabs.find(function (t) { return t.classList.contains("on"); }) || tabs[0];
      if (initial) show(initial.dataset.tab);
    });
  }

  /* ------------------------------------------------------------ 复制到剪贴板 */
  function initCopy(root) {
    root.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var el = document.querySelector(btn.dataset.copy);
        var content = el ? el.textContent : "";
        var old = btn.textContent;
        if (navigator.clipboard) navigator.clipboard.writeText(content);
        btn.textContent = "已复制";
        setTimeout(function () { btn.textContent = old; }, 1200);
      });
    });
  }

  /* -------------------------------------------------------------- 亮 / 暗主题 */
  function initTheme() {
    var btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    var icon = btn.querySelector("[data-theme-icon]");
    var label = btn.querySelector("[data-theme-label]");

    function apply(theme) {
      document.documentElement.dataset.theme = theme;
      storeSet(THEME_KEY, theme);
      if (icon) icon.textContent = theme === "light" ? "☀" : "☾";
      if (label) label.textContent = theme === "light" ? "亮色" : "暗色";
      btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
      btn.title = theme === "light" ? "切换到暗色（D）" : "切换到亮色（D）";
    }

    apply(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    btn.addEventListener("click", function () {
      apply(document.documentElement.dataset.theme === "light" ? "dark" : "light");
    });
  }

  /* -------------------------------------------------------------- 会话切换 */
  function initShell(applyFilters) {
    var links = Array.prototype.slice.call(document.querySelectorAll("[data-sess]"));
    if (!links.length) return;
    var views = Array.prototype.slice.call(document.querySelectorAll(".view[data-view]"));
    var stateEl = document.querySelector("[data-h-state]");
    var reconEl = document.querySelector("[data-h-recon]");
    var countEls = Array.prototype.slice.call(document.querySelectorAll("[data-count]"));

    var FIELDS = [
      ["cwd", "[data-h-cwd]"],
      ["id", "[data-h-id]"],
      ["model", "[data-h-model]"],
      ["thinking", "[data-h-thinking]"],
      ["updated", "[data-h-updated]"],
      ["file", "[data-h-file]"],
      ["msgs", "[data-h-msgs]"],
      ["turns", "[data-h-turns]"],
      ["tools", "[data-h-tools]"],
      ["in", "[data-h-in]"],
      ["out", "[data-h-out]"],
      ["cache", "[data-h-cache]"],
      ["cost", "[data-h-cost]"]
    ];

    var STATES = {
      live: ["badge ok", "进行中"],
      idle: ["badge warn", "空闲"],
      ended: ["badge", "已结束"]
    };

    function select(link) {
      links.forEach(function (l) { l.classList.toggle("on", l === link); });
      views.forEach(function (v) { v.hidden = v.dataset.view !== link.dataset.view; });

      FIELDS.forEach(function (pair) {
        text(pair[1], link.dataset[pair[0]] || "—");
      });

      var state = STATES[link.dataset.state] || STATES.ended;
      if (stateEl) {
        stateEl.className = state[0];
        stateEl.textContent = state[1];
      }
      if (reconEl) {
        var ok = link.dataset.recon === "yes";
        reconEl.className = ok ? "badge info" : "badge warn";
        reconEl.textContent = ok ? "已对账" : "未对账";
      }

      countEls.forEach(function (el) {
        var key = el.dataset.count;
        var camel = "c" + key.charAt(0).toUpperCase() + key.slice(1);
        var n = Number(link.dataset[camel] || 0);
        el.textContent = n;
        var chip = el.closest("[data-cat-chip]");
        if (chip) {
          chip.disabled = n === 0;
          chip.title = n === 0 ? "这个会话没有这类数据" : "";
        }
      });

      var view = views.find(function (v) { return v.dataset.view === link.dataset.view; });
      var scroller = view ? view.querySelector(".tl-scroll") : null;
      /* 进入会话先停在最新一轮（与聊天一致），往上翻才是更早的 Turn */
      if (scroller) scroller.scrollTop = scroller.scrollHeight;

      if (applyFilters) applyFilters();
    }

    links.forEach(function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        select(link);
        try { history.replaceState(null, "", "#s=" + link.dataset.sess); } catch (err) {}
      });
    });

    var hash = (location.hash.match(/s=([\w-]+)/) || [])[1];
    var initial = links.find(function (l) { return l.dataset.sess === hash; }) || links[0];
    select(initial);
  }

  /* ---------------------------------------------------------- 左栏会话搜索 */
  function initSidebarSearch() {
    var input = document.querySelector("[data-sb-search]");
    if (!input) return;
    var rows = Array.prototype.slice.call(document.querySelectorAll("[data-sb-row]"));
    var groups = Array.prototype.slice.call(document.querySelectorAll("[data-sb-group]"));
    var empty = document.querySelector("[data-sb-empty]");

    function apply() {
      var q = input.value.trim().toLowerCase();
      var visible = 0;
      rows.forEach(function (row) {
        var hay = (row.textContent + " " + (row.dataset.search || "")).toLowerCase();
        var ok = !q || hay.indexOf(q) >= 0;
        row.hidden = !ok;
        if (ok) visible++;
      });
      groups.forEach(function (group) {
        group.hidden = !group.querySelector("[data-sb-row]:not([hidden])");
      });
      if (empty) empty.hidden = visible > 0;
    }

    input.addEventListener("input", apply);
  }

  /* ------------------------------------------------------------ 时间线筛选
     六个分类芯片控制文件条目与事件行；思考与其它分支是额外的显隐开关。
     选择存进 localStorage，刷新与切换会话都保持。
  */
  function initFilters() {
    var chips = Array.prototype.slice.call(document.querySelectorAll("[data-cat-chip]"));
    var think = document.querySelector("[data-think-chip]");
    var branch = document.querySelector("[data-branch-chip]");
    var saved = {};

    try { saved = JSON.parse(storeGet(FILTER_KEY) || "{}") || {}; } catch (e) {}

    chips.forEach(function (chip) {
      var key = chip.dataset.catChip;
      chip.classList.toggle("on", !saved.cats || saved.cats[key] !== false);
      chip.addEventListener("click", function () {
        chip.classList.toggle("on");
        apply();
      });
    });

    if (think) {
      think.classList.toggle("on", saved.think !== false);
      think.addEventListener("click", function () {
        think.classList.toggle("on");
        apply();
      });
    }

    if (branch) {
      branch.classList.toggle("on", saved.branch === true);
      branch.addEventListener("click", function () {
        branch.classList.toggle("on");
        apply();
      });
    }

    function apply() {
      var cats = {};
      chips.forEach(function (chip) { cats[chip.dataset.catChip] = chip.classList.contains("on"); });
      var thinkOn = !think || think.classList.contains("on");
      var branchOn = !!branch && branch.classList.contains("on");

      document.documentElement.classList.toggle("hide-think", !thinkOn);

      document.querySelectorAll(".entry[data-cat]").forEach(function (row) {
        var rowCats = row.dataset.cat.split(/\s+/);
        var show = rowCats.some(function (c) { return cats[c]; });
        if (row.classList.contains("off") && !branchOn) show = false;
        row.hidden = !show;
      });

      storeSet(FILTER_KEY, JSON.stringify({ cats: cats, think: thinkOn, branch: branchOn }));
    }

    apply();
    return apply;
  }

  /* ------------------------------------------------------------ Turn 折叠 */
  function initTurns() {
    function setOpen(turn, open) {
      turn.classList.toggle("open", open);
      var head = turn.querySelector(".turn-head");
      if (!head) return;
      head.setAttribute("aria-expanded", open ? "true" : "false");
      var twist = head.querySelector(".twist");
      if (twist) twist.textContent = open ? "▾" : "▸";
    }

    document.querySelectorAll(".turn-head").forEach(function (head) {
      head.addEventListener("click", function () {
        var turn = head.closest(".turn");
        setOpen(turn, !turn.classList.contains("open"));
      });
    });

    var all = document.querySelector("[data-expand-all]");
    if (!all) return;
    all.addEventListener("click", function () {
      var open = all.dataset.on !== "1";
      var view = document.querySelector(".view[data-view]:not([hidden])");
      if (!view) return;
      view.querySelectorAll(".turn").forEach(function (turn) { setOpen(turn, open); });
      all.dataset.on = open ? "1" : "0";
      all.textContent = open ? "收起全部" : "展开全部";
    });
  }

  /* ------------------------------------------------------- 加载更早的 Turn */
  function initEarlier() {
    var btn = document.querySelector("[data-load-earlier]");
    var group = document.querySelector("[data-earlier]");
    var wrap = document.querySelector("[data-load-wrap]");
    var end = document.querySelector("[data-tl-end]");
    var range = document.querySelector("[data-turn-range]");
    if (!btn || !group) return;

    btn.addEventListener("click", function () {
      var scroller = btn.closest(".tl-scroll");
      var before = scroller ? scroller.scrollHeight : 0;
      group.hidden = false;
      if (wrap) wrap.hidden = true;
      if (end) end.hidden = false;
      if (range) range.textContent = "全部 34 个 Turn";
      if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
    });
  }

  /* -------------------------------------------------------------- 详情弹窗 */
  function initModal() {
    var modal = document.querySelector("[data-modal]");
    if (!modal) return { close: function () {} };
    var panel = modal.querySelector("[data-modal-panel]");
    var lastFocus = null;

    function open(id, trigger) {
      var tpl = document.getElementById(id);
      if (!tpl) return;
      panel.innerHTML = tpl.innerHTML;
      modal.hidden = false;
      document.body.classList.add("modal-open");
      lastFocus = trigger || null;
      initTabs(panel);
      panel.setAttribute("tabindex", "-1");
      panel.focus();
    }

    function close() {
      if (modal.hidden) return;
      modal.hidden = true;
      document.body.classList.remove("modal-open");
      panel.innerHTML = "";
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    document.addEventListener("click", function (e) {
      var trigger = e.target.closest("[data-detail]");
      if (trigger) {
        e.preventDefault();
        open(trigger.dataset.detail, trigger);
        return;
      }
      if (e.target.closest("[data-close]")) {
        e.preventDefault();
        close();
      }
    });

    return { close: close };
  }

  /* ------------------------------------------------------------ 刷新按钮演示 */
  function initRefresh() {
    var btn = document.querySelector("[data-refresh]");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var old = btn.textContent;
      btn.textContent = "已刷新";
      btn.disabled = true;
      setTimeout(function () {
        btn.textContent = old;
        btn.disabled = false;
      }, 900);
    });
  }

  /* ------------------------------------------------------------ 键盘快捷键 */
  function initKeys(modal) {
    document.addEventListener("keydown", function (e) {
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.metaKey || e.ctrlKey || e.altKey) return;
      var key = e.key.toLowerCase();

      if (key === "escape") { modal.close(); return; }
      if (key === "/") {
        var search = document.querySelector("[data-sb-search]");
        if (search) { search.focus(); e.preventDefault(); }
        return;
      }
      if (key === "d") {
        var theme = document.querySelector("[data-theme-toggle]");
        if (theme) theme.click();
        return;
      }
      if (key === "t") {
        var think = document.querySelector("[data-think-chip]");
        if (think) think.click();
        return;
      }
      if (key === "b") {
        var branch = document.querySelector("[data-branch-chip]");
        if (branch) branch.click();
        return;
      }
      if (key === "e") {
        var all = document.querySelector("[data-expand-all]");
        if (all) all.click();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTabs(document);
    initCopy(document);
    initTheme();
    var applyFilters = initFilters();
    initShell(applyFilters);
    initSidebarSearch();
    initTurns();
    initEarlier();
    initRefresh();
    var modal = initModal();
    initKeys(modal);
  });
})();
