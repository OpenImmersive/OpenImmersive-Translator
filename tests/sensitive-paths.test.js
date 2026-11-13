/**
 * @jest-environment jsdom
 */
'use strict';

// 敏感信息脱敏开着时，三条用户可触发的翻译路径（整页、划词、输入框 Alt+Enter）
// 发给引擎的文字里只有占位符。content.js 与真实的 background.js 接在一起：
// 内容脚本的 runtime.sendMessage 直接交给后台的消息监听，后台的 fetch 记下
// 发往 Google 的 q，译文是「译文：」加上 q。

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const YLSensitive = require('../sensitive-mask.js');

const ROOT = path.join(__dirname, '..');
const SECRETS = {
  email: 'jane.doe@example.com',
  phone: '13812345678',
  card: '4111 1111 1111 1111',
  openaiKey: 'sk-proj-abcdefghijklmnopqrstuvwx',
  githubToken: 'ghp_' + 'A1b2C3d4E5'.repeat(4),
  cnId: '11010519491231002X',
};
const TEXT = `Contact ${SECRETS.email} or ${SECRETS.phone}, card ${SECRETS.card}, ` +
  `key ${SECRETS.openaiKey}, token ${SECRETS.githubToken}, ID ${SECRETS.cnId}.`;

const outgoing = [];
let fns;

function loadBackground(storageData) {
  let listener = null;
  const ctx = vm.createContext({
    YLSensitive,
    browser: {
      storage: { local: { get: (keys) => Promise.resolve(Object.fromEntries(keys.filter(k => k in storageData).map(k => [k, storageData[k]]))) } },
      runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
      tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() },
      commands: { onCommand: { addListener: () => {} } },
    },
    fetch: (url) => {
      const q = new URL(url).searchParams.get('q');
      outgoing.push(q);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([[['译文：' + q, q]], null, 'en']) });
    },
    URL, Promise, console, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx);
  return (msg) => new Promise(resolve => listener(msg, {}, resolve));
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return document.body; } });
  if (!document.createRange().getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 10, right: 10, width: 10, height: 10 });
  }
  if (typeof window.requestAnimationFrame !== 'function') window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const settings = { sensitiveMask: true, engine: 'google', targetLang: 'zh-CN' };
  const send = loadBackground(settings);
  global.browser = {
    storage: { local: { get: () => Promise.resolve(settings) } },
    runtime: { onMessage: { addListener: () => {} }, sendMessage: send },
    i18n: require('./i18n-stub').i18n,
  };
  global.YLSensitive = YLSensitive;
  global.__yllTestMode = true;
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
  fns = global.__yllInternals;
});

beforeEach(() => { outgoing.length = 0; document.body.innerHTML = ''; });

const settle = () => new Promise(r => setTimeout(r, 20));

function expectMasked(q) {
  for (const value of Object.values(SECRETS)) expect(q).not.toContain(value);
  for (const type of ['EMAIL', 'PHONE', 'CARD', 'KEY', 'IDCARD']) expect(q).toMatch(new RegExp(`__PII_${type}_\\d+__`));
}

test('page translation sends placeholders and shows the restored values', async () => {
  document.body.innerHTML = `<p id="p">${TEXT}</p>`;
  await fns.translateBlock(document.getElementById('p'));
  expect(outgoing).toHaveLength(1);
  expectMasked(outgoing[0]);
  expect(document.querySelector('[data-yll-inject]').textContent).toBe('译文：' + TEXT);
});

test('selection translation sends placeholders and shows the restored values', async () => {
  document.body.innerHTML = `<p id="p">${TEXT}</p>`;
  const range = document.createRange();
  range.selectNodeContents(document.getElementById('p'));
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  // 划词等鼠标停下 250 ms 再问
  await new Promise(r => setTimeout(r, 300));
  expect(outgoing).toHaveLength(1);
  expectMasked(outgoing[0]);
  expect(document.querySelector('#yll-sel-popup .yll-popup-text').textContent).toBe('译文：' + TEXT);
});

test('Alt+Enter input translation sends placeholders and writes back the restored values', async () => {
  document.body.innerHTML = '<textarea></textarea>';
  const box = document.querySelector('textarea');
  box.value = TEXT;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
  await settle();
  expect(outgoing).toHaveLength(1);
  expectMasked(outgoing[0]);
  expect(box.value).toBe('译文：' + TEXT);
});
