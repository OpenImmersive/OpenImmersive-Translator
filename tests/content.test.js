/**
 * @jest-environment jsdom
 */
'use strict';

const fs = require('fs');
const path = require('path');

let fns;

beforeAll(() => {
  // jsdom doesn't compute layout; fake offsetParent so shouldTranslate works
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body; }
  });

  // Mock browser extension API
  global.browser = {
    storage: {
      local: {
        get: () => Promise.resolve({ targetLang: 'zh-CN', engine: 'google' })
      }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => Promise.resolve({ success: true, translation: '测试翻译' })
    },
    i18n: require('./i18n-mock')
  };

  // Signal test mode before the IIFE runs
  global.__yllTestMode = true;

  // Load and evaluate content.js in this jsdom context
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);

  fns = global.__yllInternals;
});

afterEach(() => {
  // Clean up any injected translation elements between tests
  document.querySelectorAll('[data-yll-inject]').forEach(el => el.remove());
  document.querySelectorAll('[data-yll-done]').forEach(el => { delete el.dataset.yllDone; });
});

// ─── isAlreadyTargetLang ─────────────────────────────────────────────────────

describe('isAlreadyTargetLang', () => {
  test('always returns false for non-CJK target (en)', () => {
    expect(fns.isAlreadyTargetLang('Hello World', 'en')).toBe(false);
  });

  test('always returns false for non-CJK target even with CJK input', () => {
    expect(fns.isAlreadyTargetLang('你好世界', 'fr')).toBe(false);
  });

  test('returns true for pure CJK text with zh-CN target', () => {
    expect(fns.isAlreadyTargetLang('你好世界欢迎使用语灵灵', 'zh-CN')).toBe(true);
  });

  test('returns false for mostly-Latin text with zh-CN target', () => {
    expect(fns.isAlreadyTargetLang('Hello World from Shanghai', 'zh-CN')).toBe(false);
  });

  test('returns true when CJK ratio ~50% (above 35% threshold)', () => {
    // "你好ab" → 2 CJK / 4 non-space chars = 50% > 35%
    expect(fns.isAlreadyTargetLang('你好ab', 'zh-CN')).toBe(true);
  });

  test('returns false when CJK ratio ~17% (below 35% threshold)', () => {
    // "你abcde" → 1 CJK / 6 non-space = ~17% < 35%
    expect(fns.isAlreadyTargetLang('你abcde', 'zh-CN')).toBe(false);
  });

  test('handles exactly 35% boundary (returns false at exactly 35%)', () => {
    // 7 CJK + 13 Latin = 20 chars; 7/20 = 35% → ratio > 0.35 is false
    const text = '你好世界七八九' + 'a'.repeat(13);
    expect(fns.isAlreadyTargetLang(text, 'zh-CN')).toBe(false);
  });

  test('returns true for Japanese hiragana with ja target', () => {
    expect(fns.isAlreadyTargetLang('こんにちは世界', 'ja')).toBe(true);
  });

  test('returns true for Korean with ko target', () => {
    expect(fns.isAlreadyTargetLang('안녕하세요 반갑습니다', 'ko')).toBe(true);
  });

  test('returns false for empty string', () => {
    expect(fns.isAlreadyTargetLang('', 'zh-CN')).toBe(false);
  });
});

// ─── extractText ─────────────────────────────────────────────────────────────

describe('extractText', () => {
  test('returns plain textContent', () => {
    const p = document.createElement('p');
    p.textContent = 'Hello World';
    expect(fns.extractText(p)).toBe('Hello World');
  });

  test('skips child elements marked data-yll-inject', () => {
    const p = document.createElement('p');
    p.textContent = 'Original text';
    const injected = document.createElement('div');
    injected.dataset.yllInject = '1';
    injected.textContent = ' [Translation]';
    p.appendChild(injected);
    expect(fns.extractText(p)).toBe('Original text');
  });

  test('includes text from non-injected child elements', () => {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Hello '));
    const span = document.createElement('span');
    span.textContent = 'World';
    p.appendChild(span);
    expect(fns.extractText(p)).toBe('Hello World');
  });

  test('returns empty string for element with no text', () => {
    const div = document.createElement('div');
    expect(fns.extractText(div)).toBe('');
  });

  test('concatenates multiple text nodes', () => {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('foo'));
    p.appendChild(document.createTextNode('bar'));
    expect(fns.extractText(p)).toBe('foobar');
  });
});

// ─── shouldTranslate ─────────────────────────────────────────────────────────

describe('shouldTranslate', () => {
  test('returns false if data-yll-done is set', () => {
    const el = document.createElement('p');
    el.dataset.yllDone = '1';
    document.body.appendChild(el);
    expect(fns.shouldTranslate(el)).toBe(false);
    el.remove();
  });

  test('returns false if data-yll-ui is set on element', () => {
    const el = document.createElement('div');
    el.dataset.yllUi = 'true';
    document.body.appendChild(el);
    expect(fns.shouldTranslate(el)).toBe(false);
    el.remove();
  });

  test('returns false for element inside [data-yll-ui] ancestor', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-yll-ui', 'true');
    const inner = document.createElement('p');
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    expect(fns.shouldTranslate(inner)).toBe(false);
    wrapper.remove();
  });

  test('returns false for SCRIPT tag', () => {
    const el = document.createElement('script');
    document.body.appendChild(el);
    expect(fns.shouldTranslate(el)).toBe(false);
    el.remove();
  });

  test('returns false for STYLE tag', () => {
    const el = document.createElement('style');
    document.body.appendChild(el);
    expect(fns.shouldTranslate(el)).toBe(false);
    el.remove();
  });

  test('returns false for CODE tag', () => {
    const el = document.createElement('code');
    document.body.appendChild(el);
    expect(fns.shouldTranslate(el)).toBe(false);
    el.remove();
  });

  test('returns false for element inside <nav>', () => {
    const nav = document.createElement('nav');
    const p = document.createElement('p');
    p.textContent = 'Navigation item';
    nav.appendChild(p);
    document.body.appendChild(nav);
    expect(fns.shouldTranslate(p)).toBe(false);
    nav.remove();
  });

  test('returns false for element inside <header>', () => {
    const header = document.createElement('header');
    const p = document.createElement('p');
    header.appendChild(p);
    document.body.appendChild(header);
    expect(fns.shouldTranslate(p)).toBe(false);
    header.remove();
  });

  test('returns false for element inside <footer>', () => {
    const footer = document.createElement('footer');
    const p = document.createElement('p');
    footer.appendChild(p);
    document.body.appendChild(footer);
    expect(fns.shouldTranslate(p)).toBe(false);
    footer.remove();
  });

  test('returns false for element containing <code>', () => {
    const p = document.createElement('p');
    const code = document.createElement('code');
    code.textContent = 'const x = 1;';
    p.appendChild(code);
    document.body.appendChild(p);
    expect(fns.shouldTranslate(p)).toBe(false);
    p.remove();
  });

  test('returns true for regular paragraph in body', () => {
    const p = document.createElement('p');
    p.textContent = 'This is a regular paragraph.';
    document.body.appendChild(p);
    expect(fns.shouldTranslate(p)).toBe(true);
    p.remove();
  });

  test('returns true for h1 in body', () => {
    const h1 = document.createElement('h1');
    h1.textContent = 'Article title';
    document.body.appendChild(h1);
    expect(fns.shouldTranslate(h1)).toBe(true);
    h1.remove();
  });
});

// ─── escHtml ─────────────────────────────────────────────────────────────────

describe('escHtml', () => {
  test('escapes <', () => {
    expect(fns.escHtml('<script>')).toContain('&lt;');
  });

  test('escapes >', () => {
    expect(fns.escHtml('<b>text</b>')).toContain('&gt;');
  });

  test('escapes &', () => {
    expect(fns.escHtml('foo & bar')).toBe('foo &amp; bar');
  });

  test('passes through plain text unchanged', () => {
    expect(fns.escHtml('Hello World 你好')).toBe('Hello World 你好');
  });

  test('passes through double quotes (innerHTML does not encode them)', () => {
    expect(fns.escHtml('"quoted"')).toBe('"quoted"');
  });
});

// ─── injectTranslation ───────────────────────────────────────────────────────

describe('injectTranslation', () => {
  test('inserts a .yll-tr element immediately after the target', () => {
    const p = document.createElement('p');
    p.textContent = 'Original';
    document.body.appendChild(p);

    fns.injectTranslation(p, '翻译内容');

    const next = p.nextElementSibling;
    expect(next).not.toBeNull();
    expect(next.className).toBe('yll-tr');
    expect(next.textContent).toBe('翻译内容');
    p.remove();
    next && next.remove();
  });

  test('sets data-yll-done on the source element', () => {
    const p = document.createElement('p');
    p.textContent = 'Test';
    document.body.appendChild(p);

    fns.injectTranslation(p, '翻译');
    expect(p.dataset.yllDone).toBe('1');
    p.remove();
  });

  test('sets data-yll-inject on injected element', () => {
    const p = document.createElement('p');
    p.textContent = 'Test';
    document.body.appendChild(p);

    fns.injectTranslation(p, '翻译');
    const injected = p.nextElementSibling;
    expect(injected.dataset.yllInject).toBe('1');
    p.remove();
  });
});

// ─── removeTranslations ──────────────────────────────────────────────────────

describe('removeTranslations', () => {
  test('removes all [data-yll-inject] elements', () => {
    const p = document.createElement('p');
    p.textContent = 'Original';
    document.body.appendChild(p);
    fns.injectTranslation(p, '翻译');

    expect(document.querySelectorAll('[data-yll-inject]').length).toBeGreaterThan(0);
    fns.removeTranslations();
    expect(document.querySelectorAll('[data-yll-inject]').length).toBe(0);
    p.remove();
  });

  test('clears data-yll-done from source elements', () => {
    const p = document.createElement('p');
    p.textContent = 'Original';
    document.body.appendChild(p);
    fns.injectTranslation(p, '翻译');

    fns.removeTranslations();
    expect(p.dataset.yllDone).toBeUndefined();
    p.remove();
  });

  test('removes multiple injected translations', () => {
    const paragraphs = ['First paragraph text', 'Second paragraph text', 'Third paragraph text'];
    const els = paragraphs.map(text => {
      const p = document.createElement('p');
      p.textContent = text;
      document.body.appendChild(p);
      fns.injectTranslation(p, '翻译' + text);
      return p;
    });

    fns.removeTranslations();
    expect(document.querySelectorAll('[data-yll-inject]').length).toBe(0);
    els.forEach(el => el.remove());
  });
});

// ─── collectBlocks ───────────────────────────────────────────────────────────

describe('collectBlocks', () => {
  test('collects paragraph elements with sufficient text', () => {
    const main = document.createElement('main');
    const p1 = document.createElement('p');
    p1.textContent = 'This paragraph has enough text to be collected by the function.';
    const p2 = document.createElement('p');
    p2.textContent = 'Another paragraph with sufficient content.';
    main.appendChild(p1);
    main.appendChild(p2);
    document.body.appendChild(main);

    const blocks = fns.collectBlocks();
    expect(blocks).toContain(p1);
    expect(blocks).toContain(p2);
    main.remove();
  });

  test('skips paragraphs with fewer than 15 characters', () => {
    const p = document.createElement('p');
    p.textContent = 'Short text';  // < 15 chars
    document.body.appendChild(p);

    const blocks = fns.collectBlocks();
    expect(blocks).not.toContain(p);
    p.remove();
  });

  test('skips elements inside nav', () => {
    const nav = document.createElement('nav');
    const p = document.createElement('p');
    p.textContent = 'Navigation text that is long enough to pass the length check';
    nav.appendChild(p);
    document.body.appendChild(nav);

    const blocks = fns.collectBlocks();
    expect(blocks).not.toContain(p);
    nav.remove();
  });

  test('does not return duplicates when selector matches ancestor and descendant', () => {
    // "article p" and "p" both match the same element — WeakSet should deduplicate
    const article = document.createElement('article');
    const p = document.createElement('p');
    p.textContent = 'This paragraph is inside an article and should appear only once.';
    article.appendChild(p);
    document.body.appendChild(article);

    const blocks = fns.collectBlocks();
    const count = blocks.filter(el => el === p).length;
    expect(count).toBe(1);
    article.remove();
  });

  test('collects heading elements', () => {
    const h2 = document.createElement('h2');
    h2.textContent = 'Section heading that is long enough';
    document.body.appendChild(h2);

    const blocks = fns.collectBlocks();
    expect(blocks).toContain(h2);
    h2.remove();
  });

  test('skips already-translated elements', () => {
    const p = document.createElement('p');
    p.textContent = 'This paragraph was already translated and should be skipped.';
    p.dataset.yllDone = '1';
    document.body.appendChild(p);

    const blocks = fns.collectBlocks();
    expect(blocks).not.toContain(p);
    p.remove();
  });
});

// ─── 悬停翻译 hover translate ────────────────────────────────────────────────

describe('hover translate', () => {
  test('hoverKeyHeld 读对应修饰键（默认 Alt）', () => {
    expect(fns.hoverKeyHeld({ altKey: true })).toBe(true);
    expect(fns.hoverKeyHeld({ altKey: false })).toBe(false);
    expect(fns.hoverKeyHeld({ ctrlKey: true })).toBe(false); // 默认键是 Alt
  });

  test('setHoverKey off 时任何键都不触发', () => {
    fns.setHoverKey('off');
    expect(fns.hoverKeyHeld({ altKey: true })).toBe(false);
    fns.setHoverKey('Alt'); // 复位，避免污染其他用例
  });

  test('findHoverBlock 从命中的子节点向上找到可翻译段落', () => {
    document.body.innerHTML = '<article><p id="para">This is a long English paragraph worth translating.<span id="child">inline</span></p></article>';
    const child = document.getElementById('child');
    const block = fns.findHoverBlock(child);
    expect(block).not.toBeNull();
    expect(block.id).toBe('para');
  });

  test('findHoverBlock 跳过已是中文的段落', () => {
    document.body.innerHTML = '<p id="zh">这是一段已经是中文的内容不需要翻译呀呀呀</p>';
    expect(fns.findHoverBlock(document.getElementById('zh'))).toBeNull();
  });

  test('findHoverBlock 对非文本块返回 null', () => {
    document.body.innerHTML = '<div id="wrap"><nav><p>Skip me</p></nav></div>';
    // nav 内的段落被 shouldTranslate 排除
    expect(fns.findHoverBlock(document.querySelector('nav p'))).toBeNull();
  });
});

// ─── M1: style-matched injection + leaf-block fallback ───────────────────────

describe('injectTranslation M1 behaviors', () => {
  test('headings get an inline appended span, not a sibling block', () => {
    const h = document.createElement('h2');
    h.textContent = 'Machine translation systems overview';
    document.body.appendChild(h);
    fns.injectTranslation(h, '机器翻译系统概览');
    const span = h.querySelector('span.yll-tr.yll-tr-inline');
    expect(span).not.toBeNull();
    expect(span.textContent).toBe(' 机器翻译系统概览');
    expect(h.nextElementSibling).toBeNull();
    h.remove();
  });

  test('paragraph translation still lands as a following block', () => {
    const p = document.createElement('p');
    p.textContent = 'A paragraph that is long enough to translate.';
    document.body.appendChild(p);
    fns.injectTranslation(p, '一个足够长的段落。');
    const next = p.nextElementSibling;
    expect(next.classList.contains('yll-tr')).toBe(true);
    expect(next.classList.contains('yll-tr-inline')).toBe(false);
    p.remove();
  });
});

describe('collectBlocks leaf fallback', () => {
  test('picks up bare-div copy on non-semantic pages', () => {
    document.body.innerHTML = '';
    const d = document.createElement('div');
    d.textContent = 'This page keeps its copy in plain divs with no semantic tags at all.';
    document.body.appendChild(d);
    const blocks = fns.collectBlocks();
    expect(blocks).toContain(d);
    document.body.innerHTML = '';
  });

  test('fallback skips containers that hold block-level children', () => {
    document.body.innerHTML = '';
    const wrap = document.createElement('div');
    const inner = document.createElement('p');
    inner.textContent = 'Inner paragraph text that is comfortably long enough.';
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    const blocks = fns.collectBlocks();
    expect(blocks).toContain(inner);
    expect(blocks).not.toContain(wrap);
    document.body.innerHTML = '';
  });
});

// ─── M2: local page-language detection (no network) ─────────────────────────

describe('detectPageLang', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang');
    document.body.innerHTML = '';
  });

  test('trusts the html lang attribute and strips the region', () => {
    document.documentElement.setAttribute('lang', 'ja-JP');
    expect(fns.detectPageLang()).toBe('ja');
  });

  test('falls back to script detection when lang is absent', () => {
    document.body.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = '这是一段足够长的中文正文内容，用来触发本地的书写系统判定逻辑，'
      + '需要超过五十个字符才会进入检测分支，所以这里再补充一些文字。';
    document.body.appendChild(p);
    expect(fns.detectPageLang()).toBe('zh');
  });

  test('kana wins over han so Japanese is not read as Chinese', () => {
    document.body.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = 'これは日本語の文章です。漢字と仮名が混在していますが、'
      + '仮名の比率で日本語と判定されるべきです。もう少し文字を足しておきます。';
    document.body.appendChild(p);
    expect(fns.detectPageLang()).toBe('ja');
  });

  test('returns empty for short or Latin-script text rather than guessing', () => {
    document.body.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = 'A perfectly ordinary English paragraph with no lang attribute set on it.';
    document.body.appendChild(p);
    expect(fns.detectPageLang()).toBe('');
  });
});

// Regression: every behaviour flag must be in the storage key list, or the
// feature silently never fires (this bit hover/input once, and autoTranslateLangs again).
describe('storage key list', () => {
  test('content.js requests all behaviour keys it reads', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');
    const call = src.match(/storageGet\(\[([\s\S]*?)\]\)/);
    expect(call).not.toBeNull();
    const requested = call[1];
    for (const key of ['targetLang', 'engine', 'hoverTranslate', 'hoverKey', 'selectionTranslate',
      'inputTranslate', 'inputTargetLang', 'autoTranslateSites', 'autoTranslateLangs', 'floatBall']) {
      expect(requested).toContain(`'${key}'`);
    }
  });
});

// Grid/flex parents treat a sibling as a new cell, which pushes the translation
// away from its source text — keep it inside the element in that case.
describe('injectTranslation in grid/flex layouts', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('goes inside the element when the parent is a grid', () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    const p = document.createElement('p');
    p.textContent = 'A row of a two-column grid layout.';
    wrap.appendChild(p);
    document.body.appendChild(wrap);
    fns.injectTranslation(p, '两列网格布局中的一行。');
    expect(p.querySelector('.yll-tr')).not.toBeNull();
    expect(p.nextElementSibling).toBeNull();
  });

  test('goes inside a table cell rather than becoming a stray column', () => {
    const table = document.createElement('table');
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.textContent = 'A post title living in a table cell.';
    row.appendChild(cell);
    table.appendChild(row);
    document.body.appendChild(table);
    fns.injectTranslation(cell, '表格单元格里的文章标题。');
    expect(cell.querySelector('.yll-tr')).not.toBeNull();
    expect(row.querySelectorAll(':scope > .yll-tr')).toHaveLength(0);
  });

  test('stays a sibling in ordinary block flow', () => {
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = 'An ordinary paragraph in normal block flow.';
    wrap.appendChild(p);
    document.body.appendChild(wrap);
    fns.injectTranslation(p, '普通文档流中的段落。');
    expect(p.querySelector('.yll-tr')).toBeNull();
    expect(p.nextElementSibling.classList.contains('yll-tr')).toBe(true);
  });
});

// A container and a block inside it both match the semantic selector, which
// would translate the same sentence twice — only the innermost should survive.
describe('collectBlocks overlap dedup', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('drops the table cell when it only wraps a heading', () => {
    document.body.innerHTML = '';
    const table = document.createElement('table');
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    const h = document.createElement('h1');
    h.textContent = 'Posts in 2026 and other announcements';
    cell.appendChild(h);
    row.appendChild(cell);
    table.appendChild(row);
    document.body.appendChild(table);
    const blocks = fns.collectBlocks();
    expect(blocks).toContain(h);
    expect(blocks).not.toContain(cell);
  });

  test('keeps independent siblings', () => {
    document.body.innerHTML = '';
    const a = document.createElement('p');
    a.textContent = 'The first standalone paragraph of the page.';
    const b = document.createElement('p');
    b.textContent = 'The second standalone paragraph of the page.';
    document.body.append(a, b);
    const blocks = fns.collectBlocks();
    expect(blocks).toContain(a);
    expect(blocks).toContain(b);
  });
});

// Code comments live in spans INSIDE <pre>; "contains code" misses them, so the
// guard has to look upward too, or comment translations land inside code blocks.
describe('code block containment', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('a span inside a pre is never translatable', () => {
    document.body.innerHTML = '';
    const pre = document.createElement('pre');
    const span = document.createElement('span');
    span.textContent = '# division always returns a float';
    pre.appendChild(span);
    document.body.appendChild(pre);
    expect(fns.shouldTranslate(span)).toBe(false);
    expect(fns.collectBlocks()).not.toContain(span);
  });

  test('a span outside code is still translatable', () => {
    document.body.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = 'An ordinary run of prose text in a span element.';
    document.body.appendChild(span);
    expect(fns.shouldTranslate(span)).toBe(true);
  });
});

// Mixed CN/EN entries slip past the CJK-ratio check and come back unchanged;
// injecting those just doubles the page.
describe('sameText', () => {
  test('treats punctuation and spacing differences as identical', () => {
    expect(fns.sameText('法律（英语：Legal translation）', '法律 (英语: Legal translation)')).toBe(true);
    expect(fns.sameText('Hello, world!', 'hello world')).toBe(true);
  });

  test('still reports genuinely different text as different', () => {
    expect(fns.sameText('机器翻译', 'Machine translation')).toBe(false);
  });
});

// Wikipedia embeds <style> inside table cells; if extractText walks into it the
// stylesheet gets sent to the translator and comes back as Chinese CSS.
describe('extractText skips non-content children', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('ignores style and script children', () => {
    const cell = document.createElement('td');
    const style = document.createElement('style');
    style.textContent = '.navbar{display:inline;font-weight:normal}';
    const script = document.createElement('script');
    script.textContent = 'var x = 1;';
    cell.append(style, script, document.createTextNode('查论编'));
    document.body.appendChild(cell);
    const text = fns.extractText(cell);
    expect(text).toContain('查论编');
    expect(text).not.toContain('display:inline');
    expect(text).not.toContain('var x');
  });

  test('skips a style buried deeper than a direct child', () => {
    const li = document.createElement('li');
    const wrap = document.createElement('span');
    const style = document.createElement('style');
    style.textContent = 'cite.citation{font-style:italic}';
    wrap.append(style, document.createTextNode('Google Translate Gets an Upgrade'));
    li.appendChild(wrap);
    document.body.appendChild(li);
    const text = fns.extractText(li);
    expect(text).toContain('Google Translate Gets an Upgrade');
    expect(text).not.toContain('font-style');
  });

  test('still reads ordinary inline children', () => {
    const p = document.createElement('p');
    const em = document.createElement('em');
    em.textContent = 'emphasised';
    p.append(document.createTextNode('An '), em, document.createTextNode(' word.'));
    document.body.appendChild(p);
    expect(fns.extractText(p)).toBe('An emphasised word.');
  });
});

// ─── page hotkeys (Alt+T / Alt+A / Alt+W) ───────────────────────────────────

describe('pageHotkeyAction', () => {
  const ev = (props) => Object.assign({ altKey: true, ctrlKey: false, metaKey: false }, props);

  test('Alt+T toggles', () => {
    expect(fns.pageHotkeyAction(ev({ code: 'KeyT', key: 't' }))).toBe('toggle');
  });

  test('Alt+A toggles (competitor muscle memory)', () => {
    expect(fns.pageHotkeyAction(ev({ code: 'KeyA', key: 'a' }))).toBe('toggle');
  });

  test('Alt+W translates', () => {
    expect(fns.pageHotkeyAction(ev({ code: 'KeyW', key: 'w' }))).toBe('translate');
  });

  test('macOS composed keys match via e.code (Alt+A gives key "å")', () => {
    expect(fns.pageHotkeyAction(ev({ code: 'KeyA', key: 'å' }))).toBe('toggle');
    expect(fns.pageHotkeyAction(ev({ code: 'KeyT', key: '†' }))).toBe('toggle');
    expect(fns.pageHotkeyAction(ev({ code: 'KeyW', key: '∑' }))).toBe('translate');
  });

  test('requires Alt', () => {
    expect(fns.pageHotkeyAction({ altKey: false, ctrlKey: false, metaKey: false, code: 'KeyA', key: 'a' })).toBe(null);
  });

  test('ignores Ctrl+Alt combos (AltGr typing on some layouts)', () => {
    expect(fns.pageHotkeyAction(ev({ ctrlKey: true, code: 'KeyA', key: 'a' }))).toBe(null);
  });

  test('unrelated keys return null', () => {
    expect(fns.pageHotkeyAction(ev({ code: 'KeyB', key: 'b' }))).toBe(null);
  });

  test('falls back to e.key when e.code is absent (synthetic events)', () => {
    expect(fns.pageHotkeyAction(ev({ key: 'w' }))).toBe('translate');
  });
});

// ─── float ball hover menu ──────────────────────────────────────────────────

describe('float ball hover menu', () => {
  test('wrapper with ball and 3-item menu is injected, marked as UI', () => {
    fns.removeFloatBall();
    fns.ensureFloatBall();
    const wrap = document.getElementById('yll-ball-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap.dataset.yllUi).toBe('true');
    expect(document.getElementById('yll-float-ball')).not.toBeNull();
    const items = wrap.querySelectorAll('.yll-ball-item');
    expect(items.length).toBe(3);
    expect(items[2].textContent).toBe('设置');
  });

  test('设置 item asks background to open the options page', () => {
    const sent = [];
    global.browser.runtime.sendMessage = (m) => { sent.push(m); return Promise.resolve({}); };
    fns.removeFloatBall();
    fns.ensureFloatBall();
    const items = document.querySelectorAll('#yll-ball-wrap .yll-ball-item');
    items[2].click();
    expect(sent).toContainEqual({ type: 'openOptions' });
  });

  test('menu contents are excluded from translation collection', () => {
    fns.removeFloatBall();
    fns.ensureFloatBall();
    const item = document.querySelector('#yll-ball-wrap .yll-ball-item');
    expect(fns.shouldTranslate(item)).toBe(false);
  });
});

// ─── v1.12.0：header 连坐修正 ────────────────────────────────────────────────

describe('header inside article/main is content, not chrome', () => {
  test('translates p inside <article><header>', () => {
    const article = document.createElement('article');
    const header = document.createElement('header');
    const p = document.createElement('p');
    p.textContent = 'Anthropic to build in-house chip design team';
    header.appendChild(p);
    article.appendChild(header);
    document.body.appendChild(article);
    expect(fns.shouldTranslate(p)).toBe(true);
    article.remove();
  });

  test('translates h1 inside <main><header>', () => {
    const main = document.createElement('main');
    const header = document.createElement('header');
    const h1 = document.createElement('h1');
    h1.textContent = 'Top story headline';
    header.appendChild(h1);
    main.appendChild(header);
    document.body.appendChild(main);
    expect(fns.shouldTranslate(h1)).toBe(true);
    main.remove();
  });

  test('still skips page-level header outside article/main', () => {
    const header = document.createElement('header');
    const p = document.createElement('p');
    p.textContent = 'Site chrome text';
    header.appendChild(p);
    document.body.appendChild(header);
    expect(fns.shouldTranslate(p)).toBe(false);
    header.remove();
  });
});

// ─── v1.12.0：视觉隐藏节点过滤 ───────────────────────────────────────────────

describe('visually hidden nodes', () => {
  test('extractText excludes display:none children (sr-only labels)', () => {
    const li = document.createElement('li');
    const kicker = document.createElement('span');
    kicker.textContent = 'Business';
    const hidden = document.createElement('span');
    hidden.textContent = 'category';
    hidden.style.display = 'none';
    const title = document.createElement('span');
    title.textContent = "Fed's Schmid says finances merit watching";
    li.append(kicker, hidden, title);
    document.body.appendChild(li);
    const text = fns.extractText(li);
    expect(text).toContain('Business');
    expect(text).not.toContain('category');
    expect(text).toContain('Schmid');
    li.remove();
  });

  test('extractText excludes visibility:hidden children', () => {
    const p = document.createElement('p');
    const vis = document.createElement('span');
    vis.textContent = 'visible caption';
    const hid = document.createElement('span');
    hid.textContent = 'stacked hidden caption';
    hid.style.visibility = 'hidden';
    p.append(vis, hid);
    document.body.appendChild(p);
    const text = fns.extractText(p);
    expect(text).toContain('visible caption');
    expect(text).not.toContain('stacked hidden caption');
    p.remove();
  });

  test('shouldTranslate skips a visibility:hidden block', () => {
    const p = document.createElement('p');
    p.textContent = 'Sergey Ponomarev for The New York Times';
    p.style.visibility = 'hidden';
    document.body.appendChild(p);
    expect(fns.shouldTranslate(p)).toBe(false);
    p.remove();
  });
});

// ─── v1.12.0：表格短词门槛 ──────────────────────────────────────────────────

describe('short table cells', () => {
  test('minTextLen lowers the bar for td/th only', () => {
    const td = document.createElement('td');
    const th = document.createElement('th');
    const p = document.createElement('p');
    expect(fns.minTextLen(td, 12)).toBe(3);
    expect(fns.minTextLen(th, 12)).toBe(3);
    expect(fns.minTextLen(p, 12)).toBe(12);
  });

  test('collectBlocks picks up short entity cells but not number cells', () => {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    for (const [name, val] of [['Chips', '61'], ['Funding', '55'], ['OpenAI', '72']]) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = name;
      const td2 = document.createElement('td');
      td2.textContent = val;
      tr.append(td1, td2);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    document.body.appendChild(table);
    const blocks = fns.collectBlocks();
    const texts = blocks.map(el => fns.extractText(el).trim());
    expect(texts).toContain('Chips');
    expect(texts).toContain('Funding');
    expect(texts).toContain('OpenAI');
    expect(texts).not.toContain('61'); // 纯数字列不送翻
    table.remove();
  });
});

// ─── v1.12.0：专有名词名单跳过 ──────────────────────────────────────────────

describe('looksLikeNameList', () => {
  test('detects a bullet-separated signatory wall', () => {
    const text = '1789 Capital • A.Team • Adam • Adaption • Agentastic • Agno • AI Native Foundation • AI Tinkerers • AI21 • alphaXiv • Amazon • AMD';
    expect(fns.looksLikeNameList(text)).toBe(true);
  });

  test('does not flag normal prose', () => {
    const text = 'Ceuta, Spain, and Fnideq, Morocco, are only a mile apart but they are intertwined by family and trade.';
    expect(fns.looksLikeNameList(text)).toBe(false);
  });

  test('does not flag short bullet runs (breadcrumbs)', () => {
    expect(fns.looksLikeNameList('Home • Products • Pricing')).toBe(false);
  });
});

// ─── v1.12.0：仅显示译文模式 ────────────────────────────────────────────────

describe('displayMode replace', () => {
  afterEach(() => fns.setDisplayMode('bilingual'));

  test('hides the original into a wrapper and shows only the translation', () => {
    fns.setDisplayMode('replace');
    const p = document.createElement('p');
    const a = document.createElement('a');
    a.href = 'https://example.com';
    a.textContent = 'Original text';
    p.appendChild(a);
    document.body.appendChild(p);

    fns.injectTranslation(p, '译文内容');

    const wrap = p.querySelector('[data-yll-orig]');
    expect(wrap).not.toBeNull();
    expect(wrap.className).toBe('yll-orig-hidden');
    expect(wrap.querySelector('a')).not.toBeNull(); // 原文节点结构保留
    const tr = p.querySelector('[data-yll-inject]');
    expect(tr.textContent).toBe('译文内容');
    p.remove();
  });

  test('removeTranslations restores the original DOM exactly', () => {
    fns.setDisplayMode('replace');
    const h2 = document.createElement('h2');
    h2.textContent = 'Machine translation';
    document.body.appendChild(h2);

    fns.injectTranslation(h2, '机器翻译');
    fns.removeTranslations();

    expect(h2.querySelector('[data-yll-orig]')).toBeNull();
    expect(h2.querySelector('[data-yll-inject]')).toBeNull();
    expect(h2.textContent).toBe('Machine translation');
    expect(h2.dataset.yllDone).toBeUndefined();
    h2.remove();
  });

  test('bilingual mode is unchanged (translation appended after)', () => {
    const p = document.createElement('p');
    p.textContent = 'Hello world paragraph';
    document.body.appendChild(p);
    fns.injectTranslation(p, '你好世界');
    expect(p.querySelector('[data-yll-orig]')).toBeNull();
    expect(p.nextElementSibling && p.nextElementSibling.className).toContain('yll-tr');
    p.nextElementSibling.remove();
    p.remove();
  });
});
