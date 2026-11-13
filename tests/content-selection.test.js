/**
 * @jest-environment jsdom
 */
'use strict';

// 划词气泡：双击、三击的几次 mouseup 合成一次请求；回得晚的旧选区译文不盖掉
// 新选区的气泡。

const fs = require('fs');
const path = require('path');

let fns;
let sent;
let delayOf;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body; }
  });
  Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10 });
  global.browser = {
    storage: { local: { get: () => Promise.resolve({ targetLang: 'zh-CN', engine: 'google' }) } },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (m) => {
        sent.push(m.text);
        return wait(delayOf(m.text)).then(() => ({ success: true, translation: '译:' + m.text }));
      }
    },
    i18n: require('./i18n-stub').i18n
  };
  global.YLSensitive = require('../sensitive-mask.js');
  global.__yllTestMode = true;
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'));
  fns = global.__yllInternals;
});

const PARA = 'Jupiter is the fifth planet from the Sun and the largest in the Solar System.';

beforeEach(() => {
  sent = [];
  delayOf = () => 0;
  for (const n of Array.from(document.body.childNodes)) if (n.id !== 'yll-sel-popup') n.remove();
  document.body.insertAdjacentHTML('afterbegin', `<p id="p">${PARA}</p>`);
});

function selectWord(word) {
  const node = document.getElementById('p').firstChild;
  const at = node.data.indexOf(word);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + word.length);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
}

function selectParagraph() {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById('p'));
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
}

const mouseup = () => document.getElementById('p').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
const popupText = () => {
  const box = document.querySelector('#yll-sel-popup .yll-popup-text');
  return box && document.getElementById('yll-sel-popup').style.display !== 'none' ? box.textContent : null;
};

test('a late reply for an older selection does not replace the newer one', async () => {
  delayOf = (t) => (t === 'fifth' ? 80 : 5);
  selectWord('fifth');
  const older = fns.translateCurrentSelection();
  selectParagraph();
  const newer = fns.translateCurrentSelection();
  await Promise.all([older, newer]);
  await wait(100);
  expect(sent).toEqual(['fifth', PARA]);
  expect(popupText()).toBe('译:' + PARA);
});

test('a late reply after the selection was cleared does not reopen the popup', async () => {
  delayOf = () => 60;
  selectWord('fifth');
  const pending = fns.translateCurrentSelection();
  window.getSelection().removeAllRanges();
  await fns.translateCurrentSelection();
  await pending;
  expect(popupText()).toBe(null);
});

test('click, double-click, triple-click in a row send one request for the final selection', async () => {
  selectWord('fifth'); mouseup();
  await wait(30);
  selectWord('fifth'); mouseup();
  await wait(30);
  selectParagraph(); mouseup();
  expect(sent).toEqual([]);
  await wait(320);
  expect(sent).toEqual([PARA]);
  expect(popupText()).toBe('译:' + PARA);
});

test('mouseups far enough apart each translate their own selection', async () => {
  selectWord('fifth'); mouseup();
  await wait(320);
  expect(popupText()).toBe('译:fifth');
  selectParagraph(); mouseup();
  await wait(320);
  expect(sent).toEqual(['fifth', PARA]);
  expect(popupText()).toBe('译:' + PARA);
});
