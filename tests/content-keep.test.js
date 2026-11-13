/**
 * @jest-environment jsdom
 */
'use strict';

// 划词和 Alt+Enter 输入框：名字（保留名单）和行内代码换成占位符送出，译文回来
// 换回；占位符被引擎弄丢就按原文再问一次。

const fs = require('fs');
const path = require('path');

let fns;
let sent;
let reply;

const tick = () => new Promise(r => setTimeout(r, 0));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body; }
  });
  // jsdom 的 Range 没有布局
  Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10 });
  global.browser = {
    storage: { local: { get: () => Promise.resolve({ targetLang: 'zh-CN', engine: 'google' }) } },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (m) => { sent.push(m.text); return Promise.resolve({ success: true, translation: reply(m.text) }); }
    },
    i18n: require('./i18n-stub').i18n
  };
  global.YLSensitive = require('../sensitive-mask.js');
  global.__yllTestMode = true;
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);
  fns = global.__yllInternals;
});

beforeEach(() => {
  sent = [];
  reply = (t) => '译:' + t;
  // 划词气泡建一次、之后复用：留着它，只清掉用例自己的内容
  for (const n of Array.from(document.body.childNodes)) if (n.id !== 'yll-sel-popup') n.remove();
});

function setBody(html) {
  for (const n of Array.from(document.body.childNodes)) if (n.id !== 'yll-sel-popup') n.remove();
  document.body.insertAdjacentHTML('afterbegin', html);
}

function select(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function selectionResult() {
  await fns.translateCurrentSelection();
  await tick();
  const box = document.querySelector('#yll-sel-popup .yll-popup-text');
  return box && box.textContent;
}

const altEnter = () => new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true, composed: true });

async function altEnterIn(value) {
  setBody('<textarea></textarea>');
  const box = document.querySelector('textarea');
  box.value = value;
  box.dispatchEvent(altEnter());
  await tick(); await tick();
  return box.value;
}

describe('keep-list in selection translation', () => {
  test('a kept name goes out as a placeholder and comes back as written', async () => {
    setBody('<p id="p">Follow us on Bluesky for updates.</p>');
    select(document.getElementById('p'));
    expect(await selectionResult()).toBe('译:Follow us on Bluesky for updates.');
    expect(sent).toEqual(['Follow us on __PII_NAME_1__ for updates.']);
  });

  test('a lost placeholder falls back to the plain text', async () => {
    setBody('<p id="p">Follow us on Bluesky for updates.</p>');
    reply = (t) => t.replace('__PII_NAME_1__', '蓝天');
    select(document.getElementById('p'));
    expect(await selectionResult()).toBe('Follow us on Bluesky for updates.');
    expect(sent).toEqual(['Follow us on __PII_NAME_1__ for updates.', 'Follow us on Bluesky for updates.']);
  });
});

describe('keep-list in Alt+Enter input translation', () => {
  test('a kept name in the box goes out as a placeholder', async () => {
    expect(await altEnterIn('我在 Mastodon 上发帖')).toBe('译:我在 Mastodon 上发帖');
    expect(sent).toEqual(['我在 __PII_NAME_1__ 上发帖']);
  });

  test('text without kept names goes out unchanged', async () => {
    expect(await altEnterIn('你好世界')).toBe('译:你好世界');
    expect(sent).toEqual(['你好世界']);
  });
});

describe('inline code in selection translation', () => {
  test('<code> inside the selection goes out as a placeholder', async () => {
    setBody('<p id="p">Call <code>fetch()</code> and then read <code>response.json</code> once.</p>');
    reply = (t) => t.replace('Call', '调用').replace('and then read', '然后读取').replace('once', '一次');
    select(document.getElementById('p'));
    expect(await selectionResult()).toBe('调用 fetch() 然后读取 response.json 一次.');
    expect(sent).toEqual(['Call __PII_CODE_1__ and then read __PII_CODE_2__ once.']);
  });

  test('a selection that starts inside the code keeps just the selected part', async () => {
    setBody('<p id="p">Use <kbd>Ctrl</kbd> with the window open.</p>');
    const p = document.getElementById('p');
    const range = document.createRange();
    range.setStart(p.querySelector('kbd').firstChild, 1);
    range.setEnd(p.lastChild, p.lastChild.length);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    await selectionResult();
    expect(sent).toEqual(['__PII_CODE_1__ with the window open.']);
  });

  test('a selection made inside a code element is translated as is', async () => {
    setBody('<p>See <code id="c">window.open is blocked</code> here.</p>');
    select(document.getElementById('c'));
    await selectionResult();
    expect(sent).toEqual(['window.open is blocked']);
  });

  test('a lost code placeholder falls back to the plain text', async () => {
    setBody('<p id="p">Call <code>fetch()</code> to load the window.</p>');
    reply = (t) => t.replace('__PII_CODE_1__', '获取()');
    select(document.getElementById('p'));
    await selectionResult();
    expect(sent).toEqual(['Call __PII_CODE_1__ to load the window.', 'Call fetch() to load the window.']);
  });
});

describe('code in Alt+Enter input translation', () => {
  test('backtick spans and code-looking tokens go out as placeholders', async () => {
    reply = (t) => t.replace('用', 'Use ').replace('安装，然后调用', ' to install, then call').replace('和', ' and ');
    const out = await altEnterIn('用`npm install`安装，然后调用 useState() 和 res.json');
    expect(sent).toEqual(['用__PII_CODE_1__安装，然后调用 __PII_CODE_2__ 和 __PII_CODE_3__']);
    expect(out).toBe('Use `npm install` to install, then call useState()  and  res.json');
  });

  test('camelCase and snake_case identifiers are kept; e.g. and U.S. are not code', async () => {
    await altEnterIn('把 user_id 传给 getItem，e.g. 在 U.S. 用');
    expect(sent).toEqual(['把 __PII_CODE_1__ 传给 __PII_CODE_2__，e.g. 在 U.S. 用']);
  });
});

test('emails and URLs in the input box are left to the sensitive-info mask, not taken as code', async () => {
  await altEnterIn('发邮件到 alice.test@example.com 或看 https://example.com/a_b.html');
  expect(sent).toEqual(['发邮件到 alice.test@example.com 或看 https://example.com/a_b.html']);
});
