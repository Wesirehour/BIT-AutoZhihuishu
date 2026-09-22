// ==UserScript==
// @name         题库正确答案悬浮窗（batch-get-question-detail）
// @namespace    https://github.com/qa-overlay
// @version      1.0.0
// @description  实时监听 XHR / fetch 发出的 question/batch-get-question-detail 请求，解析响应里 isCorrect=1 的选项作为正确答案，显示在可拖拽浮层上。支持多次请求累加、去重、复制、清空、跨 iframe 汇总。
// @author       you
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @noframes     false
// ==/UserScript==

/**
 * 使用说明
 * 1. 安装后打开答题页面，浮层会出现在右上角（绿色小圆点表示运行中）。
 * 2. 页面每发一次 batch-get-question-detail 请求，答案就会自动累加到列表里（同一道题只保留一份）。
 * 3. 交互：拖动标题栏移动；「复制」复制全部答案；「清空」清空并删除本地缓存；「—」收起成悬浮球；Alt+Q 显示/隐藏。
 * 4. 答案会存 localStorage，刷新页面不丢。想改监听接口只改 API_KEYWORDS 即可。
 */
(function () {
  'use strict';

  /* ========================= 配置 ========================= */
  const API_KEYWORDS = [
    'batch-get-question-detail',
    'question/batch-get-question-detail'
  ];
  const STORAGE_KEY = 'qa_overlay_answers_v1';
  const DEBUG = false; // 改 true 可在控制台看到命中日志
  const log = (...a) => DEBUG && console.log('%c[正确答案浮层]', 'color:#22c55e', ...a);

  /* ========================= 状态 ========================= */
  /** key(contentHash) -> {questionId, questionName, content, result, letters, correct:[{letter,content}], time} */
  const answers = new Map();
  const isTop = (() => { try { return window.top === window.self; } catch (e) { return false; } })();

  /* ========================= 工具 ========================= */
  function simpleHash(str) {
    let h = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 判断 URL 是否是目标接口 */
  function isTarget(url) {
    if (!url) return false;
    let u = String(url);
    try { u = decodeURIComponent(u); } catch (e) {}
    return API_KEYWORDS.some(k => u.indexOf(k) !== -1);
  }

  /* ========================= 响应解析 ========================= */
  /** 从 JSON 对象里取出题目数组（兼容 data / data.list / 直接数组） */
  function pickQuestionList(json) {
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.data)) return json.data;
    if (json.data && Array.isArray(json.data.list)) return json.data.list;
    if (Array.isArray(json.list)) return json.list;
    return [];
  }

  /** 把接口返回的题目结构，规整成「题干 + 正确答案」 */
  function normalize(json) {
    const out = [];
    const walk = (q) => {
      if (!q || typeof q !== 'object') return;

      const raw = Array.isArray(q.optionOpenDtos) ? q.optionOpenDtos : [];
      // 过滤已删除选项，按 sort 排序，序号决定选项字母 A/B/C/D...
      const opts = raw
        .filter(o => o && Number(o.isDeleted) !== 1)
        .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));

      if (opts.length) {
        const mapped = opts.map((o, i) => ({
          letter: String.fromCharCode(65 + i),           // 0->A 1->B ...
          content: String(o.content == null ? '' : o.content),
          isCorrect: Number(o.isCorrect) === 1            // 只有 === 1 才算正确答案
        }));
        const correct = mapped.filter(o => o.isCorrect);

        if (correct.length) {
          out.push({
            questionId: q.id != null ? q.id : null,
            questionType: q.questionType,
            questionName: q.questionName || '',
            content: q.content || '',
            result: q.result || '',
            letters: correct.map(o => o.letter).join(''),
            correct: correct.map(o => ({ letter: o.letter, content: o.content })),
            time: Date.now()
          });
        }
      }

      // 小题（套题）也递归抓一遍
      if (Array.isArray(q.childQuestionInfoOpenDtos)) q.childQuestionInfoOpenDtos.forEach(walk);
    };

    pickQuestionList(json).forEach(walk);
    return out;
  }

  /** 文本 -> 题目列表；容错处理非标准 JSON 前缀（如 )]}'） */
  function parseResponseText(text) {
    if (typeof text !== 'string' || !text) return [];
    let s = text.trim();
    if (!s) return [];

    const c = s.charCodeAt(0);
    if (c !== 123 /* { */ && c !== 91 /* [ */) {
      const i = s.indexOf('{'), j = s.indexOf('[');
      const k = (i === -1) ? j : (j === -1 ? i : Math.min(i, j));
      if (k === -1) return [];
      s = s.slice(k);
    }

    let json;
    try { json = JSON.parse(s); } catch (e) { return []; }
    return normalize(json);
  }

  /* ========================= 数据入库 ========================= */
  /** 非顶层 iframe：把数据 postMessage 给顶层，由顶层统一展示 */
  function forwardToTop(items) {
    try {
      if (window.top && window.top !== window.self) {
        window.top.postMessage({ __qaOverlay: true, type: 'data', payload: items }, '*');
      }
    } catch (e) {}
  }

  function ingest(items) {
    if (!items || !items.length) return;
    let changed = false;

    items.forEach(it => {
      const key = it.content ? simpleHash(it.content) : ('id:' + it.questionId);
      const prev = answers.get(key);
      if (prev && prev.letters === it.letters && prev.content === it.content) return;
      answers.set(key, it);
      changed = true;
      log('捕获答案：', it.letters, it.content);
    });

    if (changed) { render(); save(); }
  }

  /** 从任意来源（字符串 / 对象）接收响应 */
  function handlePayload(payload) {
    let items = [];
    if (typeof payload === 'string') items = parseResponseText(payload);
    else if (payload && typeof payload === 'object') items = normalize(payload);
    if (!items.length) return;

    if (isTop) ingest(items);
    else forwardToTop(items);
  }

  /* ========================= 本地缓存 ========================= */
  function save() {
    if (!isTop) return;
    try {
      const list = Array.from(answers.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, t: Date.now(), list }));
    } catch (e) {}
  }

  function load() {
    if (!isTop) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.list)) {
        obj.list.forEach(it => {
          if (it && it.content != null) answers.set(simpleHash(it.content) || ('id:' + it.questionId), it);
        });
      }
    } catch (e) {}
  }

  function clearAll() {
    answers.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    render();
  }

  /* ========================= 浮层 UI ========================= */
  const CSS = `
  *{box-sizing:border-box}
  .panel{width:344px;max-width:92vw;background:linear-gradient(180deg,rgba(24,26,32,.97),rgba(17,19,24,.97));
    border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 14px 36px rgba(0,0,0,.5);
    color:#eaeef5;font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden;backdrop-filter:blur(10px)}
  .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(255,255,255,.05);
    border-bottom:1px solid rgba(255,255,255,.08);cursor:move;user-select:none}
  .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;flex:0 0 auto}
  .title{font-weight:600;font-size:13px;color:#fff;white-space:nowrap}
  .badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#22c55e;color:#04170a;
    font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
  .sp{flex:1}
  .btn{all:unset;cursor:pointer;font-size:11px;line-height:1;color:#b9c3d3;padding:4px 7px;border-radius:6px;
    border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)}
  .btn:hover{color:#fff;background:rgba(255,255,255,.14)}
  .bd{max-height:min(66vh,560px);overflow:auto;padding:8px}
  .bd::-webkit-scrollbar{width:8px}
  .bd::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:4px}
  .empty{text-align:center;color:#8b95a7;padding:20px 0;font-size:12px;line-height:2}
  .empty-sub{font-size:11px;color:#5f6a7d;font-family:Consolas,Monaco,monospace}
  .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:9px;
    padding:9px 10px;margin-bottom:8px}
  .card:last-child{margin-bottom:2px}
  .q{color:#dbe3f0;font-size:12.5px;line-height:1.6;word-break:break-word}
  .tag{display:inline-block;font-size:10px;color:#7fd4a5;border:1px solid rgba(34,197,94,.4);
    background:rgba(34,197,94,.12);border-radius:4px;padding:0 4px;margin-right:5px;vertical-align:1px}
  .ans{display:flex;align-items:center;gap:8px;margin:8px 0 5px}
  .letters{font:700 14px/1 Consolas,Monaco,monospace;color:#052e16;
    background:linear-gradient(180deg,#4ade80,#22c55e);padding:5px 10px;border-radius:6px;letter-spacing:1px}
  .hint{font-size:11px;color:#7dd3a0}
  .opts{list-style:none;margin:0;padding:0}
  .opts li{display:flex;gap:7px;font-size:12px;color:#c9d3e2;padding:2px 0;word-break:break-word}
  .opts li b{color:#4ade80;font-weight:700;flex:0 0 auto;font-family:Consolas,Monaco,monospace}
  .meta{font-size:10px;color:#5f6a7d;margin-top:5px;text-align:right}
  .ball{display:none;width:46px;height:46px;border-radius:50%;background:linear-gradient(180deg,#4ade80,#16a34a);
    color:#04170a;font-weight:700;font-size:13px;align-items:center;justify-content:center;
    box-shadow:0 8px 22px rgba(0,0,0,.45);cursor:pointer;user-select:none;position:relative}
  .ballNum{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:#ef4444;
    color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0 4px}
  `;

  let hostEl = null, shadow = null, panelEl = null, listEl = null,
      badgeEl = null, ballEl = null, ballNumEl = null, btnCopyEl = null;
  let collapsed = false, hidden = false;

  function ensureUI() {
    if (!isTop) return;
    if (hostEl) {
      // 某些 SPA 会重绘页面，导致节点被移除，这里做兜底重挂
      if (!hostEl.isConnected) (document.body || document.documentElement).appendChild(hostEl);
      return;
    }

    hostEl = document.createElement('div');
    hostEl.id = 'qa-overlay-host';
    hostEl.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="panel" id="panel">
        <div class="hd" id="hd">
          <span class="dot"></span>
          <span class="title">正确答案</span>
          <span class="badge" id="badge">0</span>
          <span class="sp"></span>
          <button class="btn" id="btnCopy">复制</button>
          <button class="btn" id="btnClear">清空</button>
          <button class="btn" id="btnMin" title="收起">—</button>
        </div>
        <div class="bd" id="bd"><div id="list"></div></div>
      </div>
      <div class="ball" id="ball" title="展开（Alt+Q）">答<span class="ballNum" id="ballNum">0</span></div>`;

    (document.body || document.documentElement).appendChild(hostEl);

    panelEl    = shadow.getElementById('panel');
    listEl     = shadow.getElementById('list');
    badgeEl    = shadow.getElementById('badge');
    ballEl     = shadow.getElementById('ball');
    ballNumEl  = shadow.getElementById('ballNum');
    btnCopyEl  = shadow.getElementById('btnCopy');

    // ---- 拖动 ----
    const hd = shadow.getElementById('hd');
    hd.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('button')) return;
      const rect = hostEl.getBoundingClientRect();
      const dx = ev.clientX - rect.left;
      const dy = ev.clientY - rect.top;
      hostEl.style.left = rect.left + 'px';
      hostEl.style.top = rect.top + 'px';
      hostEl.style.right = 'auto';
      const move = (e) => {
        const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dx));
        const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy));
        hostEl.style.left = x + 'px';
        hostEl.style.top = y + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      ev.preventDefault();
    });

    // ---- 收起 / 展开 ----
    shadow.getElementById('btnMin').addEventListener('click', () => setCollapsed(true));
    ballEl.addEventListener('click', () => setCollapsed(false));

    // ---- 复制 ----
    btnCopyEl.addEventListener('click', () => {
      const txt = buildPlainText();
      copyText(txt, () => {
        const old = btnCopyEl.textContent;
        btnCopyEl.textContent = answers.size ? '已复制' : '暂无';
        setTimeout(() => { btnCopyEl.textContent = old; }, 1200);
      });
    });

    // ---- 清空 ----
    shadow.getElementById('btnClear').addEventListener('click', clearAll);

    // ---- 全局快捷键 Alt+Q ----
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'q' || e.key === 'Q')) {
        hidden = !hidden;
        hostEl.style.display = hidden ? 'none' : '';
        e.preventDefault();
      }
    }, true);
  }

  function setCollapsed(v) {
    collapsed = v;
    if (panelEl) panelEl.style.display = v ? 'none' : '';
    if (ballEl) ballEl.style.display = v ? 'flex' : 'none';
    if (hostEl) { hostEl.style.top = '16px'; hostEl.style.left = 'auto'; hostEl.style.right = '16px'; }
  }

  function buildPlainText() {
    if (!answers.size) return '';
    const items = Array.from(answers.values()).sort((a, b) => b.time - a.time);
    return items.map((it, i) => {
      const opts = it.correct.map(o => `${o.letter}. ${o.content}`).join('\n');
      return `${i + 1}. ${it.content}\n答案：${it.letters}\n${opts}`;
    }).join('\n\n────────────\n\n');
  }

  function copyText(text, done) {
    if (!text) { done && done(); return; }
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (e) {}
      done && done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done && done()).catch(fallback);
    } else fallback();
  }

  function cardHTML(it) {
    const tag = it.questionName ? `<span class="tag">${escapeHtml(it.questionName)}</span>` : '';
    const opts = it.correct.map(o =>
      `<li><b>${escapeHtml(o.letter)}</b><span>${escapeHtml(o.content)}</span></li>`
    ).join('');
    const time = new Date(it.time || Date.now()).toLocaleTimeString();
    return `<div class="card">
      <div class="q">${tag}${escapeHtml(it.content)}</div>
      <div class="ans"><span class="letters">${escapeHtml(it.letters)}</span><span class="hint">正确答案</span></div>
      <ul class="opts">${opts}</ul>
      <div class="meta">${escapeHtml(time)}</div>
    </div>`;
  }

  function render() {
    if (!isTop) return;
    ensureUI();
    if (!hostEl) return;

    const items = Array.from(answers.values()).sort((a, b) => b.time - a.time);
    badgeEl.textContent = String(items.length);
    ballNumEl.textContent = String(items.length);

    if (!items.length) {
      listEl.innerHTML = `<div class="empty">等待接口数据…<br>
        <span class="empty-sub">question/batch-get-question-detail</span></div>`;
      return;
    }
    listEl.innerHTML = items.map(cardHTML).join('');
  }

  /* ========================= 注入拦截 ========================= */

  // 1) XMLHttpRequest（axios / jQuery 等底层大多走这个）
  function hookXHR() {
    const XHR = window.XMLHttpRequest;
    if (!XHR || !XHR.prototype || XHR.prototype.__qaHooked) return;

    const rawOpen = XHR.prototype.open;
    const rawSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try { this.__qaUrl = url == null ? '' : String(url); } catch (e) {}
      return rawOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      try {
        if (isTarget(this.__qaUrl)) {
          const self = this;
          const done = () => {
            if (self.__qaDone) return;
            self.__qaDone = true;
            let text = null;
            try {
              const rt = self.responseType;
              if (rt === '' || rt === 'text') text = self.responseText;
              else if (rt === 'json') text = self.response ? JSON.stringify(self.response) : null;
              else if (typeof self.response === 'string') text = self.response;
            } catch (e) { return; }
            if (text) handlePayload(text);
          };
          self.addEventListener('readystatechange', function () {
            if (self.readyState === 4) done();
          });
          self.addEventListener('load', done);
        }
      } catch (e) {}
      return rawSend.apply(this, arguments);
    };

    XHR.prototype.__qaHooked = true;
    log('XHR 已挂钩');
  }

  // 2) fetch
  function hookFetch() {
    const rawFetch = window.fetch;
    if (typeof rawFetch !== 'function' || rawFetch.__qaHooked) return;

    const wrapped = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = rawFetch.apply(this, arguments);
      if (!isTarget(url)) return p;
      return p.then((res) => {
        try {
          res.clone().text().then(t => handlePayload(t)).catch(() => {});
        } catch (e) {}
        return res;
      });
    };
    wrapped.__qaHooked = true;
    window.fetch = wrapped;
    log('fetch 已挂钩');
  }

  // 3) 顶层接收 iframe 转发的数据
  if (isTop) {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.__qaOverlay && d.type === 'data') ingest(d.payload);
    });
  }

  // 4) 接口随时可能被懒加载覆盖，定时保活（新出现的实现也会被挂上）
  hookXHR();
  hookFetch();

  const ready = () => {
    if (isTop) {
      hookXHR(); hookFetch();
      load();
      ensureUI();
      render();
      log('浮层就绪');
    } else {
      hookXHR(); hookFetch();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }

  // 部分页面会在运行时重写 XHR / fetch，这里低频复查一次
  setInterval(() => { hookXHR(); hookFetch(); }, 2000);
})();
