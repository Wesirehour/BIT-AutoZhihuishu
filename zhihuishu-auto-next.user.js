// ==UserScript==
// @name         智慧树自动连播 （持久记忆·整页刷新适配）
// @namespace    https://zhihuishu.com/autonext7
// @version      1.0
// @description  学习记录存入localStorage，整页刷新后仍记住当前视频；播完自动展开单元并点击下一条；浮层内显示条目数组检视；浮层可锁定倍速(1.0/1.25/1.5)；debug模式才显示诊断控件
// @author       Hermes
// @match        *://*.zhihuishu.com/*
// @match        *://*.zhihuishu.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    interval: 1000,
    autoCloseQuiz: true,
    resumeWhenBlurred: true,
    storageKey: '__zhsAutoNextV7',
    speedKey: '__zhsAutoNextV7Speed',
    speeds: [1, 1.25, 1.5],
    debug: false,
    debugKey: '__zhsAutoNextV7Debug'
  };

  // 调试开关：默认取 CFG.debug；也可用 localStorage 临时覆盖：
  // 控制台执行 localStorage.setItem('__zhsAutoNextV7Debug', '1') 后刷新
  function debugOn() {
    if (CFG.debug) return true;
    try { return localStorage.getItem(CFG.debugKey) === '1'; }
    catch (e) { return false; }
  }

  /* ================= 倍速（持久化） ================= */
  function getSpeed() {
    try {
      const x = parseFloat(localStorage.getItem(CFG.speedKey));
      return CFG.speeds.indexOf(x) >= 0 ? x : 1;
    } catch (e) { return 1; }
  }
  function setSpeed(x) {
    try { localStorage.setItem(CFG.speedKey, String(x)); } catch (e) {}
  }
  function applySpeed(v) {
    if (!v) return;
    const sp = getSpeed();
    if (v.playbackRate !== sp) {
      try { v.playbackRate = sp; } catch (e) {}
    }
  }

  const isZHS = /zhihuishu/i.test(location.hostname);
  if (!isZHS) return;
  if (window.__zhsAuto7Installed) return;
  window.__zhsAuto7Installed = true;

  /* ================= 日志 ================= */
  const lines = [];
  function emit(level, msg) {
    msg = String(msg);
    lines.push({ time: new Date().toTimeString().slice(0, 8), level, msg });
    if (lines.length > 80) lines.shift();
    renderPanel();
    if (level === 'warn') console.warn('[连播]', msg); else console.log('[连播]', msg);
  }
  const log = m => emit('info', m);
  const warn = m => emit('warn', m);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = t => {
    if (!isFinite(t) || t < 0) return '--:--';
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  };

  /* ================= 持久化 ================= */
  function saveMemory(o) {
    try { localStorage.setItem(CFG.storageKey, JSON.stringify(o)); return true; }
    catch (e) { warn('localStorage 写入失败：' + e.message); return false; }
  }
  function loadMemory() {
    try {
      const s = localStorage.getItem(CFG.storageKey);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }

  /* ================= 元素路径（body 起算的 child-index 链） ================= */
  function buildPath(el) {
    const path = [];
    let n = el;
    while (n && n !== document.body) {
      if (!n.parentElement) return null;
      path.push(Array.prototype.indexOf.call(n.parentElement.children, n));
      n = n.parentElement;
    }
    return n === document.body ? path.reverse() : null;
  }
  function resolvePath(path) {
    if (!path || !path.length) return null;
    let n = document.body;
    for (const i of path) {
      if (!n || i >= n.children.length) return null;
      n = n.children[i];
    }
    return n;
  }

  /* ================= 基础工具 ================= */
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    let s;
    try { s = getComputedStyle(el); } catch (e) { return true; }
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
  }

  function findVideo() {
    const vids = Array.from(document.querySelectorAll('video')).filter(v => {
      const r = v.getBoundingClientRect();
      return r.width > 20 && r.height > 20 && (v.currentSrc || v.src);
    });
    if (!vids.length) return null;
    vids.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return vids[0];
  }

  function currentResourceId() {
    const m = location.pathname.match(/learnPage\/[^/]+\/([^/]+)\//);
    return m ? m[1] : '';
  }

  function dispatchMouse(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, pointerId: 1, pointerType: 'mouse' };
    ['pointerover', 'mouseover', 'pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
      .forEach(type => {
        try { el.dispatchEvent(new PointerEvent(type, opts)); }
        catch (e) { try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (err) {} }
      });
  }

  function coordinateClick(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + Math.min(100, r.width * 0.3), r.top + r.height / 2],
      [r.left + Math.min(40, r.width * 0.15), r.top + r.height / 2]
    ];
    let target = null;
    for (const [x, y] of pts) {
      const c = document.elementFromPoint(
        Math.max(2, Math.min(innerWidth - 2, x)),
        Math.max(2, Math.min(innerHeight - 2, y))
      );
      if (c && (c === el || el.contains(c) || c.contains(el))) { target = c; break; }
    }
    target = target || el;
    dispatchMouse(target);
    return target;
  }

  /* ================= 行（视频条目）识别 ================= */
  const MARKER_RE = /(必学|选学)\s*\d+\s*[\/／]\s*\d+/;

  function findMarkerLeaves() {
    const all = [];
    document.querySelectorAll('*').forEach(el => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length <= 16 && MARKER_RE.test(t)) all.push(el);
    });
    // 只保留最深层匹配节点：内部还含有其他匹配节点的是容器，丢弃
    return all.filter(m => !all.some(o => o !== m && m.contains(o)));
  }

  function countLeavesIn(root, leaves) {
    let n = 0;
    for (const l of leaves) if (root.contains(l)) n++;
    return n;
  }

  const ITEM_CLS_RE = /section-item/i;
  function markerToRow(marker, leaves) {
    leaves = leaves || findMarkerLeaves();
    let row = marker, g = 0;
    // 从标记叶子向上抬到“条目”容器：父容器内仍只有这一个视频标记就继续；
    // 已抬到 section-item 条目、其父不再是条目（即列表外壳）时停止，避免把整组吞成一行
    while (row.parentElement && g < 12) {
      const p = row.parentElement;
      if (countLeavesIn(p, leaves) !== 1) break;
      const rowIsItem = ITEM_CLS_RE.test((row.getAttribute && row.getAttribute('class')) || '');
      const pIsItem = ITEM_CLS_RE.test((p.getAttribute && p.getAttribute('class')) || '');
      if (rowIsItem && !pIsItem) break;
      row = p; g++;
    }
    return row;
  }

  function rowTitle(row) {
    // 遍历行内所有文本节点，排除“必学/选学 x/x”片段，取最长的剩余文本
    const texts = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      let t = node.textContent.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      t = t.replace(/(必学|选学)\s*\d+\s*[\/／]\s*\d+/g, '').trim();
      if (t) texts.push(t);
    }
    texts.sort((a, b) => b.length - a.length);
    return (texts[0] || (row.textContent || '').replace(MARKER_RE, '')).slice(0, 24);
  }

  // 收集所有行（含折叠单元内的隐藏行），按文档顺序
  function collectRows() {
    const rows = [];
    const markerLeaves = findMarkerLeaves();
    markerLeaves.forEach(m => {
      const r = markerToRow(m, markerLeaves);
      if (!rows.includes(r)) rows.push(r);
    });

    // 可见行必须在左侧栏；隐藏行按“与可见行同结构”保留
    const visRows = rows.filter(r => {
      const rc = r.getBoundingClientRect();
      return visible(r) && rc.right <= innerWidth * 0.45 && rc.width > 60;
    });
    let keep;
    if (visRows.length >= 2) {
      keep = rows.filter(r => {
        if (visible(r)) return visRows.includes(r);
        const tok = (r.getAttribute('class') || '').split(/\s+/);
        return visRows.some(v => v.tagName === r.tagName &&
          tok.some(t => t && (v.getAttribute('class') || '').split(/\s+/).includes(t)));
      });
    } else keep = rows;

    keep.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

    // 清理异常的嵌套小容器：若 A 嵌套在另一个候选行 B 内，且 A 提取不到有效标题，剔除 A
    const cleaned = keep.filter(A => {
      if (rowTitle(A)) return true;
      return !keep.some(B => B !== A && B.contains(A));
    });
    return cleaned;
  }

  // 从任意点击 target 找到所属行
  function targetToRow(t) {
    let n = t, g = 0;
    while (n && g < 8) {
      if (MARKER_RE.test((n.textContent || '').replace(/\s+/g, ' '))) {
        const allLeaves = findMarkerLeaves();
        const leaves = allLeaves.filter(l => n.contains(l));
        if (leaves.length) return markerToRow(leaves[0], allLeaves);
      }
      n = n.parentElement; g++;
    }
    return null;
  }

  /* ================= 折叠单元展开 ================= */
  async function ensureRowVisible(row) {
    if (visible(row)) return true;

    for (let attempt = 0; attempt < 4; attempt++) {
      // 找最近的隐藏祖先
      let hidden = row.parentElement, g = 0;
      while (hidden && visible(hidden) && g < 10) { hidden = hidden.parentElement; g++; }
      if (!hidden) return false;

      // 在隐藏祖先的父容器内找“知识单元/模块”标题
      const parent = hidden.parentElement;
      if (!parent) return false;
      let header = null;
      const scan = [hidden].concat(
        Array.from(parent.children).slice(0, Math.max(0,
          Array.prototype.indexOf.call(parent.children, hidden)))
      );
      for (const el of scan) {
        const t = (el.textContent || '').replace(/\s+/g, '');
        if (visible(el) && /知识(单元|模块)/.test(t) && t.length <= 30) { header = el; break; }
      }
      if (!header) {
        // 退路：点击页面上任意折叠状态的单元标题
        const hs = Array.from(document.querySelectorAll('*')).filter(e => {
          const t = (e.textContent || '').replace(/\s+/g, '');
          return visible(e) && /^知识(单元|模块)/.test(t) && t.length <= 14;
        });
        header = hs[0];
      }
      if (!header) return false;

      log('展开折叠单元：' + header.textContent.replace(/\s+/g, '').slice(0, 14));
      coordinateClick(header);
      await sleep(700);
      if (visible(row)) return true;
    }
    return visible(row);
  }

  /* ================= 内存中的当前状态 ================= */
  let currentRow = null;
  let currentHow = '';

  function restoreCurrent() {
    const rows = collectRows();
    const mem = loadMemory();

    // 1) 持久化路径还原，并用标题校验
    if (mem && mem.rowPath) {
      const el = resolvePath(mem.rowPath);
      if (el && rows.includes(el) && (!mem.title || rowTitle(el) === mem.title)) {
        currentRow = el; currentHow = '持久记忆';
        return rows;
      }
      // 路径失效 → 按保存的标题匹配
      if (mem.title) {
        const byTitle = rows.find(r => rowTitle(r) === mem.title);
        if (byTitle) { currentRow = byTitle; currentHow = '持久记忆(标题)'; return rows; }
      }
    } else if (mem && mem.title) {
      const byTitle = rows.find(r => rowTitle(r) === mem.title);
      if (byTitle) { currentRow = byTitle; currentHow = '持久记忆(标题)'; return rows; }
    }
    // 2) URL 资源ID 在属性中查找
    const id = currentResourceId();
    if (id) {
      const byId = rows.find(r => {
        const els = [r].concat(Array.from(r.querySelectorAll('*')));
        return els.some(el => Array.from(el.attributes || [])
          .some(a => a.value && a.value.indexOf(id) >= 0));
      });
      if (byId) { currentRow = byId; currentHow = 'URL-ID'; return rows; }
    }
    // 3) 底色兜底
    const colored = rows.find(r => visible(r) &&
      !['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'].includes(getComputedStyle(r).backgroundColor));
    if (colored) { currentRow = colored; currentHow = '底色兜底'; return rows; }

    currentRow = null; currentHow = '未定位';
    return rows;
  }

  /* ================= 学习用户点击（同步保存，防刷新丢失） ================= */
  document.addEventListener('click', e => {
    if (!e.isTrusted) return;
    const t = e.target;
    if (!t || !t.getBoundingClientRect) return;
    const r = t.getBoundingClientRect();
    if (r.left < 0 || r.left > innerWidth * 0.5) return;
    const row = targetToRow(t);
    if (!row) return;

    // 必须同步写入：点击后页面可能立即整页刷新
    const rowPath = buildPath(row);
    if (rowPath) {
      saveMemory({
        rowPath,
        title: rowTitle(row),
        resId: currentResourceId(),
        t: Date.now()
      });
      currentRow = row; currentHow = '本次点击';
      log('已学习并持久化：' + rowTitle(row));
    }
  }, true);

  /* ================= 切换下一条 ================= */
  let switching = false;

  async function triggerNext() {
    if (switching) { warn('切换中，忽略重复触发'); return; }
    switching = true;
    try {
      await sleep(3000);
      const rows = restoreCurrent();
      if (!currentRow) { warn('❌ 当前条目未定位，请先手动点击一个左侧视频'); return; }

      const idx = rows.indexOf(currentRow);
      log('当前[' + currentHow + ']：' + rowTitle(currentRow) + '（共' + rows.length + '条，位置#' + (idx + 1) + '）');

      const target = rows[idx + 1];
      if (!target) { warn('❌ 已经是最后一个视频'); return; }

      // 目标在折叠单元里则先展开
      if (!visible(target)) {
        log('下一条在折叠单元中，先展开…');
        const ok = await ensureRowVisible(target);
        if (!ok) { warn('❌ 无法展开下一条所在单元，请点【复制诊断】'); return; }
      }

      // 关键：点击刷新前，先把下一行路径持久化
      const path = buildPath(target);
      if (!path) { warn('❌ 无法生成下一条路径'); return; }
      saveMemory({ rowPath: path, title: rowTitle(target), resId: currentResourceId(), t: Date.now() });

      log('点击下一条：' + rowTitle(target));
      coordinateClick(target);

      // 页面通常整页刷新；若没有刷新，1.5s 后复查
      await sleep(1500);
      const stillHere = document.contains(target) && currentResourceId() === loadMemory().resId;
      if (stillHere) warn('点击后页面未刷新/未跳转，请点【复制诊断】');
    } catch (e) {
      warn('❌ 切换异常：' + e.message);
    } finally {
      setTimeout(() => { switching = false; }, 1000);
    }
  }

  function forcePlay() {
    const v = findVideo();
    if (v && v.paused && v.play) v.play().catch(() => {});
  }

  /* ================= 视频监听 ================= */
  let endLock = 0;
  function bindVideo(v) {
    if (!v || v.__zhs7Bound) return;
    v.__zhs7Bound = true;
    log('已绑定正片 <video>');
    v.addEventListener('ended', () => {
      if (Date.now() - endLock > 8000) { endLock = Date.now(); log('视频 ended'); triggerNext(); }
    });
    v.addEventListener('loadstart', () => { endLock = 0; applySpeed(v); });
    // 每次开始播放（含整页刷新后首次播放、切换下一条）都强制锁定倍速
    v.addEventListener('play', () => { applySpeed(v); });
    v.addEventListener('ratechange', () => {
      // 播放器自身在加载新源时可能把倍速重置回 1，异步纠正
      if (v.playbackRate !== getSpeed()) setTimeout(() => applySpeed(v), 0);
    });
    v.addEventListener('timeupdate', () => {
      if (Date.now() - endLock > 8000 && v.duration > 5 && v.currentTime >= v.duration - 1) {
        endLock = Date.now();
        log('进度到片尾（兜底）');
        triggerNext();
      }
    });
  }

  /* ================= 弹题 ================= */
  function handleQuiz() {
    if (!CFG.autoCloseQuiz) return;
    document.querySelectorAll('[class*="dialog" i],[class*="modal" i],[class*="popup" i],[role="dialog"]').forEach(box => {
      if (!visible(box) || box.__zh7Handled) return;
      if (!/(单选|多选|判断|本题|习题|答题|问答)/.test(box.textContent || '')) return;
      const close = box.querySelector('[class*="close" i],[aria-label*="关闭" i]') ||
        Array.from(box.querySelectorAll('button,span,div,i')).find(e =>
          ['×', '✕', '关闭'].includes((e.textContent || '').trim()));
      if (close) {
        box.__zh7Handled = true;
        log('弹题已自动关闭');
        coordinateClick(close);
        setTimeout(forcePlay, 800);
      }
    });
  }

  setInterval(() => {
    const v = findVideo();
    if (v) {
      bindVideo(v);
      applySpeed(v);
      const nearEnd = v.duration > 0 && v.currentTime >= v.duration - 1.5;
      if (CFG.resumeWhenBlurred && v.paused && !nearEnd &&
          (document.visibilityState !== 'visible' || !document.hasFocus())) {
        v.play().catch(() => {});
      }
    }
    handleQuiz();
  }, CFG.interval);

  /* ================= 浮层 ================= */
  let panel, listEl, statEl, rowsEl, speedBtnEl, collapsed = false, rowsCollapsed = false;

  function buildPanel() {
    if (panel) return;
    const host = document.body || document.documentElement;
    if (!host) return;

    panel = document.createElement('div');
    panel.style.cssText = 'all:initial;position:fixed!important;right:10px!important;bottom:10px!important;z-index:2147483647!important;width:380px!important';
    panel.innerHTML =
      '<div style="font:12px/1.5 Consolas,monospace;box-shadow:0 6px 24px rgba(0,0,0,.4);border-radius:10px;overflow:hidden;background:rgba(18,22,28,.94);color:#e6edf3">' +
        '<div id="zh7-head" style="padding:7px 10px;background:#0a7d33;cursor:pointer;font-weight:bold">连播 v7<span style="float:right" id="zh7-toggle">—</span></div>' +
        '<div id="zh7-body">' +
          '<div id="zh7-stat" style="padding:7px 10px 3px"></div>' +
          '<div id="zh7-hint" style="padding:0 10px 5px;color:#d29922;font-size:11px;line-height:1.4">提示：若“下一条”标题与左侧目录不符，请点击左侧目录中的当前视频刷新一下</div>' +

          // ===== 调试：条目数组检视（仅 debug=true 时显示） =====
          '<div id="zh7-rows-head" style="display:none;padding:5px 10px;background:#30363d;cursor:pointer;border-top:1px solid #444">' +
            '🔍 条目数组检视（collectRows）<span style="float:right" id="zh7-rows-toggle">—</span></div>' +
          '<div id="zh7-rows-body" style="display:none;max-height:230px;overflow:auto;padding:4px 10px"></div>' +

          '<div id="zh7-list" style="padding:4px 10px;max-height:120px;overflow:auto;border-top:1px solid #30363d"></div>' +
          '<div style="padding:7px 10px;display:flex;gap:6px">' +
            '<button id="zh7-next" style="flex:1;padding:5px;border:0;border-radius:6px;background:#1f6feb;color:#fff;cursor:pointer">手动下一条</button>' +
            '<button id="zh7-play" style="display:none;flex:1;padding:5px;border:0;border-radius:6px;background:#21262d;color:#e6edf3;cursor:pointer">强制播放</button>' +
            '<button id="zh7-speed" style="flex:1;padding:5px;border:0;border-radius:6px;background:#21262d;color:#e6edf3;cursor:pointer">倍速 1.0x</button>' +
            '<button id="zh7-diag" style="display:none;flex:1;padding:5px;border:0;border-radius:6px;background:#21262d;color:#e6edf3;cursor:pointer">复制诊断</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    host.appendChild(panel);

    document.getElementById('zh7-head').onclick = () => {
      collapsed = !collapsed;
      document.getElementById('zh7-body').style.display = collapsed ? 'none' : 'block';
      document.getElementById('zh7-toggle').textContent = collapsed ? '+' : '—';
    };
    document.getElementById('zh7-rows-head').onclick = () => {
      rowsCollapsed = !rowsCollapsed;
      document.getElementById('zh7-rows-body').style.display = rowsCollapsed ? 'none' : 'block';
      document.getElementById('zh7-rows-toggle').textContent = rowsCollapsed ? '+' : '—';
    };
    document.getElementById('zh7-next').onclick = () => triggerNext();
    document.getElementById('zh7-play').onclick = forcePlay;
    document.getElementById('zh7-diag').onclick = copyDiagnostic;
    speedBtnEl = document.getElementById('zh7-speed');
    speedBtnEl.onclick = () => {
      const cur = getSpeed();
      const list = CFG.speeds;
      const next = list[(list.indexOf(cur) + 1) % list.length];
      setSpeed(next);
      applySpeed(findVideo());
      log('倍速已设为 ' + next + 'x');
    };
    listEl = document.getElementById('zh7-list');
    statEl = document.getElementById('zh7-stat');
    rowsEl = document.getElementById('zh7-rows-body');

    // 仅调试模式显示：强制播放 / 复制诊断 / 条目数组检视
    const dbg = debugOn();
    document.getElementById('zh7-play').style.display = dbg ? 'block' : 'none';
    document.getElementById('zh7-diag').style.display = dbg ? 'block' : 'none';
    document.getElementById('zh7-rows-head').style.display = dbg ? 'block' : 'none';
    document.getElementById('zh7-rows-body').style.display = dbg && !rowsCollapsed ? 'block' : 'none';

    // 启动时尝试恢复记忆
    const mem = loadMemory();
    log('v7 已启动' + (dbg ? '（debug 模式）' : '') + (mem ? '，检测到持久记忆：' + (mem.title || '') : '，无持久记忆，请手动点一个左侧视频'));
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 渲染条目数组：真实下标顺序 + 标签/class/标题/可见性/当前标记
  function renderRowsInspector(rows) {
    if (!rowsEl) return;
    const head = '<div style="color:#8b949e;margin-bottom:3px">数组长度: ' + rows.length +
      '（顺序即 collectRows() 返回顺序）</div>';
    rowsEl.innerHTML = head + rows.map((r, i) => {
      const isCur = r === currentRow;
      const tag = r.tagName ? r.tagName.toLowerCase() : '?';
      const cls = (r.getAttribute && r.getAttribute('class')) || '';
      const title = rowTitle(r);
      const v = visible(r);
      const bg = (function () { try { return getComputedStyle(r).backgroundColor; } catch (e) { return ''; } })();
      const bgHas = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)';

      const c = isCur ? '#7ee787' : v ? '#c9d1d9' : '#8b949e';
      return '<div style="color:' + c + ';background:' + (isCur ? 'rgba(63,185,80,.12)' : 'transparent') +
        ';padding:1px 3px;white-space:nowrap">' +
        '[' + i + '] ' + (isCur ? '★' : v ? ' ' : '·') + ' ' +
        '&lt;' + tag + '&gt; ' +
        '<span style="color:#ffa657">' + esc(cls.slice(0, 42)) + '</span>' +
        '<br><span style="padding-left:22px">标题: ' + esc(title || '(空)') +
        (v ? '' : ' [隐藏]') + (bgHas ? ' [有底色]' : '') +
        '</span></div>';
    }).join('');
  }

  function renderPanel() {
    if (!panel) { buildPanel(); if (!panel) return; }
    const v = findVideo();
    if (speedBtnEl) speedBtnEl.textContent = '倍速 ' + getSpeed().toFixed(2).replace(/0$/, '') + 'x';
    const rows = restoreCurrent();
    let nextName = '';
    if (currentRow) {
      const i = rows.indexOf(currentRow);
      nextName = i >= 0 && rows[i + 1] ? rowTitle(rows[i + 1]) : '已到最后一条';
    }
    let html = '<div style="color:#7ee787">正片: ' + (v ? fmt(v.currentTime) + '/' + fmt(v.duration) + (v.paused ? ' ⏸' : ' ▶') : '无') + '</div>';
    html += '<div style="color:#7ee787">当前[' + currentHow + ']: ' + (currentRow ? rowTitle(currentRow) : '未定位') + '</div>';
    html += '<div style="color:#8bb4ff">下一条 → ' + nextName + '</div>';
    statEl.innerHTML = html;

    if (debugOn()) renderRowsInspector(rows);

    listEl.innerHTML = lines.slice(-7).map(l =>
      '<div style="color:' + (l.level === 'warn' ? '#f0883e' : '#c9d1d9') + '">' + l.time.slice(3) + ' ' + l.msg + '</div>').join('');
    listEl.scrollTop = listEl.scrollHeight;
  }

  /* ================= 诊断 ================= */
  function copyDiagnostic() {
    const mem = loadMemory();
    const rows = restoreCurrent();
    const pathOk = mem && mem.rowPath ? !!resolvePath(mem.rowPath) : false;
    const text = JSON.stringify({
      时间: new Date().toLocaleString(),
      网址: location.href,
      URL资源ID: currentResourceId(),
      持久记忆: mem,
      路径能否还原: pathOk,
      还原出的标题: pathOk ? rowTitle(resolvePath(mem.rowPath)) : null,
      条目数: rows.length,
      条目列表: rows.map((r, i) => ({
        n: i,
        标题: rowTitle(r),
        tag: r.tagName,
        class: r.getAttribute('class') || '',
        可见: visible(r)
      }))
    }, null, 2);

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    const b = document.getElementById('zh7-diag');
    const old = b.textContent;
    b.textContent = ok ? '✅已复制' : '失败';
    setTimeout(() => b.textContent = old, 2000);
  }

  (function waitMount() {
    buildPanel();
    if (!panel) setTimeout(waitMount, 5);
  })();
  setInterval(renderPanel, 2000);
})();
