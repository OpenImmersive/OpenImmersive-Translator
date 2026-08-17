'use strict';

// 语灵灵 Content Script - 页面翻译与划词翻译
// 隐私保证：所有API调用通过background.js直接发往翻译服务商

(function () {
  // Interface language follows the browser (chrome.i18n). A missing key falls
  // back to the key name rather than a blank control.
  const T = (k) => {
    try { return (typeof browser !== 'undefined' ? browser : chrome).i18n.getMessage(k) || k; }
    catch { return k; }
  };
  if (window.__yllLoaded) return;
  window.__yllLoaded = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;

  // Storage 兼容层
  function storageGet(keys) {
    if (typeof browser !== 'undefined') return browser.storage.local.get(keys);
    return new Promise(r => chrome.storage.local.get(keys, r));
  }

  // ===== 状态 =====
  const state = {
    isTranslated: false,
    isTranslating: false,
    engine: 'google',
    targetLang: 'zh-CN',
    displayMode: 'bilingual', // 'bilingual' 双语对照 | 'replace' 仅显示译文
    translatedCount: 0,
    totalCount: 0,
    pageKey: location.href
  };

  // ===== 需要跳过翻译的标签 =====
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT',
    'IFRAME', 'SVG', 'MATH', 'BUTTON', 'INPUT',
    'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS'
  ]);

  const SKIP_ROLES = new Set([
    'navigation', 'menubar', 'menu', 'toolbar', 'search', 'banner',
    // 侧栏/页脚/标签条：都是界面而非正文（X 的「For you / Following」是 tablist）
    'complementary', 'contentinfo', 'tablist', 'tab'
  ]);

  // ===== 站点适配 =====
  // 通用规则在少数几个站上判不准，这里按站点补一条明确的「别碰这块」。
  // X：左侧导航、右栏（趋势/推荐关注/页脚链接）都是界面，沉浸式翻译两侧也都不翻；
  // 我们此前是"长词条翻、短词条不翻"，看起来像随机挑着翻。
  const SITE_SKIP = {
    x: '[data-testid="sidebarColumn"], [data-testid="DMDrawer"], [data-testid="primaryColumn"] [role="tablist"]',
  };

  function siteKey() {
    return /(^|\.)(x|twitter)\.com$/.test(location.hostname) ? 'x' : '';
  }

  const SITE = siteKey();

  // ===== 消息监听（来自popup）=====
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStatus') {
      sendResponse({
        isTranslated: state.isTranslated,
        isTranslating: state.isTranslating,
        translatedCount: state.translatedCount,
        totalCount: state.totalCount
      });
      return false;
    }

    if (msg.type === 'translatePage') {
      state.engine = msg.engine || state.engine;
      state.targetLang = msg.targetLang || state.targetLang;

      if (state.isTranslated) {
        removeTranslations();
        sendResponse({ status: 'removed' });
      } else {
        translatePage().then(() => {
          sendResponse({
            status: 'done',
            count: state.translatedCount,
            total: state.totalCount
          });
        }).catch(err => sendResponse({ status: 'error', message: err.message }));
        return true;
      }
      return false;
    }

    if (msg.type === 'removeTranslations') {
      removeTranslations();
      sendResponse({ status: 'removed' });
      return false;
    }

    if (msg.type === 'toggleTranslation') {
      if (state.isTranslated) {
        removeTranslations();
      } else {
        translatePage();
      }
      return false;
    }

    // 右键菜单「翻译选中文字」→ 复用划词气泡
    if (msg.type === 'translateSelection') {
      translateCurrentSelection();
      return false;
    }

    // popup 的「总是翻译该语言」开关需要知道当前页是什么语种
    if (msg.type === 'getPageLang') {
      sendResponse({ lang: detectPageLang() });
      return false;
    }
  });

  // ===== 快捷键：Alt+T / Alt+A 切换整页翻译，Alt+W 翻译整页 =====
  // Alt+A / Alt+W 对齐主流翻译插件的肌肉记忆，迁移用户按老习惯就能用。
  // 用 e.code 匹配字母：macOS 上按住 Alt 时 e.key 是组合字符（Alt+T='†'），
  // 只看 e.key 在 mac 真机上永远匹配不中。
  function pageHotkeyAction(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return null;
    const code = e.code || '';
    const k = /^Key[TAW]$/.test(code) ? code[3].toLowerCase() : String(e.key || '').toLowerCase();
    if (k === 't' || k === 'a') return 'toggle';
    if (k === 'w') return 'translate';
    return null;
  }

  document.addEventListener('keydown', (e) => {
    const action = pageHotkeyAction(e);
    if (!action) return;
    // 可编辑区不抢按键（Alt+字母在部分输入法/编辑器里有含义）
    if (editableTarget(e.target)) return;
    e.preventDefault();
    if (action === 'toggle') {
      if (state.isTranslated) removeTranslations();
      else translatePage();
    } else {
      // Alt+W：未译则译；已译则再跑一遍补翻动态新增内容（已译块会被跳过）
      translatePage();
    }
  });

  // ===== 划词翻译 =====
  let selPopup = null;
  let selTimer = null;

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('touchend', onMouseUp);

  async function onMouseUp(e) {
    if (!selectionEnabled) return;
    // 点击了自己的popup则忽略
    if (selPopup && selPopup.contains(e.target)) return;
    translateCurrentSelection();
  }

  // 翻译当前选中文字并弹气泡（划词自动触发 + 右键菜单显式触发共用）
  async function translateCurrentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hidePopup();
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 1000) {
      hidePopup();
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    showPopup(rect, T('popupTranslating'), true);

    try {
      const { engine = 'google', targetLang = 'zh-CN' } = await getSettings();
      const resp = await api.runtime.sendMessage({
        type: 'translate',
        text,
        engine,
        targetLang,
        sourceLang: 'auto'
      });

      if (resp && resp.success) {
        showPopup(rect, resp.translation, false);
      } else {
        showPopup(rect, T('popupTranslateFailed') + (resp ? resp.error : T('commError')), false);
      }
    } catch (err) {
      showPopup(rect, T('popupTranslateFailed') + err.message, false);
    }
  }

  function showPopup(rect, text, loading) {
    if (!selPopup) {
      selPopup = document.createElement('div');
      selPopup.id = 'yll-sel-popup';
      selPopup.setAttribute('data-yll-ui', 'true');
      document.body.appendChild(selPopup);
    }

    // DOM API 构建（不用 innerHTML）：内容全部经 textContent 注入，AMO 审核友好。
    selPopup.textContent = '';
    if (loading) {
      const spin = document.createElement('span');
      spin.className = 'yll-spin';
      spin.textContent = '⟳';
      selPopup.append(spin, ' ' + T('popupTranslating'));
      selPopup.className = 'yll-popup-loading';
    } else {
      const textDiv = document.createElement('div');
      textDiv.className = 'yll-popup-text';
      textDiv.textContent = text;
      const copy = document.createElement('a');
      copy.href = '#';
      copy.className = 'yll-copy';
      copy.textContent = T('bubbleCopy');
      copy.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(text).catch(() => {});
      });
      const footer = document.createElement('div');
      footer.className = 'yll-popup-footer';
      footer.append('OpenImmersive · ', copy);
      selPopup.append(textDiv, footer);
      selPopup.className = 'yll-popup-done';
    }

    // 定位
    const vw = window.innerWidth;
    const sx = window.scrollX;
    const sy = window.scrollY;
    let x = sx + rect.left;
    let y = sy + rect.bottom + 8;

    selPopup.style.display = 'block';
    selPopup.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      const pw = selPopup.offsetWidth || 300;
      if (x + pw > sx + vw - 10) x = sx + vw - pw - 10;
      if (x < sx + 10) x = sx + 10;
      selPopup.style.left = x + 'px';
      selPopup.style.top = y + 'px';
      selPopup.style.visibility = 'visible';
    });

    clearTimeout(selTimer);
    if (!loading) {
      selTimer = setTimeout(hidePopup, 10000);
    }
  }

  function hidePopup() {
    if (selPopup) selPopup.style.display = 'none';
  }

  document.addEventListener('mousedown', (e) => {
    if (selPopup && !selPopup.contains(e.target)) hidePopup();
  });

  // ===== 悬停翻译（按住触发键 + 鼠标扫过段落 → 就地翻译该段）=====
  // 沉浸式翻译的「第二心智入口」：无需选中，按住 Alt 划过正文即逐段翻译。
  // 默认开启、默认 Alt；复用页面翻译的 translateBlock/injectTranslation。
  let hoverEnabled = true;
  let hoverKey = 'Alt'; // 'Alt' | 'Control' | 'Shift' | 'off'
  let lastHoverEl = null;

  const HOVER_KEY_PROP = { Alt: 'altKey', Control: 'ctrlKey', Shift: 'shiftKey' };
  const HOVER_BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'DT', 'DD', 'TD', 'TH', 'SUMMARY'
  ]);

  // 划词翻译开关（默认开）
  let selectionEnabled = true;
  // 输入框翻译（可编辑区按 Alt+Enter 就地译成 inputTargetLang，默认英文）
  let inputEnabled = true;
  let inputTargetLang = 'en';
  // 悬浮球（默认开）：点一下整页翻译/还原
  let floatBallEnabled = true;
  let floatBall = null;

  let ballWrap = null;

  // 悬浮球 + 悬停菜单：点球=翻译/还原（老行为不变），悬停展开动作菜单
  //（第二入口，对齐同类插件的球菜单/侧边栏，纯页面内实现不加任何新权限）。
  function ensureFloatBall() {
    if (!floatBallEnabled || floatBall || !document.body) return;
    ballWrap = document.createElement('div');
    ballWrap.id = 'yll-ball-wrap';
    ballWrap.setAttribute('data-yll-ui', 'true');

    const menu = document.createElement('div');
    menu.className = 'yll-ball-menu';
    const mkItem = (label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yll-ball-item';
      b.textContent = label;
      // blur：点击后不让按钮留焦点，否则 :focus-within 会把菜单钉住不收起
      b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); onClick(); });
      menu.appendChild(b);
      return b;
    };
    const toggleItem = mkItem(T('popupTranslatePage'), () => {
      if (state.isTranslated) removeTranslations();
      else translatePage();
    });
    mkItem(T('ctxTranslateSelection'), () => translateCurrentSelection());
    mkItem(T('menuSettings'), () => {
      api.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
    });
    // 展开时按当前状态刷新第一项的文案
    ballWrap.addEventListener('mouseenter', () => {
      toggleItem.textContent = state.isTranslated ? T('popupRestore') : T('popupTranslatePage');
    });

    floatBall = document.createElement('div');
    floatBall.id = 'yll-float-ball';
    floatBall.textContent = T('ballLabel');
    floatBall.title = T('ballTitle');
    floatBall.addEventListener('click', () => {
      if (state.isTranslated) removeTranslations();
      else translatePage();
    });

    ballWrap.append(menu, floatBall);
    document.body.appendChild(ballWrap);
  }

  function removeFloatBall() {
    if (ballWrap) { ballWrap.remove(); ballWrap = null; floatBall = null; }
  }

  // 状态与设置同步：hover/输入框走 state.engine/targetLang，先从存储初始化，再随改动更新。
  // 注意：必须显式列出所有键——getSettings() 只取 targetLang/engine，读不到行为开关。
  storageGet(['targetLang', 'engine', 'displayMode', 'hoverTranslate', 'hoverKey',
    'selectionTranslate', 'inputTranslate', 'inputTargetLang', 'autoTranslateSites',
    'autoTranslateLangs', 'floatBall']).then(s => {
    if (s.engine) state.engine = s.engine;
    if (s.targetLang) state.targetLang = s.targetLang;
    if (s.displayMode) state.displayMode = s.displayMode;
    if (s.hoverTranslate === false) hoverEnabled = false;
    if (typeof s.hoverKey === 'string') hoverKey = s.hoverKey;
    if (s.selectionTranslate === false) selectionEnabled = false;
    if (s.inputTranslate === false) inputEnabled = false;
    if (typeof s.inputTargetLang === 'string') inputTargetLang = s.inputTargetLang;
    if (s.floatBall === false) floatBallEnabled = false;
    ensureFloatBall();
    // 自动翻译此网站：命中名单则整页翻译（等动态内容稍稳后触发）
    if (Array.isArray(s.autoTranslateSites) && s.autoTranslateSites.includes(location.hostname)) {
      setTimeout(() => {
        if (!state.isTranslated && !state.isTranslating) translatePage();
      }, 800);
      return;
    }
    // 总是翻译该语言：页面语种命中名单就自动整页翻译（与站点名单互补——
    // 站点名单认域名，语言名单认内容，遇到没见过的外语站也能直接双语）
    if (Array.isArray(s.autoTranslateLangs) && s.autoTranslateLangs.length) {
      maybeAutoTranslateByLang(s.autoTranslateLangs);
    }
  });

  // 页面语种判定：`<html lang>` 优先，缺失时按正文字符所属书写系统本地推断。
  // 刻意不做服务端语种识别——为判个语种就把正文样本发出去，和"无中间服务器、
  // 零数据收集"冲突；两步都判不出就不自动翻，保守但不泄露。
  const SCRIPT_RANGES = [
    [/[一-鿿]/g, 'zh'],
    [/[぀-ヿ]/g, 'ja'],
    [/[가-힯]/g, 'ko'],
    [/[Ѐ-ӿ]/g, 'ru'],
    [/[؀-ۿ]/g, 'ar'],
    [/[֐-׿]/g, 'he'],
    [/[Ͱ-Ͽ]/g, 'el'],
    [/[฀-๿]/g, 'th'],
    [/[ऀ-ॿ]/g, 'hi'],
  ];

  function detectPageLang() {
    const declared = (document.documentElement.getAttribute('lang') || '').trim().toLowerCase();
    if (declared) return declared.split('-')[0];
    const sample = ((document.body && (document.body.innerText || document.body.textContent)) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (sample.length < 50) return '';
    // 日文常混大量汉字，先看假名再看汉字，避免把日文判成中文。
    const kana = (sample.match(/[぀-ヿ]/g) || []).length;
    if (kana / sample.length > 0.05) return 'ja';
    for (const [re, lang] of SCRIPT_RANGES) {
      const hits = (sample.match(re) || []).length;
      if (hits / sample.length > 0.2) return lang;
    }
    return '';
  }

  function maybeAutoTranslateByLang(langs) {
    const pageLang = detectPageLang();
    if (!pageLang) return;
    const wanted = langs.some(l => String(l).toLowerCase().split('-')[0] === pageLang);
    if (!wanted) return;
    // 页面本来就是目标语言时不翻（目标中文、页面也中文）
    if (state.targetLang.toLowerCase().split('-')[0] === pageLang) return;
    setTimeout(() => {
      if (!state.isTranslated && !state.isTranslating) translatePage();
    }, 800);
  }
  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.engine) state.engine = changes.engine.newValue || state.engine;
      if (changes.targetLang) state.targetLang = changes.targetLang.newValue || state.targetLang;
      if (changes.displayMode) state.displayMode = changes.displayMode.newValue || state.displayMode;
      if (changes.hoverTranslate) hoverEnabled = changes.hoverTranslate.newValue !== false;
      if (changes.hoverKey) hoverKey = changes.hoverKey.newValue || hoverKey;
      if (changes.selectionTranslate) selectionEnabled = changes.selectionTranslate.newValue !== false;
      if (changes.inputTranslate) inputEnabled = changes.inputTranslate.newValue !== false;
      if (changes.inputTargetLang) inputTargetLang = changes.inputTargetLang.newValue || inputTargetLang;
      if (changes.floatBall) {
        floatBallEnabled = changes.floatBall.newValue !== false;
        if (floatBallEnabled) ensureFloatBall(); else removeFloatBall();
      }
    });
  }

  // ===== 输入框翻译：在可编辑区按 Alt+Enter → 就地译成 inputTargetLang（写外语场景）=====
  function editableTarget(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT' && /^(text|search|email|url|)$/i.test(el.getAttribute('type') || '')) return el;
    if (el.isContentEditable) return el;
    return null;
  }

  document.addEventListener('keydown', async (e) => {
    if (!inputEnabled) return;
    if (!(e.altKey && e.key === 'Enter')) return;
    const el = editableTarget(e.target);
    if (!el) return;
    const isCE = el.isContentEditable;
    const text = (isCE ? el.innerText : el.value) || '';
    if (!text.trim() || text.trim().length > 5000) return;
    e.preventDefault();
    try {
      const resp = await api.runtime.sendMessage({
        type: 'translate', text: text.trim(),
        engine: state.engine, targetLang: inputTargetLang, sourceLang: 'auto'
      });
      if (resp && resp.success && resp.translation) {
        if (isCE) { el.innerText = resp.translation; }
        else { el.value = resp.translation; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    } catch (err) { /* 静默失败，保留原文 */ }
  }, true);

  function hoverKeyHeld(e) {
    const prop = HOVER_KEY_PROP[hoverKey];
    return prop ? Boolean(e[prop]) : false;
  }

  function findHoverBlock(node) {
    let el = node;
    while (el && el !== document.body) {
      if (el.nodeType === Node.ELEMENT_NODE && HOVER_BLOCK_TAGS.has(el.tagName) && shouldTranslate(el)) {
        const text = extractText(el);
        if (text && text.trim().length >= 5 && !isAlreadyTargetLang(text, state.targetLang)) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  document.addEventListener('mouseover', (e) => {
    if (!hoverEnabled || hoverKey === 'off') return;
    if (!hoverKeyHeld(e)) return;
    const block = findHoverBlock(e.target);
    if (!block || block === lastHoverEl || block.dataset.yllDone) return;
    lastHoverEl = block;
    translateBlock(block);
  }, true);
  // 松开触发键后重置，允许再次划过同一段落触发
  document.addEventListener('keyup', () => { lastHoverEl = null; });

  // ===== 页面翻译主流程 =====

  // 视口边界（带余量）内的块优先翻译，感知速度对齐"滚到哪翻到哪"类插件；
  // 视口外的块仍全部排队后台补全——整页完整性是我们相对的差异点，不牺牲。
  function inViewport(el, margin = 600) {
    const r = el.getBoundingClientRect();
    return r.bottom > -margin && r.top < window.innerHeight + margin;
  }

  async function translatePage() {
    if (state.isTranslating) return;

    const settings = await getSettings();
    state.engine = settings.engine || 'google';
    state.targetLang = settings.targetLang || 'zh-CN';
    state.displayMode = settings.displayMode || 'bilingual';
    state.isTranslating = true;
    showProgressBar();

    try {
      const blocks = collectBlocks();
      state.totalCount = blocks.length;
      state.translatedCount = 0;
      updateProgressBar();

      if (blocks.length === 0) {
        return;
      }

      // 两级队列：prioritized=视口内（先翻），rest=其余（按文档序垫底）；
      // IntersectionObserver 把滚动临近的块从 rest 提升进 prioritized。
      const prioritized = [];
      const rest = [];
      const waiting = new Set();
      for (const b of blocks) {
        if (inViewport(b)) prioritized.push(b);
        else { rest.push(b); waiting.add(b); }
      }
      let observer = null;
      if (typeof IntersectionObserver === 'function' && waiting.size) {
        observer = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (en.isIntersecting && waiting.has(en.target)) {
              waiting.delete(en.target);
              prioritized.push(en.target);
              observer.unobserve(en.target);
            }
          }
        }, { rootMargin: '600px' });
        for (const b of rest) observer.observe(b);
      }

      const CONCURRENCY = 4;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          let el = prioritized.shift();
          if (!el) {
            do { el = rest.shift(); } while (el && !waiting.has(el));
            if (!el) { if (prioritized.length) continue; break; }
            waiting.delete(el);
          }
          await translateBlock(el);
          updateProgressBar();
        }
      });
      await Promise.allSettled(workers);
      if (observer) observer.disconnect();

      state.isTranslated = true;
    } finally {
      state.isTranslating = false;
      hideProgressBar();
    }
  }

  async function translateBlock(el) {
    const text = extractText(el);
    if (!text || text.trim().length < minTextLen(el, 5)) return;

    // 跳过已经是目标语言的内容
    if (isAlreadyTargetLang(text, state.targetLang)) return;

    // 「A • B • C」式专有名词名单（署名墙、合作伙伴列表）：引擎会把一部分
    // 品牌名意译成怪词（Cognition→认知、Disruptive→颠覆性），剩下的保留，
    // 观感像随机挑着翻。整段跳过比翻一半更不伤原文。
    if (looksLikeNameList(text)) return;

    try {
      const resp = await api.runtime.sendMessage({
        type: 'translate',
        text: text.trim(),
        engine: state.engine,
        targetLang: state.targetLang,
        sourceLang: 'auto'
      });

      if (resp && resp.success && resp.translation) {
        // 译文和原文实质相同就别插：中英混排的条目（"法律（英语：Legal
        // translation）"）CJK 占比过不了 isAlreadyTargetLang 的阈值，翻回来
        // 却几乎原样，插进去只是把页面撑成两份。这条与语言无关，通用兜底。
        if (sameText(resp.translation, text)) return;
        injectTranslation(el, resp.translation);
        state.translatedCount++;
      }
    } catch (err) {
      // 静默失败，不打断其他段落
    }
  }

  // ===== DOM 遍历：找到可翻译块 =====

  // 语义选择器会同时命中外层容器和它里面的块（表格单元格里放标题就是典型），
  // 两者都翻会让同一句话出现两遍。只留最内层的那个。
  function dropOuterOverlaps(blocks) {
    return blocks.filter(el => !blocks.some(other => other !== el && el.contains(other)));
  }

  // X 把一条推文的正文全放进一个 div，段落之间只靠 <br> 分隔。整块送去翻译
  // 就得到一大坨贴在推文末尾（用户报的「整篇翻译」）。按 <br> 把正文切成段、
  // 每段包一层 span 单独成块，译文才跟在各自那段后面——沉浸式翻译在 X 上就是
  // 这个粒度。包一层而不是直接翻，是为了让下游的 translateBlock/injectTranslation/
  // removeTranslations 一行都不用改。
  function splitTweetParagraphs(root) {
    if (root.dataset.yllSplit) {
      return Array.from(root.children).filter(c => c.dataset && c.dataset.yllPara);
    }

    const groups = [];
    let cur = [];
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
        if (cur.length) { groups.push(cur); cur = []; }
        continue; // <br> 留在原地，段与段之间的空行不能丢
      }
      cur.push(node);
    }
    if (cur.length) groups.push(cur);

    root.dataset.yllSplit = '1';
    if (groups.length < 2) return []; // 单段推文没必要切，走原来的整块路径

    const wrappers = [];
    for (const nodes of groups) {
      const wrap = document.createElement('span');
      wrap.setAttribute('data-yll-para', '1');
      wrap.style.display = 'block';
      root.insertBefore(wrap, nodes[0]);
      for (const n of nodes) wrap.appendChild(n);
      wrappers.push(wrap);
    }
    return wrappers;
  }

  function collectTweetBlocks(seen, results) {
    for (const tweet of document.querySelectorAll('[data-testid="tweetText"]')) {
      if (!shouldTranslate(tweet)) continue;
      const paras = splitTweetParagraphs(tweet);
      // 切开后原容器本身不能再当块，否则兜底分支会把它当叶子整条再翻一遍
      if (paras.length) seen.add(tweet);
      // 切不动（单段）就整块当一个块，行为和以前一样
      for (const el of paras.length ? paras : [tweet]) {
        if (seen.has(el)) continue;
        const text = extractText(el);
        if (!text || text.trim().length < 2) continue;
        if (!/\p{L}/u.test(text)) continue;
        seen.add(el);
        results.push(el);
      }
    }
  }

  function collectBlocks() {
    const results = [];
    const seen = new WeakSet();

    // X 的正文不是 p/li，通用选择器一个都命中不到，会落到兜底的"叶子块"分支去
    // 猜——推文这种结构明确的东西不该靠猜。个人简介之类仍交给后面的通用流程。
    if (SITE === 'x') collectTweetBlocks(seen, results);

    // 优先选择语义化文本块
    const selector = [
      'article p', 'main p', '.content p', '.post p', '.article p',
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'blockquote', 'figcaption', 'td', 'th',
      'dt', 'dd', 'summary'
    ].join(', ');

    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      if (!shouldTranslate(el)) continue;

      const text = extractText(el);
      if (!text || text.trim().length < minTextLen(el, 12)) continue;
      if (!/\p{L}/u.test(text)) continue; // 纯数字/符号（表格数值列）没有可翻内容

      seen.add(el);
      results.push(el);
    }

    // 兜底：语义选择器几乎没命中时（极简/非语义化页面，如纯 div 文案的站点），
    // 补捞"叶子块"——不含其它块级候选后代、但直接文本足够长的容器。
    let coveredLen = 0;
    for (const el of results) coveredLen += extractText(el).trim().length;
    const bodyLen = ((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\s+/g, ' ').trim().length;
    if (bodyLen >= 40 && coveredLen / bodyLen < 0.5) {
      for (const el of document.querySelectorAll('div, section, article, span')) {
        if (seen.has(el)) continue;
        if (!shouldTranslate(el)) continue;
        if (el.querySelector('p,div,section,article,ul,ol,table,h1,h2,h3,h4,h5,h6,li,blockquote,td')) continue;
        const text = extractText(el);
        if (!text || text.trim().length < 12) continue;
        let anc = el.parentElement, nested = false;
        while (anc) { if (seen.has(anc)) { nested = true; break; } anc = anc.parentElement; }
        if (nested) continue;
        seen.add(el);
        results.push(el);
      }
    }

    return dropOuterOverlaps(results);
  }

  function shouldTranslate(el) {
    // 跳过已翻译
    if (el.dataset.yllDone) return false;

    // 跳过语灵灵自己插入的元素
    if (el.dataset.yllUi) return false;
    if (el.closest('[data-yll-ui]')) return false;

    // 跳过标签
    if (SKIP_TAGS.has(el.tagName)) return false;

    // 站点级排除区（见 SITE_SKIP）
    if (SITE && SITE_SKIP[SITE] && el.closest(SITE_SKIP[SITE])) return false;

    // 跳过导航、页眉、页脚等。header/footer 只在页面级（不在 article/main 里）
    // 才算页头页脚——新闻站的头条区常包在文章内的 <header> 里，连坐会把
    // 正文标题整个漏掉（Reuters 频道页头条就是这样丢的）。
    //
    // 必须逐层往上看，不能只看最近的一个：closest() 命中的常常是里层一个
    // 无害的 [role="link"]/[role="button"]，外面真正的 <nav> 就再也问不到了
    //（X 几乎每个元素都套着这类 role，导航栏因此整个漏进来被翻译）。
    for (let anc = el.closest('nav, header, footer, aside, [role]'); anc; ) {
      const tag = anc.tagName;
      if (['NAV', 'ASIDE'].includes(tag)) return false;
      if (['HEADER', 'FOOTER'].includes(tag) && !anc.closest('article, main')) return false;
      const role = anc.getAttribute('role');
      if (role && SKIP_ROLES.has(role)) return false;
      anc = anc.parentElement ? anc.parentElement.closest('nav, header, footer, aside, [role]') : null;
    }

    // 跳过包含代码的块
    if (el.querySelector('code, pre, .code, .highlight')) return false;

    // 也要跳过位于代码块内部的元素：代码里的注释常被包在 span 里，
    // 只查「是否包含代码」会漏掉它们，结果把注释译文插进 <pre>。
    if (el.closest('pre, code, kbd, samp, .highlight')) return false;

    // 跳过隐藏元素
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    if (isVisuallyHidden(el)) return false;

    return true;
  }

  // 视觉上不可见的节点：display/visibility 之外还要认出 sr-only 模式
  //（absolute + 1px 盒 + clip，无障碍专用文本）。NYT 图集把多张图的说明全
  // 渲染在 DOM 里只显示一张，不过滤会把隐藏的几条全翻出来叠在图上。
  function isVisuallyHidden(el) {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return true;
    }
    return false;
  }

  function extractText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 跳过语灵灵注入的内容
        if (node.dataset.yllInject) continue;
        // 也跳过不该当正文的子树：维基条目里 <style> 常嵌在 <span> 之类的
        // 元素内部，只看直接子元素会漏掉，整段 CSS 就被当文字送去翻译
        // （译文里出现「显示：内联」）。所以要递归下去逐层排除。
        if (SKIP_TAGS.has(node.tagName)) continue;
        // 视觉隐藏的子节点（sr-only 辅助文本等）不算正文：新闻卡片里的
        // 隐藏「category」标签混进标题，译文就成了一句拼接怪话。
        if (isVisuallyHidden(node)) continue;
        text += extractText(node);
      }
    }
    return text;
  }

  // 表格单元格里合法的内容天然就短（"Chips"、"Funding"），统一用 12 字符
  // 门槛会把排行榜的词条列整列漏掉、只剩长词条被翻的"选择性翻译"观感。
  function minTextLen(el, normal) {
    return (el.tagName === 'TD' || el.tagName === 'TH') ? 3 : normal;
  }

  // 「A • B • C」式名单：≥8 段、绝大多数段短且以大写/数字开头
  function looksLikeNameList(text) {
    const segs = text.split(/[•·]/).map(s => s.trim()).filter(Boolean);
    if (segs.length < 8) return false;
    const nameLike = segs.filter(s =>
      s.length <= 40 && /^[("'\d]*[A-Z0-9]/.test(s) && s.split(/\s+/).length <= 5
    );
    return nameLike.length / segs.length >= 0.8;
  }

  // 忽略空白与标点差异后是否是同一段文字（翻译服务常只改动标点/空格）
  function sameText(a, b) {
    const norm = (s) => String(s)
      .replace(/\s+/g, '')
      .replace(/[，。！？；：、（）【】《》""'',.!?;:()[\]<>"']/g, '')
      .toLowerCase();
    return norm(a) === norm(b);
  }

  // 简单判断是否已经是目标语言（避免翻译中文→中文）
  function isAlreadyTargetLang(text, targetLang) {
    const isCJK = targetLang.startsWith('zh') || targetLang.startsWith('ja') || targetLang.startsWith('ko');
    if (!isCJK) return false;

    const cjkChars = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
    const ratio = cjkChars / Math.max(text.replace(/\s/g, '').length, 1);
    return ratio > 0.35; // 超过35%是CJK字符则跳过
  }

  // ===== 注入翻译 =====

  // 标题走行内接排（"Machine translation 机器翻译"式），正文块另起一行；
  // 两者都直接继承原文的计算样式——译文和原文看起来是同一篇文档。
  const INLINE_APPEND_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  function injectTranslation(el, translation) {
    el.dataset.yllDone = '1';

    // 仅显示译文：把原文子节点整体挪进一个隐藏的包裹节点（保留 DOM，可还原），
    // 译文放回元素内部——继承元素级样式，grid/表格里也不产生新兄弟节点。
    if (state.displayMode === 'replace') {
      const orig = document.createElement('span');
      orig.className = 'yll-orig-hidden';
      orig.setAttribute('data-yll-orig', '1');
      while (el.firstChild) orig.appendChild(el.firstChild);
      const tr = document.createElement('span');
      tr.className = 'yll-tr-replace';
      tr.setAttribute('data-yll-inject', '1');
      tr.setAttribute('data-yll-ui', 'true');
      tr.textContent = translation;
      el.append(orig, tr);
      return;
    }

    if (INLINE_APPEND_TAGS.has(el.tagName)) {
      const span = document.createElement('span');
      span.className = 'yll-tr yll-tr-inline';
      span.setAttribute('data-yll-inject', '1');
      span.setAttribute('data-yll-ui', 'true');
      span.textContent = ' ' + translation;
      el.appendChild(span);
      return;
    }

    const div = document.createElement('div');
    div.className = 'yll-tr';
    // 按元素实际背景深浅适配（网站深色主题时 prefers-color-scheme 可能仍是 light）
    if (isDarkBg(el)) div.classList.add('yll-tr-dark');
    div.setAttribute('data-yll-inject', '1');
    div.setAttribute('data-yll-ui', 'true');
    // 样式贴原文：字体/字号/行高/颜色/对齐全部取自原块的计算样式
    try {
      const cs = getComputedStyle(el);
      div.style.fontSize = cs.fontSize;
      div.style.fontFamily = cs.fontFamily;
      div.style.fontWeight = cs.fontWeight;
      div.style.fontStyle = cs.fontStyle;
      div.style.lineHeight = cs.lineHeight;
      div.style.color = cs.color;
      div.style.textAlign = cs.textAlign;
    } catch (_) { /* jsdom 等环境下取不到就走 CSS 默认 */ }
    div.textContent = translation;

    // 父容器只接受特定子元素时（表格行、grid、flex），兄弟节点会被当成新的
    // 单元格/网格项，译文就飘到隔壁列去了（Rust blog 的文章列表就是 table）。
    // 这类容器改成插进原元素内部，译文才留在原格里紧跟原文。
    const parent = el.parentElement;
    let display = '';
    try { display = parent ? getComputedStyle(parent).display : ''; } catch (_) { /* jsdom 无布局 */ }
    if (/grid|flex|table/.test(display)) el.appendChild(div);
    else el.insertAdjacentElement('afterend', div);
  }

  // 向上找到第一个不透明背景，判断其明度是否偏暗（用于译文配色自适应）
  function isDarkBg(el) {
    let node = el;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      const m = bg && bg.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const parts = m[1].split(',').map(Number);
      const a = parts.length > 3 ? parts[3] : 1;
      if (a < 0.5) continue; // 透明背景，继续往上找
      const [r, g, b] = parts;
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum < 0.5;
    }
    return false;
  }

  function removeTranslations() {
    document.querySelectorAll('[data-yll-inject]').forEach(el => el.remove());
    // 仅译文模式藏起来的原文：把子节点挪回原位再删掉包裹节点
    document.querySelectorAll('[data-yll-orig]').forEach(wrap => {
      const parent = wrap.parentNode;
      if (parent) {
        while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      }
      wrap.remove();
    });
    document.querySelectorAll('[data-yll-done]').forEach(el => delete el.dataset.yllDone);
    // X 推文按段包的那层 span：把子节点挪回去再删壳，推文恢复成原来的样子
    document.querySelectorAll('[data-yll-para]').forEach(wrap => {
      const parent = wrap.parentNode;
      if (parent) {
        while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      }
      wrap.remove();
    });
    document.querySelectorAll('[data-yll-split]').forEach(el => delete el.dataset.yllSplit);
    state.isTranslated = false;
    state.translatedCount = 0;
    state.totalCount = 0;
  }

  // ===== 进度条 =====

  let progressBar = null;

  function showProgressBar() {
    if (!progressBar) {
      progressBar = document.createElement('div');
      progressBar.id = 'yll-progress';
      progressBar.setAttribute('data-yll-ui', 'true');
      progressBar.innerHTML = '<div id="yll-progress-bar"></div>';
      document.body.appendChild(progressBar);
    }
    progressBar.style.display = 'block';
    document.getElementById('yll-progress-bar').style.width = '0%';
  }

  function updateProgressBar() {
    if (!progressBar) return;
    const pct = state.totalCount > 0
      ? Math.round((state.translatedCount / state.totalCount) * 100)
      : 0;
    const bar = document.getElementById('yll-progress-bar');
    if (bar) bar.style.width = pct + '%';
  }

  function hideProgressBar() {
    if (progressBar) {
      setTimeout(() => {
        if (progressBar) progressBar.style.display = 'none';
      }, 600);
    }
  }

  // ===== 工具函数 =====

  function getSettings() {
    return storageGet(['targetLang', 'engine', 'displayMode']);
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Expose internals for automated testing only
  if (typeof window !== 'undefined' && window.__yllTestMode) {
    window.__yllInternals = {
      isAlreadyTargetLang,
      extractText,
      shouldTranslate,
      escHtml,
      collectBlocks,
      injectTranslation,
      removeTranslations,
      findHoverBlock,
      hoverKeyHeld,
      pageHotkeyAction,
      ensureFloatBall,
      removeFloatBall,
      setHoverKey: (k) => { hoverKey = k; },
      detectPageLang,
      sameText,
      isVisuallyHidden,
      looksLikeNameList,
      minTextLen,
      splitTweetParagraphs,
      setDisplayMode: (m) => { state.displayMode = m; }
    };
  }

})();
