/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://github.com/LibreTranslate/LibreTranslate"}
 */
'use strict';

// GitHub 仓库首页：测试者报文件名被译（README.md→自述文件.md、LICENSE→执照、
// main.py→主要.py），日期被撑成两行，README 正文最后才翻。文件表和语言占比条
// 是名字和数据，整块不翻；README 是正文，排在界面前面。

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

// 仓库首页的骨架（2026-10 的 React 版文件表）
function renderRepo() {
  document.body.innerHTML = `
    <main>
      <p id="about">Free and Open Source Machine Translation API. Self-hosted, offline capable.</p>
      <table aria-labelledby="folders-and-files">
        <thead><tr><th>Name</th><th>Last commit message</th><th>Last commit date</th></tr></thead>
        <tbody>
          <tr class="react-directory-row">
            <td class="react-directory-row-name-cell-large-screen"><a href="/LibreTranslate/LibreTranslate/blob/main/README.md">README.md</a></td>
            <td class="react-directory-row-commit-cell"><a href="/LibreTranslate/LibreTranslate/commit/abc">Update readme with the new install steps</a></td>
            <td><relative-time datetime="2026-02-08">Feb 8, 2026</relative-time></td>
          </tr>
        </tbody>
      </table>
      <ul><li class="languageListItem__Y9dtVH">Batchfile 0.6%</li></ul>
      <article class="markdown-body">
        <h1>LibreTranslate</h1>
        <p id="readme">Free and Open Source Machine Translation API, entirely self-hosted.</p>
      </article>
    </main>`;
}

test('the file table and the language bar are not collected', () => {
  renderRepo();
  const blocks = fns.collectBlocks();
  expect(blocks.some(b => b.closest('table'))).toBe(false);
  expect(blocks.some(b => b.closest('[class*="languageListItem"]'))).toBe(false);
  expect(blocks).toContain(document.getElementById('readme'));
  expect(blocks).toContain(document.getElementById('about'));
});

test('README text ranks ahead of the rest of <main>', () => {
  renderRepo();
  expect(fns.rankOf(document.getElementById('readme'))).toBeLessThan(fns.rankOf(document.getElementById('about')));
});

test('sidebar fragments are not picked up as leaf blocks once the file table is skipped', () => {
  renderRepo();
  // 文件表排除后，页面大半文字落在非语义 div 里，通用兜底会把它们当叶子块
  const side = document.createElement('div');
  side.innerHTML = Array.from({ length: 12 }, (_, i) =>
    `<div class="BorderGrid-cell">${i + 100} watching this repository right now</div>`).join('');
  document.querySelector('main').appendChild(side);
  const blocks = fns.collectBlocks();
  expect(blocks.some(b => b.classList.contains('BorderGrid-cell'))).toBe(false);
});

test('header controls and repo nav tabs are not collected; the issue title in the page header is', () => {
  document.body.innerHTML = `
    <header class="AppHeader"><ul><li><a href="/notifications">Notifications for your account</a></li></ul></header>
    <main>
      <header class="prc-PageLayout-Header-0of-R">
        <h1 id="title">Translation stops after the first paragraph on long pages</h1>
        <ul class="list-style-none d-flex">
          <li id="notif"><a class="prc-Button-ButtonBase-9n-Xk" href="/login">Notifications</a>
            <span>You must be signed in to change notification settings</span></li>
          <li><a href="/login">Fork the repository to your own account</a></li>
        </ul>
      </header>
      <div id="repository-container-header"><ul class="pagehead-actions"><li>Star this repository on GitHub</li></ul></div>
      <div class="prc-UnderlineNav-UnderlineWrapper-abc"><ul><li>Issues and pull requests overview</li></ul></div>
      <article class="markdown-body"><p id="readme">Free and Open Source Machine Translation API, entirely self-hosted.</p></article>
    </main>`;
  const blocks = fns.collectBlocks();
  expect(blocks.map(b => b.id).filter(Boolean)).toEqual(['title', 'readme']);
  expect(blocks.some(b => b.tagName === 'LI')).toBe(false);
});
