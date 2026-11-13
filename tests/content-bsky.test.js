/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://bsky.app/profile/bsky.app"}
 */
'use strict';

// Bluesky：页面没有 <p>，贴文正文是 div[data-testid=postText]，靠兜底叶子块收。
// 贴文末尾带「1/5」串号徽标的那些（一个 inline-flex 的 div）整页翻译一条都没收；
// 作者的显示名和 handle 被翻成「古时的猫」。骨架取自 2026-10 的 bsky.app。

const fs = require('fs');
const path = require('path');

let fns;
const sent = [];

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body; },
  });
  global.browser = {
    storage: { local: { get: () => Promise.resolve({ targetLang: 'zh-CN', engine: 'google' }) } },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (msg) => { sent.push(msg.text); return Promise.resolve({ success: true, translation: '测试翻译' }); },
    },
    i18n: require('./i18n-stub').i18n,
  };
  global.YLSensitive = require('../sensitive-mask.js');
  global.__yllTestMode = true;
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);
  fns = global.__yllInternals;
});

beforeEach(() => { sent.length = 0; fns.clearMemo(); });

const PILL = '<div id="pill" style="display:inline-flex"><span aria-label="Post 1 of 5" style="display:block">1/5</span></div>';

function feedItem(handle, name, body, { pill = false } = {}) {
  return `
    <div role="link" tabindex="0" data-testid="feedItem-by-${handle}">
      <div><a href="/profile/${handle}" aria-label="${name}'s avatar" role="link"><div data-testid="userAvatarImage"></div></a></div>
      <div>
        <div style="display:flex">
          <div class="author-row" style="display:flex">
            <a href="/profile/${handle}" dir="auto" aria-label="View profile" role="link">${name}</a>
            <a href="/profile/${handle}" dir="auto" aria-label="View profile" role="link">&nbsp;@${handle}</a>
          </div>
          <a href="/profile/${handle}/post/3abc" dir="auto" aria-label="October 30, 2026" data-tooltip="October 30, 2026" role="link"><span>· </span>1h</a>
        </div>
        <div data-testid="contentHider-post"><div style="display:flex">
          <div dir="auto" data-word-wrap="1" data-testid="postText">${body}${pill ? ' ' + PILL : ''}</div>
        </div></div>
      </div>
    </div>`;
}

function renderProfile() {
  document.body.innerHTML = `
    <div data-testid="profileScreen"><div data-testid="profileView">
      <div><div dir="auto" data-testid="profileHeaderDisplayName">Cats of Yore Archive<div style="display:inline-flex"><button aria-label="View verifications"></button></div></div></div>
      <div dir="auto" data-word-wrap="1" data-testid="profileHeaderDescription">Old photographs of cats, posted daily from the archives.</div>
      <a href="/profile/arbutocrat.bsky.social" aria-label="View Madrona Murphy's profile" role="link" data-testid="profileCard-arbutocrat.bsky.social-link">
        <div data-testid="CardOuter"><div>
          <div><div dir="auto" id="card-name">Madrona Murphy the Botanist</div></div>
          <div><div dir="auto" data-word-wrap="1" id="card-desc">Mercenary botanist and local scientist working on island ecology.</div></div>
        </div></div>
      </a>
      <div data-testid="postsFeed">
        ${feedItem('catsofyore.bsky.social', 'Cats of Yore', 'A cat sleeping in a basket of yarn, photographed around 1910.')}
        ${feedItem('bsky.app', 'Bluesky', 'New in beta: the moderation inbox. Now you can see the reports you have made.', { pill: true })}
        <div role="link" tabindex="0" data-testid="feedItem-by-bsky.app"><div data-testid="contentHider-post">
          <div dir="auto" data-word-wrap="1" data-testid="postText" id="quoting">Here is a quote of a stream we are excited about this week.</div>
          <div role="link" aria-label="Post by niedermeyer.online" tabindex="0"><div>
            <div><div><div dir="auto" id="embed-name">e.w. niedermeyer reporting</div><div dir="auto">&nbsp;@niedermeyer.online</div></div><div dir="auto" data-tooltip="Oct 20">· 10d</div></div>
            <div dir="auto" data-word-wrap="1" id="embed-text">Here's a reminder for my stream with Alex Gibney, happening this Tuesday.</div>
            <a href="https://atmo.rsvp/p/x" aria-label="Alex Gibney live" role="link"><div><div dir="auto" id="embed-card-title">Alex Gibney, Director of the documentary, live on the protocol</div></div></a>
          </div></div>
        </div></div>
      </div>
    </div></div>`;
}

const postWithPill = () => document.querySelector('[data-testid="feedItem-by-bsky.app"] [data-testid="postText"]');

test('a post ending in a thread-counter pill is collected by page translation', () => {
  renderProfile();
  const blocks = fns.collectBlocks();
  expect(blocks).toContain(postWithPill());
  expect(blocks).toContain(document.querySelector('[data-testid="feedItem-by-catsofyore.bsky.social"] [data-testid="postText"]'));
  expect(blocks.some(b => b.id === 'pill' || b.closest('#pill'))).toBe(false);
});

test('the pill is not part of the text sent, and stays in place', async () => {
  renderProfile();
  const post = postWithPill();
  expect(fns.extractText(post)).not.toMatch(/1\/5/);
  await fns.translateBlock(post);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/moderation inbox/);
  expect(sent[0]).not.toMatch(/1\/5/);
  expect(post.querySelector('#pill').textContent).toBe('1/5');
  expect(post.querySelector('[data-yll-inject]').textContent).toBe('测试翻译');
});

test('author display names and handles are not collected', () => {
  renderProfile();
  const blocks = fns.collectBlocks();
  const texts = blocks.map(b => fns.extractText(b));
  for (const name of ['Cats of Yore', 'catsofyore.bsky.social', 'Madrona Murphy', 'e.w. niedermeyer', 'niedermeyer.online']) {
    expect(texts.some(t => t.includes(name))).toBe(false);
  }
  expect(blocks.some(b => b.closest('.author-row'))).toBe(false);
  expect(blocks.some(b => b.closest('[data-testid="profileHeaderDisplayName"]'))).toBe(false);
});

test('prose next to the names is still collected', () => {
  renderProfile();
  const blocks = fns.collectBlocks();
  for (const id of ['card-desc', 'embed-text', 'embed-card-title', 'quoting']) {
    expect(blocks).toContain(document.getElementById(id));
  }
  expect(blocks).toContain(document.querySelector('[data-testid="profileHeaderDescription"]'));
});

test('the focused post of a thread keeps its author link untranslated', () => {
  document.body.innerHTML = `
    <div data-testid="postThreadItem-by-danielradosh.bsky.social">
      <a href="/profile/danielradosh.bsky.social" aria-label="Daniel Radosh" role="link"><div><div>
        <div dir="auto" id="anchor-name">Daniel Radosh</div>
        <div dir="auto" id="anchor-handle">@danielradosh.bsky.social</div>
      </div></div></a>
      <div dir="auto" data-word-wrap="1" id="anchor-text">The first thing I did this morning was check the weather report.${PILL}</div>
    </div>`;
  const blocks = fns.collectBlocks();
  expect(blocks).toContain(document.getElementById('anchor-text'));
  expect(fns.extractText(document.getElementById('anchor-text'))).not.toMatch(/1\/5/);
  expect(blocks).not.toContain(document.getElementById('anchor-name'));
  expect(blocks).not.toContain(document.getElementById('anchor-handle'));
  expect(fns.findHoverBlock(document.getElementById('anchor-name'))).toBeNull();
});

test('@mentions inside a post stay in the text sent', async () => {
  document.body.innerHTML = `<div data-testid="postsFeed">
    <div dir="auto" data-word-wrap="1" data-testid="postText" id="m">Thanks to <div style="display:inline-flex"><div style="display:inline-flex"><a href="/profile/did:plc:abc" role="link">@alexbenzer.com</a></div></div> for the update on search ranking today. ${PILL}</div></div>`;
  const post = document.getElementById('m');
  expect(fns.collectBlocks()).toContain(post);
  await fns.translateBlock(post);
  expect(sent[0]).toMatch(/Thanks to @alexbenzer\.com for the update/);
  expect(sent[0]).not.toMatch(/1\/5/);
});

test('trending topics link to a feed under /profile/ and are still collected', () => {
  document.body.innerHTML = `<div>
    <a href="/profile/did:plc:qrz3/feed/8a84" aria-label="Browse topic 8a84" role="link"><div><div dir="auto" id="topic">Halloween trick-or-treating traditions</div></div></a>
    <a href="/profile/bsky.app" aria-label="Reposted by Bluesky" role="link"><div><div dir="auto" id="repost">Reposted by Cats of Yore Archive</div></div></a></div>`;
  const blocks = fns.collectBlocks();
  expect(blocks).toContain(document.getElementById('topic'));
  expect(blocks).not.toContain(document.getElementById('repost'));
});

// 右栏底部的「Privacy ∙ Terms ∙ Help」：三个外链，骨架取自 2026-10 的 bsky.app
test('the side-column footer links are not collected', () => {
  document.body.innerHTML = `
    <main role="main"><div data-testid="postText" id="post">A cat sleeping in a basket of yarn, photographed around 1910.</div></main>
    <div><div dir="auto" id="footer"><a href="https://bsky.social/about/support/privacy-policy" aria-label="Privacy" role="link">Privacy</a><span> ∙ </span><a href="https://bsky.social/about/support/tos" aria-label="Terms" role="link">Terms</a><span> ∙ </span><a href="https://blueskyweb.zendesk.com/hc/en-us" aria-label="Help" role="link">Help</a></div></div>`;
  const blocks = fns.collectBlocks();
  expect(blocks).toContain(document.getElementById('post'));
  expect(blocks.some(b => b.closest('#footer') || b.contains(document.getElementById('footer')))).toBe(false);
});

// 回复贴上方的「Replied to <名字>」：名字被翻译、译文另起一行插在中间。骨架取自 2026-10 的 bsky.app
test('the "Replied to <name>" line above a reply is not collected', () => {
  document.body.innerHTML = `
    <div data-testid="postsFeed"><div role="link" tabindex="0" data-testid="feedItem-by-bsky.app">
      <div><svg width="12" height="12"></svg><div dir="auto" id="replied">Replied to <div><div><a href="/profile/alexfirer.bsky.social" aria-label="Mr. Buddy" role="link"><span>Mr. Buddy</span></a></div></div></div></div>
      <div dir="auto" data-word-wrap="1" data-testid="postText" id="reply">We are rolling out a fix for the notification delay this afternoon.</div>
    </div></div>`;
  const blocks = fns.collectBlocks();
  expect(blocks).toContain(document.getElementById('reply'));
  expect(blocks.some(b => b.id === 'replied' || b.closest('#replied') || b.contains(document.getElementById('replied')))).toBe(false);
  expect(fns.findHoverBlock(document.querySelector('#replied span'))).toBeNull();
});
