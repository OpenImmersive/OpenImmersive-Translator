/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.reddit.com/r/programming/"}
 */
'use strict';

// Reddit 列表页：测试者报帖子标题（首屏和滚动加载的）都不翻、摘要照翻。
// 新版 Reddit 的标题是 shreddit-post 里块级的 <a slot="title">，不在通用的
// 块选择器里。帖子页的标题是 <h1>，本来就翻。

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
  global.YLSensitive = require('../sensitive-mask.js');
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'));
  fns = global.__yllInternals;
});

// 2026-10 的 shreddit 列表页骨架（标题在 shreddit-post 的默认 slot 里的 div 中）
function post(id, title, excerpt) {
  return `
    <article><shreddit-post id="t3_${id}">
      <a slot="full-post-link" href="/r/programming/comments/${id}/"><faceplate-screen-reader-content>${title}</faceplate-screen-reader-content></a>
      <div>
        <a href="/r/programming/comments/${id}/" id="post-title-t3_${id}" slot="title" class="block font-semibold">${title}</a>
        <div slot="text-body"><p>${excerpt}</p></div>
      </div>
    </shreddit-post></article>`;
}

test('post titles on a listing page are translation blocks, like their excerpts', () => {
  document.body.innerHTML = `<main>${post('a1', 'I miss the part of programming where I figure it out myself', 'Lately every problem gets solved before I even think about it.')}</main>`;
  const ids = fns.collectBlocks().map(b => b.id || b.tagName);
  expect(ids).toContain('post-title-t3_a1');
  expect(ids).toContain('P');
});

test('titles of posts loaded while scrolling are found in the new subtree', () => {
  document.body.innerHTML = '<main><div id="feed"></div></main>';
  const feed = document.getElementById('feed');
  feed.insertAdjacentHTML('beforeend', post('b2', 'Why does my build get slower every week', 'The cache keeps growing and nobody cleans it.'));
  const ids = fns.collectBlocks(feed.lastElementChild).map(b => b.id || b.tagName);
  expect(ids).toContain('post-title-t3_b2');
});

test('the translation of a title sits right after it and keeps its slot', () => {
  document.body.innerHTML = `<main>${post('c3', 'A title long enough to be translated here', 'Excerpt text for the post body.')}</main>`;
  const a = document.getElementById('post-title-t3_c3');
  fns.injectTranslation(a, '一个足够长的标题');
  expect(a.nextElementSibling.dataset.yllInject).toBe('1');
  expect(a.nextElementSibling.slot).toBe('title');
});
