'use strict';

// Interface language follows the browser (chrome.i18n); a missing key falls
// back to the key name so nothing renders blank.
const T = (k, subs) => {
  try { return (typeof browser !== 'undefined' ? browser : chrome).i18n.getMessage(k, subs) || k; }
  catch { return k; }
};

// OpenImmersive Translator Background Script - 翻译引擎路由
// 所有API请求直接从浏览器发出，无中间服务器

const api = typeof browser !== 'undefined' ? browser : chrome;

// 敏感信息脱敏模块（可选功能，默认关闭）。Chrome MV3 service worker 用
// importScripts 加载；Firefox 事件页由 manifest background.scripts 先行加载
// （见 build-store.mjs）。加载失败只是功能不可用，不影响翻译。
if (typeof YLSensitive === 'undefined' && typeof importScripts === 'function') {
  try { importScripts('sensitive-mask.js'); } catch (e) { console.warn('sensitive-mask.js 加载失败', e); }
}

// 共享语言表（LLM 引擎 prompt 里要写目标语言全名）。同样是加载失败只降级不致命。
if (typeof YLLangs === 'undefined' && typeof importScripts === 'function') {
  try { importScripts('languages.js'); } catch (e) { console.warn('languages.js 加载失败', e); }
}

// Storage 兼容层（Firefox用Promise，Chrome用callback包装）
function storageGet(keys) {
  if (typeof browser !== 'undefined') return browser.storage.local.get(keys);
  return new Promise(r => chrome.storage.local.get(keys, r));
}

// 键盘快捷键 Alt+T -> 向当前标签页发消息
api.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-translation') {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      api.tabs.sendMessage(tab.id, { type: 'toggleTranslation' }).catch(() => {});
    }
  }
});

// 首次安装 → 打开新手引导页；安装/更新时建右键菜单
if (api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      api.tabs.create({ url: api.runtime.getURL('welcome.html') }).catch(() => {});
    }
    createContextMenus();
  });
}

// 右键菜单：翻译选中文字 / 翻译此页
function createContextMenus() {
  if (!api.contextMenus) return;
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: 'yll-translate-selection', title: T('ctxTranslateSelection'), contexts: ['selection'] });
    api.contextMenus.create({ id: 'yll-translate-page', title: T('ctxTranslatePage'), contexts: ['page'] });
  });
}

if (api.contextMenus) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || tab.id == null) return;
    if (info.menuItemId === 'yll-translate-selection') {
      api.tabs.sendMessage(tab.id, { type: 'translateSelection' }).catch(() => {});
    } else if (info.menuItemId === 'yll-translate-page') {
      api.tabs.sendMessage(tab.id, { type: 'toggleTranslation' }).catch(() => {});
    }
  });
}

// ===== 消息监听 =====

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'translate') {
    translate(message)
      .then(result => sendResponse({ success: true, translation: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 保持异步通道
  }

  if (message.type === 'detectLang') {
    detectLanguage(message.text)
      .then(lang => sendResponse({ success: true, lang }))
      .catch(() => sendResponse({ success: true, lang: 'unknown' }));
    return true;
  }

  // 悬浮球菜单的「设置」入口（content script 无法直接开 options 页）
  if (message.type === 'openOptions') {
    if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
    return false;
  }

  // 设置页的账号区：查询官网登录状态（cookie 随请求自动带上，插件不存凭据）
  if (message.type === 'oiAuthStatus') {
    oiAuthStatus()
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// 官网会员状态。404 = 新站尚未部署到该地址（AI 档即将上线的同一状态）。
async function oiAuthStatus() {
  const { oiSiteBase } = await storageGet(['oiSiteBase']);
  const site = oiSiteBase || OI_SITE;
  const resp = await fetch(`${site}/api/auth/me`, { credentials: 'include' });
  if (resp.status === 404) return { success: true, site, available: false, user: null };
  let data = {};
  try { data = await resp.json(); } catch (_) { /* 非 JSON 视作未登录 */ }
  return { success: true, site, available: true, user: (data && data.user) || null };
}

// ===== 翻译入口 =====

async function translate({ text, engine, targetLang, sourceLang = 'auto' }) {
  if (!text || !text.trim()) return '';

  const { apiKeys = {}, sensitiveMask = false } = await storageGet(['apiKeys', 'sensitiveMask']);

  // 脱敏：发送前在本地把敏感信息换成占位符，翻译返回后还原
  let masked = null;
  if (sensitiveMask && typeof YLSensitive !== 'undefined') {
    masked = YLSensitive.maskSensitive(text);
    text = masked.masked;
  }

  let result;
  switch (engine) {
    case 'oi-standard': result = await translateViaSite(text, targetLang, sourceLang, 'standard'); break;
    case 'oi-premium':  result = await translateViaSite(text, targetLang, sourceLang, 'premium'); break;
    case 'deepl':     result = await translateDeepL(text, targetLang, sourceLang, apiKeys.deepl); break;
    case 'openai':    result = await translateOpenAI(text, targetLang, sourceLang, apiKeys.openai); break;
    case 'deepseek':  result = await translateDeepSeek(text, targetLang, sourceLang, apiKeys.deepseek); break;
    case 'libretranslate': result = await translateLibre(text, targetLang, sourceLang, apiKeys.libretranslate_url); break;
    // 免费引擎（含未识别的引擎名）走互为备份的链条，见 translateFree。
    default:          result = await translateFree(engine, text, targetLang, sourceLang);
  }

  if (masked && masked.entities.length) {
    result = YLSensitive.restoreSensitive(result, masked.entities);
  }
  return result;
}

// ===== 官网 AI 档（Standard / Premium，走账号 credits）=====
// 不在插件里存 token：请求带 credentials:'include'，浏览器自动带上官网的
// httpOnly 会话 cookie。插件本身拿不到凭据，用户在官网登录/登出即时生效。
// 未登录 401、额度不足 402 —— 都翻成一句能引导用户去官网的错误。

const OI_SITE = 'https://openimmersive.ai';

// The site opens its sign-in / sign-up dialog on this query, so a hint can
// land the user in the form instead of on the home page.
function siteLoginUrl(site) {
  return `${site}/?login=1`;
}

async function translateViaSite(text, targetLang, sourceLang, tier) {
  // oiSiteBase：内部测试用的官网地址覆盖（正式发布不暴露 UI，storage 手工写入）
  const { oiSiteBase } = await storageGet(['oiSiteBase']);
  const site = oiSiteBase || OI_SITE;
  const resp = await fetch(`${site}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      text,
      target: siteLangName(targetLang),
      source: sourceLang === 'auto' ? 'auto' : siteLangName(sourceLang),
      mode: tier,
    }),
  });

  let data = {};
  try { data = await resp.json(); } catch (_) { /* 非 JSON 走下面的状态码分支 */ }

  if (resp.status === 401) {
    throw new Error(T('errLoginRequired', [siteLoginUrl(site)]));
  }
  if (resp.status === 402) {
    throw new Error(T('errOutOfCredits', [site]));
  }
  if (resp.status === 404) {
    // 官网新版（带账号/额度）尚未切到正式域名时，接口整个不存在
    throw new Error(T('errAiSoon'));
  }
  if (!resp.ok) {
    throw new Error((data.error && data.error.message) || T('errSiteStatus', [String(resp.status)]));
  }
  return data.translatedText || '';
}

// 官网 API 收的是语言全名（"Simplified Chinese"），插件内部用的是语言码。
function siteLangName(code) {
  const map = {
    'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
    en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German',
    es: 'Spanish', ru: 'Russian', ar: 'Standard Arabic', pt: 'Portuguese',
    it: 'Italian', nl: 'Dutch', pl: 'Polish',
  };
  return map[code] || code;
}

// ===== 免费引擎链（互为备份）=====
// 单个免费端点随时会限流：gtx 一整页几十次请求就可能开始回 429，Bing 的
// token 也会过期。此前任一次失败都会让那一段无声地留在原文，整页看起来就是
// 「点了没反应」。所以免费引擎按链条依次试，只有全部失败才把错误抛给上层。
// 自带 Key 的引擎和官网 AI 档不参与——它们的失败是配置或额度问题，
// 静默换引擎只会掩盖真正的原因。

const FREE_CHAIN = ['google', 'microsoft', 'mymemory'];
const FREE_IMPL = {
  google:    (text, tl, sl) => translateGoogle(text, tl, sl),
  microsoft: (text, tl, sl) => translateMicrosoft(text, tl, sl),
  mymemory:  (text, tl, sl) => translateMyMemory(text, tl, sl),
};

// 刚失败过的引擎降到顺位末尾：一整页几十个块各自先撞一次同一面墙，
// 等于把翻译时间翻倍。冷却期过了自然回到原顺位。
const FREE_COOLDOWN_MS = 60000;
const freeCooldown = new Map();

function freeOrder(startEngine) {
  const order = FREE_CHAIN.includes(startEngine)
    ? [startEngine, ...FREE_CHAIN.filter(e => e !== startEngine)]
    : [...FREE_CHAIN];
  const now = Date.now();
  const cooling = e => freeCooldown.get(e) > now;
  // 全都在冷却期时仍然要一个个试，只是保持原顺序。
  return [...order.filter(e => !cooling(e)), ...order.filter(cooling)];
}

async function translateFree(startEngine, text, targetLang, sourceLang) {
  const errors = [];
  for (const name of freeOrder(startEngine)) {
    try {
      const out = await FREE_IMPL[name](text, targetLang, sourceLang);
      freeCooldown.delete(name);
      return out;
    } catch (err) {
      freeCooldown.set(name, Date.now() + FREE_COOLDOWN_MS);
      errors.push(err.message);
    }
  }
  throw new Error(errors.join(' / '));
}

// ===== Google Translate（非官方免费接口，无需Key）=====

async function translateGoogle(text, targetLang, sourceLang = 'auto') {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', sourceLang);
  url.searchParams.set('tl', targetLang);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Google: HTTP ${resp.status}`);

  const data = await resp.json();
  // data[0] = [[translated, original], ...]
  return data[0]
    .filter(item => item && item[0])
    .map(item => item[0])
    .join('');
}

// ===== Microsoft / Bing（非官方免费接口，无需Key）=====
// bing.com/translator 的页面里带着一对一次性的 key/token（服务端给的有效期
// 写在同一处）和一个 IG 请求标识，抓出来缓存复用即可。实测这个端点只认浏览器
// User-Agent —— 插件里的 fetch 用的就是浏览器自己的 UA，所以不需要伪造任何
// 请求头；也不需要 cookie，因此显式 credentials:'omit'，不把用户已有的 Bing
// 会话带出去。

const MS_PAGE = 'https://www.bing.com/translator';
const MS_API = 'https://www.bing.com/ttranslatev3';
let msAuth = null; // { ig, key, token, expiresAt }

async function msGetAuth() {
  if (msAuth && msAuth.expiresAt > Date.now()) return msAuth;

  const resp = await fetch(MS_PAGE, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`Microsoft: HTTP ${resp.status}`);
  const html = await resp.text();

  const ig = (html.match(/IG:"([A-Fa-f0-9]+)"/) || [])[1];
  const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/);
  if (!ig || !abuse) throw new Error('Microsoft: auth token not found');

  // 第三个数是有效期毫秒。提前 5 分钟作废，别让整页翻译卡在过期边界上。
  const ttl = Math.max(Number(abuse[3]) - 300000, 60000);
  msAuth = { ig, key: abuse[1], token: abuse[2], expiresAt: Date.now() + ttl };
  return msAuth;
}

// 这个端点单次只吃 1000 字符，超了不是报错而是回 HTTP 200 + {"statusCode":400}
// ——只断言状态码是发现不了的（实测 4000 字符照样 200）。所以长段落先按句子
// 边界切块再依次送，Google 那边不需要这一步，别把限制搬到共用代码里。
const MS_MAX_CHARS = 1000;

function msChunk(text, limit = MS_MAX_CHARS) {
  if (text.length <= limit) return [text];
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
  const parts = [];
  let buf = '';
  for (const s of sentences) {
    // 单句本身就超长时硬切：切得不好看也比整段丢掉好
    for (let rest = s; rest.length; rest = rest.slice(limit)) {
      const seg = rest.slice(0, limit);
      if (buf && buf.length + seg.length > limit) { parts.push(buf); buf = seg; }
      else buf += seg;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

async function translateMicrosoft(text, targetLang, sourceLang = 'auto') {
  const chunks = msChunk(text);
  if (chunks.length === 1) return msTranslateOne(text, targetLang, sourceLang);

  // 顺序发而不是并发：同一段落的几块共用一个 token，也不想为一段正文
  // 把请求量翻几倍。
  const out = [];
  for (const chunk of chunks) out.push(await msTranslateOne(chunk, targetLang, sourceLang));
  return out.join('');
}

async function msTranslateOne(text, targetLang, sourceLang = 'auto', retried = false) {
  const auth = await msGetAuth();
  const form = [
    ['fromLang', sourceLang === 'auto' ? 'auto-detect' : toMsLang(sourceLang)],
    ['to', toMsLang(targetLang)],
    ['text', text],
    ['token', auth.token],
    ['key', auth.key],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  const resp = await fetch(`${MS_API}?isVertical=1&IG=${auth.ig}&IID=translator.5023`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  // token 作废时回 401 + {"ShowCaptcha":false}。重取一次 token 再试；还不行就
  // 抛出去让 translateFree 换引擎，不在这里反复重试。
  if (resp.status === 401 && !retried) {
    msAuth = null;
    return msTranslateOne(text, targetLang, sourceLang, true);
  }
  if (!resp.ok) throw new Error(`Microsoft: HTTP ${resp.status}`);

  const data = await resp.json();
  // 业务错误藏在 200 里：{"statusCode":400} 而不是数组。当成失败抛出去，
  // 让 translateFree 换引擎，别把它误当成「翻译结果为空」。
  if (!Array.isArray(data)) {
    throw new Error(`Microsoft: statusCode ${(data && data.statusCode) || 'unknown'}`);
  }
  const hit = data[0] && data[0].translations && data[0].translations[0];
  if (!hit || typeof hit.text !== 'string') throw new Error('Microsoft: empty translation');
  return hit.text;
}

// 微软用 zh-Hans / zh-Hant 这套写法，其余语言码直接透传。
function toMsLang(code) {
  const map = { 'zh-CN': 'zh-Hans', 'zh': 'zh-Hans', 'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant' };
  return map[code] || code;
}

// ===== MyMemory（免费，500词/次，无需Key）=====

async function translateMyMemory(text, targetLang, sourceLang = 'auto') {
  const sl = sourceLang === 'auto' ? 'en' : sourceLang;
  const chunk = text.substring(0, 500);

  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', chunk);
  url.searchParams.set('langpair', `${sl}|${targetLang}`);

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`MyMemory: HTTP ${resp.status}`);

  const data = await resp.json();
  if (data.responseStatus !== 200) {
    throw new Error(data.responseMessage || 'MyMemory error');
  }
  return data.responseData.translatedText;
}

// ===== DeepL（免费API Key，deepl.com注册即得500K字/月）=====

async function translateDeepL(text, targetLang, sourceLang, apiKey) {
  if (!apiKey) throw new Error(T('errNeedDeepLKey'));

  const body = {
    text: [text],
    target_lang: toDeepLLang(targetLang)
  };
  if (sourceLang && sourceLang !== 'auto') {
    body.source_lang = toDeepLLang(sourceLang).split('-')[0];
  }

  const resp = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`DeepL: HTTP ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return data.translations[0].text;
}

function toDeepLLang(lang) {
  const map = {
    'zh-CN': 'ZH', 'zh-TW': 'ZH',
    'en': 'EN-US', 'en-US': 'EN-US', 'en-GB': 'EN-GB',
    'ja': 'JA', 'ko': 'KO', 'fr': 'FR', 'de': 'DE',
    'es': 'ES', 'ru': 'RU', 'pt': 'PT-PT', 'it': 'IT',
    'nl': 'NL', 'pl': 'PL', 'ar': 'AR'
  };
  return map[lang] || lang.toUpperCase().split('-')[0];
}

// ===== OpenAI（BYOK，gpt-4o-mini成本极低）=====

async function translateOpenAI(text, targetLang, sourceLang, apiKey) {
  if (!apiKey) throw new Error(T('errNeedOpenAIKey'));
  return callOpenAICompat(
    'https://api.openai.com/v1/chat/completions',
    'gpt-4o-mini',
    apiKey,
    text,
    targetLang
  );
}

// ===== DeepSeek（BYOK，比OpenAI便宜90%）=====

async function translateDeepSeek(text, targetLang, sourceLang, apiKey) {
  if (!apiKey) throw new Error(T('errNeedDeepSeekKey'));
  return callOpenAICompat(
    'https://api.deepseek.com/v1/chat/completions',
    'deepseek-chat',
    apiKey,
    text,
    targetLang
  );
}

// OpenAI兼容接口通用实现
async function callOpenAICompat(endpoint, model, apiKey, text, targetLang) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  // 脱敏占位符必须原样穿过 LLM，否则无法还原
  const piiNote = text.includes('__PII_')
    ? ' The text contains placeholders like __PII_EMAIL_1__; keep them EXACTLY unchanged in the output.'
    : '';

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate the following text to ${langName}. Output only the translation, no explanations, no quotes.${piiNote}`
        },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      max_tokens: 2048
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`API error ${resp.status}: ${errText.substring(0, 100)}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// ===== LibreTranslate（可自托管，隐私最优）=====

async function translateLibre(text, targetLang, sourceLang, instanceUrl) {
  const base = instanceUrl || 'https://libretranslate.com';
  const sl = sourceLang === 'auto' ? 'auto' : sourceLang.split('-')[0];
  const tl = targetLang.split('-')[0];

  const resp = await fetch(`${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: sl, target: tl, format: 'text' })
  });

  if (!resp.ok) throw new Error(`LibreTranslate: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.translatedText;
}

// ===== 语言检测（用Google的auto检测结果）=====

async function detectLanguage(text) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', 'en');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text.substring(0, 50));

  const resp = await fetch(url.toString());
  const data = await resp.json();
  return data[2] || 'unknown';
}

// ===== 常量 =====

// 语言名给 LLM 引擎的 prompt 用。以共享语言表为准（199 种），
// 表里没有的码直接透传，避免新增语言时这里成为静默的瓶颈。
const LANG_NAMES = (typeof YLLangs !== 'undefined' && YLLangs.NAME) ? YLLangs.NAME : {};
