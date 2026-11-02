// build-store.mjs — produce store-ready packages: webpage translation ONLY.
// The PDF module (pdf/, 35MB of wasm/fonts) is deliberately excluded — it is
// moving to the paid server-side product and never ships in the open extension.
//
// Outputs:
//   dist-store/chrome/   + yulingling-chrome-v<version>.zip   (CWS)
//   dist-store/firefox/  + yulingling-firefox-v<version>.zip  (AMO)
//
// Run: node build-store.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'dist-store');

// 已上架的 Firefox 扩展 ID —— 更新必须沿用，改了会被 AMO 视为新扩展。
const GECKO_ID = 'yulingling@openimmersive.github.io';
const STORE_NAME = 'OpenImmersive Translator';
// CWS 硬限制：manifest description ≤132 字符（长版文案放商店 listing，不放这里）
const STORE_DESCRIPTION =
  '开源、隐私优先的双语翻译插件：整页双语对照、划词/悬停/输入框翻译、199 种语言。' +
  '翻译请求直连所选引擎，无中间服务器、零数据收集；可选敏感信息本地脱敏。';
// Files that ship in the store package. Explicit allowlist — nothing else leaks in.
const SHIP = [
  'background.js', 'sensitive-mask.js', 'content.js', 'content.css',
  'file-translate.js', 'languages.js', 'i18n.js',
  'popup.html', 'popup.js', 'options.html', 'options.js',
  'welcome.html', 'welcome.js',
  'icons', 'LICENSE', 'PRIVACY.md',
];
// _locales must be copied on its own: the underscore-prefix filter below exists
// to keep local scratch out of the package, and it would swallow this too.
const SHIP_DOTTED = ['_locales'];

rmSync(OUT, { recursive: true, force: true });

for (const target of ['chrome', 'firefox']) {
  const dir = join(OUT, target);
  mkdirSync(dir, { recursive: true });
  for (const f of SHIP) {
    const src = join(ROOT, f);
    if (!existsSync(src)) { console.warn(`  ! missing ${f} — skipped`); continue; }
    // Skip local scratch inside shipped directories (e.g. icons/_yll-bak-*),
    // which is untracked leftovers that must never reach a store package.
    cpSync(src, join(dir, f), {
      recursive: true,
      filter: (s) => !basename(s).startsWith('_'),
    });
  }
  for (const f of SHIP_DOTTED) {
    const src = join(ROOT, f);
    if (!existsSync(src)) { console.warn(`  ! missing ${f} — skipped`); continue; }
    cpSync(src, join(dir, f), { recursive: true });
  }

  // Firefox's store titles are shorter; retain all existing UI messages.
  const overrides = join(ROOT, 'store-locales', target);
  if (existsSync(overrides)) {
    for (const locale of readdirSync(overrides)) {
      const file = join(dir, '_locales', locale, 'messages.json');
      const messages = JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(messages, JSON.parse(readFileSync(join(overrides, locale, 'messages.json'), 'utf8')));
      writeFileSync(file, JSON.stringify(messages, null, 2) + '\n');
    }
  }

  // ── manifest: strip PDF, patch per-browser ──
  const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  // Name and description stay as __MSG_ placeholders so the store package is
  // localized the same way the UI is; the short description lives in
  // _locales/*/messages.json under extDescShort (CWS caps it at 132 chars).
  m.name = '__MSG_extStoreName__';
  m.action.default_title = '__MSG_extName__';
  m.description = '__MSG_extDescShort__';
  // Drop pdf/* web-accessible resources; drop the block entirely if empty.
  if (m.web_accessible_resources) {
    m.web_accessible_resources = m.web_accessible_resources
      .map(e => ({ ...e, resources: (e.resources || []).filter(r => !r.startsWith('pdf/')) }))
      .filter(e => e.resources.length > 0);
    if (m.web_accessible_resources.length === 0) delete m.web_accessible_resources;
  }
  // wasm-unsafe-eval existed only for the (excluded) tesseract OCR — an
  // unnecessarily relaxed CSP invites reviewer questions. Tighten to default.
  delete m.content_security_policy;
  if (target === 'firefox') {
    // Firefox MV3 uses event pages, not service workers. sensitive-mask.js must
    // load first — event pages have no importScripts (background.js guards it).
    m.background = { scripts: ['sensitive-mask.js', 'languages.js', 'background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        strict_min_version: '115.0',
        // AMO requirement for new submissions (2025-11+): declare data collection.
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');

  // popup 的「翻译 PDF」现在只是跳 pdf.openimmersive.ai 的外链（无本地 pdf/ 依赖），
  // 商店版可原样保留，不再需要剥离。popup.html/popup.js 已由上面的 SHIP 拷贝。

  // ── zip ──
  const version = m.version;
  const zipName = `openimmersive-${target}-v${version}.zip`;
  execSync(`cd "${dir}" && zip -qr "../${zipName}" .`, { stdio: 'inherit' });
  console.log(`✓ ${target}: dist-store/${zipName}`);
}
console.log('done');
