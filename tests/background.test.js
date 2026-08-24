'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const LANGS_SRC = fs.readFileSync(path.join(__dirname, '..', 'languages.js'), 'utf8');

/**
 * Load background.js into an isolated vm context with a mocked browser API.
 * Returns the context object – module-level functions are accessible as ctx.fnName.
 */
function loadBg({ fetchImpl, storageData = {} } = {}) {
  const listeners = { message: null, command: null };

  const ctx = vm.createContext({
    browser: {
      storage: {
        local: {
          get(keys) {
            const ks = typeof keys === 'string'
              ? [keys]
              : Array.isArray(keys) ? keys : Object.keys(keys);
            const result = {};
            ks.forEach(k => { if (k in storageData) result[k] = storageData[k]; });
            return Promise.resolve(result);
          }
        }
      },
      runtime: { onMessage: { addListener: fn => { listeners.message = fn; } } },
      tabs: {
        query: () => Promise.resolve([{ id: 1 }]),
        sendMessage: () => Promise.resolve()
      },
      commands: { onCommand: { addListener: fn => { listeners.command = fn; } } },
      i18n: require('./i18n-mock')
    },
    fetch: fetchImpl ?? (() => Promise.reject(new Error('fetch not configured'))),
    URL: global.URL,
    Promise: global.Promise,
    console: global.console,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout
  });

  // Production loads the shared language table into the background context
  // (importScripts on Chrome, background.scripts on Firefox) — mirror that here
  // so prompts see real language names instead of bare codes.
  vm.runInContext(LANGS_SRC, ctx);
  vm.runInContext(SRC, ctx);
  ctx.__listeners = listeners;
  return ctx;
}

/** Helper: mock fetch that resolves OK with given JSON body */
function ok(json) {
  return () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve('')
  });
}

/** Helper: mock fetch that resolves with an HTTP error status */
function fail(status) {
  return () => Promise.resolve({
    ok: false,
    status,
    json: () => Promise.reject(new Error('no json')),
    text: () => Promise.resolve(`server error ${status}`)
  });
}

// ─── toDeepLLang ────────────────────────────────────────────────────────────

describe('toDeepLLang', () => {
  const ctx = loadBg();

  test.each([
    ['zh-CN', 'ZH'],
    ['zh-TW', 'ZH'],
    ['en',    'EN-US'],
    ['en-US', 'EN-US'],
    ['en-GB', 'EN-GB'],
    ['ja',    'JA'],
    ['ko',    'KO'],
    ['fr',    'FR'],
    ['de',    'DE'],
    ['es',    'ES'],
    ['ru',    'RU'],
    ['pt',    'PT-PT'],
    ['it',    'IT'],
    ['nl',    'NL'],
    ['pl',    'PL'],
    ['ar',    'AR']
  ])('%s → %s', (input, expected) => {
    expect(ctx.toDeepLLang(input)).toBe(expected);
  });

  test('unknown code uppercases first segment', () => {
    expect(ctx.toDeepLLang('vi')).toBe('VI');
  });

  test('unknown hyphenated code takes first segment only', () => {
    expect(ctx.toDeepLLang('pt-BR')).toBe('PT'); // not in map, fallback
  });
});

// LANG_NAMES is a const in background.js and not directly reachable on the vm
// context object — it is tested indirectly through callOpenAICompat below.

// ─── translate router ────────────────────────────────────────────────────────

describe('translate (router)', () => {
  test('returns empty string for empty text', async () => {
    const ctx = loadBg();
    expect(await ctx.translate({ text: '', engine: 'google', targetLang: 'zh-CN' })).toBe('');
  });

  test('returns empty string for whitespace-only text', async () => {
    const ctx = loadBg();
    expect(await ctx.translate({ text: '   ', engine: 'google', targetLang: 'zh-CN' })).toBe('');
  });

  test('routes unknown engine to google', async () => {
    let calledUrl = '';
    const fetch = (url) => {
      calledUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve([[['ok', 'test']]]) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translate({ text: 'Hello', engine: 'nonexistent', targetLang: 'zh-CN' });
    expect(calledUrl).toContain('translate.googleapis.com');
  });

  test('routes mymemory engine to mymemory', async () => {
    let calledUrl = '';
    const fetch = (url) => {
      calledUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ responseStatus: 200, responseData: { translatedText: 'ok' } }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translate({ text: 'Hello', engine: 'mymemory', targetLang: 'zh-CN' });
    expect(calledUrl).toContain('mymemory.translated.net');
  });

  test('reads apiKeys from storage for deepl engine', async () => {
    const ctx = loadBg({
      fetchImpl: ok({ translations: [{ text: 'Hola' }] }),
      storageData: { apiKeys: { deepl: 'test-deepl-key' } }
    });
    const result = await ctx.translate({ text: 'Hello', engine: 'deepl', targetLang: 'es' });
    expect(result).toBe('Hola');
  });
});

// ─── translateGoogle ─────────────────────────────────────────────────────────

describe('translateGoogle', () => {
  test('returns joined translation segments', async () => {
    const response = [[['你好', 'Hello', null], ['世界', 'World']]];
    const ctx = loadBg({ fetchImpl: ok(response) });
    expect(await ctx.translateGoogle('Hello World', 'zh-CN', 'en')).toBe('你好世界');
  });

  test('uses sl=auto when sourceLang is auto', async () => {
    let capturedUrl = '';
    const fetch = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve([[['ok', 'test']]]) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateGoogle('test', 'zh-CN', 'auto');
    expect(capturedUrl).toContain('sl=auto');
  });

  test('uses provided sourceLang in URL', async () => {
    let capturedUrl = '';
    const fetch = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve([[['ok', 'test']]]) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateGoogle('test', 'zh-CN', 'en');
    expect(capturedUrl).toContain('sl=en');
    expect(capturedUrl).toContain('tl=zh-CN');
  });

  test('throws on HTTP error', async () => {
    const ctx = loadBg({ fetchImpl: fail(429) });
    await expect(ctx.translateGoogle('test', 'zh-CN')).rejects.toThrow('Google: HTTP 429');
  });

  test('filters out null segments', async () => {
    const response = [[[null, 'x'], ['你好', 'Hello']]];
    const ctx = loadBg({ fetchImpl: ok(response) });
    expect(await ctx.translateGoogle('Hello', 'zh-CN')).toBe('你好');
  });
});

// ─── translateMyMemory ───────────────────────────────────────────────────────

describe('translateMyMemory', () => {
  test('returns translatedText on success', async () => {
    const ctx = loadBg({ fetchImpl: ok({ responseStatus: 200, responseData: { translatedText: '你好' } }) });
    expect(await ctx.translateMyMemory('Hello', 'zh-CN', 'en')).toBe('你好');
  });

  test('throws on non-200 responseStatus', async () => {
    const ctx = loadBg({ fetchImpl: ok({ responseStatus: 403, responseMessage: 'INVALID LANGUAGE PAIR' }) });
    await expect(ctx.translateMyMemory('test', 'zh-CN')).rejects.toThrow('INVALID LANGUAGE PAIR');
  });

  test('throws when responseMessage is absent', async () => {
    const ctx = loadBg({ fetchImpl: ok({ responseStatus: 500, responseMessage: null }) });
    await expect(ctx.translateMyMemory('test', 'zh-CN')).rejects.toThrow('MyMemory error');
  });

  test('throws on HTTP error', async () => {
    const ctx = loadBg({ fetchImpl: fail(503) });
    await expect(ctx.translateMyMemory('test', 'zh-CN')).rejects.toThrow('MyMemory: HTTP 503');
  });

  test('truncates text to 500 characters', async () => {
    let capturedUrl = '';
    const longText = 'x'.repeat(800);
    const fetch = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ responseStatus: 200, responseData: { translatedText: 'ok' } }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateMyMemory(longText, 'zh-CN', 'en');
    const qParam = new URL(capturedUrl).searchParams.get('q');
    expect(qParam.length).toBe(500);
  });

  test('falls back sourceLang=auto to "en"', async () => {
    let capturedUrl = '';
    const fetch = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ responseStatus: 200, responseData: { translatedText: 'ok' } }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateMyMemory('hello', 'zh-CN', 'auto');
    expect(new URL(capturedUrl).searchParams.get('langpair')).toBe('en|zh-CN');
  });
});

// ─── translateDeepL ──────────────────────────────────────────────────────────

describe('translateDeepL', () => {
  test('throws if apiKey is empty string', async () => {
    const ctx = loadBg();
    await expect(ctx.translateDeepL('test', 'zh-CN', 'en', '')).rejects.toThrow('DeepL API Key');
  });

  test('throws if apiKey is undefined', async () => {
    const ctx = loadBg();
    await expect(ctx.translateDeepL('test', 'zh-CN', 'en', undefined)).rejects.toThrow('DeepL API Key');
  });

  test('returns translated text on success', async () => {
    const ctx = loadBg({ fetchImpl: ok({ translations: [{ text: 'Hallo' }] }) });
    expect(await ctx.translateDeepL('Hello', 'de', 'en', 'my-key')).toBe('Hallo');
  });

  test('throws on HTTP 403', async () => {
    const ctx = loadBg({ fetchImpl: fail(403) });
    await expect(ctx.translateDeepL('test', 'zh-CN', 'en', 'bad-key')).rejects.toThrow('DeepL: HTTP 403');
  });

  test('omits source_lang when sourceLang is auto', async () => {
    let capturedBody;
    const fetch = (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ translations: [{ text: 'ok' }] }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateDeepL('Hello', 'zh-CN', 'auto', 'key');
    expect(capturedBody.source_lang).toBeUndefined();
  });

  test('sends Authorization header with key', async () => {
    let capturedHeaders;
    const fetch = (_url, opts) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ translations: [{ text: 'ok' }] }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateDeepL('Hello', 'zh-CN', 'en', 'secret-key');
    expect(capturedHeaders['Authorization']).toBe('DeepL-Auth-Key secret-key');
  });
});

// ─── translateOpenAI ─────────────────────────────────────────────────────────

describe('translateOpenAI', () => {
  test('throws if no API key', async () => {
    const ctx = loadBg();
    await expect(ctx.translateOpenAI('test', 'zh-CN', 'en', '')).rejects.toThrow('OpenAI API Key');
  });

  test('sends request to openai.com endpoint', async () => {
    let calledUrl = '';
    const fetch = (url, _opts) => {
      calledUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '你好' } }] }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateOpenAI('Hello', 'zh-CN', 'en', 'key');
    expect(calledUrl).toContain('openai.com');
  });
});

// ─── translateDeepSeek ───────────────────────────────────────────────────────

describe('translateDeepSeek', () => {
  test('throws if no API key', async () => {
    const ctx = loadBg();
    await expect(ctx.translateDeepSeek('test', 'zh-CN', 'en', '')).rejects.toThrow('DeepSeek API Key');
  });

  test('sends request to deepseek.com endpoint', async () => {
    let calledUrl = '';
    const fetch = (url, _opts) => {
      calledUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '你好' } }] }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateDeepSeek('Hello', 'zh-CN', 'en', 'key');
    expect(calledUrl).toContain('deepseek.com');
  });
});

// ─── callOpenAICompat ────────────────────────────────────────────────────────

describe('callOpenAICompat', () => {
  test('returns trimmed translation', async () => {
    const ctx = loadBg({ fetchImpl: ok({ choices: [{ message: { content: '  你好  ' } }] }) });
    const result = await ctx.callOpenAICompat('https://api.test.com', 'model', 'key', 'Hello', 'zh-CN');
    expect(result).toBe('你好');
  });

  test('throws on non-ok HTTP status', async () => {
    const ctx = loadBg({ fetchImpl: fail(401) });
    await expect(
      ctx.callOpenAICompat('https://api.test.com', 'model', 'key', 'Hello', 'zh-CN')
    ).rejects.toThrow('API error 401');
  });

  test('sends correct model in request body', async () => {
    let capturedBody;
    const fetch = (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.callOpenAICompat('https://api.test.com', 'gpt-4o-mini', 'key', 'Hello', 'zh-CN');
    expect(capturedBody.model).toBe('gpt-4o-mini');
    expect(capturedBody.messages[0].role).toBe('system');
    expect(capturedBody.messages[1].role).toBe('user');
    expect(capturedBody.messages[1].content).toBe('Hello');
  });

  test('uses lang name from LANG_NAMES in system prompt', async () => {
    let capturedBody;
    const fetch = (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.callOpenAICompat('https://api.test.com', 'model', 'key', 'Hello', 'zh-CN');
    expect(capturedBody.messages[0].content).toContain('Simplified Chinese');
  });
});

// ─── translateLibre ──────────────────────────────────────────────────────────

describe('translateLibre', () => {
  test('returns translatedText', async () => {
    const ctx = loadBg({ fetchImpl: ok({ translatedText: '你好' }) });
    expect(await ctx.translateLibre('Hello', 'zh-CN', 'en', null)).toBe('你好');
  });

  test('falls back to libretranslate.com when no instance URL', async () => {
    let calledUrl = '';
    const fetch = (url, _opts) => {
      calledUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ translatedText: 'ok' }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateLibre('test', 'zh', 'en', '');
    expect(calledUrl).toContain('libretranslate.com');
  });

  test('uses custom instance URL when provided', async () => {
    let calledUrl = '';
    const fetch = (url, _opts) => {
      calledUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ translatedText: 'ok' }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateLibre('test', 'zh', 'en', 'https://my-libre.example.com');
    expect(calledUrl).toContain('my-libre.example.com');
  });

  test('throws on HTTP error', async () => {
    const ctx = loadBg({ fetchImpl: fail(500) });
    await expect(ctx.translateLibre('test', 'zh', 'en', null)).rejects.toThrow('LibreTranslate: HTTP 500');
  });

  test('strips language subtag for libre (zh-CN → zh)', async () => {
    let capturedBody;
    const fetch = (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ translatedText: 'ok' }) });
    };
    const ctx = loadBg({ fetchImpl: fetch });
    await ctx.translateLibre('test', 'zh-CN', 'en-US', null);
    expect(capturedBody.target).toBe('zh');
    expect(capturedBody.source).toBe('en');
  });
});

// ─── message listener wiring ─────────────────────────────────────────────────

describe('runtime.onMessage listener', () => {
  test('is registered on load', () => {
    const ctx = loadBg();
    expect(typeof ctx.__listeners.message).toBe('function');
  });

  test('translate message returns success response', async () => {
    const ctx = loadBg({ fetchImpl: ok([[['你好', 'Hello']]]) });
    let response;
    ctx.__listeners.message(
      { type: 'translate', text: 'Hello', engine: 'google', targetLang: 'zh-CN' },
      {},
      (r) => { response = r; }
    );
    await new Promise(r => setTimeout(r, 50));
    expect(response.success).toBe(true);
    expect(typeof response.translation).toBe('string');
  });

  test('translate message returns error response on failure', async () => {
    const ctx = loadBg({ fetchImpl: fail(500) });
    let response;
    ctx.__listeners.message(
      { type: 'translate', text: 'Hello', engine: 'google', targetLang: 'zh-CN' },
      {},
      (r) => { response = r; }
    );
    await new Promise(r => setTimeout(r, 50));
    expect(response.success).toBe(false);
    expect(typeof response.error).toBe('string');
  });

  test('detectLang message returns lang', async () => {
    const ctx = loadBg({ fetchImpl: ok([[['ok', 'test']], null, 'en']) });
    let response;
    ctx.__listeners.message(
      { type: 'detectLang', text: 'Hello' },
      {},
      (r) => { response = r; }
    );
    await new Promise(r => setTimeout(r, 50));
    expect(response.success).toBe(true);
    expect(typeof response.lang).toBe('string');
  });
});

// ─── M2: website-backed AI tiers ────────────────────────────────────────────

describe('site AI tiers (oi-standard / oi-premium)', () => {
  test('posts to the site API with the session cookie and the tier as mode', async () => {
    let seen = null;
    const ctx = loadBg({
      fetchImpl: (url, init) => {
        seen = { url, init };
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ translatedText: '你好', detectedSource: 'English' }),
        });
      },
    });
    const out = await ctx.translate({ text: 'Hello', engine: 'oi-premium', targetLang: 'zh-CN' });
    expect(out).toBe('你好');
    expect(seen.url).toContain('/api/translate');
    expect(seen.init.credentials).toBe('include');
    const body = JSON.parse(seen.init.body);
    expect(body.mode).toBe('premium');
    expect(body.target).toBe('Simplified Chinese');
  });

  test('401 from the site becomes a sign-in hint', async () => {
    const ctx = loadBg({
      fetchImpl: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }),
    });
    await expect(ctx.translate({ text: 'Hi', engine: 'oi-standard', targetLang: 'zh-CN' }))
      .rejects.toThrow(/登录/);
  });

  test('402 from the site becomes a top-up hint', async () => {
    const ctx = loadBg({
      fetchImpl: () => Promise.resolve({ ok: false, status: 402, json: () => Promise.resolve({}) }),
    });
    await expect(ctx.translate({ text: 'Hi', engine: 'oi-standard', targetLang: 'zh-CN' }))
      .rejects.toThrow(/额度不足/);
  });
});

// ─── openOptions (float ball menu entry) ────────────────────────────────────

describe('openOptions message', () => {
  test('calls runtime.openOptionsPage when available', () => {
    const ctx = loadBg();
    let opened = 0;
    ctx.browser.runtime.openOptionsPage = () => { opened++; };
    ctx.__listeners.message({ type: 'openOptions' }, {}, () => {});
    expect(opened).toBe(1);
  });

  test('does not throw when openOptionsPage is absent', () => {
    const ctx = loadBg();
    expect(() => ctx.__listeners.message({ type: 'openOptions' }, {}, () => {})).not.toThrow();
  });
});

// ─── oiAuthStatus（v1.13.0 账号区）────────────────────────────────────────────

describe('oiAuthStatus', () => {
  test('404 means the site tier is not deployed yet', async () => {
    const ctx = loadBg({ fetchImpl: () => Promise.resolve({ status: 404, json: () => Promise.resolve({}) }) });
    const r = await ctx.oiAuthStatus();
    expect(r.success).toBe(true);
    expect(r.available).toBe(false);
    expect(r.user).toBeNull();
  });

  test('logged-in user passes through with site url', async () => {
    const user = { email: 'paytest@openimmersive.ai', plan: 'free', credits: 99990 };
    const ctx = loadBg({ fetchImpl: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ user }) }) });
    const r = await ctx.oiAuthStatus();
    expect(r.available).toBe(true);
    expect(r.user).toEqual(user);
    expect(r.site).toBe('https://openimmersive.ai');
  });

  test('oiSiteBase override changes the queried site', async () => {
    let calledUrl = '';
    const ctx = loadBg({
      storageData: { oiSiteBase: 'http://preview.test:8091' },
      fetchImpl: (url) => { calledUrl = String(url); return Promise.resolve({ status: 401, json: () => Promise.resolve({ error: 'x' }) }); },
    });
    const r = await ctx.oiAuthStatus();
    expect(calledUrl).toContain('http://preview.test:8091/api/auth/me');
    expect(r.available).toBe(true);
    expect(r.user).toBeNull(); // 未登录
  });
});

// ─── translateMicrosoft ──────────────────────────────────────────────────────

/**
 * Mock the two-step Bing flow: GET bing.com/translator hands out IG + the
 * one-time key/token pair, POST /ttranslatev3 returns the translation.
 * `translateStatus` / `translateBody` let a test bend the second step only.
 */
function msFetch({ pageHtml, translateStatus = 200, translateBody, onCall } = {}) {
  const html = pageHtml !== undefined ? pageHtml
    : 'var IG:"ABC123DEF";var params_AbusePreventionHelper = [1787549684505,"tok-xyz",3600000];';
  const body = translateBody !== undefined ? translateBody
    : [{ translations: [{ text: '你好' }], detectedLanguage: { language: 'en' } }];
  return (url, opts) => {
    if (onCall) onCall(url, opts);
    if (String(url).includes('/translator')) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
    }
    return Promise.resolve({
      ok: translateStatus >= 200 && translateStatus < 300,
      status: translateStatus,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve('')
    });
  };
}

describe('toMsLang', () => {
  const ctx = loadBg();
  test.each([
    ['zh-CN', 'zh-Hans'],
    ['zh',    'zh-Hans'],
    ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['ja',    'ja'],
    ['pt-BR', 'pt-BR']
  ])('%s → %s', (input, expected) => {
    expect(ctx.toMsLang(input)).toBe(expected);
  });
});

describe('translateMicrosoft', () => {
  test('returns the translation from the ttranslatev3 array', async () => {
    const ctx = loadBg({ fetchImpl: msFetch() });
    expect(await ctx.translateMicrosoft('Hello', 'zh-CN', 'en')).toBe('你好');
  });

  test('posts the scraped IG, key and token', async () => {
    const calls = [];
    const ctx = loadBg({ fetchImpl: msFetch({ onCall: (url, opts) => calls.push({ url: String(url), opts }) }) });
    await ctx.translateMicrosoft('Hello', 'zh-CN', 'en');

    const post = calls.find(c => c.url.includes('ttranslatev3'));
    expect(post.url).toContain('IG=ABC123DEF');
    expect(post.opts.body).toContain('token=tok-xyz');
    expect(post.opts.body).toContain('key=1787549684505');
    expect(post.opts.body).toContain('to=zh-Hans'); // zh-CN 必须映射成 zh-Hans
    expect(post.opts.body).toContain('fromLang=en');
  });

  test('sends auto-detect when sourceLang is auto', async () => {
    const calls = [];
    const ctx = loadBg({ fetchImpl: msFetch({ onCall: (url, opts) => calls.push({ url: String(url), opts }) }) });
    await ctx.translateMicrosoft('Hello', 'ja', 'auto');
    const post = calls.find(c => c.url.includes('ttranslatev3'));
    expect(post.opts.body).toContain('fromLang=auto-detect');
  });

  test('never attaches the user cookie jar', async () => {
    const calls = [];
    const ctx = loadBg({ fetchImpl: msFetch({ onCall: (url, opts) => calls.push({ url: String(url), opts }) }) });
    await ctx.translateMicrosoft('Hello', 'zh-CN', 'en');
    expect(calls.every(c => c.opts && c.opts.credentials === 'omit')).toBe(true);
  });

  test('percent-encodes the text instead of breaking the form body', async () => {
    const calls = [];
    const ctx = loadBg({ fetchImpl: msFetch({ onCall: (url, opts) => calls.push({ url: String(url), opts }) }) });
    await ctx.translateMicrosoft('a&b=c d', 'zh-CN', 'en');
    const post = calls.find(c => c.url.includes('ttranslatev3'));
    expect(post.opts.body).toContain('text=a%26b%3Dc%20d');
  });

  test('reuses the cached token for a second segment', async () => {
    let pageHits = 0;
    const inner = msFetch();
    const ctx = loadBg({
      fetchImpl: (url, opts) => {
        if (String(url).includes('/translator')) pageHits++;
        return inner(url, opts);
      }
    });
    await ctx.translateMicrosoft('one', 'zh-CN', 'en');
    await ctx.translateMicrosoft('two', 'zh-CN', 'en');
    expect(pageHits).toBe(1);
  });

  test('throws when the page carries no auth token', async () => {
    const ctx = loadBg({ fetchImpl: msFetch({ pageHtml: '<html>nothing here</html>' }) });
    await expect(ctx.translateMicrosoft('Hello', 'zh-CN')).rejects.toThrow('auth token not found');
  });

  test('re-fetches the token once on 401, then gives up', async () => {
    let pageHits = 0;
    const ctx = loadBg({
      fetchImpl: (url) => {
        if (String(url).includes('/translator')) {
          pageHits++;
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('IG:"AA11";params_AbusePreventionHelper = [1,"t",3600000];') });
        }
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ ShowCaptcha: false }), text: () => Promise.resolve('') });
      }
    });
    await expect(ctx.translateMicrosoft('Hello', 'zh-CN')).rejects.toThrow('Microsoft: HTTP 401');
    expect(pageHits).toBe(2); // 首次 + token 作废后重取一次，不会无限重试
  });

  test('throws on an empty translations array', async () => {
    const ctx = loadBg({ fetchImpl: msFetch({ translateBody: [] }) });
    await expect(ctx.translateMicrosoft('Hello', 'zh-CN')).rejects.toThrow('empty translation');
  });
});

// ─── free-engine chain ───────────────────────────────────────────────────────

describe('translateFree (free engines back each other up)', () => {
  /** google 429 → microsoft 正常 → mymemory 正常 */
  function chainFetch({ googleStatus = 200, msStatus = 200 } = {}) {
    const hits = [];
    const impl = (url, opts) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('translate.googleapis.com')) {
        return googleStatus === 200
          ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([[['G译', 'x']]]) })
          : Promise.resolve({ ok: false, status: googleStatus, json: () => Promise.reject(new Error('no json')), text: () => Promise.resolve('') });
      }
      if (u.includes('/translator')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('IG:"BB22";params_AbusePreventionHelper = [9,"tk",3600000];') });
      }
      if (u.includes('ttranslatev3')) {
        return msStatus === 200
          ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ translations: [{ text: 'MS译' }] }]) })
          : Promise.resolve({ ok: false, status: msStatus, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ responseStatus: 200, responseData: { translatedText: 'MM译' } }) });
    };
    impl.hits = hits;
    return impl;
  }

  test('google first when nothing has failed', async () => {
    const fetchImpl = chainFetch();
    const ctx = loadBg({ fetchImpl });
    expect(await ctx.translate({ text: 'Hello', engine: 'google', targetLang: 'zh-CN' })).toBe('G译');
    expect(fetchImpl.hits.some(u => u.includes('bing.com'))).toBe(false);
  });

  test('falls back to microsoft when google is rate-limited', async () => {
    const fetchImpl = chainFetch({ googleStatus: 429 });
    const ctx = loadBg({ fetchImpl });
    expect(await ctx.translate({ text: 'Hello', engine: 'google', targetLang: 'zh-CN' })).toBe('MS译');
  });

  test('falls through to mymemory when google and microsoft both fail', async () => {
    const fetchImpl = chainFetch({ googleStatus: 429, msStatus: 500 });
    const ctx = loadBg({ fetchImpl });
    expect(await ctx.translate({ text: 'Hello', engine: 'google', targetLang: 'zh-CN' })).toBe('MM译');
  });

  test('a failed engine is skipped first on the next segment (cooldown)', async () => {
    const fetchImpl = chainFetch({ googleStatus: 429 });
    const ctx = loadBg({ fetchImpl });
    await ctx.translate({ text: 'one', engine: 'google', targetLang: 'zh-CN' });
    const afterFirst = fetchImpl.hits.length;
    await ctx.translate({ text: 'two', engine: 'google', targetLang: 'zh-CN' });
    // 第二段不再重撞 google：整页几十个块不该各自先吃一次 429
    expect(fetchImpl.hits.slice(afterFirst).some(u => u.includes('translate.googleapis.com'))).toBe(false);
  });

  test('picking microsoft explicitly calls bing first', async () => {
    const fetchImpl = chainFetch();
    const ctx = loadBg({ fetchImpl });
    expect(await ctx.translate({ text: 'Hello', engine: 'microsoft', targetLang: 'zh-CN' })).toBe('MS译');
    expect(fetchImpl.hits.some(u => u.includes('translate.googleapis.com'))).toBe(false);
  });

  test('reports every engine reason when the whole chain is down', async () => {
    const ctx = loadBg({ fetchImpl: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('no json')), text: () => Promise.resolve('') }) });
    await expect(ctx.translate({ text: 'Hello', engine: 'google', targetLang: 'zh-CN' }))
      .rejects.toThrow(/Google: HTTP 503.*Microsoft: HTTP 503.*MyMemory: HTTP 503/);
  });

  test('BYOK engines do not silently fall back to a free engine', async () => {
    // DeepL 挂了要报 DeepL 的错，不能悄悄换成 Google —— 否则用户永远不知道自己的 Key 坏了
    const free = chainFetch();
    const fetchImpl = (url, opts) => String(url).includes('deepl')
      ? Promise.resolve({ ok: false, status: 456, text: () => Promise.resolve('quota'), json: () => Promise.reject(new Error('no json')) })
      : free(url, opts);
    const ctx = loadBg({ fetchImpl, storageData: { apiKeys: { deepl: 'k' } } });
    await expect(ctx.translate({ text: 'Hello', engine: 'deepl', targetLang: 'zh-CN' })).rejects.toThrow('DeepL: HTTP 456');
    expect(free.hits.some(u => u.includes('translate.googleapis.com'))).toBe(false);
  });
});

// ─── Bing 的 1000 字符上限（超了回 HTTP 200 + statusCode 400，只看状态码看不见）──

describe('msChunk / long-paragraph handling', () => {
  const ctx = loadBg();

  test('short text stays one chunk', () => {
    expect(ctx.msChunk('hello world')).toEqual(['hello world']);
  });

  test('every chunk stays within the limit', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(89); // ~4000 chars
    const chunks = ctx.msChunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.length <= 1000)).toBe(true);
  });

  test('chunks concatenate back to the original text', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(89);
    expect(ctx.msChunk(text).join('')).toBe(text);
  });

  test('splits on sentence ends, not mid-sentence', () => {
    const text = ('Sentence about shipping software that is reasonably long. ').repeat(40);
    expect(ctx.msChunk(text).slice(0, -1).every(c => /[.!?。！？]\s*$/.test(c))).toBe(true);
  });

  test('a single overlong sentence is hard-split rather than dropped', () => {
    const text = 'a'.repeat(2500);
    const chunks = ctx.msChunk(text);
    expect(chunks.every(c => c.length <= 1000)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  test('a long paragraph is sent in pieces and stitched back', async () => {
    const posts = [];
    const ctx2 = loadBg({
      fetchImpl: (url, opts) => {
        if (String(url).includes('/translator')) {
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('IG:"CC33";params_AbusePreventionHelper = [7,"tk",3600000];') });
        }
        posts.push(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ translations: [{ text: `[${posts.length}]` }] }]) });
      }
    });
    const out = await ctx2.translateMicrosoft('The quick brown fox jumps over the lazy dog. '.repeat(89), 'zh-CN', 'en');
    expect(posts.length).toBeGreaterThan(1);
    expect(out).toBe(posts.map((_, i) => `[${i + 1}]`).join(''));
  });

  test('a 200 response carrying statusCode 400 is a failure, not an empty translation', async () => {
    const ctx2 = loadBg({
      fetchImpl: (url) => String(url).includes('/translator')
        ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('IG:"DD44";params_AbusePreventionHelper = [7,"tk",3600000];') })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ statusCode: 400, errorMessage: '' }) })
    });
    await expect(ctx2.translateMicrosoft('Hello', 'zh-CN')).rejects.toThrow('Microsoft: statusCode 400');
  });
});
