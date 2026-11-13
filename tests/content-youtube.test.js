/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.youtube.com/watch?v=abc"}
 */
'use strict';

// YouTube 观看页：测试者报播放器上的提示文字被翻，译文叠在画面上。播放器
// 整块不翻；标题和简介在播放器外，照常翻。

const fs = require('fs');
const path = require('path');

let fns;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body; },
  });
  global.browser = {
    storage: { local: { get: () => Promise.resolve({ targetLang: 'zh-CN', engine: 'google' }) } },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => Promise.resolve({ success: true, translation: '测试翻译' }),
    },
    i18n: require('./i18n-stub').i18n,
  };
  global.__yllTestMode = true;
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);
  fns = global.__yllInternals;
});

function renderWatch() {
  document.body.innerHTML = `
    <ytd-player>
      <div id="movie_player" class="html5-video-player">
        <div class="ytp-tooltip"><p class="ytp-tooltip-text">Press K to pause the video at any time</p></div>
        <p class="ytp-caption-segment">Welcome back to the channel, today we cook dinner</p>
      </div>
    </ytd-player>
    <h1 id="title">How to cook a simple dinner for four people</h1>
    <p id="desc">In this video we cook a simple dinner for four people in thirty minutes.</p>`;
}

test('text inside the YouTube player is not collected', () => {
  renderWatch();
  const blocks = fns.collectBlocks();
  expect(blocks.some(b => b.closest('#movie_player'))).toBe(false);
  expect(blocks).toContain(document.getElementById('desc'));
});
