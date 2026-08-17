'use strict';

// 界面语言：跟随浏览器 UI 语言（chrome.i18n），中文用户看中文，其余看英文。
// The store listing ships in English and Chinese; the UI used to be Chinese
// only, so an English user installed it and could not read a single control.
//
// UMD：三个 HTML 页面直接用，jest 里 require。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.YLI18n = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const api = typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;

  function t(key, subs) {
    const msg = api && api.i18n ? api.i18n.getMessage(key, subs) : '';
    // A missing key must be loud in development and harmless in the store
    // build, so fall back to the key itself rather than an empty label.
    return msg || key;
  }

  /** True when the catalogue in use is the Chinese one — the only place
   *  language *names* differ, since the table carries both spellings. Asking
   *  the catalogue rather than getUILanguage() keeps names and labels in the
   *  same language even when the browser falls back to another locale. */
  function isZh() {
    return t('uiLocale') === 'zh';
  }

  /** Label for a row of YLLangs.ALL: ['zh-CN', 'Simplified Chinese', '简体中文'] */
  function langLabel(row) {
    if (!row) return '';
    const [, en, zh] = row;
    if (!isZh()) return en;
    return zh === en ? en : `${zh}（${en}）`;
  }

  // A few messages carry inline markup — a link, a <kbd>, a bold run. Build
  // those as real nodes instead of assigning innerHTML: store reviewers treat
  // any innerHTML in an extension as a red flag, and this file is the only
  // place we would have needed one.
  const RICH_TAGS = ['a', 'b', 'strong', 'kbd', 'code', 'em'];
  const RICH = new RegExp(
    `<(${RICH_TAGS.join('|')})((?:\\s+[a-zA-Z-]+="[^"]*")*)\\s*>([^<]*)</\\1>`,
    'g',
  );

  function renderRich(text) {
    const out = [];
    let last = 0;
    let m;
    RICH.lastIndex = 0;
    while ((m = RICH.exec(text)) !== null) {
      if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
      const el = document.createElement(m[1]);
      el.textContent = m[3];
      if (m[1] === 'a') {
        const href = /href="([^"]*)"/.exec(m[2]);
        // Only absolute http(s) links, so a bad message can never smuggle in a
        // javascript: URL.
        if (href && /^https?:\/\//i.test(href[1])) {
          el.setAttribute('href', href[1]);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener');
        }
      }
      out.push(el);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(document.createTextNode(text.slice(last)));
    return out;
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    // Sentences that carry a link or a <kbd> inside them.
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.textContent = '';
      renderRich(t(el.getAttribute('data-i18n-html'))).forEach((n) => el.appendChild(n));
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    // <optgroup label> — the group headings inside the engine picker.
    scope.querySelectorAll('[data-i18n-label]').forEach((el) => {
      el.setAttribute('label', t(el.getAttribute('data-i18n-label')));
    });
    const title = scope.querySelector('title[data-i18n-doc]');
    if (title) document.title = t(title.getAttribute('data-i18n-doc'));
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => apply());
    } else {
      apply();
    }
  }

  return { t, apply, isZh, langLabel };
});
