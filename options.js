'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const t = (k, ...subs) => YLI18n.t(k, subs.length ? subs.map(String) : undefined);

// ===== 加载设置 =====

// 语言下拉全部从共享表生成：设置页给全量 199 种，输入框翻译同样全量
// （写外语的场景没理由比读外语少选项）。
function fillLanguageSelects() {
  for (const sel of [document.getElementById('defLang'), document.getElementById('selInputLang')]) {
    if (!sel || sel.options.length) continue;
    const toInput = sel.id === 'selInputLang';
    for (const [code, en, zh] of YLLangs.ALL) {
      const o = document.createElement('option');
      o.value = code;
      const label = YLI18n.langLabel([code, en, zh]);
      o.textContent = toInput ? t('optInputLangLabel', YLI18n.isZh() ? zh : en) : label;
      sel.appendChild(o);
    }
  }
}

async function loadSettings() {
  fillLanguageSelects();
  const data = await getStorage([
    'targetLang', 'engine', 'displayMode', 'apiKeys', 'sensitiveMask',
    'hoverTranslate', 'hoverKey', 'selectionTranslate',
    'inputTranslate', 'inputTargetLang'
  ]);

  // 常用
  document.getElementById('defLang').value = data.targetLang || 'zh-CN';
  document.getElementById('selDisplayMode').value = data.displayMode || 'bilingual';
  document.getElementById('swHover').checked = data.hoverTranslate !== false;      // 默认开
  document.getElementById('selHoverKey').value = data.hoverKey || 'Alt';
  document.getElementById('swSelection').checked = data.selectionTranslate !== false; // 默认开
  document.getElementById('swInput').checked = data.inputTranslate !== false;      // 默认开
  document.getElementById('selInputLang').value = data.inputTargetLang || 'en';

  // 高级
  document.getElementById('defEngine').value = data.engine || 'google';
  document.getElementById('maskSensitive').checked = !!data.sensitiveMask;
  const keys = data.apiKeys || {};
  document.getElementById('keyDeepL').value = keys.deepl || '';
  document.getElementById('keyDeepSeek').value = keys.deepseek || '';
  document.getElementById('keyOpenAI').value = keys.openai || '';
  document.getElementById('libreUrl').value = keys.libretranslate_url || '';
}

// ===== 保存设置 =====

document.getElementById('btnSave').addEventListener('click', async () => {
  const settings = {
    targetLang: document.getElementById('defLang').value,
    displayMode: document.getElementById('selDisplayMode').value,
    hoverTranslate: document.getElementById('swHover').checked,
    hoverKey: document.getElementById('selHoverKey').value,
    selectionTranslate: document.getElementById('swSelection').checked,
    inputTranslate: document.getElementById('swInput').checked,
    inputTargetLang: document.getElementById('selInputLang').value,
    engine: document.getElementById('defEngine').value,
    sensitiveMask: document.getElementById('maskSensitive').checked,
    apiKeys: {
      deepl: document.getElementById('keyDeepL').value.trim(),
      deepseek: document.getElementById('keyDeepSeek').value.trim(),
      openai: document.getElementById('keyOpenAI').value.trim(),
      libretranslate_url: document.getElementById('libreUrl').value.trim()
    }
  };

  await setStorage(settings);

  const msg = document.getElementById('saveMsg');
  msg.style.display = 'inline';
  setTimeout(() => { msg.style.display = 'none'; }, 2500);
});

// ===== 显示/隐藏 API Key =====

document.querySelectorAll('.btn-show[data-target]').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = t('optHide');
    } else {
      input.type = 'password';
      btn.textContent = t('optShow');
    }
  });
});

// ===== Storage 工具 =====

function getStorage(keys) {
  if (typeof browser !== 'undefined') return browser.storage.local.get(keys);
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function setStorage(items) {
  if (typeof browser !== 'undefined') return browser.storage.local.set(items);
  return new Promise(resolve => chrome.storage.local.set(items, resolve));
}

// ===== OpenImmersive 账号区 =====

let oiSiteUrl = 'https://openimmersive.ai';

const AI_ENGINES = ['oi-standard', 'oi-premium'];

async function refreshOiAccount() {
  const el = document.getElementById('oiAcctStatus');
  const next = document.getElementById('oiAcctNext');
  el.textContent = t('optChecking');
  next.style.display = 'none';
  try {
    const resp = await api.runtime.sendMessage({ type: 'oiAuthStatus' });
    if (!resp || !resp.success) throw new Error(resp ? resp.error : t('commError'));
    if (resp.site) oiSiteUrl = resp.site;
    if (!resp.available) {
      el.textContent = t('optAcctSoon');
      return;
    }
    if (!resp.user) {
      el.textContent = t('optAcctSignedOut');
      return;
    }
    const u = resp.user;
    el.textContent = t('optAcctSignedIn', u.email, u.plan || 'free', u.credits ?? 0);
    // The AI tiers sit folded under Advanced, so a balance shown here is a
    // dead end unless the switch to spending it is offered beside it.
    const { engine } = await getStorage(['engine']);
    if ((u.credits ?? 0) > 0 && !AI_ENGINES.includes(engine)) next.style.display = '';
  } catch (err) {
    el.textContent = t('optAcctFailed', err.message);
  }
}

// The site opens its sign-in / sign-up dialog on ?login=1.
document.getElementById('btnOiLogin').addEventListener('click', () => {
  window.open(`${oiSiteUrl}/?login=1`, '_blank');
});
document.getElementById('btnOiRefresh').addEventListener('click', refreshOiAccount);
document.getElementById('btnOiUseStandard').addEventListener('click', async () => {
  const btn = document.getElementById('btnOiUseStandard');
  document.getElementById('defEngine').value = 'oi-standard';
  await setStorage({ engine: 'oi-standard' });
  // Saved on the spot: the page's Save button is a screen away, and the
  // confirmation has to sit where the click was.
  btn.previousElementSibling.textContent = t('optUseStandardDone');
  btn.style.display = 'none';
});

// ===== 启动 =====
loadSettings().catch(console.error);
refreshOiAccount().catch(() => {});

// ===== 文件翻译：本地解析简单文本格式，逐段送翻译，原格式下载 =====
// 文件内容不上传到任何我们的服务器——只有拆出来的文字片段走用户选定的引擎，
// 和网页翻译同一条链路。

const fileInput = document.getElementById('fileInput');
const fileStatus = document.getElementById('fileStatus');
const fileDownload = document.getElementById('fileDownload');

if (fileInput) {
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    const format = YLFile.extOf(file.name);
    if (!YLFile.FORMATS.includes(format)) {
      fileStatus.textContent = t('fileUnsupported', `.${format}`, YLFile.FORMATS.join(' / '));
      return;
    }

    const { targetLang = 'zh-CN', engine = 'google' } = await getStorage(['targetLang', 'engine']);
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const text = await file.text();

    fileStatus.textContent = t('fileTranslating');
    fileDownload.style.display = 'none';

    const result = await YLFile.translateFile({
      format,
      text,
      onProgress: (done, total) => { fileStatus.textContent = t('fileProgress', done, total); },
      translateFn: async (segment) => {
        const resp = await api.runtime.sendMessage({
          type: 'translate', text: segment, engine, targetLang, sourceLang: 'auto',
        });
        if (!resp || !resp.success) throw new Error(resp ? resp.error : t('commError'));
        return resp.translation;
      },
    });

    // 一段都没译成 = 引擎那条链路整个是坏的（没配 Key、AI 档没登录、接口 404）。
    // 这时给下载只会让用户拿到一份和原文一样的文件还以为翻过了，所以直接报错，
    // 并把引擎的原话带出来——那句话通常就写着该去做什么。
    if (result.total > 0 && result.translated === 0) {
      fileStatus.textContent = t('fileFailed', result.firstError || t('fileNoTranslation'));
      fileInput.value = '';
      return;
    }

    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const base = file.name.replace(/\.[^.]+$/, '');
    fileDownload.href = URL.createObjectURL(blob);
    fileDownload.download = `${base}.${targetLang}.${format}`;
    fileDownload.textContent = t('fileDownload', fileDownload.download);
    fileDownload.style.display = 'inline-block';
    fileStatus.textContent = result.failed > 0
      ? t('filePartial', result.failed, result.total, result.firstError || t('fileEmptyResult'))
      : t('fileDone');
    fileInput.value = '';
  });
}
