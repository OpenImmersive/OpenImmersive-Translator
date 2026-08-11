/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://x.com/home"}
 */
'use strict';

// X 页面适配（v1.14.0）。用户报的两件事：
//   ① 中间推文是「整篇翻译」不是逐段——正文全在一个 div 里，靠 <br> 分段；
//   ② 两侧只有少部分被翻——右栏在 <main> 里逃过了 nav/aside 过滤，长词条翻、
//      短词条不翻，看起来像随机挑着翻。
// 参照沉浸式翻译：两侧一律不翻，中间按段翻。

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
  };
  global.__yllTestMode = true;

  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);
  fns = global.__yllInternals;
});

// X 的真实骨架：几乎每层都套着 role="link"/"button"/"group"，正文块是
// div[data-testid="tweetText"]，右栏 sidebarColumn 在 <main> 里面。
function renderTimeline() {
  document.body.innerHTML = `
    <header role="banner">
      <nav role="navigation" aria-label="Primary">
        <div role="link"><span>Explore what is happening right now</span></div>
        <div role="link"><span>Subscribe to Premium and get more features</span></div>
      </nav>
    </header>
    <main role="main">
      <div data-testid="primaryColumn">
        <div role="tablist">
          <div role="tab"><span>For you</span></div>
          <div role="tab"><span>Following</span></div>
        </div>
        <article role="article">
          <div role="group">
            <div data-testid="tweetText" dir="auto">
              <span>Shipping is a skill you practise, not a talent you have.</span><br><br>
              <span>Most teams stall because they polish, not because they lack ideas.</span><br><br>
              <span>Cut the scope, ship it, learn from real users.</span>
            </div>
          </div>
        </article>
        <article role="article">
          <div role="group">
            <div data-testid="tweetText" dir="auto">
              <span>One single line of thought with nothing to split.</span>
            </div>
          </div>
        </article>
      </div>
      <div data-testid="sidebarColumn">
        <section role="region" aria-label="Trending">
          <div role="link"><span>Trending in Technology</span></div>
          <div role="link"><span>Artificial Intelligence and the future of work</span></div>
          <div role="link"><span>Who to follow on this platform right now</span></div>
        </section>
      </div>
    </main>
  `;
}

beforeEach(renderTimeline);

describe('两侧不翻', () => {
  test('右栏（趋势/推荐关注）一条都不进翻译队列', () => {
    const texts = fns.collectBlocks().map((el) => fns.extractText(el).trim());
    expect(texts.join(' | ')).not.toMatch(/Trending|Artificial Intelligence|Who to follow/);
  });

  test('左侧导航一条都不进翻译队列', () => {
    const texts = fns.collectBlocks().map((el) => fns.extractText(el).trim());
    expect(texts.join(' | ')).not.toMatch(/Explore what is happening|Subscribe to Premium/);
  });

  // 这是「两侧只有少部分被翻」的根因：closest() 命中的是里层无害的
  // role="link"，外面真正的 <nav> 再也问不到了。
  test('内层 role="link" 不再挡住外层 nav 的判定', () => {
    const inner = document.querySelector('header [role="link"] span');
    expect(fns.shouldTranslate(inner)).toBe(false);
  });

  test('「For you / Following」标签条不翻', () => {
    const tab = document.querySelector('[role="tab"] span');
    expect(fns.shouldTranslate(tab)).toBe(false);
  });
});

describe('推文逐段', () => {
  test('三段推文切成三个块，不是一整坨', () => {
    const blocks = fns.collectBlocks();
    const tweetBlocks = blocks.filter((el) => el.closest('[data-testid="tweetText"]'));
    const texts = tweetBlocks.map((el) => fns.extractText(el).trim());
    expect(texts).toContain('Shipping is a skill you practise, not a talent you have.');
    expect(texts).toContain('Most teams stall because they polish, not because they lack ideas.');
    expect(texts).toContain('Cut the scope, ship it, learn from real users.');
    // 三段各自成块，没有任何一个块横跨两段
    expect(texts.some((t) => t.includes('practise') && t.includes('polish'))).toBe(false);
  });

  test('单段推文不切，仍按整块翻', () => {
    const single = document.querySelectorAll('[data-testid="tweetText"]')[1];
    expect(fns.splitTweetParagraphs(single)).toEqual([]);
    const blocks = fns.collectBlocks();
    expect(blocks).toContain(single);
  });

  test('段与段之间的空行（<br>）不会被吞掉', () => {
    const tweet = document.querySelector('[data-testid="tweetText"]');
    fns.splitTweetParagraphs(tweet);
    expect(tweet.querySelectorAll('br').length).toBe(4);
  });

  test('重复调用不会把同一条推文切两遍', () => {
    const tweet = document.querySelector('[data-testid="tweetText"]');
    const first = fns.splitTweetParagraphs(tweet);
    const second = fns.splitTweetParagraphs(tweet);
    expect(second).toEqual(first);
    expect(tweet.querySelectorAll('[data-yll-para]').length).toBe(3);
  });
});

describe('恢复原文', () => {
  test('译文和包段的壳都拆干净，推文回到原样', () => {
    const tweet = document.querySelector('[data-testid="tweetText"]');
    const before = tweet.innerHTML;

    const blocks = fns.collectBlocks().filter((el) => tweet.contains(el));
    expect(blocks.length).toBe(3);
    for (const el of blocks) fns.injectTranslation(el, '测试译文');
    expect(tweet.querySelectorAll('[data-yll-inject]').length).toBe(3);

    fns.removeTranslations();
    expect(tweet.innerHTML).toBe(before);
    expect(document.querySelectorAll('[data-yll-para]').length).toBe(0);
  });
});
