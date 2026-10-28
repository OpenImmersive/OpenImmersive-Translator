'use strict';

// The extension reads every user-facing string through chrome.i18n. Tests run
// outside a browser, so give them the real English catalogue rather than a
// stub that returns the key — otherwise the assertions stop checking wording.
const fs = require('fs');
const path = require('path');

const MESSAGES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '_locales', 'en', 'messages.json'), 'utf8'),
);

function getMessage(key, subs) {
  const entry = MESSAGES[key];
  if (!entry) return '';
  let out = entry.message;
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  // $NAME$ placeholders map to $1, $2 … in declaration order.
  for (const [name, def] of Object.entries(entry.placeholders || {})) {
    const idx = Number(String(def.content).replace('$', '')) - 1;
    out = out.replace(new RegExp('\\$' + name + '\\$', 'gi'), String(list[idx] ?? ''));
  }
  return out;
}

module.exports = { i18n: { getMessage, getUILanguage: () => 'en-US' }, MESSAGES };
