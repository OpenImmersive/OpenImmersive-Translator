/**
 * @jest-environment jsdom
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

async function loadPopup(stored = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
  const storage = { ...stored };
  global.chrome = {
    i18n: require('./i18n-mock'),
    runtime: { openOptionsPage: jest.fn() },
    tabs: {
      query: jest.fn(async () => [{ id: 1, url: 'https://example.com/' }]),
      sendMessage: jest.fn(async () => ({})),
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
  test('ends with an entry for the full language list', async () => {
    const { sel } = await loadPopup();
    const last = sel.options[sel.options.length - 1];
    expect(last.textContent).toContain('全部');
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
