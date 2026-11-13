/**
 * @jest-environment jsdom
 */
'use strict';

// 动态页面：翻译后新插入的内容、站内跳转（SPA）、视口优先与进度条。
// 测试者在 X / Reddit / 长维基页上报的四件事，这里按机制逐条断言。

const fs = require('fs');
const path = require('path');

let fns;
let send;           // 当前的 sendMessage 实现，用例可替换
let sent;           // 本用例发出去的原文
let storageListener;
let ioInstances;
let engine;         // 设置里的引擎；免费 Google 会把短块拼成一个请求

// 引擎逐行翻译（真实引擎把换行原样带回）；sent 按块记，拼包的请求拆开记
const tr = (text) => text.split('\n').map(l => '译:' + l).join('\n');
const record = (m) => { sent.push(...m.text.split('\n')); messages.push(m.text); };
let messages;       // 本用例发出去的请求（拼包后一包一条）

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const BATCH = 400;  // > MUTATION_BATCH_MS

// 可手动触发的 IntersectionObserver：jsdom 没有布局，靠用例说哪个块「滚到了」
class FakeIO {
  constructor(cb, opts) { this.cb = cb; this.opts = opts || {}; this.targets = new Set(); ioInstances.push(this); }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}

function scrollIntoReach(el) {
  for (const io of ioInstances) {
    if (io.targets.has(el)) io.cb([{ target: el, isIntersecting: true }]);
  }
}

function offscreen(el) {
  el.getBoundingClientRect = () => ({ top: 5000, bottom: 5040, left: 0, right: 100, width: 100, height: 40 });
  return el;
}

// jsdom 的默认盒子全是 0，零边距的「此刻可见」判不进去；要断言可视块的行为就显式摆进视口
function onscreen(el) {
  el.getBoundingClientRect = () => ({ top: 100, bottom: 140, left: 0, right: 100, width: 100, height: 40 });
  return el;
}

function para(text, opts = {}) {
  const p = document.createElement('p');
  p.textContent = text;
  if (opts.offscreen) offscreen(p);
  if (opts.onscreen) onscreen(p);
  return p;
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body; }
  });
  global.IntersectionObserver = FakeIO;

  global.browser = {
    storage: {
      local: { get: () => Promise.resolve({ targetLang: 'zh-CN', engine }) },
      onChanged: { addListener: (fn) => { storageListener = fn; } }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (m) => send(m)
    },
    i18n: require('./i18n-stub').i18n
  };
  global.__yllTestMode = true;

  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);
  fns = global.__yllInternals;
});

beforeEach(() => {
  fns.removeTranslations();
  fns.clearMemo();
  ioInstances = [];
  sent = [];
  messages = [];
  engine = 'google';
  send = (m) => {
    if (m.type === 'translate') record(m);
    return Promise.resolve({ success: true, translation: tr(m.text) });
  };
  document.body.innerHTML = '<main id="main"></main>';
});

function main() { return document.getElementById('main'); }

function translationOf(el) {
  const next = el.nextElementSibling;
  return next && next.dataset.yllInject ? next.textContent : null;
}

// ─── 1. 翻译后新增的内容 ──────────────────────────────────────────────────────

describe('content added after translation', () => {
  test('a block added while translated gets translated', async () => {
    main().appendChild(para('The first paragraph was here before translation started.'));
    await fns.translatePage();
    expect(fns.state.isTranslated).toBe(true);

    const added = para('A new tweet arrived after the page was already translated.');
    main().appendChild(added);
    await wait(BATCH);

    expect(added.dataset.yllDone).toBe('1');
    expect(translationOf(added)).toBe('译:A new tweet arrived after the page was already translated.');
  });

  test('nothing is translated after the page is restored', async () => {
    main().appendChild(para('The first paragraph was here before translation started.'));
    await fns.translatePage();
    fns.removeTranslations();
    sent = [];

    const added = para('This one arrives after the user switched back to the original.');
    main().appendChild(added);
    await wait(BATCH);

    expect(added.dataset.yllDone).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test('our own inserted translations do not trigger more requests', async () => {
    for (let i = 0; i < 5; i++) main().appendChild(para(`Paragraph number ${i} has enough words to translate.`));
    await fns.translatePage();
    await wait(BATCH * 2);
    const before = sent.length;
    await wait(BATCH * 2);

    expect(before).toBe(5);
    expect(sent.length).toBe(before);
  });

  test('offscreen added blocks wait until they scroll near the viewport', async () => {
    main().appendChild(para('The first paragraph was here before translation started.'));
    await fns.translatePage();

    const far = para('Far below the fold, nobody has scrolled to this one yet.', { offscreen: true });
    main().appendChild(far);
    await wait(BATCH);
    expect(far.dataset.yllDone).toBeUndefined();
    expect(sent).not.toContain(far.textContent);

    scrollIntoReach(far);
    await wait(0);
    expect(far.dataset.yllDone).toBe('1');
  });

  test('a recycled node whose text changed is re-translated, not left with the old translation', async () => {
    const p = para('Original text of a list item that React will recycle later.');
    main().appendChild(p);
    await fns.translatePage();
    expect(translationOf(p)).toBe('译:Original text of a list item that React will recycle later.');

    p.firstChild.nodeValue = 'Completely different content now lives in the same node.';
    await wait(BATCH);

    expect(translationOf(p)).toBe('译:Completely different content now lives in the same node.');
    expect(main().querySelectorAll('[data-yll-inject]').length).toBe(1);
  });

  test('a translation whose source node was removed does not linger', async () => {
    const p = para('This item will be removed by the page framework soon.');
    main().appendChild(p);
    await fns.translatePage();
    expect(main().querySelectorAll('[data-yll-inject]').length).toBe(1);

    p.remove();
    await wait(BATCH);

    expect(main().querySelectorAll('[data-yll-inject]').length).toBe(0);
  });
});

// ─── 2. 站内跳转 ──────────────────────────────────────────────────────────────

describe('in-site navigation', () => {
  afterEach(() => { history.replaceState(null, '', '/'); });

  test('a URL change resets the per-page counts and translates the new page', async () => {
    main().appendChild(para('Timeline item one has a sentence worth translating.'));
    main().appendChild(para('Timeline item two has another sentence to translate.'));
    await fns.translatePage();
    expect(fns.state.translatedCount).toBe(2);

    history.pushState(null, '', '/status/123');
    main().innerHTML = '';
    main().appendChild(para('The opened post shows its full text on a new route.'));
    main().appendChild(para('A reply under the post is also part of the new page.'));
    await wait(1200);

    expect(fns.state.pageKey).toBe(location.href);
    expect(fns.state.isTranslated).toBe(true);
    expect(fns.state.translatedCount).toBe(2);
    for (const p of main().querySelectorAll('p')) expect(p.dataset.yllDone).toBe('1');
  });

  test('a node that kept a stale translated flag across navigation is translated again', async () => {
    const p = para('Post title on the list page before the user opens it.');
    main().appendChild(p);
    await fns.translatePage();
    // 框架换页时只摘掉了我们的译文、复用了节点并换了文字：标记还在
    main().querySelectorAll('[data-yll-inject]').forEach(n => n.remove());

    history.pushState(null, '', '/r/sub/comments/abc');
    p.textContent = 'The post page reuses this node for the post body text.';
    await wait(1200);

    expect(translationOf(p)).toBe('译:The post page reuses this node for the post body text.');
  });

  test('a hash-only change is not a new page', async () => {
    main().appendChild(para('Section one of a long article with an in-page link.'));
    await fns.translatePage();
    const key = fns.state.pageKey;

    history.pushState(null, '', '#section-2');
    main().appendChild(para('Lazy content that shows up next to the section anchor.'));
    await wait(1200);

    expect(fns.state.pageKey).toBe(key);
    expect(fns.state.translatedCount).toBe(2);
  });

  test('"always translate this site" also translates after in-site navigation', async () => {
    storageListener({ autoTranslateSites: { newValue: [location.hostname] } }, 'local');
    expect(fns.state.isTranslated).toBe(false);

    history.pushState(null, '', '/another/route');
    main().appendChild(para('Content of a route reached without a full page load.'));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await wait(1100);

    expect(fns.state.isTranslated).toBe(true);
    expect(main().querySelector('p').dataset.yllDone).toBe('1');
    storageListener({ autoTranslateSites: { newValue: [] } }, 'local');
  });
});

// ─── 4. 视口优先、进度条只等可视区 ────────────────────────────────────────────

describe('viewport-first translation', () => {
  test('visible blocks go first and the progress bar hides once they are done', async () => {
    const far = [];
    for (let i = 0; i < 6; i++) far.push(para(`Offscreen paragraph ${i} further down the article body.`, { offscreen: true }));
    const near = [];
    for (let i = 0; i < 3; i++) near.push(para(`Visible paragraph ${i} at the top of the article.`, { onscreen: true }));
    // 文档序里视口外的块排在前面，确认顺序是按位置不是按文档序
    far.slice(0, 3).forEach(p => main().appendChild(p));
    near.forEach(p => main().appendChild(p));
    far.slice(3).forEach(p => main().appendChild(p));

    const held = [];
    send = (m) => {
      record(m);
      if (m.text.startsWith('Offscreen')) {
        return new Promise(r => held.push(() => r({ success: true, translation: tr(m.text) })));
      }
      return Promise.resolve({ success: true, translation: tr(m.text) });
    };

    await fns.translatePage();

    expect(sent.slice(0, 3).every(t => t.startsWith('Visible'))).toBe(true);
    expect(near.every(p => p.dataset.yllDone === '1')).toBe(true);
    expect(fns.state.isTranslating).toBe(false);
    expect(fns.state.isTranslated).toBe(true);
    await wait(700);
    expect(document.getElementById('yll-progress').style.display).toBe('none');

    // 远处的块不在后台排队：滚到哪翻到哪
    expect(held.length).toBe(0);
    expect(sent.some(t => t.startsWith('Offscreen'))).toBe(false);
    far.forEach(scrollIntoReach);
    await wait(0);
    expect(held.length).toBeLessThanOrEqual(4);
    while (held.length) { held.shift()(); await wait(0); }
    await wait(0);
    expect(far.every(p => p.dataset.yllDone === '1')).toBe(true);
    expect(document.getElementById('yll-progress').style.display).toBe('none');
  });

  test('far blocks are translated only when they come near the viewport, nearby ones right away', async () => {
    const nearRect = () => ({ top: 1500, bottom: 1540, left: 0, right: 100, width: 100, height: 40 });
    const top = para('The lead paragraph sits at the top of the article.', { onscreen: true });
    const next = para('The next screen down is translated without waiting.');
    next.getBoundingClientRect = nearRect;
    const refs = [];
    for (let i = 0; i < 5; i++) refs.push(para(`Reference ${i}: Bolton, S. J. (2017). Jupiter's interior.`, { offscreen: true }));
    [top, next, ...refs].forEach(p => main().appendChild(p));

    await fns.translatePage();
    await wait(0);
    expect(sent).toEqual([top.textContent, next.textContent]);
    expect(refs.some(p => p.dataset.yllDone)).toBe(false);

    // 一屏半的余量交给 IntersectionObserver
    expect(ioInstances.some(io => io.targets.has(refs[0]) && io.opts.rootMargin === '150% 100%')).toBe(true);
    scrollIntoReach(refs[2]);
    await wait(0);
    expect(sent.slice(2)).toEqual([refs[2].textContent]);
    expect(refs[2].dataset.yllDone).toBe('1');
    expect(fns.state.totalCount).toBe(7);
  });

  test('a block scrolled into view jumps ahead of blocks queued earlier', async () => {
    engine = 'microsoft'; // 不拼包：一块一个请求，才看得出谁先发
    const nearRect = () => ({ top: 1000, bottom: 1040, left: 0, right: 100, width: 100, height: 40 });
    for (let i = 0; i < 8; i++) {
      const p = para(`Just-below-the-fold paragraph ${i} queued early on.`);
      p.getBoundingClientRect = nearRect;
      main().appendChild(p);
    }
    const far = para('Middle-of-article paragraph the reader just scrolled to.', { offscreen: true });
    main().appendChild(far);

    const held = [];
    send = (m) => {
      record(m);
      return new Promise(r => held.push(() => r({ success: true, translation: tr(m.text) })));
    };
    const pending = fns.translatePage();
    await wait(0);
    expect(sent.length).toBe(4);

    scrollIntoReach(far);
    held.shift()();
    await wait(0);

    expect(sent[4]).toBe(far.textContent);
    while (held.length) { held.shift()(); await wait(0); }
    await pending;
  });

  test('with nothing translatable in view, the call waits for the page instead of reporting 0', async () => {
    for (let i = 0; i < 2; i++) main().appendChild(para(`Below-the-fold paragraph ${i} after a big hero image.`, { offscreen: true }));

    const resp = await fns.translatePage();

    expect(resp).toBeUndefined();
    expect(fns.state.translatedCount).toBe(2);
    expect(fns.state.isTranslated).toBe(true);
  });
});

// ─── 正文先于界面 ────────────────────────────────────────────────────────────

describe('main content goes first', () => {
  function hold() {
    const held = [];
    send = (m) => {
      record(m);
      return new Promise(r => held.push(() => r({ success: true, translation: tr(m.text) })));
    };
    return held;
  }
  async function drain(held, pending) {
    while (held.length) { held.shift()(); await wait(0); }
    await pending;
  }

  test('visible article blocks start before visible sidebar blocks that come first in the document', async () => {
    document.body.innerHTML = '<div id="side"></div><main id="main"><article id="art"></article></main>';
    const side = document.getElementById('side');
    const art = document.getElementById('art');
    for (let i = 0; i < 5; i++) side.appendChild(para(`Sidebar link text number ${i} that is long enough.`, { onscreen: true }));
    for (let i = 0; i < 2; i++) art.appendChild(para(`Article body paragraph ${i} that the reader came for.`, { onscreen: true }));

    const held = hold();
    const pending = fns.translatePage();
    await wait(0);

    expect(sent.slice(0, 2).every(t => t.startsWith('Article'))).toBe(true);
    await drain(held, pending);
  });

  test('offscreen README text is queued before offscreen page chrome inside <main>', async () => {
    document.body.innerHTML = '<main id="main"><div id="meta"></div><div class="markdown-body" id="readme"></div></main>';
    const meta = document.getElementById('meta');
    const readme = document.getElementById('readme');
    for (let i = 0; i < 6; i++) meta.appendChild(para(`Repository sidebar entry ${i} with some words.`, { offscreen: true }));
    for (let i = 0; i < 2; i++) readme.appendChild(para(`README paragraph ${i} explains the project.`, { offscreen: true }));

    const held = hold();
    const pending = fns.translatePage();
    await wait(0);

    expect(sent.slice(0, 2).every(t => t.startsWith('README'))).toBe(true);
    await drain(held, pending);
  });

  // 维基条目：<main> 里没有 article；信息框在文档里排在首段之前
  test('body paragraphs start before headings, and headings before infobox cells', async () => {
    document.body.innerHTML = '<main id="main"><h1 id="title"></h1><table class="infobox"><tbody id="box"></tbody></table><section id="body"></section></main>';
    onscreen(document.getElementById('title')).textContent = 'Saturn planet article';
    const box = document.getElementById('box');
    for (let i = 0; i < 6; i++) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th>Orbital characteristic ${i}</th><td>Mean anomaly value ${i}</td>`;
      tr.querySelectorAll('th, td').forEach(onscreen);
      box.appendChild(tr);
    }
    const body = document.getElementById('body');
    for (let i = 0; i < 2; i++) body.appendChild(para(`Saturn paragraph ${i} is the sixth planet from the Sun.`, { onscreen: true }));
    const h2 = onscreen(document.createElement('h2'));
    h2.textContent = 'Physical characteristics';
    body.appendChild(h2);

    const held = hold();
    const pending = fns.translatePage();
    await wait(0);

    expect(sent.slice(0, 2).every(t => t.startsWith('Saturn paragraph'))).toBe(true);
    expect(sent.slice(2, 4).sort()).toEqual(['Physical characteristics', 'Saturn planet article']);
    await drain(held, pending);
    expect(sent.slice(4).every(t => /^(Orbital|Mean)/.test(t))).toBe(true);
  });

  test('a page without article or main ranks the container holding the most paragraph text first', async () => {
    document.body.innerHTML = '<div id="menu"></div><div id="story"></div>';
    const menu = document.getElementById('menu');
    const story = document.getElementById('story');
    for (let i = 0; i < 5; i++) menu.appendChild(para(`Menu entry ${i} for the site.`, { onscreen: true }));
    for (let i = 0; i < 3; i++) story.appendChild(para(`Story paragraph ${i} carries the long body text of this page, sentence after sentence.`, { onscreen: true }));

    const held = hold();
    const pending = fns.translatePage();
    await wait(0);

    expect(sent.slice(0, 3).every(t => t.startsWith('Story'))).toBe(true);
    await drain(held, pending);
  });
});

// ─── 队列总会排空，进度条总会收起 ──────────────────────────────────────────────

describe('a request that never answers', () => {
  afterEach(() => { fns.setBlockTimeout(60000); });

  test('fails that block, frees its slot, and still finishes the page and hides the bar', async () => {
    engine = 'microsoft'; // 不拼包：一块一个请求
    fns.setBlockTimeout(50);
    const blocks = [];
    for (let i = 0; i < 6; i++) blocks.push(para(`Visible paragraph ${i} of a long documentation page.`, { onscreen: true }));
    blocks.forEach(p => main().appendChild(p));
    send = (m) => {
      record(m);
      // 前四块挂住、占满并发：没有超时的话后两块永远轮不到
      if (sent.length <= 4) return new Promise(() => {});
      return Promise.resolve({ success: true, translation: tr(m.text) });
    };

    await fns.translatePage();
    await wait(700);

    expect(fns.state.isTranslating).toBe(false);
    expect(fns.state.failedCount).toBe(4);
    expect(fns.state.lastError).toBeTruthy();
    expect(blocks.slice(4).every(p => p.dataset.yllDone === '1')).toBe(true);
    expect(document.getElementById('yll-progress').style.display).toBe('none');
  });
});

// ─── 不会被一直在变的块拖进循环 ──────────────────────────────────────────────

describe('loop guards', () => {
  test('a block whose text keeps changing stops being re-translated after a few rounds', async () => {
    const p = para('Sale ends in 10 seconds, grab the discount while it lasts.');
    main().appendChild(p);
    await fns.translatePage();

    for (let i = 9; i > 0; i--) {
      p.firstChild.nodeValue = `Sale ends in ${i} seconds, grab the discount while it lasts.`;
      await wait(BATCH);
    }

    expect(sent.length).toBeLessThanOrEqual(1 + 5);
  });
});

// ─── 免费 Google：短块拼成一个请求 ────────────────────────────────────────────

describe('packing short blocks into one Google request', () => {
  // 视口下面一屏之内：这一轮就排进来，但不是进度条等着的首屏块
  const belowFold = (el) => { el.getBoundingClientRect = () => ({ top: 1500, bottom: 1540, left: 0, right: 100, width: 100, height: 40 }); return el; };
  const ref = (i, extra = '') => belowFold(para(`Reference ${i}: Bolton, S. J. (2017). Jupiter's interior.${extra}`));

  test('short blocks below the fold go out as one request, one line each, and each gets its own line back', async () => {
    const ps = Array.from({ length: 5 }, (_, i) => ref(i));
    ps.forEach(p => main().appendChild(p));
    await fns.translatePage();
    expect(messages).toEqual([ps.map(p => p.textContent).join('\n')]);
    ps.forEach(p => expect(translationOf(p)).toBe('译:' + p.textContent));
  });

  test('a pack holds at most 10 blocks and 1800 characters', async () => {
    Array.from({ length: 25 }, (_, i) => ref(i)).forEach(p => main().appendChild(p));
    await fns.translatePage();
    expect(messages.map(m => m.split('\n').length)).toEqual([10, 10, 5]);

    fns.removeTranslations();
    main().innerHTML = '';
    messages = [];
    Array.from({ length: 5 }, (_, i) => ref(i, ' Long tail.'.repeat(70))).forEach(p => main().appendChild(p));
    await fns.translatePage();
    expect(messages.every(m => m.length <= 1800)).toBe(true);
    expect(messages.map(m => m.split('\n').length)).toEqual([2, 2, 1]);
  });

  test('visible blocks are packed only with each other, spread over the free request slots', async () => {
    const vis = Array.from({ length: 8 }, (_, i) => para(`Visible title ${i} on the first screen.`, { onscreen: true }));
    const refs = Array.from({ length: 12 }, (_, i) => ref(i));
    [...refs, ...vis].forEach(p => main().appendChild(p));
    const held = [];
    send = (m) => { record(m); return new Promise(r => held.push(() => r({ success: true, translation: tr(m.text) }))); };
    const pending = fns.translatePage();
    await wait(0);
    expect(messages.map(m => m.split('\n').length)).toEqual([2, 2, 2, 2]);
    expect(messages.join('\n').split('\n').sort()).toEqual(vis.map(p => p.textContent).sort());
    while (held.length) { held.shift()(); await wait(0); }
    await pending;
    await wait(0);
    while (held.length) { held.shift()(); await wait(0); }
    expect(messages.slice(4).map(m => m.split('\n').length)).toEqual([10, 2]);
    [...vis, ...refs].forEach(p => expect(translationOf(p)).toBe('译:' + p.textContent));
  });

  test('a single visible block goes out alone, not in a pack of blocks below the fold', async () => {
    const title = para('The only post title on the first screen.', { onscreen: true });
    main().appendChild(title);
    Array.from({ length: 20 }, (_, i) => ref(i)).forEach(p => main().appendChild(p));
    await fns.translatePage();
    expect(messages[0]).toBe(title.textContent);
    expect(messages.slice(1).map(m => m.split('\n').length)).toEqual([10, 10]);
  });

  test('a pack stays within 1800 characters after the background swaps acronyms for placeholders', async () => {
    const S = require('../sensitive-mask.js');
    global.YLSensitive = S;
    try {
      // 每块约 170 字，十块拼起来 1,700 多字；缩写换成 __PII_ACRO_n__ 后每块多出近百字
      const acr = 'NASA JPL ESA GPU CPU LLM API SDK HTTP JSON ';
      const ps = Array.from({ length: 10 }, (_, i) => ref(i, ` ${acr}notes from the mission archive ${i}.`.padEnd(120, ' x').trimEnd()));
      ps.forEach(p => main().appendChild(p));
      expect(ps.map(p => p.textContent).join('\n').length).toBeLessThanOrEqual(1800);
      await fns.translatePage();
      expect(messages.length).toBeGreaterThan(1);
      for (const m of messages) expect(S.keepAcronyms(m).text.length).toBeLessThanOrEqual(1800);
      ps.forEach(p => expect(translationOf(p)).toBe('译:' + p.textContent));
    } finally {
      delete global.YLSensitive;
    }
  });

  test('when the engine merges lines, the pack is re-sent one block per request', async () => {
    const ps = Array.from({ length: 3 }, (_, i) => ref(i));
    ps.forEach(p => main().appendChild(p));
    send = (m) => {
      record(m);
      const lines = m.text.split('\n');
      // 引擎把前两行并成一行：行数对不上
      const out = lines.length > 1 ? [lines[0] + ' ' + lines[1], ...lines.slice(2)] : lines;
      return Promise.resolve({ success: true, translation: tr(out.join('\n')) });
    };
    await fns.translatePage();
    expect(messages.slice(1)).toEqual(ps.map(p => p.textContent));
    ps.forEach(p => expect(translationOf(p)).toBe('译:' + p.textContent));
  });

  test('a block with its own line breaks is not packed', async () => {
    const p1 = ref(1);
    const p2 = belowFold(para('First line of a description\nsecond line of the same block.'));
    [p1, p2].forEach(p => main().appendChild(p));
    await fns.translatePage();
    expect(messages).toEqual([p1.textContent, p2.textContent]);
  });

  test('other engines send one block per request', async () => {
    engine = 'microsoft';
    Array.from({ length: 3 }, (_, i) => ref(i)).forEach(p => main().appendChild(p));
    await fns.translatePage();
    expect(messages.length).toBe(3);
  });

  test('no more than four requests are in flight', async () => {
    Array.from({ length: 60 }, (_, i) => ref(i)).forEach(p => main().appendChild(p));
    const held = [];
    send = (m) => { record(m); return new Promise(r => held.push(() => r({ success: true, translation: tr(m.text) }))); };
    const pending = fns.translatePage();
    await wait(0);
    expect(messages.length).toBe(4);
    while (held.length) { held.shift()(); await wait(0); }
    await pending;
    expect(messages.length).toBe(6);
    expect(main().querySelectorAll('[data-yll-inject]').length).toBe(60);
  });

  test('a pack that never answers fails its blocks and frees its slot', async () => {
    fns.setBlockTimeout(50);
    const ps = Array.from({ length: 3 }, (_, i) => ref(i));
    ps.forEach(p => main().appendChild(p));
    send = (m) => { record(m); return messages.length === 1 ? new Promise(() => {}) : Promise.resolve({ success: true, translation: tr(m.text) }); };
    await fns.translatePage();
    expect(fns.state.failedCount).toBe(3);
    fns.setBlockTimeout(60000);

    // 名额已让出：重试照常发出去
    await fns.translatePage();
    expect(messages.length).toBe(2);
    ps.forEach(p => expect(translationOf(p)).toBe('译:' + p.textContent));
  });
});

// ─── 长块切段并发 ────────────────────────────────────────────────────────────

describe('long blocks are split into parts sent side by side', () => {
  const sentence = (i) => `Sentence number ${i} of a very long video description that keeps going on. `;
  const long = (n) => Array.from({ length: n }, (_, i) => sentence(i)).join('').trim();

  test('a 3,300-character block goes out as parts of at most 1,000 characters, all in flight at once, joined in order', async () => {
    engine = 'microsoft';
    const p = para(long(46), { onscreen: true });
    expect(p.textContent.length).toBeGreaterThan(3300);
    main().appendChild(p);
    const held = [];
    send = (m) => { record(m); return new Promise(r => held.push(() => r({ success: true, translation: tr(m.text) }))); };
    const pending = fns.translatePage();
    await wait(0);
    expect(messages.length).toBe(4);
    expect(messages.every(m => m.length <= 1000)).toBe(true);
    expect(messages.join(' ')).toBe(p.textContent);
    // 倒着回答：拼回去的顺序跟原文走，不跟到达顺序走
    while (held.length) { held.pop()(); await wait(0); }
    await pending;
    // 目标是中文：句与句之间不留空格
    expect(translationOf(p)).toBe(messages.map(m => '译:' + m).join(''));
  });

  test('line breaks between parts are kept; Chinese targets get no space between sentences', async () => {
    engine = 'microsoft';
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}: subscribe, follow and support the channel here`);
    const p = para(lines.join('\n'), { onscreen: true });
    main().appendChild(p);
    await fns.translatePage();
    expect(messages.length).toBeGreaterThan(1);
    expect(translationOf(p)).toBe(lines.map(l => '译:' + l).join('\n'));
  });

  test('spaced target languages keep one space between parts', async () => {
    engine = 'microsoft';
    const p = para(long(46), { onscreen: true });
    main().appendChild(p);
    const get = global.browser.storage.local.get;
    global.browser.storage.local.get = () => Promise.resolve({ targetLang: 'fr', engine });
    try { await fns.translatePage(); } finally { global.browser.storage.local.get = get; }
    expect(translationOf(p)).toBe(messages.map(m => '译:' + m).join(' '));
  });

  test('AI engines get the long block whole', async () => {
    engine = 'openai';
    const p = para(long(44), { onscreen: true });
    main().appendChild(p);
    await fns.translatePage();
    expect(messages).toEqual([p.textContent]);
  });

  test('a part boundary never falls between a pair of link markers', () => {
    const text = 'A'.repeat(900) + '. <a1>Washington, D.C. is the capital. It is on the river.</a1> ' + 'B'.repeat(300) + '.';
    const parts = fns.splitLong(text);
    expect(parts.join('')).toBe(text);
    expect(parts.some(p => p.includes('<a1>') !== p.includes('</a1>'))).toBe(false);
  });
});

// ─── 官网 AI 档被拒（401/402）：第一次就停 ─────────────────────────────────

describe('an AI-tier account refusal stops the page', () => {
  const refuse = (code) => (m) => {
    if (m.type === 'translate') record(m);
    return Promise.resolve({ success: false, error: 'Log in or sign up free', code });
  };

  test('a refusal in a split paragraph stops dispatch before all parts finish', async () => {
    engine = 'microsoft';
    send = refuse('login_required');
    main().appendChild(para(Array.from({length:100},(_,i)=>`This is sentence ${i} in a long paragraph that must stop when authentication fails.`).join(' '), {onscreen:true}));
    await fns.translatePage();
    expect(messages.length).toBeLessThanOrEqual(4);
    expect(fns.state.isTranslated).toBe(false);
  });

  test('an old login refusal cannot halt a new translation session', async () => {
    engine = 'oi-standard';
    let finishOld;
    send = m => { record(m); return new Promise(resolve => { finishOld=resolve; }); };
    main().appendChild(para('A paragraph from the previous translation session.', {onscreen:true}));
    const old=fns.translatePage(); await wait(0);
    fns.removeTranslations();
    await old;
    main().replaceChildren(para('A fresh paragraph for the next translation session.', {onscreen:true}));
    send = m => { record(m); return Promise.resolve({success:true,translation:tr(m.text)}); };
    const fresh=fns.translatePage(); await wait(0);
    finishOld({success:false,code:'login_required',error:'Old login failure'});
    await Promise.all([old,fresh]);
    expect(fns.state.isTranslated).toBe(true);
    expect(document.querySelector('#yll-acct-notice')).toBeNull();
  });

  // 测试者的复现：一直在变的页面（每 300 ms 插一条），翻译后再没有请求出去
  test.each(['login_required', 'out_of_credits'])('%s: one in-flight batch, then nothing however much the page changes', async (code) => {
    engine = 'oi-standard';
    send = refuse(code);
    for (let i = 0; i < 10; i++) main().appendChild(para(`Paragraph ${i} of a page that keeps changing all the time.`));
    await fns.translatePage();
    const first = messages.length;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(4); // CONCURRENCY：最多是同时在途的那一批
    for (let i = 0; i < 10; i++) {
      main().appendChild(para(`Live update ${i} arrived on the constantly changing page.`));
      await wait(BATCH);
    }
    expect(messages.length).toBe(first);
    expect(fns.state.isTranslated).toBe(false);
    expect(fns.state.lastError).toBe('Log in or sign up free');
  });

  test('blocks that scroll near after the refusal are not sent', async () => {
    engine = 'oi-standard';
    send = refuse('login_required');
    main().appendChild(para('The only visible paragraph is refused by the site.', { onscreen: true }));
    const far = para('Far below the fold, this one would be next.', { offscreen: true });
    main().appendChild(far);
    await fns.translatePage();
    scrollIntoReach(far);
    await wait(BATCH);
    expect(messages).toEqual(['The only visible paragraph is refused by the site.']);
  });

  test('translating again (the user acts) sends again; an automatic retry does not', async () => {
    engine = 'oi-standard';
    send = refuse('login_required');
    main().appendChild(para('A paragraph the site refuses until the user signs in.'));
    await fns.translatePage();
    expect(messages.length).toBe(1);
    await fns.translatePage({ auto: true });
    expect(messages.length).toBe(1);
    await fns.translatePage();
    expect(messages.length).toBe(2);
  });

  test('switching the engine lifts the stop', async () => {
    engine = 'oi-standard';
    send = refuse('out_of_credits');
    main().appendChild(para('A paragraph that the free engine will translate fine.'));
    await fns.translatePage();
    engine = 'google';
    storageListener({ engine: { newValue: 'google' } }, 'local');
    send = (m) => { record(m); return Promise.resolve({ success: true, translation: tr(m.text) }); };
    await fns.translatePage({ auto: true });
    expect(fns.state.isTranslated).toBe(true);
  });

  // 测试者的复现：翻到一半额度用完，再站内跳转，进度条停在 0% 不消失
  test('an in-site navigation after the refusal shows no progress bar and sends nothing', async () => {
    engine = 'oi-standard';
    main().appendChild(para('Timeline item translated before the credits ran out.', { onscreen: true }));
    await fns.translatePage();
    expect(fns.state.isTranslated).toBe(true);
    send = refuse('out_of_credits');
    main().appendChild(para('A live update that arrives after the credits ran out.', { onscreen: true }));
    await wait(BATCH);
    const first = messages.length;

    history.pushState(null, '', '/status/456');
    main().appendChild(para('The opened post on the new route, still visible.', { onscreen: true }));
    await wait(1200);

    expect(messages.length).toBe(first);
    expect(document.getElementById('yll-progress').style.display).toBe('none');
    history.replaceState(null, '', '/');
  });

  test('other failures do not stop the page', async () => {
    engine = 'oi-standard';
    send = (m) => { record(m); return Promise.resolve({ success: false, error: 'HTTP 500' }); };
    main().appendChild(para('The site had a hiccup on this paragraph only.'));
    await fns.translatePage();
    await fns.translatePage({ auto: true });
    expect(messages.length).toBe(2);
  });
});

// ─── 悬浮球菜单跟着状态走；还原要真的停下 ──────────────────────────────────

describe('float ball menu follows the state; restore really stops', () => {
  const label = () => document.querySelector('#yll-ball-wrap .yll-ball-item').textContent;
  const altT = () => document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyT', key: 't', bubbles: true }));

  beforeEach(() => { fns.removeFloatBall(); fns.ensureFloatBall(); });
  afterEach(() => { fns.removeFloatBall(); });

  test('Alt+T to translate and Alt+T to restore update the label without a hover', async () => {
    main().appendChild(para('A paragraph that the hotkey translates and restores.'));
    expect(label()).toBe('Translate this page');
    altT();
    await wait(0);
    expect(label()).toBe('Show original');
    await wait(50);
    expect(fns.state.isTranslated).toBe(true);
    expect(label()).toBe('Show original');
    altT();
    expect(label()).toBe('Translate this page');
  });

  test('a failed translation puts the label back', async () => {
    send = (m) => Promise.resolve({ success: false, error: 'HTTP 500' });
    main().appendChild(para('A paragraph that the engine fails on, every time.'));
    await fns.translatePage();
    expect(label()).toBe('Translate this page');
  });

  test('Show original while the page is still translating stops it and nothing comes back', async () => {
    const held = [];
    send = (m) => { record(m); return new Promise(r => held.push(() => r({ success: true, translation: tr(m.text) }))); };
    for (let i = 0; i < 3; i++) main().appendChild(para(`Timeline post ${i} that is still being translated.`));
    const pending = fns.translatePage();
    await wait(0);
    expect(fns.state.isTranslating).toBe(true);
    document.querySelector('#yll-ball-wrap .yll-ball-item').click();
    await wait(0);
    expect(fns.state.isTranslating).toBe(false);
    expect(label()).toBe('Translate this page');
    held.forEach(r => r());
    await pending;
    const before = sent.length;
    for (let i = 0; i < 5; i++) { main().appendChild(para(`New post ${i} arrives on the live timeline.`)); await wait(BATCH); }
    expect(main().querySelectorAll('[data-yll-inject]').length).toBe(0);
    expect(sent.length).toBe(before);
    expect(fns.state.isTranslated).toBe(false);
    expect(label()).toBe('Translate this page');
  });

  test('after restore, blocks that scroll into view are not translated', async () => {
    main().appendChild(para('Visible paragraph translated first of all.', { onscreen: true }));
    const far = para('An offscreen paragraph waiting for a scroll.', { offscreen: true });
    main().appendChild(far);
    await fns.translatePage();
    fns.removeTranslations();
    scrollIntoReach(far);
    await wait(BATCH);
    expect(far.dataset.yllDone).toBeUndefined();
    expect(sent).not.toContain(far.textContent);
  });
});

// ─── 悬浮球拖动 ──────────────────────────────────────────────────────────────

describe('float ball drags along the right edge', () => {
  let saved;
  const ball = () => document.getElementById('yll-float-ball');
  const wrap = () => document.getElementById('yll-ball-wrap');
  const pointer = (target, type, clientY) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientY }));
  const drag = (fromY, toY) => {
    pointer(ball(), 'pointerdown', fromY);
    pointer(window, 'pointermove', (fromY + toY) / 2);
    pointer(window, 'pointermove', toY);
    pointer(window, 'pointerup', toY);
    ball().click(); // 浏览器在松手后跟着发的那次 click
  };

  beforeEach(() => {
    saved = [];
    global.browser.storage.local.set = (items) => { saved.push(items); return Promise.resolve(); };
    fns.removeFloatBall();
    fns.ensureFloatBall();
    // jsdom 没有布局：按 style.top 报球的位置
    wrap().getBoundingClientRect = function () { const top = parseFloat(this.style.top) || 0; return { top, bottom: top + 40, left: 0, right: 40, width: 40, height: 40 }; };
    main().appendChild(para('A paragraph that a click on the ball would translate.'));
  });
  afterEach(() => { fns.removeFloatBall(); delete global.browser.storage.local.set; });

  test('a drag moves the ball, saves its height as a share of the viewport, and does not translate', async () => {
    wrap().style.top = '400px';
    drag(420, 220);
    await wait(50);
    expect(wrap().style.top).toBe('200px');
    expect(saved).toEqual([{ floatBallTop: (200 + 20) / window.innerHeight }]);
    expect(sent).toEqual([]);
    expect(fns.state.isTranslated).toBe(false);
  });

  test('a click that wobbles less than the threshold still translates', async () => {
    wrap().style.top = '400px';
    drag(420, 423);
    await wait(50);
    expect(saved).toEqual([]);
    expect(fns.state.isTranslated).toBe(true);
  });

  test('the ball cannot be dragged off screen', () => {
    wrap().style.top = '400px';
    drag(420, -500);
    expect(wrap().style.top).toBe('8px');
    drag(28, 5000);
    expect(wrap().style.top).toBe(`${window.innerHeight - 48}px`);
  });

  test('the next real click after a drag translates', async () => {
    wrap().style.top = '400px';
    drag(420, 220);
    await wait(0);
    ball().click();
    await wait(50);
    expect(fns.state.isTranslated).toBe(true);
  });

  test('a ball created later (another page of the site, the toggle off and on) sits at the saved height', () => {
    wrap().style.top = '400px';
    drag(420, 220);
    fns.removeFloatBall();
    fns.ensureFloatBall();
    expect(wrap().style.top).toBe('200px');
  });

  test('near the top the menu opens downward', () => {
    wrap().style.top = '400px';
    drag(420, 30);
    expect(wrap().classList.contains('yll-ball-below')).toBe(true);
    drag(30, 500);
    expect(wrap().classList.contains('yll-ball-below')).toBe(false);
  });
});

// ─── 被拒后的提示：一条，带按钮 ─────────────────────────────────────────────

describe('the account prompt after a refusal', () => {
  const MSG = 'Log in or sign up free to use Standard and Premium. The free Google tier needs no account.';
  const refuse = (code) => (m) => {
    if (m.type === 'translate') record(m);
    return Promise.resolve({ success: false, error: MSG, code, site: 'https://openimmersive.ai' });
  };
  const notice = () => document.getElementById('yll-acct-notice');
  const buttons = () => Array.from(notice().querySelectorAll('.yll-acct-btn')).map(b => b.textContent);

  let saved;
  beforeEach(() => {
    saved = [];
    window.open = jest.fn();
    global.browser.storage.local.set = (items) => { saved.push(items); if (items.engine) engine = items.engine; return Promise.resolve(); };
  });
  afterEach(() => { delete global.browser.storage.local.set; });

  test('signed out: the prompt without an "Engine failed" prefix, Log in and Use free Google', async () => {
    engine = 'oi-standard';
    send = refuse('login_required');
    for (let i = 0; i < 6; i++) main().appendChild(para(`Paragraph ${i} that the site refuses for a signed-out user.`));
    await fns.translatePage();
    expect(document.querySelectorAll('#yll-acct-notice').length).toBe(1);
    expect(notice().querySelector('.yll-acct-text').textContent).toBe(MSG);
    expect(buttons()).toEqual(['Log in', 'Use free Google']);
    const login = jest.spyOn(global.browser.runtime, 'sendMessage').mockResolvedValue({ success: true });
    notice().querySelector('.yll-acct-btn').click();
    expect(login).toHaveBeenCalledWith({ type: 'oiLogin' });
    login.mockRestore();
  });

  test('out of credits: Buy credits opens the pricing section', async () => {
    engine = 'oi-premium';
    send = refuse('out_of_credits');
    main().appendChild(para('A paragraph the site refuses for an account with no credits.'));
    await fns.translatePage();
    expect(buttons()).toEqual(['Buy credits', 'Use free Google']);
    notice().querySelector('.yll-acct-btn').click();
    expect(window.open).toHaveBeenCalledWith('https://openimmersive.ai/#pricing', '_blank', 'noopener');
  });

  test('the fair-use ceiling offers only the free engine', async () => {
    engine = 'oi-standard';
    send = refuse('usage_cap');
    main().appendChild(para('A paragraph refused because of the monthly fair-use ceiling.'));
    await fns.translatePage();
    expect(buttons()).toEqual(['Use free Google']);
  });

  test('Use free Google switches the engine and translates the page again', async () => {
    engine = 'oi-standard';
    send = refuse('login_required');
    const p = para('A paragraph the free Google tier translates after the switch.');
    main().appendChild(p);
    await fns.translatePage();
    send = (m) => { if (m.type === 'translate') record(m); return Promise.resolve({ success: true, translation: tr(m.text) }); };
    Array.from(notice().querySelectorAll('.yll-acct-btn')).find(b => b.textContent === 'Use free Google').click();
    await wait(50);
    expect(saved).toContainEqual({ engine: 'google' });
    expect(notice()).toBeNull();
    expect(translationOf(p)).toBe('译:A paragraph the free Google tier translates after the switch.');
  });

  test('closing it, or translating again, removes it', async () => {
    engine = 'oi-standard';
    send = refuse('login_required');
    main().appendChild(para('A paragraph that the site keeps refusing for now.'));
    await fns.translatePage();
    notice().querySelector('.yll-acct-close').click();
    expect(notice()).toBeNull();
    await fns.translatePage();
    expect(notice()).not.toBeNull();
    let release;
    send = (m) => { record(m); return new Promise((r) => { release = () => r({ success: true, translation: tr(m.text) }); }); };
    const pending = fns.translatePage();
    await wait(0);
    expect(notice()).toBeNull();
    fns.removeTranslations();
    release();
    await pending;
  });

  test('the prompt is UI: never collected for translation', async () => {
    engine = 'oi-standard';
    send = refuse('login_required');
    main().appendChild(para('A paragraph that the site refuses for a signed-out user.'));
    await fns.translatePage();
    expect(fns.shouldTranslate(notice().querySelector('.yll-acct-text'))).toBe(false);
  });
});
