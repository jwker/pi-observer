/* ==========================================================================
   pi-observer 原型 · 交互
   只做原型需要的四件事：标签页、开关芯片、筛选/搜索、树与折叠。
   所有行为都是纯前端模拟，没有网络请求，也没有任何写操作。
   ========================================================================== */

(function () {
  "use strict";

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
      var initial = (tabs.find(function (t) { return t.classList.contains("on"); }) || tabs[0]);
      if (initial) show(initial.dataset.tab);
    });
  }

  /* ------------------------------------------------------- 开关芯片 / 快捷键
     用法：<span class="chip" data-chip="thinking">…</span>
     命中后给 <html> 加上 hide-thinking 之类的类名，同时切换 .on。
     data-default="off" 表示初始未选中（默认全部选中）。
  */
  function initChips(root) {
    var chips = Array.prototype.slice.call(root.querySelectorAll("[data-chip]"));
    chips.forEach(function (chip) {
      var name = chip.dataset.chip;
      var off = chip.dataset.default === "off";
      chip.classList.toggle("on", !off);
      document.documentElement.classList.toggle("hide-" + name, off);
      chip.addEventListener("click", function () {
        var on = !chip.classList.contains("on");
        chip.classList.toggle("on", on);
        document.documentElement.classList.toggle("hide-" + name, !on);
      });
    });
  }

  /* ------------------------------------------------- 分段筛选 + 搜索框过滤 */
  function initFilters(root) {
    root.querySelectorAll("[data-filters]").forEach(function (scope) {
      var segs = Array.prototype.slice.call(scope.querySelectorAll("[data-filter-group]"));
      var search = scope.querySelector("input[data-search]");
      var rows = Array.prototype.slice.call(scope.querySelectorAll("[data-row]"));
      var empty = scope.querySelector("[data-empty]");

      function apply() {
        var visible = 0;
        rows.forEach(function (row) {
          var ok = true;
          segs.forEach(function (seg) {
            if (!seg.classList.contains("on")) return;
            var g = seg.dataset.filterGroup;
            var v = seg.dataset.filterValue;
            if (v === "all") return;
            ok = ok && (row.dataset[g] || "").split(" ").indexOf(v) >= 0;
          });
          if (ok && search) {
            var q = search.value.trim().toLowerCase();
            if (q) {
              var hay = (row.textContent + " " + (row.dataset.search || "")).toLowerCase();
              ok = hay.indexOf(q) >= 0;
            }
          }
          row.style.display = ok ? "" : "none";
          if (ok) visible++;
        });
        if (empty) empty.style.display = visible ? "none" : "";
      }

      segs.forEach(function (seg) {
        seg.addEventListener("click", function () {
          if (seg.dataset.multi === "true") {
            seg.classList.toggle("on");
          } else {
            var siblings = seg.parentElement.querySelectorAll("[data-filter-group='" + seg.dataset.filterGroup + "']");
            Array.prototype.forEach.call(siblings, function (s) { s.classList.remove("on"); });
            seg.classList.add("on");
          }
          apply();
        });
      });
      if (search) search.addEventListener("input", apply);
      apply();
    });
  }

  /* ----------------------------------------------------- 树节点与折叠块展开 */
  function initTrees(root) {
    var detail = root.querySelector("[data-node-detail]");
    root.querySelectorAll("[data-tree-toggle]").forEach(function (line) {
      line.addEventListener("click", function (e) {
        var node = line.closest(".node");
        if (e.target.classList.contains("twist")) node.classList.toggle("closed");
        if (node) {
          var tree = line.closest(".tree");
          if (tree) tree.querySelectorAll(".node-line.active").forEach(function (n) { n.classList.remove("active"); });
        }
        line.classList.add("active");
        if (!detail) return;
        var title = detail.querySelector("[data-node-title]");
        var body = detail.querySelector("[data-node-body]");
        var meta = detail.querySelector("[data-node-meta]");
        var label = line.querySelector(".txt");
        if (title) title.textContent = label ? label.textContent : "节点";
        if (body) body.textContent = line.getAttribute("data-full") ||
          "（原型示例）这里显示该条目的全文：role、entry id、parentId、时间戳与内容块。切换左侧节点即可看到对应内容。";
        if (meta) meta.textContent = line.getAttribute("data-entry") || "—";
      });
    });
    root.querySelectorAll("[data-box-toggle]").forEach(function (head) {
      head.addEventListener("click", function () {
        head.closest(".turn-box").classList.toggle("closed");
      });
    });
  }

  /* ------------------------------------------------------------ 复制到剪贴板 */
  function initCopy(root) {
    root.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var el = document.querySelector(btn.dataset.copy);
        var text = el ? el.textContent : "";
        var old = btn.textContent;
        if (navigator.clipboard) navigator.clipboard.writeText(text);
        btn.textContent = "已复制";
        setTimeout(function () { btn.textContent = old; }, 1200);
      });
    });
  }

  /* --------------------------------------------------------- 实时正文模拟
     用 40ms 的间隔逐段显示，模拟“每 500ms 一份快照”的观感。
     真实实现里文本来自 message_update 的合并结果，这里只是演示。
  */
  function initStreaming(root) {
    root.querySelectorAll("[data-stream]").forEach(function (el) {
      var text = el.getAttribute("data-stream") || "";
      var out = el.querySelector(".stream-text");
      var snap = el.querySelector("[data-stream-snap]");
      if (!out) return;
      var i = 0;
      var step = Math.max(1, Math.round(text.length / 90));
      out.textContent = "";
      var timer = setInterval(function () {
        i += step;
        out.textContent = text.slice(0, i);
        if (snap) snap.textContent = "快照 " + String(Math.min(99, Math.floor(i / step))) + " · 500ms 节流";
        if (i >= text.length) {
          clearInterval(timer);
          el.classList.remove("streaming");
          var caret = el.querySelector(".caret");
          if (caret) caret.remove();
          if (snap) snap.textContent = "已结束 · 共 " + text.length + " 字符";
        }
      }, 40);
    });
  }

  /* ------------------------------------------------------------ 键盘快捷键 */
  function initKeys() {
    document.addEventListener("keydown", function (e) {
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.metaKey || e.ctrlKey) return;
      var key = e.key.toLowerCase();
      var chip = document.querySelector('[data-chip="' + ({ t: "thinking", h: "hidden", o: "tools" }[key] || "") + '"]');
      if (chip) { chip.click(); e.preventDefault(); return; }
      if (key === "j") {
        var link = document.querySelector("[data-jsonl]");
        if (link) location.href = link.getAttribute("href");
      }
      if (key === "/" ) {
        var s = document.querySelector("input[data-search]");
        if (s) { s.focus(); e.preventDefault(); }
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var root = document.body;
    initTabs(root);
    initChips(root);
    initFilters(root);
    initTrees(root);
    initCopy(root);
    initStreaming(root);
    initKeys();
  });
})();
