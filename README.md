# OpenImmersive Translator

[![CI](https://github.com/OpenImmersive/Open-Immersive-Translator/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenImmersive/Open-Immersive-Translator/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

## About This Project

This project started from a simple need: many friends around me rely on immersive translation tools in their daily work and study, but they also care deeply about data security and privacy.

Since some popular immersive translation tools are not open source, it can be difficult for users to fully understand how their data is processed. To address this concern, I decided to build and open-source an AI-native translation project in my spare time.

The goal of this project is to provide a privacy-focused translation experience that is simple, transparent, and accessible. It removes unnecessary complex settings and is designed especially for users with little or no technical background.

This project focuses on:

* Data security and privacy protection
* Open-source transparency
* AI-native translation experience
* Simple setup and easy daily use
* Accessibility for non-technical users

The vision is to make AI-powered translation more trustworthy, easier to use, and safer for everyone.

## Features

- **Bilingual, in place** — side-by-side translation on the page you are reading. No copy-paste, no uploading your content to someone else's website. Toggle with `Alt+T`.
- **Privacy by architecture** — translation requests go directly from your browser to the engine you choose. No middle server, no proxy, no telemetry, zero data collection ([privacy policy](PRIVACY.md)).
- **Sensitive-data masking (Beta)** — optional, off by default. Emails, phone numbers, bank card numbers (Luhn-validated), national ID numbers, and API keys (`sk-…`, `ghp_…`, `AKIA…`, JWT, …) are detected **locally**, replaced with placeholders before the text is sent to any engine, and restored locally afterwards. The originals never leave your browser. See [`sensitive-mask.js`](sensitive-mask.js).
- **Transparent engines, BYOK** — free out of the box (Google, MyMemory, LibreTranslate — self-hostable); bring your own key for DeepL / OpenAI / DeepSeek. Keys are stored in `storage.local` only.
- **14 target languages**, Chrome (MV3 service worker) and Firefox (MV3 event page) supported.

## Install

**From source (Chrome / Edge):**

1. Clone this repository
2. Open `chrome://extensions`, enable *Developer mode*
3. *Load unpacked* → select the repository folder

**From source (Firefox):** in `manifest.json`, replace the `background` block with `{"scripts": ["sensitive-mask.js", "background.js"]}`, then load via `about:debugging` → *Load Temporary Add-on*.

Store listings (Chrome Web Store / Firefox Add-ons) are pending review.

## How sensitive-data masking works

```
"Contact admin@example.com or call 13812345678"
        │  local detection (regex + checksums)
        ▼
"Contact __PII_EMAIL_1__ or call __PII_PHONE_1__"   →  translation engine
        │  translated text returns
        ▼
"联系 admin@example.com 或致电 13812345678"            ←  local restore
```

Detection is precision-first: card numbers must pass a Luhn check, Chinese national IDs must pass the mod-11 checksum, so financial figures, years, and thousand-separated numbers in ordinary text are never touched. Restore tolerates the common ways engines mangle placeholders (case changes, inserted spaces, dropped trailing underscores). Enable it in the extension options page.

## Development

```bash
npm install
npm test        # jest — unit + integration (masking round-trips through translate())
```

No build step: the extension loads directly from source. `background.js` routes all engines through a single `translate()` entry point; `sensitive-mask.js` is a dependency-free UMD module.

## License

This project is licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only).

You may use, study, modify, and distribute this project under the terms of the AGPL-3.0-only license.

If you modify this project, distribute it, or make it available as part of a network service, you must make the corresponding source code available under the same license.

For commercial closed-source use, please contact the project maintainer for a separate commercial license.
