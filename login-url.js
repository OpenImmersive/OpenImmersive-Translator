'use strict';

// All extension sign-in entry points follow the browser UI language.
(function (root) {
  root.OILoginUrl = function (site) {
    const api = typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
    const language = (api && api.i18n && api.i18n.getUILanguage
      ? api.i18n.getUILanguage()
      : navigator.language).toLowerCase().replace(/_/g, '-');
    const parts = language.split('-');
    const base = parts[0];
    const path = base === 'zh'
      ? parts.some((part) => ['tw', 'hk', 'mo', 'hant'].includes(part)) ? '/zh-tw' : '/zh'
      : ['ja', 'ko', 'es', 'pt'].includes(base) ? `/${base}` : '/';
    return `${site.replace(/\/$/, '')}${path}?login=1`;
  };
})(globalThis);
