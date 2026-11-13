/**
 * @jest-environment jsdom
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

async function loadPopup(stored = {}, status = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  const storage = { ...stored };
  global.chrome = {
    i18n: require('./i18n-stub').i18n,
    runtime: { openOptionsPage: jest.fn(), sendMessage: jest.fn().mockResolvedValue({ success: true }) },
    tabs: {
      query: jest.fn(async () => [{ id: 1, url: 'https://example.com/' }]),
      sendMessage: jest.fn(async () => status),
    },
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries(keys.filter(k => k in storage).map(k => [k, storage[k]]))),
        set: (items, cb) => { Object.assign(storage, items); cb && cb(); },
      },
    },
  };
  global.YLI18n = require('../i18n.js');
  global.YLLangs = require('../languages.js');
  window.close = jest.fn();
  // popup.js declares top-level consts; indirect eval would clash between tests.
  new Function(fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8'))();
  await new Promise(r => setTimeout(r, 0));
  return { storage, sel: document.getElementById('selLang') };
}

afterEach(() => { jest.resetModules(); delete global.chrome; });

describe('popup language picker', () => {
  test('ends with an entry naming the full language count', async () => {
    const { sel } = await loadPopup();
    const last = sel.options[sel.options.length - 1];
    expect(last.textContent).toBe(`All ${YLLangs.count} languages…`);
  });

  test('choosing the full-list entry opens settings and keeps the language', async () => {
    const { storage, sel } = await loadPopup({ targetLang: 'ja' });
    sel.value = sel.options[sel.options.length - 1].value;
    sel.dispatchEvent(new Event('change'));
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
    expect(sel.value).toBe('ja');
    expect(storage.targetLang).toBe('ja');
  });

  test('choosing a language still saves it', async () => {
    const { storage, sel } = await loadPopup({ targetLang: 'ja' });
    sel.value = 'fr';
    sel.dispatchEvent(new Event('change'));
    expect(storage.targetLang).toBe('fr');
    expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
  });
});

describe('popup status line', () => {
  test('a failure naming a site URL renders it as a link that opens a tab', async () => {
    const hint = 'Sign up free or log in at https://openimmersive.ai/?login=1 to use the AI tiers';
    await loadPopup();
    chrome.tabs.create = jest.fn();
    chrome.tabs.sendMessage = jest.fn(async () => ({ status: 'done', isTranslated: true, count: 0, error: hint }));
    document.getElementById('btnTranslate').click();
    await new Promise(r => setTimeout(r, 0));
    const a = document.querySelector('#statusText a');
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('https://openimmersive.ai/?login=1');
    expect(document.getElementById('statusText').textContent).toContain(hint);
    a.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://openimmersive.ai/?login=1' });
  });

  test('a plain status line stays plain text', async () => {
    await loadPopup();
    chrome.tabs.sendMessage = jest.fn(async () => ({ status: 'done', isTranslated: true, count: 3 }));
    document.getElementById('btnTranslate').click();
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelector('#statusText a')).toBeNull();
    expect(document.getElementById('statusText').textContent).toBe('3 paragraphs translated');
  });
});

describe('popup account prompt (the site refused the page)', () => {
  const MSG = 'Log in or sign up free to use Standard and Premium. The free Google tier needs no account.';
  const shown = (id) => document.getElementById(id).style.display !== 'none';

  async function refusedBy(code) {
    const loaded = await loadPopup({ engine: 'oi-standard' });
    chrome.tabs.create = jest.fn();
    chrome.tabs.sendMessage = jest.fn(async () => ({ status: 'done', isTranslated: false, count: 0, error: MSG, code, site: 'https://openimmersive.ai' }));
    document.getElementById('btnTranslate').click();
    await new Promise(r => setTimeout(r, 0));
    return loaded;
  }

  test('signed out: the prompt itself, no "Engine failed:" prefix, with Log in and Use free Google', async () => {
    await refusedBy('login_required');
    expect(document.getElementById('statusText').textContent).toBe(MSG);
    expect(shown('acctActions')).toBe(true);
    expect(shown('btnAcctLogin')).toBe(true);
    expect(shown('btnAcctBuy')).toBe(false);
    expect(shown('btnAcctGoogle')).toBe(true);
    document.getElementById('btnAcctLogin').click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'oiLogin' });
  });

  test('out of credits: Buy credits opens the pricing section', async () => {
    await refusedBy('out_of_credits');
    expect(shown('btnAcctLogin')).toBe(false);
    expect(shown('btnAcctBuy')).toBe(true);
    document.getElementById('btnAcctBuy').click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://openimmersive.ai/#pricing' });
  });

  test('Use free Google saves the engine and translates the page with it', async () => {
    const { storage } = await refusedBy('login_required');
    chrome.tabs.sendMessage = jest.fn(async (_id, m) => (m.type === 'translatePage' ? { status: 'done', count: 4 } : { status: 'removed' }));
    document.getElementById('btnAcctGoogle').click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(storage.engine).toBe('google');
    const types = chrome.tabs.sendMessage.mock.calls.map(c => c[1]);
    expect(types[0]).toEqual({ type: 'removeTranslations' });
    expect(types[1]).toMatchObject({ type: 'translatePage', engine: 'google' });
    expect(document.getElementById('statusText').textContent).toBe('4 paragraphs translated');
    expect(shown('acctActions')).toBe(false);
  });

  test('opening the popup on a page that was already refused shows the prompt', async () => {
    await loadPopup({}, { isTranslated: false, isTranslating: false, translatedCount: 0, error: MSG, code: 'login_required', site: 'https://openimmersive.ai' });
    expect(document.getElementById('statusText').textContent).toBe(MSG);
    expect(shown('btnAcctLogin')).toBe(true);
  });

  test('credits running out part-way: the prompt and Buy credits, and the button still restores', async () => {
    await loadPopup({}, { isTranslated: true, isTranslating: false, translatedCount: 4, error: 'out', code: 'out_of_credits', site: 'https://openimmersive.ai' });
    expect(document.getElementById('statusText').textContent).toBe('out');
    expect(shown('btnAcctBuy')).toBe(true);
    expect(document.getElementById('btnTranslate').textContent).toBe('Show original');
  });

  test('other failures keep the "Engine failed:" wording and no buttons', async () => {
    await loadPopup();
    chrome.tabs.sendMessage = jest.fn(async () => ({ status: 'done', isTranslated: true, count: 0, error: 'Google: HTTP 429' }));
    document.getElementById('btnTranslate').click();
    await new Promise(r => setTimeout(r, 0));
    expect(document.getElementById('statusText').textContent).toBe('Engine failed: Google: HTTP 429');
    expect(shown('acctActions')).toBe(false);
  });
});
