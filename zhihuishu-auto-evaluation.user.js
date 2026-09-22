// ==UserScript==
// @name         题库正确答案悬浮窗 + 自动答题
// @namespace    https://github.com/qa-overlay
// @version      2.0.0
// @description  实时监听 batch-get-question-detail 请求获取正确答案，自动点击选项答题。多选题自动点提交，单选题点选项即提交。
// @author       you
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @noframes     false
// ==/UserScript==
/**
 * 使用说明
 * 1. 打开答题页面，浮层出现在右上角。
 * 2. 开关：「自动答题」按钮开启后，检测到新题目会自动选择正确答案。
 * 3. 多选题：自动选完选项后自动点提交按钮。
 * 4. 单选题/判断题：点选项即自动提交，无需额外操作。
 * 5. 交互：拖动标题栏移动；「复制」复制全部答案；「清空」清空；Alt+Q 显示/隐藏。
 */
(function () {
  'use strict';

  /* ========================= 配置 ========================= */
  const API_KEYWORDS = [
    'batch-get-question-detail',
    'question/batch-get-question-detail'
  ];
  const STORAGE_KEY = 'qa_overlay_answers_v1';
  const DEBUG = false;
  const log = (...a) => DEBUG && console.log('%c[正确答案浮层]', 'color:#22c55e', ...a);

  /* ========================= 状态 ========================= */
  /** key(contentHash) -> {questionId, questionName, content, result, letters, correct:[{letter,content}], time} */
  const answers = new Map();
  let autoAnswerEnabled = true; // 默认开启自动答题
  let answering = false; // 防止重复答题
  const answeredStems = new Set(); // 已答过的题干，防止重复
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
  function isTarget(url) {
    if (!url) return false;
    let u = String(url);
    try { u = decodeURIComponent(u); } catch (e) {}
    return API_KEYWORDS.some(k => u.indexOf(k) !== -1);
  }

  /* ========================= 响应解析 ========================= */
  function pickQuestionList(json) {
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.data)) return json.data;
    if (json.data && Array.isArray(json.data.list)) return json.data.list;
    if (Array.isArray(json.list)) return json.list;
    return [];
  }

  function normalize(json) {
    const out = [];
    const walk = (q) => {
      if (!q || typeof q !== 'object') return;
      const raw = Array.isArray(q.optionOpenDtos) ? q.optionOpenDtos : [];
      const opts = raw
        .filter(o => o && Number(o.isDeleted) !== 1)
        .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
      if (opts.length) {
        const mapped = opts.map((o, i) => ({
          letter: String.fromCharCode(65 + i),
          content: String(o.content == null ? '' : o.content),
          isCorrect: Number(o.isCorrect) === 1
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
      if (Array.isArray(q.childQuestionInfoOpenDtos)) q.childQuestionInfoOpenDtos.forEach(walk);
    };
    pickQuestionList(json).forEach(walk);
    return out;
  }

  function parseResponseText(text) {
    if (typeof text !== 'string' || !text) return [];
    let s = text.trim();
    if (!s) return [];
    const c = s.charCodeAt(0);
    if (c !== 123 && c !== 91) {
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

  /* ========================= 自动答题逻辑 ========================= */

  /**
   * 根据题干文本匹配答案
   * 先精确匹配 hash，再模糊匹配（去除空格/标点后比较）
   */
  function findAnswerByStem(stemText) {
    if (!stemText) return null;

    // 1. 精确匹配
    const exactKey = simpleHash(stemText);
    if (answers.has(exactKey)) return answers.get(exactKey);

    // 2. 模糊匹配：遍历所有答案，比较题干相似度
    const normalize = (s) => String(s).replace(/[\s\u3000，。、；：！？""''（）()【】\[\].,;:!?'"]/g, '');
    const stemNorm = normalize(stemText);

    let bestMatch = null;
    let bestScore = 0;

    for (const [key, ans] of answers) {
      const ansNorm = normalize(ans.content);
      if (!ansNorm) continue;

      // 简单的包含关系匹配
      if (stemNorm.includes(ansNorm) || ansNorm.includes(stemNorm)) {
        const score = Math.min(stemNorm.length, ansNorm.length) / Math.max(stemNorm.length, ansNorm.length);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = ans;
        }
      }
    }

    return bestScore > 0.6 ? bestMatch : null;
  }

  /**
   * 从 DOM 中提取最新的未答题题目信息
   * 聊天界面中多道题都在 DOM 里，取最后一个、且未显示"答案是："的题目
   */
  function getCurrentQuestion() {
    const allQuizItems = document.querySelectorAll('.quiz-item');
    if (!allQuizItems.length) return null;

    // 从后往前找，找最后一个还没显示答案的题目
    let quizItem = null;
    for (let i = allQuizItems.length - 1; i >= 0; i--) {
      const item = allQuizItems[i];
      // 如果这道题已经显示了答案，说明是已答过的，跳过
      if (item.textContent.includes('答案是：')) continue;
      quizItem = item;
      break;
    }

    if (!quizItem) return null;

    // 题干
    const stemEl = quizItem.querySelector('.quiz-item__stem');
    const stem = stemEl ? stemEl.textContent.trim() : '';

    // 题型
    const typeEl = quizItem.querySelector('.quiz-item__type');
    const typeText = typeEl ? typeEl.textContent.trim() : '';

    // 选项 - 支持多种选项结构
    let optionEls = quizItem.querySelectorAll('.quiz-option');

    // 如果没找到 .quiz-option，尝试其他常见的选项类名（判断题可能不同）
    if (!optionEls.length) {
      // 排除整个 quiz-item 本身，只找子元素中像选项的
      optionEls = quizItem.querySelectorAll(
        '.quiz-options > div, .quiz-options > [class*="option"], ' +
        '[class*="option-item"], [class*="choice-item"], [class*="answer-item"], ' +
        '[class*="judge-option"], [class*="single-option"]'
      );
    }

    // 如果还是没找到，尝试找所有可点击的子元素（判断题兜底）
    if (!optionEls.length) {
      const allChildren = quizItem.querySelectorAll('div, span, button, li');
      optionEls = Array.from(allChildren).filter(el => {
        const text = el.textContent.trim();
        // 判断题选项通常很短，就是"正确"或"错误"两个字
        return text.length <= 4 && (text === '正确' || text === '错误' || text === '对' || text === '错');
      });
    }

    const options = Array.from(optionEls).map((el, idx) => {
      const keyEl = el.querySelector('.quiz-option__key, [class*="option-key"], [class*="label"], [class*="option-letter"]');
      const textEl = el.querySelector('.quiz-option__text, [class*="option-text"], [class*="content"], [class*="option-content"]');

      // 统一按顺序生成 A/B/C... 字母，因为接口返回的答案也是按这个顺序的
      // 不管页面上显示的是 ✓/✗ 还是 A/B/C，都用索引对应的字母
      const autoLetter = String.fromCharCode(65 + idx);
      const keyText = keyEl ? keyEl.textContent.trim() : '';

      return {
        index: idx, // 用索引作为唯一标识
        letter: autoLetter, // 统一用 A/B/C... 顺序字母
        keyText: keyText, // 原始 key 文本（如 ✓/✗）
        text: textEl ? textEl.textContent.trim() : el.textContent.trim(),
        element: el
      };
    });

    // 如果没有选项，说明题目还没渲染完
    if (!options.length) return null;

    // 是否有提交按钮（多选题有，单选/判断没有）
    const submitBtn = quizItem.querySelector('.quiz-submit-btn');
    const hasSubmitBtn = !!submitBtn;

    return { stem, typeText, options, hasSubmitBtn, element: quizItem, submitBtn };
  }

  /**
   * 把答案转换成要点击的选项索引列表
   * 兼容：多选题 "ABC"、单选题 "A"、判断题 "正确"/"错误"
   */
  function resolveAnswerLetters(answerStr, options) {
    const normalized = answerStr.replace(/\s/g, '');

    // 1. 如果答案是纯字母（A、B、AB、ABC 等），拆分成单个字母
    if (/^[A-E]+$/.test(normalized)) {
      return normalized.split(''); // "ABC" -> ["A", "B", "C"]
    }

    // 2. 如果答案是带分隔符的字母（A,B 或 A、B）
    if (/^[A-E,，、]+$/.test(normalized)) {
      return normalized.split(/[,，、]+/).filter(Boolean);
    }

    // 3. 判断题的文字答案转换
    const trueWords = ['正确', '对', '√', 'T', 'true', '对的', '是', 'yes'];
    const falseWords = ['错误', '错', '×', 'F', 'false', '错的', '否', 'no'];

    // 先尝试按文字匹配选项
    const matched = [];
    options.forEach(opt => {
      const optText = opt.text.replace(/\s/g, '');
      // 答案包含"正确"类词，且选项文本也包含"正确"类词
      if (trueWords.some(w => optText.includes(w)) && trueWords.some(w => normalized.includes(w))) {
        matched.push(opt.letter);
      }
      // 答案包含"错误"类词，且选项文本也包含"错误"类词
      if (falseWords.some(w => optText.includes(w)) && falseWords.some(w => normalized.includes(w))) {
        matched.push(opt.letter);
      }
    });

    if (matched.length) return matched;

    // 4. 兜底：答案包含"正确"就点第一个选项，包含"错误"就点第二个
    if (trueWords.some(w => normalized.includes(w)) && options.length > 0) {
      return [options[0].letter];
    }
    if (falseWords.some(w => normalized.includes(w)) && options.length > 1) {
      return [options[1].letter];
    }

    // 5. 最后兜底：返回原答案
    return [normalized];
  }

  /**
   * 自动答题主逻辑
   */
  function autoAnswer() {
    if (!autoAnswerEnabled || answering) return;

    const question = getCurrentQuestion();
    if (!question) return;

    // 已经答过的题直接跳过（DOM 中显示了答案）
    if (question.element.textContent.includes('答案是：')) return;

    // 用题干 hash 判断是否已经答过这道题
    const stemKey = simpleHash(question.stem);
    if (answeredStems.has(stemKey)) return;

    const answer = findAnswerByStem(question.stem);
    if (!answer) {
      log('未匹配到答案，等待...', question.stem.substring(0, 50));
      return;
    }

    // 标记为已答，防止重复
    answeredStems.add(stemKey);

    log(`匹配到答案: ${answer.letters}`, question.stem.substring(0, 30));
    answering = true;

    // 根据答案，解析出要点击的选项字母（兼容判断题文字答案）
    const answerLetters = resolveAnswerLetters(answer.letters, question.options);
    let clicked = 0;

    question.options.forEach(opt => {
      if (answerLetters.includes(opt.letter)) {
        // 检查是否已选中
        const isSelected = opt.element.classList.contains('selected') ||
                          opt.element.classList.contains('active') ||
                          opt.element.getAttribute('aria-selected') === 'true' ||
                          opt.element.getAttribute('class').includes('checked') ||
                          opt.element.getAttribute('class').includes('chosen');

        if (!isSelected) {
          setTimeout(() => {
            opt.element.click();
            log(`点击选项 ${opt.letter}`);
          }, clicked * 300); // 间隔 300ms 逐个点击
          clicked++;
        }
      }
    });

    // 点击完所有选项后处理
    setTimeout(() => {
      if (question.hasSubmitBtn) {
        // 多选题：点击提交按钮
        log('多选题，点击提交按钮');
        setTimeout(() => {
          // 重新获取提交按钮，防止 DOM 更新后元素失效
          const currentQuestion = getCurrentQuestion();
          if (currentQuestion && currentQuestion.submitBtn) {
            currentQuestion.submitBtn.click();
            log('已点击提交');
          }
          // 短时间后释放锁，等待下一题
          setTimeout(() => { answering = false; }, 800);
        }, 600);
      } else {
        // 单选题/判断题：点击选项即自动提交，不需要额外操作
        log('单选题，点击选项即自动提交');
        setTimeout(() => { answering = false; }, 800);
      }
    }, clicked * 300 + 500);
  }

  /**
   * 检测并点击"提交测评并查看报告"按钮
   */
  function checkFinishButton() {
    if (!autoAnswerEnabled) return;

    // 1. 优先用精确 class 选择器（最可靠）
    const finishBtn = document.querySelector('.submit-view-report-btn');
    if (finishBtn) {
      log('检测到完成按钮（class匹配）: ' + finishBtn.textContent.trim(), '点击...');
      finishBtn.click();
      // 点击完成后清空浮层信息
      setTimeout(() => {
        log('已清空浮层答案');
        clearAll();
      }, 500);
      return true;
    }

    // 2. 备选：用文字匹配各种按钮
    const allEls = document.querySelectorAll('button, [class*="btn"], [class*="submit"], [class*="finish"], a, div');
    for (const el of allEls) {
      const text = el.textContent.trim();
      if (!text || text.length > 30) continue;

      // 匹配完成相关的各种文字变体
      const matchPatterns = [
        /提交.*报告/,
        /查看.*报告/,
        /完成.*测评/,
        /提交.*测评/,
        /生成.*报告/,
        /查看.*成绩/
      ];

      if (matchPatterns.some(p => p.test(text))) {
        log('检测到完成按钮（文字匹配）: ' + text, '点击...');
        el.click();
        // 点击完成后清空浮层信息
        setTimeout(() => {
          log('已清空浮层答案');
          clearAll();
        }, 500);
        return true;
      }
    }
    return false;
  }

  /**
   * 监听 DOM 变化 + 轮询，检测新题目出现
   */
  function startObserver() {
    // 1. MutationObserver 监听 DOM 变化
    const observer = new MutationObserver((mutations) => {
      if (!autoAnswerEnabled) return;

      // 只要有 DOM 变化，就尝试检测新题目和完成按钮
      setTimeout(() => {
        autoAnswer();
        checkFinishButton();
      }, 300);
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    log('DOM Observer 已启动');

    // 2. 轮询机制作为备用（每 1.5 秒检查一次）
    // 防止某些场景 MutationObserver 没触发
    setInterval(() => {
      if (autoAnswerEnabled && !answering) {
        autoAnswer();
        checkFinishButton();
      }
    }, 1500);

    log('轮询已启动');

    // 页面加载完成后也尝试答一次
    window.addEventListener('load', () => {
      setTimeout(() => {
        autoAnswer();
        checkFinishButton();
      }, 1000);
    });
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
  .dot.off{background:#6b7280;box-shadow:none}
  .title{font-weight:600;font-size:13px;color:#fff;white-space:nowrap}
  .badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#22c55e;color:#04170a;
    font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
  .sp{flex:1}
  .btn{all:unset;cursor:pointer;font-size:11px;line-height:1;color:#b9c3d3;padding:4px 7px;border-radius:6px;
    border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)}
  .btn:hover{color:#fff;background:rgba(255,255,255,.14)}
  .btn.active{color:#04170a;background:#22c55e;border-color:#22c55e;font-weight:600}
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
      badgeEl = null, ballEl = null, ballNumEl = null, btnCopyEl = null, btnAutoEl = null;
  let collapsed = false, hidden = false;

  function ensureUI() {
    if (!isTop) return;
    if (hostEl) {
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
          <span class="dot" id="dot"></span>
          <span class="title">正确答案</span>
          <span class="badge" id="badge">0</span>
          <span class="sp"></span>
          <button class="btn" id="btnAuto" title="自动答题开关">自动答题</button>
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
    btnAutoEl  = shadow.getElementById('btnAuto');
    const dotEl = shadow.getElementById('dot');

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

    // ---- 自动答题开关 ----
    btnAutoEl.addEventListener('click', () => {
      autoAnswerEnabled = !autoAnswerEnabled;
      btnAutoEl.classList.toggle('active', autoAnswerEnabled);
      dotEl.classList.toggle('off', !autoAnswerEnabled);
      log('自动答题:', autoAnswerEnabled ? '开启' : '关闭');
      if (autoAnswerEnabled) {
        // 开启后立即尝试答当前题
        setTimeout(autoAnswer, 500);
      }
    });

    // 设置初始状态（默认开启）
    btnAutoEl.classList.toggle('active', autoAnswerEnabled);
    dotEl.classList.toggle('off', !autoAnswerEnabled);

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

  // 顶层接收 iframe 转发的数据
  if (isTop) {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.__qaOverlay && d.type === 'data') ingest(d.payload);
    });
  }

  /* ========================= 启动 ========================= */
  hookXHR();
  hookFetch();

  const ready = () => {
    if (isTop) {
      hookXHR(); hookFetch();
      load();
      ensureUI();
      render();
      startObserver(); // 启动自动答题的 DOM 监听
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

  // 保活
  setInterval(() => { hookXHR(); hookFetch(); }, 2000);
})();
