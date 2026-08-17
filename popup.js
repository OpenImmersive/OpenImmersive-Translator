'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const t = (k, ...subs) => YLI18n.t(k, subs.length ? subs.map(String) : undefined);

const btnTranslate = document.getElementById('btnTranslate');
const selLang = document.getElementById('selLang');
const swHover = document.getElementById('swHover');
const swAutoSite = document.getElementById('swAutoSite');
const swFloatBall = document.getElementById('swFloatBall');
const swAutoLang = document.getElementById('swAutoLang');
const autoLangName = document.getElementById('autoLangName');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

let currentTab = null;
let currentHost = '';
let currentPageLang = '';
// popup 只列常用语言；用户在设置页选了冷门语言时把它插进来，否则下拉里看不到自己的选择。
function fillPopupLanguages(current) {
  const seen = new Set();
  const add = (code) => {
    const row = YLLangs.ALL.find(r => r[0] === code);
    if (!row || seen.has(code)) return;
    seen.add(code);
    const o = document.createElement('option');
    o.value = code;
    o.textContent = YLI18n.langLabel(row);
    selLang.appendChild(o);
  };
  YLLangs.COMMON.forEach(add);
  if (current) add(current);
}

// 「总是翻译该语言」里那个语种名：查语言表拿当前界面语言下的写法。
function langName(code) {
  const row = YLLangs.ALL.find(r => r[0] === code || r[0].split('-')[0] === code);
  return row ? (YLI18n.isZh() ? row[2] : row[1]) : code;
}
let engine = 'google'; // 引擎收进「更多设置」，popup 只读取、不展示

// ===== 初始化 =====

async function init() {
  const data = await getStorage(['targetLang', 'engine', 'hoverTranslate', 'autoTranslateSites', 'floatBall', 'autoTranslateLangs']);
  fillPopupLanguages(data.targetLang);
  selLang.value = data.targetLang || 'zh-CN';
  engine = data.engine || 'google';
  swHover.checked = data.hoverTranslate !== false; // 默认开
  swFloatBall.checked = data.floatBall !== false; // 默认开

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  try { currentHost = tab && tab.url ? new URL(tab.url).hostname : ''; } catch { currentHost = ''; }
  const sites = Array.isArray(data.autoTranslateSites) ? data.autoTranslateSites : [];
  swAutoSite.checked = !!currentHost && sites.includes(currentHost);
  swAutoSite.disabled = !currentHost;

  // 「总是翻译该语言」认的是当前页的语种，先问 content script 拿判定结果
  const langs = Array.isArray(data.autoTranslateLangs) ? data.autoTranslateLangs : [];
  try {
    const r = await api.tabs.sendMessage(tab.id, { type: 'getPageLang' });
    currentPageLang = (r && r.lang) || '';
  } catch { currentPageLang = ''; }
  autoLangName.textContent = currentPageLang ? langName(currentPageLang) : t('popupThisLanguage');
  swAutoLang.checked = !!currentPageLang && langs.includes(currentPageLang);
  swAutoLang.disabled = !currentPageLang;

  try {
    const resp = await api.tabs.sendMessage(tab.id, { type: 'getStatus' });
    updateUI(resp);
  } catch {
    setStatus('dot-off', t('popupUnsupportedPage'));
    btnTranslate.disabled = true;
  }
}

// ===== 翻译按钮 =====

btnTranslate.addEventListener('click', async () => {
  if (!currentTab) return;
  const targetLang = selLang.value;
  await setStorage({ targetLang });

  btnTranslate.disabled = true;
  setStatus('dot-loading', t('popupTranslating'));
  try {
    const resp = await api.tabs.sendMessage(currentTab.id, { type: 'translatePage', targetLang, engine });
    updateUI(resp);
  } catch (err) {
    setStatus('dot-off', t('popupTranslateFailed') + err.message);
  } finally {
    btnTranslate.disabled = false;
  }
});

// ===== 设置变更自动保存 =====

selLang.addEventListener('change', () => setStorage({ targetLang: selLang.value }));
swHover.addEventListener('change', () => setStorage({ hoverTranslate: swHover.checked }));
swFloatBall.addEventListener('change', () => setStorage({ floatBall: swFloatBall.checked }));

// 总是翻译此网站：增删当前 host；勾选后立即翻译当前页
swAutoSite.addEventListener('change', async () => {
  if (!currentHost) return;
  const { autoTranslateSites } = await getStorage(['autoTranslateSites']);
  const sites = new Set(Array.isArray(autoTranslateSites) ? autoTranslateSites : []);
  if (swAutoSite.checked) {
    sites.add(currentHost);
    if (currentTab) api.tabs.sendMessage(currentTab.id, { type: 'translatePage', targetLang: selLang.value, engine }).catch(() => {});
  } else {
    sites.delete(currentHost);
  }
  await setStorage({ autoTranslateSites: [...sites] });
});

// 总是翻译该语言：按当前页语种增删名单；勾选后立即翻译当前页
swAutoLang.addEventListener('change', async () => {
  if (!currentPageLang) return;
  const { autoTranslateLangs } = await getStorage(['autoTranslateLangs']);
  const langs = new Set(Array.isArray(autoTranslateLangs) ? autoTranslateLangs : []);
  if (swAutoLang.checked) {
    langs.add(currentPageLang);
    if (currentTab) api.tabs.sendMessage(currentTab.id, { type: 'translatePage', targetLang: selLang.value, engine }).catch(() => {});
  } else {
    langs.delete(currentPageLang);
  }
  await setStorage({ autoTranslateLangs: [...langs] });
});

// ===== 更多设置 =====

document.getElementById('btnOptions').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
  window.close();
});

// ===== PDF 翻译：跳网站（保留排版 / 学术论文模式）=====

document.getElementById('btnPdf').addEventListener('click', (e) => {
  e.preventDefault();
  api.tabs.create({ url: 'https://pdf.openimmersive.ai/' });
  window.close();
});

// ===== UI 更新 =====

function updateUI(resp) {
  if (!resp) { setStatus('dot-off', t('popupNoConnection')); return; }

  if (resp.isTranslating) {
    setStatus('dot-loading', t('popupProgress', resp.translatedCount || 0, resp.totalCount || 0));
    btnTranslate.disabled = true;
    return;
  }
  if (resp.isTranslated || resp.status === 'done') {
    const count = resp.count || resp.translatedCount || 0;
    setStatus('dot-on', t('popupDoneCount', count));
    btnTranslate.textContent = t('popupRestore');
    btnTranslate.classList.add('active');
    return;
  }
  if (resp.status === 'removed') {
    setStatus('dot-off', t('popupRestored'));
    btnTranslate.textContent = t('popupTranslatePage');
    btnTranslate.classList.remove('active');
    return;
  }
  setStatus('dot-off', t('popupReady'));
  btnTranslate.textContent = t('popupTranslatePage');
  btnTranslate.classList.remove('active');
}

function setStatus(dotClass, text) {
  statusDot.className = 'status-dot';
  if (dotClass === 'dot-on') statusDot.classList.add('on');
  if (dotClass === 'dot-loading') statusDot.classList.add('loading');
  statusText.textContent = text;
}

// ===== Storage 工具 =====

function getStorage(keys) {
  if (typeof browser !== 'undefined') return browser.storage.local.get(keys);
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function setStorage(items) {
  if (typeof browser !== 'undefined') return browser.storage.local.set(items);
  return new Promise(resolve => chrome.storage.local.set(items, resolve));
}

// ===== 启动 =====
init().catch(console.error);
