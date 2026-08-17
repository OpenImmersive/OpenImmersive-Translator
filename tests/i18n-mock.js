'use strict';

// chrome.i18n.getMessage backed by the real Chinese catalogue, so tests keep
// asserting the strings users see and fail loudly when a key is missing from
// _locales rather than silently comparing raw keys.
const fs = require('fs');
const path = require('path');

const CATALOGUE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '_locales', 'zh_CN', 'messages.json'), 'utf8'),
);

function getMessage(key, subs) {
  const entry = CATALOGUE[key];
  if (!entry) return '';
  let msg = entry.message;
  const list = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
  list.forEach((s, i) => {
    msg = msg.split(`$${i + 1}`).join(String(s));
  });
  return msg;
}

module.exports = { getMessage };
