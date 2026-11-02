# 隐私政策 / Privacy Policy

**OpenImmersive Translator** — 最后更新 / Last updated: 2026-08-15

## 中文

OpenImmersive Translator 是一款开源、隐私优先的双语网页翻译浏览器扩展。

**我们不收集任何数据。** 具体而言：

- **无中间服务器**：所有翻译请求由你的浏览器直接发往你所选择的翻译引擎（如 Google、DeepL、OpenAI 等）。我们不运营任何中转、代理或遥测服务器，扩展不向开发者发送任何信息。
- **待翻译文本**：仅发送给你选择的翻译引擎用于获取译文。各引擎对这些文本的处理受其各自隐私政策约束。
- **敏感信息脱敏（可选，默认关闭）**：开启后，扩展在你的浏览器**本地**识别邮箱、电话、银行卡号、身份证号、API Key，先替换为占位符再发给翻译引擎，收到译文后在本地还原。被打码的敏感内容原文不会发往任何翻译服务商，该功能不依赖任何服务器。
- **API Key（BYOK）**：你自行配置的 API Key 仅保存在浏览器本地存储（`storage.local`）中，只用于向对应引擎发起请求，绝不会发送到其他任何地方。
- **设置项**：目标语言、引擎选择等偏好仅保存在浏览器本地。
- **无跟踪**：不含任何统计、分析、广告或指纹代码。
- **可审计**：全部源代码开源（AGPL-3.0），任何人可以验证以上声明与代码行为一致。

权限说明：

| 权限 | 用途 |
| --- | --- |
| `storage` | 在本地保存你的设置与 API Key |
| `activeTab` / 网站访问权限 | 读取当前页面文本以进行翻译、在页面中插入译文 |

## English

OpenImmersive Translator is an open-source, privacy-first bilingual webpage translation extension.

**We collect no data.** Specifically:

- **No middle server**: translation requests go directly from your browser to the translation engine you choose (Google, DeepL, OpenAI, etc.). We operate no relay, proxy, or telemetry servers; the extension sends nothing to the developers.
- **Text to translate** is sent only to your chosen engine to obtain the translation, governed by that engine's own privacy policy.
- **Sensitive-data masking (optional, off by default)**: when enabled, the extension detects emails, phone numbers, card numbers, national ID numbers, and API keys **locally in your browser**, replaces them with placeholders before sending text to the engine, and restores them locally afterwards. Masked originals are never sent to any translation provider; no server is involved.
- **API keys (BYOK)** are stored only in your browser's local storage (`storage.local`), used only to call the corresponding engine, and never sent anywhere else.
- **Preferences** (target language, engine choice) are stored locally.
- **No tracking**: no analytics, ads, or fingerprinting code of any kind.
- **Auditable**: the full source code is open (AGPL-3.0); anyone can verify these claims against the code.

Permissions:

| Permission | Purpose |
| --- | --- |
| `storage` | Save your settings and API keys locally |
| `activeTab` / site access | Read page text for translation and insert translations into the page |

## 联系 / Contact

nolan.byte@outlook.com
