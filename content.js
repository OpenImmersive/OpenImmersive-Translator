'use strict';

// OpenImmersive Translator Content Script - 页面翻译与划词翻译
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
  function storageSet(items) {
    if (typeof browser !== 'undefined') return browser.storage.local.set(items);
    return new Promise(r => chrome.storage.local.set(items, r));
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
    // 整页 0 段成功时，这两个是唯一能回答「为什么点了没反应」的东西。
    failedCount: 0,
    lastError: '',
    pageKey: String(location.href).split('#')[0]
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
  // GitHub：仓库首页的文件表（文件名、提交说明、提交时间）和语言占比条是
  // 名字和数据，不是正文——译成「执照」「泊坞窗」「批处理文件」只会添乱。
  // 顶栏（AppHeader）、仓库页头的按钮（Notifications / Fork / Star）和仓库导航
  // 标签是界面：新版页头是 <main> 里的 <header>，通用的页头规则管不到，按钮又是
  // 列表项里的链接，会被当成一条 li 正文翻出「通知」。页头里的标题不在 li 里，照翻。
  // YouTube：播放器里的提示、字幕设置和遮罩文字是界面，译文会叠在画面上；
  // 标题、简介和推荐标题在播放器外，照常翻。
  // Bluesky：作者的显示名和 @handle 是名字（「Cats of Yore」→「古时的猫」）；
  // 贴文末尾的串号徽标（「1/5」）是贴文里的一个小块，不是正文。正文是富文本，
  // 带 data-word-wrap；作者链接带 aria-label，正文里的 @提及链接不带。
  // 排除区里的字也不算外层块的原文（见 extractText）：Bluesky 作者行容器的字全在
  // 两个链接里，排除后没字可翻；「1/5」也不会混进贴文送去翻译。

  // 指向某人主页本身的链接；/post/、/feed/（热门话题）、/lists/ 底下是内容
  const BSKY_PROFILE_LINK = 'a[href^="/profile/"][aria-label]' +
    ':not([href*="/post/"]):not([href*="/feed/"]):not([href*="/lists/"])';
  const SITE_SKIP = {
    x: '[data-testid="sidebarColumn"], [data-testid="DMDrawer"], [data-testid="primaryColumn"] [role="tablist"]',
    github: [
      'table[aria-labelledby="folders-and-files"]', '[class*="react-directory-row"]', '[class*="languageListItem"]',
      '.AppHeader', '#repository-container-header', '.pagehead-actions',
      '[class*="PageLayout-Header"] li', '[class*="UnderlineNav"]',
    ].join(', '),
    youtube: '#movie_player, .html5-video-player, ytd-player',
    bsky: [
      '[data-testid="profileHeaderDisplayName"]',
      // 动态和回复里的作者行：显示名、handle 各是一个链接
      `${BSKY_PROFILE_LINK}[dir="auto"]`,
      // 链接整块包着作者的地方（帖子页的主贴作者、推荐关注卡片、「Reposted by」）：
      // 名字和 handle 不是富文本，卡片里的简介是
      `${BSKY_PROFILE_LINK} [dir="auto"]:not([data-word-wrap])`,
      // 引用帖：整块是一个 div 链接，里面的作者名不是链接；外链卡片的标题和摘要在 <a> 里
      'div[role="link"][aria-label] [dir="auto"]:not([data-word-wrap]):not(a [dir="auto"])',
      // 串号徽标是富文本下的 div > span[aria-label]；同样包在 div 里的 @提及是 div > div > a
      '[data-word-wrap] > div > span[aria-label]',
      // 右栏底部「Privacy ∙ Terms ∙ Help」：一行外链，指向 bsky.social 的支持页
      '[dir="auto"]:has(> a[href^="https://bsky.social/about/support/"])',
      // 回复贴上方的「Replied to <名字>」：名字是包在两层 div 里的作者链接，整行是界面
      '[dir="auto"]:not([data-word-wrap]):has(> div > div > a[href^="/profile/"][aria-label])',
    ].join(', '),
  };

  // 反过来，通用选择器认不出、但确定是正文的块。
  // Reddit：列表页的帖子标题是块级的 <a slot="title">，不是 h*（帖子页里是
  // <h1>，通用规则已覆盖）；标题不翻、摘要 <p> 照翻，整页看着像漏了一半。
  const SITE_BLOCKS = {
    reddit: 'a[slot="title"], a[id^="post-title"]',
  };

  // 正文都在语义标签里的站：文件表排除之后覆盖率掉到一半以下，兜底叶子块
  // 只会捞到侧栏碎字（「8 Branches」、话题标签）。
  const SITE_NO_LEAF_FALLBACK = new Set(['github']);

  function siteKey() {
    if (/(^|\.)(x|twitter)\.com$/.test(location.hostname)) return 'x';
    if (/(^|\.)github\.com$/.test(location.hostname)) return 'github';
    if (/(^|\.)youtube\.com$/.test(location.hostname)) return 'youtube';
    if (/(^|\.)reddit\.com$/.test(location.hostname)) return 'reddit';
    if (/(^|\.)bsky\.app$/.test(location.hostname)) return 'bsky';
    return '';
  }

  const SITE = siteKey();

  // ===== 消息监听（来自popup）=====
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStatus') {
      sendResponse({
        isTranslated: state.isTranslated,
        isTranslating: state.isTranslating,
        translatedCount: state.translatedCount,
        totalCount: state.totalCount,
        error: halted ? halted.error : '',
        code: halted ? halted.code : '',
        site: halted ? halted.site : ''
      });
      return false;
    }

    if (msg.type === 'translatePage') {
      state.engine = msg.engine || state.engine;
      state.targetLang = msg.targetLang || state.targetLang;

      if (active()) {
        removeTranslations();
        sendResponse({ status: 'removed' });
      } else {
        translatePage().then(() => {
          sendResponse({
            status: 'done',
            count: state.translatedCount,
            total: state.totalCount,
            failed: state.failedCount,
            error: state.lastError,
            code: halted ? halted.code : '',
            site: halted ? halted.site : ''
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
      toggleTranslation();
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
    if (editableTarget(eventTarget(e))) return;
    e.preventDefault();
    if (action === 'toggle') {
      toggleTranslation();
    } else {
      // Alt+W：未译则译；已译则再跑一遍补翻动态新增内容（已译块会被跳过）
      translatePage();
    }
  });

  // ===== 划词翻译 =====
  let selPopup = null;
  let selTimer = null;
  // 双击、三击是连着几次 mouseup：等鼠标停下再按最后的选区只问一次
  const SELECTION_SETTLE_MS = 250;
  let selSettleTimer = null;
  // 每次划词一个序号：回得晚的旧请求不能盖掉新选区的气泡
  let selSeq = 0;

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('touchend', onMouseUp);

  function onMouseUp(e) {
    if (!selectionEnabled) return;
    // 点击了自己的popup则忽略
    if (selPopup && selPopup.contains(e.target)) return;
    clearTimeout(selSettleTimer);
    selSettleTimer = setTimeout(translateCurrentSelection, SELECTION_SETTLE_MS);
  }

  // 翻译当前选中文字并弹气泡（划词自动触发 + 右键菜单显式触发共用）
  async function translateCurrentSelection() {
    const seq = ++selSeq;
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
      const codes = [];
      const resp = await translateKept(text, selectionWithCode(text, range, codes), codes, targetLang, engine);
      if (seq !== selSeq) return;

      if (resp && resp.success) {
        showPopup(rect, resp.translation, false);
      } else if (accountRefusal(resp)) {
        // 账号提示本身就是一句完整的话，不加「翻译失败：」
        showPopup(rect, resp.error, false);
      } else {
        showPopup(rect, T('popupTranslateFailed') + (resp ? resp.error : T('commError')), false);
      }
    } catch (err) {
      if (seq !== selSeq) return;
      showPopup(rect, T('popupTranslateFailed') + err.message, false);
    }
  }

  // 选区里的行内代码：按文档顺序在选中的文字里逐个找到、换成占位符（选中的
  // 文字是浏览器排过版的，没法按节点拼回去，只能按内容找）。选区整个落在
  // 代码里时选的就是代码本身，照常翻。
  function selectionWithCode(text, range, codes) {
    if (typeof YLSensitive === 'undefined') return text;
    const anc = range.commonAncestorContainer;
    const host = anc.nodeType === Node.ELEMENT_NODE ? anc : anc.parentElement;
    if (!host || host.closest('code, kbd, samp, var, pre')) return text;
    let out = '';
    let rest = text;
    for (const c of host.querySelectorAll('code, kbd, samp, var')) {
      if (!range.intersectsNode(c) || c.parentElement.closest('code, kbd, samp, var')) continue;
      const part = document.createRange();
      part.selectNodeContents(c);
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
      const value = part.toString().trim();
      const at = value.length >= 2 ? rest.indexOf(value) : -1;
      if (at < 0) continue;
      out += rest.slice(0, at) + codePlaceholder(value, codes);
      rest = rest.slice(at + value.length);
    }
    return out + rest;
  }

  // 输入框里的代码：规则见 sensitive-mask.js 的 keepCode（文件翻译共用）
  function inputWithCode(text, codes) {
    if (typeof YLSensitive === 'undefined') return text;
    return YLSensitive.keepCode(text, codes);
  }

  // 划词和输入框送出的是一段纯文本：名字（和调用方先换好的代码占位符，记在
  // codes 里）换成占位符，译文回来换回；占位符被引擎弄丢就按原文再问一次——
  // 这两处宁可带回被意译的词，也不能什么都不给。
  async function translateKept(plain, source, codes, targetLang, engine) {
    const ask = (text) => api.runtime.sendMessage({ type: 'translate', text, engine, targetLang, sourceLang: 'auto' });
    if (typeof YLSensitive === 'undefined') return ask(plain);
    source = YLSensitive.keepNames(source, codes);
    if (!codes.length) return ask(plain);
    const resp = await ask(source);
    if (!(resp && resp.success && resp.translation)) return resp;
    const restored = YLSensitive.restoreCounting(resp.translation, codes);
    return restored.missing ? ask(plain) : { ...resp, translation: restored.text };
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
  let ballToggleItem = null;

  // 翻译中也算「已翻」：这时按「恢复原文」要真的停下，而不是因为还没翻完
  // 就被当成「翻译此页」——一直在变的页面（X）上整页可能好几秒都在翻。
  function toggleTranslation() {
    if (active()) removeTranslations();
    else translatePage();
  }

  // 菜单第一项跟着状态走：每次翻译开始、结束、还原、被拒停下都刷新，
  // 快捷键和弹窗触发的也一样
  function syncBallMenu() {
    if (ballToggleItem) ballToggleItem.textContent = active() ? T('popupRestore') : T('popupTranslatePage');
  }

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
    ballToggleItem = mkItem(T('popupTranslatePage'), toggleTranslation);
    mkItem(T('ctxTranslateSelection'), () => translateCurrentSelection());
    mkItem(T('menuSettings'), () => {
      api.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
    });

    floatBall = document.createElement('div');
    floatBall.id = 'yll-float-ball';
    floatBall.textContent = T('ballLabel');
    floatBall.title = T('ballTitle');
    floatBall.addEventListener('click', () => {
      if (ballDragged) { ballDragged = false; return; }
      toggleTranslation();
    });
    floatBall.addEventListener('pointerdown', startBallDrag);
    ballWrap.addEventListener('mouseenter', placeBallMenu);

    ballWrap.append(menu, floatBall);
    placeBall(ballTop);
    document.body.appendChild(ballWrap);
    syncBallMenu();
  }

  // ===== 悬浮球拖动：沿右边缘上下拖，位置全站共用一份 =====
  // 记的是球心在视口里的高度比例（floatBallTop，0–1），窗口高矮变了按比例
  // 重新摆，整个球总在屏幕内。挪动超过 BALL_DRAG_PX 才算拖：手抖一两个像素的
  // 点击照样是点击，拖完松手不算点击。
  const BALL_SIZE = 40;
  const BALL_EDGE = 8;
  const BALL_DRAG_PX = 5;
  let ballTop = null;      // 存过的比例；null 用 CSS 的默认位置
  let ballDragged = false; // 刚拖完：吞掉松手时跟着来的那次 click

  function clampBallTop(top) {
    return Math.min(Math.max(top, BALL_EDGE), window.innerHeight - BALL_SIZE - BALL_EDGE);
  }

  function placeBall(ratio) {
    if (!ballWrap || typeof ratio !== 'number' || !(ratio >= 0 && ratio <= 1)) return;
    ballWrap.style.top = clampBallTop(ratio * window.innerHeight - BALL_SIZE / 2) + 'px';
  }
  window.addEventListener('resize', () => placeBall(ballTop));

  // 球靠近顶部时菜单往下展开，免得顶出屏幕
  function placeBallMenu() {
    if (!ballWrap) return;
    ballWrap.classList.toggle('yll-ball-below', ballWrap.getBoundingClientRect().top < 160);
  }

  function startBallDrag(e) {
    if (e.button !== 0 || !ballWrap) return;
    const startY = e.clientY;
    const startTop = ballWrap.getBoundingClientRect().top;
    let dragging = false;
    const move = (ev) => {
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dy) < BALL_DRAG_PX) return;
      dragging = true;
      ballWrap.classList.add('yll-dragging');
      ballWrap.style.top = clampBallTop(startTop + dy) + 'px';
      ev.preventDefault();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      if (!dragging || !ballWrap) return;
      ballWrap.classList.remove('yll-dragging');
      ballDragged = true;
      // 没有 click 跟来（松手时已经移出球外）也不能让下一次真点击被吞掉
      setTimeout(() => { ballDragged = false; }, 0);
      const top = parseFloat(ballWrap.style.top);
      ballTop = Math.min(Math.max((top + BALL_SIZE / 2) / window.innerHeight, 0), 1);
      placeBallMenu();
      // 存不了（扩展刚被重载、上下文已失效）只是下次回到默认位置
      try { Promise.resolve(api.storage.local.set({ floatBallTop: ballTop })).catch(() => {}); } catch (_) { /* 同上 */ }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function removeFloatBall() {
    if (ballWrap) { ballWrap.remove(); ballWrap = null; floatBall = null; ballToggleItem = null; }
  }

  // 自动翻译名单（站点 / 页面语种），站内跳转后还要再判一次
  let autoSites = [];
  let autoLangs = [];

  // 状态与设置同步：hover/输入框走 state.engine/targetLang，先从存储初始化，再随改动更新。
  // 注意：必须显式列出所有键——getSettings() 只取 targetLang/engine，读不到行为开关。
  storageGet(['targetLang', 'engine', 'displayMode', 'hoverTranslate', 'hoverKey',
    'selectionTranslate', 'inputTranslate', 'inputTargetLang', 'autoTranslateSites',
    'autoTranslateLangs', 'floatBall', 'floatBallTop']).then(s => {
    if (s.engine) state.engine = s.engine;
    if (s.targetLang) state.targetLang = s.targetLang;
    if (s.displayMode) state.displayMode = s.displayMode;
    if (s.hoverTranslate === false) hoverEnabled = false;
    if (typeof s.hoverKey === 'string') hoverKey = s.hoverKey;
    if (s.selectionTranslate === false) selectionEnabled = false;
    if (s.inputTranslate === false) inputEnabled = false;
    if (typeof s.inputTargetLang === 'string') inputTargetLang = s.inputTargetLang;
    if (s.floatBall === false) floatBallEnabled = false;
    if (typeof s.floatBallTop === 'number') ballTop = s.floatBallTop;
    if (Array.isArray(s.autoTranslateSites)) autoSites = s.autoTranslateSites;
    if (Array.isArray(s.autoTranslateLangs)) autoLangs = s.autoTranslateLangs;
    ensureFloatBall();
    // 站内跳转也要按自动规则翻（换页后原先没翻的状态下才用得上）
    if (autoSites.includes(location.hostname) || autoLangs.length) startUrlWatch();
    // 自动翻译此网站 / 总是翻译该语言：命中就整页翻译（等动态内容稍稳后触发）
    if (autoTranslateWanted()) {
      setTimeout(() => {
        if (!state.isTranslated && !state.isTranslating) translatePage({ auto: true });
      }, 800);
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

  // 站点名单认域名，语言名单认内容（与站点名单互补，遇到没见过的外语站也能
  // 直接双语）
  function autoTranslateWanted() {
    if (autoSites.includes(location.hostname)) return true;
    if (!autoLangs.length) return false;
    const pageLang = detectPageLang();
    if (!pageLang) return false;
    const wanted = autoLangs.some(l => String(l).toLowerCase().split('-')[0] === pageLang);
    if (!wanted) return false;
    // 页面本来就是目标语言时不翻（目标中文、页面也中文）
    return state.targetLang.toLowerCase().split('-')[0] !== pageLang;
  }
  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.engine) {
        state.engine = changes.engine.newValue || state.engine;
        halted = null;
        hideAccountNotice();
      }
      if (changes.targetLang) state.targetLang = changes.targetLang.newValue || state.targetLang;
      if (changes.displayMode) state.displayMode = changes.displayMode.newValue || state.displayMode;
      if (changes.hoverTranslate) hoverEnabled = changes.hoverTranslate.newValue !== false;
      if (changes.hoverKey) hoverKey = changes.hoverKey.newValue || hoverKey;
      if (changes.selectionTranslate) selectionEnabled = changes.selectionTranslate.newValue !== false;
      if (changes.inputTranslate) inputEnabled = changes.inputTranslate.newValue !== false;
      if (changes.inputTargetLang) inputTargetLang = changes.inputTargetLang.newValue || inputTargetLang;
      if (changes.autoTranslateSites || changes.autoTranslateLangs) {
        if (changes.autoTranslateSites) autoSites = changes.autoTranslateSites.newValue || [];
        if (changes.autoTranslateLangs) autoLangs = changes.autoTranslateLangs.newValue || [];
        if (autoSites.includes(location.hostname) || autoLangs.length) startUrlWatch();
      }
      if (changes.floatBall) {
        floatBallEnabled = changes.floatBall.newValue !== false;
        if (floatBallEnabled) ensureFloatBall(); else removeFloatBall();
      }
    });
  }

  // ===== 输入框翻译：在可编辑区按 Alt+Enter → 就地译成 inputTargetLang（写外语场景）=====
  // 输入框在开放的 shadow DOM 里时，document 上看到的 target 是宿主元素，
  // 真正按键的元素在 composedPath 的第一位。
  function eventTarget(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path[0] || e.target;
  }

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
    const el = editableTarget(eventTarget(e));
    if (!el) return;
    const isCE = el.isContentEditable;
    const text = (isCE ? el.innerText : el.value) || '';
    if (!text.trim() || text.trim().length > 5000) return;
    e.preventDefault();
    // Alt+Enter 归输入框翻译：站点自己的 Enter 处理不能再跑。维基的搜索框
    // 有高亮的联想项时按 Enter 就跳页，译文回来之前页面已经走了。这里挂在
    // document 的捕获阶段，先于输入框自己的监听。
    e.stopPropagation();
    try {
      const codes = [];
      const resp = await translateKept(text.trim(), inputWithCode(text.trim(), codes), codes, inputTargetLang, state.engine);
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

  // 不是 p/li 这类标签、但按块排版且里面只有行内内容的元素，也算一段正文：
  // X 的推文正文是 div[data-testid=tweetText]，里面只有 span/a/br。要求「没有
  // 块级子元素」是为了从命中点往上只停在最近的一段，而不是整栏；字数上限兜底
  // 那种整页只靠 <br> 排版的大容器。
  const HOVER_MAX_TEXT = 2000;
  const BLOCK_CHILD_SELECTOR = 'p, div, section, article, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, li, blockquote, pre, form, header, footer, main, nav, aside';

  function laysOutAsBlock(el) {
    let display = '';
    try { display = getComputedStyle(el).display || ''; } catch (_) { return false; }
    return !!display && display !== 'none' && display !== 'contents' && !display.startsWith('inline');
  }

  // 按实际排版判断子元素：贴文里的 inline-flex 小徽标（Bluesky 的「1/28」）
  // 是个 div，但不该让整段失去资格。找到第一个块级后代就返回，容器很快判完。
  function hasBlockDescendant(el, selector) {
    for (const d of el.querySelectorAll(selector)) if (laysOutAsBlock(d)) return true;
    return false;
  }

  function isLeafTextBlock(el) {
    return laysOutAsBlock(el) && !hasBlockDescendant(el, BLOCK_CHILD_SELECTOR);
  }

  function findHoverBlock(node) {
    let el = node;
    while (el && el !== document.body) {
      if (el.nodeType === Node.ELEMENT_NODE) {
        const tagged = HOVER_BLOCK_TAGS.has(el.tagName);
        if ((tagged || isLeafTextBlock(el)) && shouldTranslate(el)) {
          const text = extractText(el);
          if (text && text.trim().length >= 5 && (tagged || text.length <= HOVER_MAX_TEXT) &&
              !isAlreadyTargetLang(text, state.targetLang, declaredLang(el))) return el;
        }
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

  // 滚到哪翻到哪：视口和上下各一屏半以内的块现在就翻，再远的等滚近了再翻。
  // 整页一次全排进后台会把长条目的参考文献也全送出去（维基「木星」六百多个
  // 请求），免费引擎半路就开始 429；没人往下看的部分不必翻。
  const NEAR_SCREENS = 1.5;

  function inViewport(el, margin = window.innerHeight * NEAR_SCREENS) {
    const r = el.getBoundingClientRect();
    return r.bottom > -margin && r.top < window.innerHeight + margin;
  }

  // auto：自动翻译名单触发的（不是用户按的）。账号被拒停下以后，只有用户
  // 自己再按一次翻译（或换引擎）才重试，自动触发不算。
  async function translatePage({ auto = false } = {}) {
    if (state.isTranslating) return;
    if (halted && auto) return;
    halted = null;
    hideAccountNotice();

    const settings = await getSettings();
    state.engine = settings.engine || 'google';
    state.targetLang = settings.targetLang || 'zh-CN';
    state.displayMode = settings.displayMode || 'bilingual';
    state.isTranslating = true;
    syncBallMenu();
    const sess = session;
    // 翻的就是眼前这一页：之后的站内跳转以它为起点比对
    state.pageKey = pageKeyOf(location.href);
    startDomWatch();
    startUrlWatch();

    try {
      state.totalCount = 0;
      state.translatedCount = 0;
      state.failedCount = 0;
      state.lastError = '';

      // 视口内的块一翻完就返回、进度条就收起，临近的在后台继续，再远的等滚到。
      // 可视区一段都没翻（视口里没有正文，比如整屏头图）又没失败时，把整页都
      // 排上再等，免得把「没翻」报成成功；失败了就直接报，不拿整页去撞同一面墙。
      await runPass();
      // 半路被还原或被拒停下（会话号变了）就不再补排整页
      if (sess === session && !state.translatedCount && !state.failedCount) { backfill(); await whenIdle(); }

      // 一段都没插进去就不算「已翻译」：否则按钮翻成「恢复原文」，再点一次
      // 只是把不存在的译文撤掉，用户永远回不到重试那一步。
      state.isTranslated = state.translatedCount > 0;
      if (!state.isTranslated) { stopDomWatch(); resetQueues(); }
    } finally {
      state.isTranslating = false;
      hideProgressBar();
      syncBallMenu();
    }
  }

  // ===== 调度：视口优先、临近的后台补、远处的滚到才翻 =====
  // 整页、动态新增、换页补扫共用一个并发上限：免费引擎靠它不被限流。
  // 取块顺序：此刻就在视口里的 > 视口临近的 > backlog，每一级里正文
  // 先于界面（见 rankOf）。「此刻在视口里」由一个零边距的 IntersectionObserver
  // 维护，而不是每取一块量一次位置——每插一条译文都会让布局失效，逐块量等于
  // 逐块强制重排。
  const CONCURRENCY = 4;
  const RANKS = 7;
  const tiers = () => Array.from({ length: RANKS }, () => []);
  let urgent = tiers();     // 登记时就在视口内或临近
  let backlog = tiers();    // 后台补全的块：没有 IntersectionObserver 时的视口外块，和 backfill 排上的
  const waiting = new Set(); // 已登记未开译：backlog 里的 + 只等滚到的
  const inView = new Set();  // 已登记未开译、此刻在视口里的块
  const inFlight = new Set();
  let queued = new WeakSet(); // 本页登记过的块，防止同一块重复排队
  let nearObserver = null;
  let viewObserver = null;
  let idleWaiters = [];
  let fg = null;            // 当前一轮的可视块：{ pending, total, resolve }
  let session = 0;          // 还原时 +1，晚到的译文据此作废

  function active() {
    return state.isTranslated || state.isTranslating;
  }

  // 先分区：正文（文章、README）> <main> 里的其它块 > 其余界面。页面没有
  // 任何语义容器时，由 findContentRoot 找出的最大正文容器算正文。
  // 前两区里再按块的种类分档：段落 > 标题、列表等 > 表格与图里的块。维基的
  // 信息框在文档里排在首段之前，几十个单元格各占一个请求，首段要等它们翻完。
  const MAIN_CONTENT = 'article, .markdown-body, [itemprop="articleBody"], [role="article"]';
  const TABULAR = 'table, figure, figcaption, caption';
  let contentRoot = null;
  let ranks = new WeakMap();

  function rankOf(el) {
    let r = ranks.get(el);
    if (r === undefined) {
      const area = (el.closest(MAIN_CONTENT) || (contentRoot && contentRoot.contains(el))) ? 0
        : el.closest('main, [role="main"]') ? 1 : 2;
      const kind = el.closest(TABULAR) ? 2 : el.tagName === 'P' ? 0 : 1;
      r = area === 2 ? RANKS - 1 : area * 3 + kind;
      ranks.set(el, r);
    }
    return r;
  }

  // 段落字数（父容器全计、祖父容器计一半）最多的容器：正文段落常常各自
  // 包一层 div，只算父容器会选中其中一段。
  function findContentRoot(blocks) {
    if (document.querySelector(MAIN_CONTENT + ', main, [role="main"]')) return null;
    const score = new Map();
    for (const b of blocks) {
      if (b.tagName !== 'P') continue;
      const len = b.textContent.length;
      const parent = b.parentElement;
      const grand = parent && parent.parentElement;
      if (parent) score.set(parent, (score.get(parent) || 0) + len);
      if (grand) score.set(grand, (score.get(grand) || 0) + len / 2);
    }
    let best = null, max = 0;
    for (const [el, n] of score) if (n > max) { best = el; max = n; }
    return best;
  }

  // 视口外的块只等滚到；没有 IntersectionObserver 时退回 backlog 后台补全。
  function schedule(blocks) {
    if (halted) return;
    for (const b of blocks) {
      const near = inViewport(b);
      if (queued.has(b)) {
        if (near && waiting.delete(b)) urgent[rankOf(b)].push(b);
        continue;
      }
      queued.add(b);
      state.totalCount++;
      const observed = observe(b);
      if (near) { urgent[rankOf(b)].push(b); continue; }
      waiting.add(b);
      if (!observed) backlog[rankOf(b)].push(b);
    }
    pump();
  }

  function observe(el) {
    if (typeof IntersectionObserver !== 'function') return false;
    if (!nearObserver) {
      nearObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (en.isIntersecting && waiting.delete(en.target)) urgent[rankOf(en.target)].push(en.target);
        }
        pump();
      }, { rootMargin: `${NEAR_SCREENS * 100}% 100%` });
      viewObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (en.isIntersecting) inView.add(en.target); else inView.delete(en.target);
        }
        pump();
      });
    }
    nearObserver.observe(el);
    viewObserver.observe(el);
    return true;
  }

  function startable(el) {
    return el.isConnected && !el.dataset.yllDone && !inFlight.has(el);
  }

  function take(el) {
    waiting.delete(el);
    inView.delete(el);
    if (nearObserver) { nearObserver.unobserve(el); viewObserver.unobserve(el); }
    return el;
  }

  function nextBlock() {
    let best = null;
    for (const el of inView) {
      if (!startable(el)) { inView.delete(el); continue; }
      if (!best || rankOf(el) < rankOf(best)) best = el;
    }
    if (best) return take(best);
    for (const q of urgent) {
      while (q.length) {
        const el = q.shift();
        if (startable(el)) return take(el);
        // 在途的块由它自己落地时结算
        if (!inFlight.has(el)) settle(el);
      }
    }
    for (const q of backlog) {
      while (q.length) {
        const el = q.shift();
        if (waiting.has(el) && startable(el)) return take(el);
      }
    }
    return null;
  }

  // 免费 Google 的请求会拼包（见 request）：块的并发要够凑满几包
  function blockLimit() {
    return state.engine === 'google' ? CONCURRENCY * PACK_BLOCKS : CONCURRENCY;
  }

  function pump() {
    while (!halted && inFlight.size < blockLimit()) {
      const el = nextBlock();
      if (!el) break;
      inFlight.add(el);
      const done = (changed) => {
        inFlight.delete(el);
        // 失败的块放出登记，之后这块再被改动/再扫到时还能重试；
        // 等译文期间内容换了的块按新内容重排
        if (!el.dataset.yllDone) queued.delete(el);
        if (changed === CHANGED && active() && mayRefresh(el)) schedule([el]);
        settle(el);
        pump();
      };
      translateBlock(el).then(done, done);
    }
    if (inFlight.size === 0) releaseIdle();
  }

  // 还原、被拒停下时不必等在途的块落地：它们回来时按会话号作废
  function releaseIdle() {
    const ws = idleWaiters; idleWaiters = [];
    ws.forEach(r => r());
  }

  // 还在等滚到的块全部排进 backlog（见 translatePage）
  function backfill() {
    for (const el of waiting) backlog[rankOf(el)].push(el);
    pump();
  }

  function whenIdle() {
    return new Promise(resolve => { idleWaiters.push(resolve); pump(); });
  }

  function settle(el) {
    if (!fg || !fg.pending.delete(el)) return;
    updateProgressBar();
    if (!fg.pending.size) finishForeground();
  }

  function finishForeground() {
    if (fg) { const f = fg; fg = null; f.resolve(); }
    hideProgressBar();
  }

  // 一轮整页扫描：可视块排最前并驱动进度条，临近的跟上，远处的等滚到。
  function runPass() {
    if (fg) fg.resolve();
    const blocks = collectBlocks();
    contentRoot = findContentRoot(blocks);
    ranks = new WeakMap();
    const visible = blocks.filter(b => inViewport(b, 0));
    showProgressBar();
    return new Promise(resolve => {
      fg = { pending: new Set(visible), total: visible.length, resolve };
      updateProgressBar();
      schedule(visible);
      schedule(blocks);
      if (fg && !fg.pending.size) finishForeground();
    });
  }

  function resetQueues() {
    urgent = tiers();
    backlog = tiers();
    waiting.clear();
    inView.clear();
    if (nearObserver) {
      nearObserver.disconnect(); viewObserver.disconnect();
      nearObserver = null; viewObserver = null;
    }
    queued = new WeakSet();
    finishForeground();
  }

  // ===== 请求：同时在途不超过 CONCURRENCY 个，免费 Google 短块拼包，长块切段 =====
  // 页面翻译的请求都从这里出去。免费 Google 按请求次数限流，而维基参考文献
  // 这种页面全是一两行的短块：排队的短块按行拼成一个请求（最多 PACK_BLOCKS 块、
  // PACK_CHARS 字），引擎把换行原样带回，按行拆回各块。行数对不上（引擎并了
  // 或拆了行）就把这一包拆成单块重排；本身带换行的块不拼。超时按请求算：
  // 挂住的请求到点让出名额，包里每块按失败记账。
  // 首屏的块（这一轮进度条等着的）不等凑满一包：只和首屏的块拼，摊到空着的
  // 并发名额上：长包回得比短包慢，首屏不该等它。
  const PACK_BLOCKS = 10;
  const PACK_CHARS = 1800;
  let reqQueue = [];        // { text, size, packable, urgent, resolve, reject }
  let reqInFlight = 0;
  let dispatchQueued = false;

  // 长块（YouTube 简介动辄三千多字）按句子和换行切成不超过 PART_CHARS 的几段，
  // 并发送出（照样受上面的并发上限管），回来按原顺序拼好。Bing 单次只吃 1000 字，
  // 整块进去会在后台一段段串行，十几秒才回来。只对免费引擎这样切：AI 档看整段
  // 上下文译得更好。不在一对链接标记中间下刀，否则两段都拿着半个标记。
  const LONG_CHARS = 1500;
  const PART_CHARS = 1000;
  const FREE_ENGINES = new Set(['google', 'microsoft', 'mymemory']);
  const SENTENCE_END = /[.!?。！？]+["'”’)\]]*\s+|[。！？]+|\n\s*/g;

  function request(text, urgent = false) {
    if (text.length > LONG_CHARS && FREE_ENGINES.has(state.engine)) return requestParts(splitLong(text), urgent);
    return enqueue(text, urgent);
  }

  function openLinks(s) {
    const count = (re) => (s.match(re) || []).length;
    return count(/<\s*a\s*\d+\s*>/gi) - count(/<\s*\/\s*a\s*\d+\s*>/gi) +
      count(/__PII_LINK_\d+__/g) - count(/__PII_LINKEND_\d+__/g);
  }

  function splitLong(text) {
    const pieces = [];
    let last = 0, m;
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(text))) {
      pieces.push(text.slice(last, SENTENCE_END.lastIndex));
      last = SENTENCE_END.lastIndex;
    }
    if (last < text.length) pieces.push(text.slice(last));
    const parts = [];
    let buf = '';
    for (const piece of pieces) {
      if (buf && buf.length + piece.length > PART_CHARS && !openLinks(buf)) { parts.push(buf); buf = ''; }
      buf += piece;
    }
    if (buf) parts.push(buf);
    return parts;
  }

  // 段与段之间按原文接：换行照留，空格留一个（中文、日文译文不留）
  async function requestParts(parts, urgent) {
    const resps = await Promise.all(parts.map(p => (p.trim() ? enqueue(p.trim(), urgent) : { success: true, translation: '' })));
    const failed = resps.find(r => !(r && r.success));
    if (failed !== undefined) return failed;
    const tight = TIGHT_TARGETS.test(state.targetLang);
    const translation = resps.map((r, i) => {
      const tail = /\s*$/.exec(parts[i])[0];
      const gap = tail.includes('\n') ? tail.replace(/[^\n]/g, '') : tail && !tight ? ' ' : '';
      return ((r.translation || '').trim() || parts[i].trim()) + gap;
    }).join('').trim();
    return { ...resps[0], translation };
  }

  // 包的大小按引擎实际收到的算：后台给免费引擎把缩写换成更长的占位符
  //（keepAcronyms 逐行判断，单块量出来的就是它在包里的长度），每个占位符再留
  // 一位给包里接着编的两位序号
  function wireSize(text) {
    if (typeof YLSensitive === 'undefined') return text.length;
    const kept = YLSensitive.keepAcronyms(text);
    return kept.text.length + kept.tokens.length;
  }

  function enqueue(text, urgent = false) {
    return new Promise((resolve, reject) => {
      const packable = state.engine === 'google' && !text.includes('\n');
      reqQueue.push({ text, size: packable ? wireSize(text) : text.length, packable, urgent, resolve, reject });
      // 同一轮 pump 里登记的请求都排进来以后再拼包
      if (!dispatchQueued) { dispatchQueued = true; Promise.resolve().then(dispatch); }
    });
  }

  function dispatch() {
    dispatchQueued = false;
    while (reqInFlight < CONCURRENCY && reqQueue.length) {
      const head = reqQueue.shift();
      const pack = [head];
      let room = PACK_BLOCKS;
      if (head.urgent) {
        const urgentLeft = 1 + reqQueue.filter(r => r.urgent).length;
        room = Math.min(room, Math.ceil(urgentLeft / (CONCURRENCY - reqInFlight)));
      }
      let chars = head.size;
      for (let i = 0; head.packable && i < reqQueue.length && pack.length < room;) {
        const r = reqQueue[i];
        if (r.packable && r.urgent === head.urgent && chars + 1 + r.size <= PACK_CHARS) {
          pack.push(r);
          chars += 1 + r.size;
          reqQueue.splice(i, 1);
        } else i++;
      }
      sendPack(pack);
    }
  }

  function sendPack(pack) {
    reqInFlight++;
    const sent = withTimeout(api.runtime.sendMessage({
      type: 'translate',
      text: pack.map(r => r.text).join('\n'),
      engine: state.engine,
      targetLang: state.targetLang,
      sourceLang: 'auto'
    }), blockTimeoutMs);
    sent.then((resp) => {
      if (pack.length === 1) return pack[0].resolve(resp);
      if (!(resp && resp.success)) return pack.forEach(r => r.resolve(resp));
      const lines = String(resp.translation || '').split('\n');
      if (lines.length === pack.length && lines.every(l => l.trim())) {
        pack.forEach((r, i) => r.resolve({ ...resp, translation: lines[i] }));
      } else {
        reqQueue.unshift(...pack.map(r => ({ ...r, packable: false })));
      }
    }, (err) => pack.forEach(r => r.reject(err))).finally(() => {
      reqInFlight--;
      dispatch();
    });
  }

  // 还原后还没发出去的请求作废：等着它们的块落地时会按会话号丢掉结果
  function dropRequests() {
    const dropped = reqQueue;
    reqQueue = [];
    dropped.forEach(r => r.resolve(null));
  }

  // ===== 官网 AI 档被拒：第一次就停下整页 =====
  // 没登录（401）、额度用完（402）时，这一页后面的块会被同样拒掉：再送只是让
  // 一直在变的页面每批变动都重撞一次（测试者在动态页上 34 秒看到 51 个请求）。
  // 第一次被拒就停：已排队和等滚到的块作废，动态翻译不再跟，在途的那一批回来
  // 时按会话号丢掉。用户再按一次翻译或换引擎前不再送（见 translatePage）。
  const ACCOUNT_CODES = new Set(['login_required', 'out_of_credits', 'usage_cap']);
  let halted = null; // { code, error }

  function accountRefusal(resp) {
    return !!(resp && !resp.success && ACCOUNT_CODES.has(resp.code));
  }

  function haltForAccount(resp) {
    if (halted) return;
    halted = { code: resp.code, error: resp.error || '', site: resp.site || OI_SITE };
    session++;
    stopDomWatch();
    resetQueues();
    dropRequests();
    releaseIdle();
    showAccountNotice(halted);
  }

  // 被拒后页面上只出一条提示：没登录给「登录」，额度用完给「购买额度」，
  // 两种都给「改用免费 Google」（换引擎并立刻重翻）。合理使用上限买额度
  // 解决不了，只给后者。
  const OI_SITE = 'https://openimmersive.ai';
  let acctNotice = null;

  function showAccountNotice(h) {
    hideAccountNotice();
    if (!document.body) return;
    const box = document.createElement('div');
    box.id = 'yll-acct-notice';
    box.setAttribute('data-yll-ui', 'true');
    box.setAttribute('role', 'alert');
    const text = document.createElement('div');
    text.className = 'yll-acct-text';
    text.textContent = h.error;
    const row = document.createElement('div');
    row.className = 'yll-acct-actions';
    const button = (label, primary, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yll-acct-btn' + (primary ? ' yll-acct-primary' : '');
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    };
    const open = (url) => () => { window.open(url, '_blank', 'noopener'); };
    if (h.code === 'login_required') row.append(button(T('acctLogIn'), true, open(OILoginUrl(h.site))));
    if (h.code === 'out_of_credits') row.append(button(T('acctBuyCredits'), true, open(`${h.site}/#pricing`)));
    row.append(button(T('acctUseGoogle'), false, useFreeGoogle));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'yll-acct-close';
    close.textContent = '×';
    close.title = T('acctDismiss');
    close.setAttribute('aria-label', T('acctDismiss'));
    close.addEventListener('click', hideAccountNotice);
    box.append(text, row, close);
    document.body.appendChild(box);
    acctNotice = box;
  }

  function hideAccountNotice() {
    if (acctNotice) { acctNotice.remove(); acctNotice = null; }
  }

  async function useFreeGoogle() {
    hideAccountNotice();
    await storageSet({ engine: 'google' });
    state.engine = 'google';
    halted = null;
    if (active()) removeTranslations();
    translatePage();
  }

  // ===== 动态内容：已翻译状态下，新插入的正文随出现随翻 =====
  // 只看 childList/characterData，不看属性——属性抖动（class、样式、计数）
  // 是 SPA 的常态，跟正文无关。按固定间隔成批处理，不随每次变动重置计时，
  // 否则一直在动的页面（X 时间线）永远等不到处理。
  const MUTATION_BATCH_MS = 300;
  let domObserver = null;
  let mutTimer = null;
  let mutRoots = new Set();
  let sawRemoval = false;

  function startDomWatch() {
    if (domObserver || typeof MutationObserver !== 'function' || !document.body) return;
    domObserver = new MutationObserver(onMutations);
    domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopDomWatch() {
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    clearTimeout(mutTimer);
    mutTimer = null;
    mutRoots = new Set();
    sawRemoval = false;
  }

  function onMutations(records) {
    for (const r of records) {
      // 文字原地改写也可能落在仅译文模式的原文壳里（框架改的是它自己的文本节点）
      if (r.type === 'characterData') { noteChanged(r.target.parentElement, '[data-yll-ui]'); continue; }
      if (r.removedNodes.length) sawRemoval = true;
      for (const n of r.addedNodes) {
        noteChanged(n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement, '[data-yll-ui], [data-yll-orig]');
      }
    }
    if ((mutRoots.size || sawRemoval) && !mutTimer) mutTimer = setTimeout(flushMutations, MUTATION_BATCH_MS);
  }

  // 自己插的译文、仅译文模式往原文壳里挪节点——处理它们只会自己追自己
  function noteChanged(el, ownSelector) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (el.closest(ownSelector)) return;
    mutRoots.add(el);
  }

  function flushMutations() {
    mutTimer = null;
    const roots = mutRoots;
    mutRoots = new Set();
    if (!active() || halted) return;
    checkUrl();
    if (sawRemoval) { sawRemoval = false; dropOrphanTranslations(); }
    for (const el of waiting) if (!el.isConnected) take(el);

    const found = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      let skip = false;
      let owner = null;
      for (let a = root; a && a !== document.body; a = a.parentElement) {
        if (a !== root && roots.has(a)) { skip = true; break; }
        if (a.dataset && a.dataset.yllDone) { owner = a; break; }
        if (queued.has(a)) { skip = true; break; }
      }
      if (skip) continue;
      // 变动落在一个已译块里面：内容换了就撤掉旧译文重翻（shouldTranslate 判旧）
      if (owner) { if (shouldTranslate(owner)) found.push(owner); continue; }
      found.push(...collectBlocks(root));
    }
    if (found.length) schedule(found);
  }

  // 原块被框架删掉、插在它后面的译文兄弟节点却留在父容器里，就成了一条
  // 没有原文的孤儿译文；同位置换上的新节点再翻一次还会叠出两条。
  function dropOrphanTranslations() {
    for (const node of document.querySelectorAll('[data-yll-inject]')) {
      const owner = injectOwner.get(node);
      if (owner && !owner.isConnected) node.remove();
    }
  }

  // ===== 站内跳转（SPA）=====
  // content script 在隔离环境里，改写 history.pushState 拦不到页面自己的调用，
  // 而 world:MAIN 脚本要 Firefox 128+（我们支持到 115）。所以不挂钩子：
  // Navigation API（有就用）、popstate、动态内容批处理时顺带比对，再加一个
  // 很轻的轮询兜底。只比到 # 之前——页内锚点跳转不算换页。
  const URL_POLL_MS = 1000;
  const NAV_SETTLE_MS = 500;
  let urlWatching = false;
  let navTimer = null;

  function pageKeyOf(href) {
    return String(href).split('#')[0];
  }

  function startUrlWatch() {
    if (urlWatching) return;
    urlWatching = true;
    window.addEventListener('popstate', checkUrl);
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', () => setTimeout(checkUrl, 0));
    }
    setInterval(checkUrl, URL_POLL_MS);
  }

  function checkUrl() {
    const key = pageKeyOf(location.href);
    if (key === state.pageKey) return;
    state.pageKey = key;
    onPageChange();
  }

  function onPageChange() {
    clearTimeout(navTimer);
    if (active()) {
      // 新页面重新计数、重新登记；旧页面还在途的块落地时已脱离文档，自然作废
      resetQueues();
      state.totalCount = 0;
      state.translatedCount = 0;
      state.failedCount = 0;
      state.lastError = '';
      // 新内容大多已被动态翻译接住；这一轮补的是框架复用、只是从隐藏变可见的节点
      // 被拒停下时不补：块排不出去，进度条会停在 0% 等不到头
      navTimer = setTimeout(() => { if (active() && !halted) runPass(); }, NAV_SETTLE_MS);
    } else if (autoTranslateWanted()) {
      navTimer = setTimeout(() => {
        if (!state.isTranslated && !state.isTranslating) translatePage({ auto: true });
      }, 800);
    }
  }

  // 同一段文字在一个页面里会反复出现在新节点上：X 时间线滚走的推文会被卸载，
  // 滚回来是全新的节点。记住译文就不用再去敲一次免费引擎。
  const MEMO_MAX = 1000;
  const memo = new Map();

  function memoKey(text) {
    return state.engine + '\u0000' + state.targetLang + '\u0000' + text;
  }

  function remember(key, translation) {
    memo.set(key, translation);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }

  const CHANGED = 'changed';

  // 一直在变的块（倒计时、实时比分）每变一次就重翻，会持续敲免费引擎；
  // 同一个节点换过几次内容后就不再跟。
  const MAX_REFRESHES = 5;
  const refreshes = new WeakMap();

  function mayRefresh(el) {
    const n = (refreshes.get(el) || 0) + 1;
    refreshes.set(el, n);
    return n <= MAX_REFRESHES;
  }

  // 引擎一直不回（请求挂住、后台被回收后消息没人接）时，这个请求里的块按失败
  // 记账、让出并发名额：否则四个挂住的请求就能让整页停在半路、进度条永远不收。
  // 上限按慢的 AI 档长段落留足余量。
  let blockTimeoutMs = 60000;

  function withTimeout(promise, ms) {
    let timer;
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(T('errTimeout'))), ms);
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
  }

  async function translateBlock(el) {
    const text = extractText(el);
    if (!text || text.trim().length < minTextLen(el, 5)) return;

    // 跳过已经是目标语言的内容
    if (isAlreadyTargetLang(text, state.targetLang, declaredLang(el))) return;

    // 「A • B • C」式专有名词名单（署名墙、合作伙伴列表）：引擎会把一部分
    // 品牌名意译成怪词（Cognition→认知、Disruptive→颠覆性），剩下的保留，
    // 观感像随机挑着翻。整段跳过比翻一半更不伤原文。
    if (looksLikeNameList(text)) return;

    // 不是句子，是名字或数据：文件名、品牌名、提交时间、只有一段代码的列表项
    if (looksLikeName(text) || !hasProse(el, text)) return;

    // 行内代码换成占位符再送引擎，译文回来再换回原文（window 不会变成「窗口」）。
    // sensitive-mask.js 由 manifest 排在本文件之前注入；万一没加载上，
    // 保证不了代码原样就不翻这段。
    // 仅译文模式下原文连同链接一起藏起来，链接文字两头加成对的标记送出，
    // 译文回来按标记重建可点的链接（见 LINK_MARK、linkNodes）。
    const hasCode = !!el.querySelector('code, kbd, samp, var');
    if (hasCode && typeof YLSensitive === 'undefined') return;
    const keeps = typeof YLSensitive !== 'undefined';
    const wantLinks = state.displayMode === 'replace' && !!el.querySelector('a[href]');
    // 送给引擎的版本：codes 记占位符对应的原文，links 记打了标记的链接
    const prepare = (linkStyle) => {
      const codes = [];
      let links = wantLinks ? Object.assign([], { style: linkStyle }) : null;
      let source = hasCode || links ? extractText(el, codes, links).trim() : text.trim();
      if (links && !links.length) links = null;
      if (keeps) source = YLSensitive.keepNames(source, codes);
      return { source, codes, links };
    };
    const job = prepare('tag');
    if (!/\p{L}/u.test(job.source.replace(/__PII_[A-Z]+_\d+__|<\/?a\d+>/g, ''))) return;
    const links = job.links;

    // 首屏的块插队，见 request
    const ask = (source) => request(source, !!(fg && fg.pending.has(el)));
    // 占位符换回原文；'' 表示引擎吞掉或改坏了占位符，null 表示没拿到译文
    const restore = (resp, { codes }) => {
      if (!(resp && resp.success && resp.translation)) return null;
      if (!codes.length) return resp.translation;
      const restored = YLSensitive.restoreCounting(resp.translation, codes);
      return restored.missing ? '' : restored.text;
    };

    const sess = session;
    const key = memoKey((links ? 'links\u0000' : '') + text.trim());
    try {
      const cached = memo.get(key);
      const resp = cached !== undefined ? null : await ask(job.source);
      if (accountRefusal(resp)) {
        if (sess === session) { recordFailure(resp.error); haltForAccount(resp); }
        return;
      }
      let translation = cached !== undefined ? cached : restore(resp, job);
      // 链接标记被引擎弄丢：换另一种标记再问一次。免费链条里实际答话的引擎
      // 事先不知道，而 Bing 留得住 <a1>、Google 留得住 __PII_LINK_1__。
      if (cached === undefined && translation && links && !linkNodes(translation, links) &&
          typeof YLSensitive !== 'undefined') {
        const alt = prepare('pii');
        const again = restore(await ask(alt.source), alt);
        if (again) translation = again;
      }

      // 等译文的这段时间里页面可能已还原、节点被框架拿走或换了内容：
      // 旧译文不能插到新内容后面。
      if (sess !== session || !el.isConnected || el.dataset.yllDone) return;
      if (extractText(el) !== text) return CHANGED;

      // 宁可这段留原文，也不显示缺了代码的译文
      if (translation === '') return;
      if (translation) {
        if (cached === undefined) remember(key, translation);
        // 译文和原文实质相同就别插：中英混排的条目（"法律（英语：Legal
        // translation）"）CJK 占比过不了 isAlreadyTargetLang 的阈值，翻回来
        // 却几乎原样，插进去只是把页面撑成两份。这条与语言无关，通用兜底。
        if (sameText(translation.replace(LINK_MARK, ''), text)) return;
        injectTranslation(el, translation, links);
        state.translatedCount++;
        return;
      }
      // 引擎失败是 resolve 出来的 { success:false, error }，不是 reject ——
      // 这条 else 之前不存在，所以「Google 被限流」和「翻译成功但内容相同」
      // 在页面上是同一个结果：什么都没发生。
      recordFailure(resp && resp.error);
    } catch (err) {
      // 单段失败不打断其他段落，但必须留痕。此前这里是个空 catch，连
      // 「background 不在」这种整页级故障都看不见。
      recordFailure(err && err.message);
    }
  }

  // 只留第一条原话：几十个块通常败在同一个原因上，留第一条足够定位，
  // 也不用把错误列表搬进 popup。
  function recordFailure(message) {
    state.failedCount++;
    if (!state.lastError) state.lastError = message || T('errUnknown');
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
      const paras = Array.from(root.children).filter(c => c.dataset && c.dataset.yllPara);
      // 框架重绘过正文，我们包的那层已经没了：标记是旧的，按现在的内容重切
      if (paras.length) return paras;
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

  function collectTweetBlocks(root, seen, results) {
    for (const tweet of within(root, '[data-testid="tweetText"]')) {
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

  // root 自身也算候选：动态新增的子树根常常就是一个 <p>
  function within(root, selector) {
    const list = Array.from(root.querySelectorAll(selector));
    if (root.matches && root.matches(selector)) list.unshift(root);
    return list;
  }

  // 兜底叶子块认的块级标签
  const LEAF_BLOCK_SELECTOR = 'p,div,section,article,ul,ol,table,h1,h2,h3,h4,h5,h6,li,blockquote,td';

  // 自己的直接文本里有字：区分「一段话带个行内徽标」和「只是一排行内小块的外壳」
  function holdsOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE && /\p{L}/u.test(n.textContent)) return true;
    return false;
  }

  // 是否启用兜底叶子块由整页扫描决定，动态新增的小子树沿用：在一张推文卡片
  // 这种局部里算覆盖率，几乎总会触发兜底，把用户名、按钮文案也捞进来。
  let pageLeafFallback = false;

  function collectBlocks(root = document.body) {
    const results = [];
    const seen = new WeakSet();

    // X 的正文不是 p/li，通用选择器一个都命中不到，会落到兜底的"叶子块"分支去
    // 猜——推文这种结构明确的东西不该靠猜。个人简介之类仍交给后面的通用流程。
    if (SITE === 'x') collectTweetBlocks(root, seen, results);

    // 优先选择语义化文本块
    const selector = [
      'article p', 'main p', '.content p', '.post p', '.article p',
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'blockquote', 'figcaption', 'td', 'th',
      'dt', 'dd', 'summary',
      ...(SITE_BLOCKS[SITE] ? [SITE_BLOCKS[SITE]] : [])
    ].join(', ');

    for (const el of within(root, selector)) {
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
    if (root === document.body) {
      let coveredLen = 0;
      for (const el of results) coveredLen += extractText(el).trim().length;
      const bodyLen = ((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\s+/g, ' ').trim().length;
      pageLeafFallback = !SITE_NO_LEAF_FALLBACK.has(SITE) && bodyLen >= 40 && coveredLen / bodyLen < 0.5;
    }
    if (pageLeafFallback) {
      for (const el of within(root, 'div, section, article, span')) {
        if (seen.has(el)) continue;
        // 先做便宜的结构判断：动态批处理会在每张新卡片上跑这一段。带块级标签
        // 后代、但自己装着字的容器再按实际排版看一次（和悬停取段同一条规则）：
        // Bluesky 贴文没有 <p>，末尾的「1/5」徽标是个 inline-flex 的 div。
        if (el.querySelector(LEAF_BLOCK_SELECTOR) &&
            !(holdsOwnText(el) && !hasBlockDescendant(el, LEAF_BLOCK_SELECTOR))) continue;
        if (!shouldTranslate(el)) continue;
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
    // 跳过已翻译——除非框架复用了这个节点、只换了里面的文字（React 列表、
    // SPA 换页常见）：标记还在，内容已不是当初翻的那段，撤掉旧译文重翻。
    if (el.dataset.yllDone) {
      const was = doneText.get(el);
      if (was === undefined || was === extractText(el)) return false;
      if (!mayRefresh(el)) return false;
      clearBlock(el);
    }

    // 跳过本扩展自己插入的元素
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

    // 跳过包含代码块的块。行内 <code> 不算：MDN 这类文档几乎每段都夹着
    // fetch()、Response，按它跳过会漏掉大半正文。
    if (el.querySelector('pre, .code, .highlight')) return false;

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

  // 行内代码：句子的一部分，但里面是标识符，不能交给引擎意译
  const INLINE_CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR']);

  // 给了 codes 就把行内代码换成占位符、原文按序记进 codes（发给引擎的版本）；
  // 不给就带上代码原文（比对内容、判断语种用的版本）。给了 links 就给每个
  // 有字的链接前后加上 links.style 写法的成对标记，链接元素按序记进 links。
  function extractText(el, codes, links) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 跳过本扩展注入的内容
        if (node.dataset.yllInject) continue;
        // 仅译文模式把原文挪进了隐藏壳：它仍是这块的原文，不能被下面的
        // 「视觉隐藏」规则当成辅助文本丢掉
        if (node.dataset.yllOrig) { text += extractText(node, codes, links); continue; }
        if (INLINE_CODE_TAGS.has(node.tagName)) {
          text += codes ? codePlaceholder(node.textContent, codes) : node.textContent;
          continue;
        }
        // 也跳过不该当正文的子树：维基条目里 <style> 常嵌在 <span> 之类的
        // 元素内部，只看直接子元素会漏掉，整段 CSS 就被当文字送去翻译
        // （译文里出现「显示：内联」）。所以要递归下去逐层排除。
        if (SKIP_TAGS.has(node.tagName)) continue;
        if (SITE_SKIP[SITE] && node.matches(SITE_SKIP[SITE])) continue;
        // 视觉隐藏的子节点（sr-only 辅助文本等）不算正文：新闻卡片里的
        // 隐藏「category」标签混进标题，译文就成了一句拼接怪话。
        if (isVisuallyHidden(node)) continue;
        const inner = extractText(node, codes, links);
        if (links && node.tagName === 'A' && node.hasAttribute('href') && /[\p{L}\p{N}]/u.test(inner)) {
          links.push(node);
          const n = links.length;
          text += links.style === 'pii'
            ? YLSensitive.placeholderFor('LINK', n) + inner + YLSensitive.placeholderFor('LINKEND', n)
            : `<a${n}>${inner}</a${n}>`;
          continue;
        }
        text += inner;
      }
    }
    return text;
  }

  // 占位符和 PII 脱敏同一套（__PII_CODE_1__）：几个免费引擎都原样带回，
  // MyMemory 会在里面插空格，还原时容忍
  function codePlaceholder(value, codes) {
    return keepPlaceholder('CODE', value, codes);
  }

  function keepPlaceholder(type, value, codes) {
    const serial = codes.length + 1;
    codes.push({ type, serial, value });
    return YLSensitive.placeholderFor(type, serial);
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

  // 整块只是一个词、而这个词长得像名字：文件名（README.md、main.py、.gitignore）、
  // 路径、全大写（LICENSE、VERSION）、驼峰或带下划线（LibreTranslate、
  // check_command）。引擎会把它们意译成「自述文件.md」「执照」「自由翻译」。
  // 只认不带空格的 ASCII 串：中文、日文句子本来就不带空格，不能被当成「一个词」。
  function looksLikeName(text) {
    const t = text.trim();
    if (!/^[\x21-\x7e]+$/.test(t)) return false;
    return /^\.?[\w-]+(\.[\w-]+)+$/.test(t) || /^\.[\w-]+$/.test(t) ||
      /^[\w.-]*\/[\w./-]*$/.test(t) || /^[A-Z][A-Z0-9]+$/.test(t) ||
      /[a-z][A-Z]/.test(t) || /^\w+_\w+$/.test(t);
  }

  // 代码、时间、指向文件/提交的链接里的字不算正文：整块除掉它们就没有字母了，
  // 这块就是一串标签而不是一句话（GitHub 的提交说明和「Oct 26, 2026」、
  // MDN 只放一个 <code> 的列表项）。时间还会因为译文另起一行把日期撑成两行。
  const NON_PROSE_SELECTOR = 'code, kbd, samp, var, time, relative-time, ' +
    'a[href*="/blob/"], a[href*="/tree/"], a[href*="/commit/"]';

  function hasProse(el, text) {
    let rest = text;
    for (const n of el.querySelectorAll(NON_PROSE_SELECTOR)) rest = rest.replace(n.textContent, '');
    return /\p{L}/u.test(rest);
  }

  // 忽略空白与标点差异后是否是同一段文字（翻译服务常只改动标点/空格）
  function sameText(a, b) {
    const norm = (s) => String(s)
      .replace(/\s+/g, '')
      .replace(/[，。！？；：、（）【】《》""'',.!?;:()[\]<>"']/g, '')
      .toLowerCase();
    return norm(a) === norm(b);
  }

  // 只在一种中文写法里出现的高频字（成对排列），用来分简体和繁体。
  // 日文汉字两边都有重合，但带假名的日文在这之前已经分走了。
  const HANS_ONLY = '这们个来时为说国会学对经过现动实问应关开门东车长书见头电话认语让进还样么从无边间点总乐条员爱买卖写报区单变华处产业习专传亚优伤张当该发';
  const HANT_ONLY = '這們個來時為說國會學對經過現動實問應關開門東車長書見頭電話認語讓進還樣麼從無邊間點總樂條員愛買賣寫報區單變華處產業習專傳亞優傷張當該發';
  const HANT_TAG = /^zh-(tw|hk|mo|hant)/i;

  function countChars(text, set) {
    let n = 0;
    for (const ch of text) if (set.includes(ch)) n++;
    return n;
  }

  // 'hans' | 'hant' | ''（看不出）：特有字说了算，字上看不出再看语言标注
  function chineseVariant(text, contextLang) {
    const hans = countChars(text, HANS_ONLY);
    const hant = countChars(text, HANT_ONLY);
    if (hans !== hant) return hans > hant ? 'hans' : 'hant';
    if (HANT_TAG.test(contextLang)) return 'hant';
    if (/^zh-(cn|sg|hans)/i.test(contextLang)) return 'hans';
    return '';
  }

  // 是否已经是目标语言（避免翻译中文→中文）。CJK 占比只说明是「中日韩之一」，
  // 具体是哪种按书写系统分：有假名是日文，有谚文是韩文，只有汉字才可能是中文。
  // 纯汉字的短句（「概要」「経営報告」）字面上分不出中日，就看作者标注的
  // lang（元素自己或 <html> 的）。不用引擎回报的源语言：那要先把本来就是目标
  // 语言的正文发出去才知道，而且短串上它会乱报（README.md 被报成中文）。
  function isAlreadyTargetLang(text, targetLang, contextLang = '') {
    const target = String(targetLang || '').toLowerCase();
    const base = target.split('-')[0];
    if (base !== 'zh' && base !== 'ja' && base !== 'ko') return false;

    const cjkChars = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
    const ratio = cjkChars / Math.max(text.replace(/\s/g, '').length, 1);
    if (ratio <= 0.35) return false; // 不超过35%是CJK字符就照常翻

    const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    const hangul = (text.match(/\p{Script=Hangul}/gu) || []).length;
    const ctx = String(contextLang || '').toLowerCase();
    if (base === 'ko') return hangul > 0;
    if (base === 'ja') return hangul === 0 && (kana > 0 || !ctx || ctx.startsWith('ja'));
    if (kana || hangul) return false;
    if (ctx.startsWith('ja') || ctx.startsWith('ko')) return false;
    const variant = chineseVariant(text, ctx);
    return !variant || variant === (HANT_TAG.test(target) ? 'hant' : 'hans');
  }

  // 作者给这段标的语言：元素自己或最近祖先的 lang，最后是 <html lang>
  function declaredLang(el) {
    const owner = el && el.closest && el.closest('[lang]');
    return owner ? owner.getAttribute('lang') || '' : '';
  }

  // ===== 注入翻译 =====

  // 标题走行内接排（"Machine translation 机器翻译"式），正文块另起一行；
  // 两者都直接继承原文的计算样式——译文和原文看起来是同一篇文档。
  const INLINE_APPEND_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  // 已译块 → 当初翻的原文 / 它的译文节点；译文节点 → 所属块。用来认出被框架
  // 复用换了内容的块、撤掉单块的旧译文、清理原块已被删掉的孤儿译文。
  const doneText = new WeakMap();
  const injectedNode = new WeakMap();
  const injectOwner = new WeakMap();

  function clearBlock(el) {
    const node = injectedNode.get(el);
    if (node) node.remove();
    const orig = Array.from(el.children).find(c => c.dataset && c.dataset.yllOrig);
    if (orig) {
      while (orig.firstChild) el.insertBefore(orig.firstChild, orig);
      orig.remove();
    }
    delete el.dataset.yllDone;
    doneText.delete(el);
    injectedNode.delete(el);
    queued.delete(el);
  }

  // 译文的书写方向和语言跟目标语言走，不继承原文：阿拉伯语页面上的中文译文
  // 继承 dir=rtl 会右对齐，句号还会跳到行首。
  const RTL_LANGS = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);

  function targetDir() {
    return RTL_LANGS.has(String(state.targetLang).toLowerCase().split('-')[0]) ? 'rtl' : 'ltr';
  }

  // jsdom 不算 direction，退回最近的 dir 属性
  function dirOf(el, cs) {
    if (cs && cs.direction) return cs.direction;
    const owner = el.closest('[dir]');
    return owner ? owner.getAttribute('dir').toLowerCase() : 'ltr';
  }

  function markLang(node) {
    node.lang = state.targetLang;
    node.dir = targetDir();
  }

  // 链接标记有两种写法：<a1>文字</a1>，或 __PII_LINK_1__文字__PII_LINKEND_1__。
  // 维基正文段落上 Bing 留得住前者、常丢后者，Google 正相反，所以先发前者，
  // 认不回来再用后者问一次（见 translateBlock）。两种都容忍引擎插空格、改大小写。
  const LINK_MARK = /<\s*(\/?)\s*a\s*(\d+)\s*>|_{1,4}\s*PII[_\s]+LINK(END)?[_\s]+(\d+)\s*_{0,4}/gi;

  // 带链接标记的译文 → 文字与可点链接（原链接的浅拷贝，href、target、class
  // 都在，站点的委托点击照常生效）。每个链接至少出现一次、开合成对、不交叉，
  // 否则返回 null；引擎把同一链接用在两处（同一个词第二次出现）照样接受。
  function linkNodes(translation, links) {
    const frag = document.createDocumentFragment();
    const seen = new Set();
    let open = null, openSerial = 0, last = 0, m;
    LINK_MARK.lastIndex = 0;
    while ((m = LINK_MARK.exec(translation)) !== null) {
      (open || frag).append(translation.slice(last, m.index));
      last = LINK_MARK.lastIndex;
      const serial = Number(m[2] || m[4]);
      if (!m[1] && !m[3]) {
        if (open || !links[serial - 1]) return null;
        seen.add(serial);
        open = links[serial - 1].cloneNode(false);
        open.removeAttribute('id');
        openSerial = serial;
      } else {
        if (!open || serial !== openSerial) return null;
        frag.append(open);
        open = null;
      }
    }
    if (open || seen.size !== links.length) return null;
    frag.append(translation.slice(last));
    tidyLinkSpacing(frag);
    return frag;
  }

  // 引擎常在链接标记里外各留空格（「是 <a1> 太阳 </a1> 中」），重建后链接两头
  // 就是双空格。链接文字两头的空白去掉，每处边界有空白就并成一个空格（原文
  // 词间就是一个），没有就不加；紧挨开括号或收尾标点时不留；中文、日文译文里
  // 两边都不是拉丁字母或数字时也不留（汉字、假名、全角标点、脚注号之间不空格）。
  const TIGHT_TARGETS = /^(zh|ja)\b/i;

  function tidyLinkSpacing(frag) {
    const tight = TIGHT_TARGETS.test(state.targetLang);
    const gap = (left, right) => {
      if (!left || !right) return '';
      if (/[(\[{“‘«]/.test(left) || /[,.;:!?)\]}”’»，。、；：！？）」』]/.test(right)) return '';
      if (tight && !/[A-Za-z0-9]/.test(left) && !/[A-Za-z0-9]/.test(right)) return '';
      return ' ';
    };
    const textAt = (a, side) => {
      const n = side === 'before' ? a.previousSibling : a.nextSibling;
      if (n && n.nodeType === Node.TEXT_NODE) return n;
      const t = document.createTextNode('');
      a.parentNode.insertBefore(t, side === 'before' ? a : a.nextSibling);
      return t;
    };
    // 边界外侧第一个可见字：这段文字空了就看再外面那个链接
    const edge = (t, side) => {
      const s = t.data.trim();
      if (s) return side === 'before' ? s.slice(-1) : s[0];
      const n = side === 'before' ? t.previousSibling : t.nextSibling;
      const ns = n ? n.textContent.trim() : '';
      return side === 'before' ? ns.slice(-1) : ns.charAt(0);
    };
    for (const a of frag.querySelectorAll('a')) {
      const inner = a.textContent;
      const core = inner.trim();
      const before = textAt(a, 'before');
      const after = textAt(a, 'after');
      // 引擎把链接文字挪到了标记外面、标记里只剩空白：空链接不留，两边的空白照样并
      if (!core) {
        const space = /\s$/.test(before.data) || inner || /^\s/.test(after.data);
        before.data = before.data.replace(/\s+$/, '');
        after.data = after.data.replace(/^\s+/, '');
        a.remove();
        if (space) before.data += gap(edge(before, 'before'), edge(after, 'after'));
        continue;
      }
      const left = edge(before, 'before');
      const right = edge(after, 'after');
      // 标记里面的空白多半是引擎垫的，只在两侧都是拉丁字母、数字时才算词间空格
      //（韩文助词紧贴着词：「<a1>공식 문서 </a1>와」是「문서와」）
      const word = (x, y) => /[A-Za-z0-9]/.test(x) && /[A-Za-z0-9]/.test(y);
      const spaceBefore = /\s$/.test(before.data) || (/^\s/.test(inner) && word(left, core[0]));
      const spaceAfter = /^\s/.test(after.data) || (/\s$/.test(inner) && word(core.slice(-1), right));
      if (core !== inner) a.textContent = core;
      before.data = before.data.replace(/\s+$/, '') + (spaceBefore ? gap(left, core[0]) : '');
      after.data = (spaceAfter ? gap(core.slice(-1), right) : '') + after.data.replace(/^\s+/, '');
    }
  }

  function injectTranslation(el, translation, links) {
    const source = extractText(el);
    // 链接没能按标记认回时这一块退回双语显示：原文和它的链接留在原处可点
    let linked = null;
    if (links) {
      if (state.displayMode === 'replace') linked = linkNodes(translation, links);
      translation = translation.replace(LINK_MARK, '');
    }
    el.dataset.yllDone = '1';
    const track = (node) => {
      doneText.set(el, source);
      injectedNode.set(el, node);
      injectOwner.set(node, el);
    };

    // 仅显示译文：把原文子节点整体挪进一个隐藏的包裹节点（保留 DOM，可还原），
    // 译文放回元素内部——继承元素级样式，grid/表格里也不产生新兄弟节点。
    if (state.displayMode === 'replace' && (!links || linked)) {
      const orig = document.createElement('span');
      orig.className = 'yll-orig-hidden';
      orig.setAttribute('data-yll-orig', '1');
      while (el.firstChild) orig.appendChild(el.firstChild);
      const tr = document.createElement('span');
      tr.className = 'yll-tr-replace';
      tr.setAttribute('data-yll-inject', '1');
      tr.setAttribute('data-yll-ui', 'true');
      markLang(tr);
      // 方向和原块相反时，行内的译文仍按原块的方向对齐；单独成块才能按自己的方向排
      let cs = null;
      try { cs = getComputedStyle(el); } catch (_) { /* 取不到按属性判断 */ }
      if (dirOf(el, cs) !== tr.dir) {
        tr.style.display = 'block';
        if (!/center|justify/.test((cs && cs.textAlign) || '')) tr.style.textAlign = 'start';
      }
      tr.append(linked || translation);
      el.append(orig, tr);
      track(tr);
      return;
    }

    if (INLINE_APPEND_TAGS.has(el.tagName)) {
      const span = document.createElement('span');
      span.className = 'yll-tr yll-tr-inline';
      span.setAttribute('data-yll-inject', '1');
      span.setAttribute('data-yll-ui', 'true');
      markLang(span);
      span.textContent = ' ' + translation;
      el.appendChild(span);
      track(span);
      return;
    }

    const div = document.createElement('div');
    div.className = 'yll-tr';
    // 按元素实际背景深浅适配（网站深色主题时 prefers-color-scheme 可能仍是 light）
    if (isDarkBg(el)) div.classList.add('yll-tr-dark');
    div.setAttribute('data-yll-inject', '1');
    div.setAttribute('data-yll-ui', 'true');
    markLang(div);
    // 样式贴原文：字体/字号/行高/颜色/对齐全部取自原块的计算样式；方向相反时
    // 左右对齐不照搬（原文的 right 对译文是 end），居中、两端对齐照搬
    try {
      const cs = getComputedStyle(el);
      div.style.fontSize = cs.fontSize;
      div.style.fontFamily = cs.fontFamily;
      div.style.fontWeight = cs.fontWeight;
      div.style.fontStyle = cs.fontStyle;
      div.style.lineHeight = cs.lineHeight;
      div.style.color = cs.color;
      if (dirOf(el, cs) === div.dir || /center|justify/.test(cs.textAlign)) div.style.textAlign = cs.textAlign;
    } catch (_) { /* jsdom 等环境下取不到就走 CSS 默认 */ }
    div.textContent = translation;

    // 父容器只接受特定子元素时（表格行、grid、flex），兄弟节点会被当成新的
    // 单元格/网格项，译文就飘到隔壁列去了（Rust blog 的文章列表就是 table）。
    // 这类容器改成插进原元素内部，译文才留在原格里紧跟原文。
    const parent = el.parentElement;
    let display = '';
    try { display = parent ? getComputedStyle(parent).display : ''; } catch (_) { /* jsdom 无布局 */ }
    if (/grid|flex|table/.test(display)) el.appendChild(div);
    else {
      // 父元素是 shadow host 时，没有同名 slot 的子节点不会被渲染
      if (el.slot) div.slot = el.slot;
      el.insertAdjacentElement('afterend', div);
    }
    track(div);
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
    session++;
    stopDomWatch();
    resetQueues();
    dropRequests();
    releaseIdle();
    document.querySelectorAll('[data-yll-inject]').forEach(el => el.remove());
    // 仅译文模式藏起来的原文：把子节点挪回原位再删掉包裹节点
    document.querySelectorAll('[data-yll-orig]').forEach(wrap => {
      const parent = wrap.parentNode;
      if (parent) {
        while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      }
      wrap.remove();
    });
    document.querySelectorAll('[data-yll-done]').forEach(el => { delete el.dataset.yllDone; doneText.delete(el); });
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
    syncBallMenu();
  }

  // ===== 进度条 =====

  let progressBar = null;
  let progressHideTimer = null;

  function showProgressBar() {
    clearTimeout(progressHideTimer);
    if (!progressBar) {
      progressBar = document.createElement('div');
      progressBar.id = 'yll-progress';
      progressBar.setAttribute('data-yll-ui', 'true');
      progressBar.innerHTML = '<div id="yll-progress-bar"></div>';
    }
    // 整块重绘 body 的 SPA 会把它摘掉，换页后要挂回去
    if (!progressBar.isConnected) document.body.appendChild(progressBar);
    progressBar.style.display = 'block';
    document.getElementById('yll-progress-bar').style.width = '0%';
  }

  // 进度条只跟可视区的块走：可视区翻完就收起，视口外的在后台安静补全
  function updateProgressBar() {
    if (!progressBar) return;
    const pct = fg && fg.total > 0
      ? Math.round(((fg.total - fg.pending.size) / fg.total) * 100)
      : 100;
    const bar = document.getElementById('yll-progress-bar');
    if (bar) bar.style.width = pct + '%';
  }

  function hideProgressBar() {
    if (progressBar) {
      clearTimeout(progressHideTimer);
      progressHideTimer = setTimeout(() => {
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
      setBlockTimeout: (ms) => { blockTimeoutMs = ms; },
      splitLong,
      looksLikeName,
      hasProse,
      rankOf,
      detectPageLang,
      sameText,
      isVisuallyHidden,
      looksLikeNameList,
      minTextLen,
      splitTweetParagraphs,
      setDisplayMode: (m) => { state.displayMode = m; },
      translateBlock,
      translatePage,
      translateCurrentSelection,
      clearMemo: () => memo.clear(),
      state
    };
  }

})();
