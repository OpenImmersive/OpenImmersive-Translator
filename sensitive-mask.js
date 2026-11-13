'use strict';

// 敏感信息脱敏（本地正则版，Beta）
// 发送给翻译引擎前把敏感信息替换成占位符（__PII_EMAIL_1__），翻译返回后按
// 记录还原。检测与还原全部在本地完成，原文敏感内容不会离开浏览器。
//
// 精度优先原则：宁可漏检也不误伤——财务文档里到处是数字，电话/卡号的
// 匹配都带校验或强格式约束（Luhn / 身份证 mod-11 / 国际区号前缀），
// 千分位数字（1,234,567）不在分隔符集合里，天然不会命中。
//
// 同一套占位符也给页面翻译保护行内代码（content.js，类型 CODE，始终开启）：
// 引擎会把 window 译成「窗口」，占位符则原样穿过。
//
// UMD：service worker / Firefox 事件页 / content script 挂全局 YLSensitive，
// jest 直接 require。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.YLSensitive = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

  // ── 校验器 ──────────────────────────────────────────────────────────────

  // Luhn 校验（银行卡）。13-19 位，过滤掉纯格式巧合的数字串。
  function luhnValid(digits) {
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = digits.charCodeAt(digits.length - 1 - i) - 48;
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  function isValidCard(raw) {
    return luhnValid(raw.replace(/[ -]/g, ''));
  }

  // 中国大陆 18 位身份证：出生日期合理性 + mod-11 校验码，双重校验后误报率极低。
  const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const ID_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  function isValidCnId(raw) {
    const year = +raw.slice(6, 10), month = +raw.slice(10, 12), day = +raw.slice(12, 14);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += (raw.charCodeAt(i) - 48) * ID_WEIGHTS[i];
    return ID_CHECK[sum % 11] === raw[17].toUpperCase();
  }

  // ── 检测器（按优先级排列，先命中的先占住区间）────────────────────────────

  // 已知前缀的 key：前缀够特别的只要求一个现实的最短长度（测试 key、截短的
  // 示例 key 比正式的短）。sk- 和 xox 这种短前缀后面可能是一串连字符词：去掉
  // 前缀（连同 proj-、ant-api03- 这类子前缀）后还带连字符的，要带数字或大小写
  // 混排——随机串几乎总有，「sk-hynix-news」没有。
  function looksRandom(raw) {
    const body = raw.replace(/^\w+-(?:(?:proj|svcacct|admin|ant(?:-api\d+|-admin\d+)?)-)?/, '');
    return !body.includes('-') || /\d/.test(body) || (/[a-z]/.test(body) && /[A-Z]/.test(body));
  }
  const KEY_END = '(?![A-Za-z0-9_-])';

  const DETECTORS = [
    // OpenAI / DeepSeek（sk-、sk-proj-）、Anthropic（sk-ant-api03-）同一个前缀
    { type: 'KEY', regexes: [
      new RegExp('\\bsk-[A-Za-z0-9_-]{16,}' + KEY_END, 'g'),
      /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,                               // Slack
    ], validate: looksRandom },
    { type: 'KEY', regexes: [
      new RegExp('\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}' + KEY_END, 'g'), // Stripe
      new RegExp('\\bgh[pousr]_[A-Za-z0-9]{16,}' + KEY_END, 'g'),                // GitHub
      new RegExp('\\bgithub_pat_[A-Za-z0-9_]{16,}' + KEY_END, 'g'),              // GitHub fine-grained
      /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                       // AWS access key
      new RegExp('\\bAIza[0-9A-Za-z_-]{30,}' + KEY_END, 'g'),                    // Google API key
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,    // JWT
    ] },
    { type: 'EMAIL', regexes: [
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ] },
    { type: 'IDCARD', regexes: [/(?<!\d)\d{17}[0-9Xx](?!\d)/g], validate: isValidCnId },
    // PHONE 必须先于 CARD：+86 分组号码的纯数字部分可能碰巧通过 Luhn；
    // 反向不会误伤——卡号无 + 前缀，且连续/分隔形态不满足电话正则的边界
    { type: 'PHONE', regexes: [
      /\+\d{1,3}[ -]?\d{2,4}(?:[ -]\d{2,4}){1,4}(?!\d)/g,                // 国际格式（必须带 +）
      /(?<!\d)(?:\(\d{3}\)\s?|\d{3}[-.])\d{3}[-.]\d{4}(?!\d)/g,          // 美式 (555) 123-4567 / 555-123-4567
      /(?<!\d)1[3-9]\d{9}(?!\d)/g,                                       // 中国大陆手机 11 位
    ] },
    { type: 'CARD', regexes: [/(?<!\d)\d(?:[ -]?\d){12,18}(?![\d-])/g], validate: isValidCard },
  ];

  function placeholderFor(type, serial) {
    return `__PII_${type}_${serial}__`;
  }

  /**
   * 打码。返回 { masked, entities }；entities 为空数组表示没有命中，
   * 调用方可跳过 restore。
   */
  function maskSensitive(text) {
    if (!text) return { masked: text, entities: [] };

    const spans = []; // { start, end, type, value }
    const overlaps = (s, e) => spans.some(x => s < x.end && e > x.start);

    for (const det of DETECTORS) {
      for (const re of det.regexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const start = m.index, end = m.index + m[0].length;
          if (overlaps(start, end)) continue;
          if (det.validate && !det.validate(m[0])) continue;
          spans.push({ start, end, type: det.type, value: m[0] });
        }
      }
    }
    if (spans.length === 0) return { masked: text, entities: [] };

    // 从后往前替换，避免偏移失效；序号按出现顺序（每类独立计数）。
    spans.sort((a, b) => a.start - b.start);
    const counters = {};
    const entities = spans.map(s => {
      counters[s.type] = (counters[s.type] || 0) + 1;
      return { type: s.type, serial: counters[s.type], value: s.value, start: s.start, end: s.end };
    });
    let masked = text;
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i];
      masked = masked.slice(0, e.start) + placeholderFor(e.type, e.serial) + masked.slice(e.end);
      delete e.start; delete e.end;
    }
    return { masked, entities };
  }

  /**
   * 还原。容忍引擎对占位符的常见改写：大小写变化、下划线旁插空格、
   * 尾部下划线丢失。找不到的占位符跳过（该实体在译文中缺失，只影响
   * 完整性不泄露信息）。
   */
  function restoreSensitive(text, entities) {
    if (!text || !entities || entities.length === 0) return text;
    return restoreCounting(text, entities).text;
  }

  /**
   * 同 restoreSensitive，另报有几个实体在译文里一处都没找到。调用方据此
   * 决定整段弃用（行内代码丢了比原文没翻更糟）。
   */
  function restoreCounting(text, entities) {
    let out = text || '';
    let missing = 0;
    // 序号降序还原，避免 _1 命中 _11 的前缀
    const ordered = [...entities].sort((a, b) => b.serial - a.serial);
    for (const e of ordered) {
      const re = new RegExp(
        '_{1,4}\\s*PII[_\\s]+' + e.type + '[_\\s]+' + e.serial + '(?!\\d)\\s*_{0,4}',
        'gi'
      );
      let hit = false;
      out = out.replace(re, () => { hit = true; return e.value; });
      if (!hit) missing++;
    }
    return { text: out, missing };
  }

  // ── 原样保留的产品名 ──────────────────────────────────────────────────────
  // 免费引擎会按字面意译的产品名（Bluesky→蓝天、Mastodon→乳齿象、
  // Homebrew→自制）和技术词（localhost→本地主机）：和行内代码一样换成占位符
  // 原样带回。只收在句首大写时也几乎不会是普通英文词的名字——Signal、Slack、
  // Threads、Notion 会把正文里的普通词一起冻住，不收。区分大小写、整词匹配；
  // 要加名字就加在这里。
  // 页面、划词、输入框（content.js）和文件翻译（file-translate.js）共用这一份。
  const KEEP_NAMES = /\b(?:Bluesky|Mastodon|Discord|Telegram|Docker|Homebrew|Copilot|Obsidian|localhost|stdin|stdout|stderr)\b/g;

  // text 里的名字换成占位符，原文按序记进 tokens；序号接着 tokens 里已有的往下编，
  // 和调用方自己的占位符（行内代码）共用一个 tokens 数组。
  function keepNames(text, tokens, type = 'NAME') {
    return String(text).replace(KEEP_NAMES, (name) => {
      const serial = tokens.length + 1;
      tokens.push({ type, serial, value: name });
      return placeholderFor(type, serial);
    });
  }

  // ── 一眼就是代码的词 ──────────────────────────────────────────────────────
  // 没有标记的纯文本（输入框、文件翻译）里的代码：`反引号` 包着的，和带括号的
  // 调用（useState()、fetch(url)）、点连起来的标识符（res.json、README.md）、
  // 驼峰（getItem）、下划线（snake_case）。每段都只有一个字母的（e.g、U.S）是
  // 缩写，file(s) 这种复数写法是普通词，都不算；邮箱和网址里的不算——它们归
  // 敏感信息脱敏认（打开脱敏时要换成 EMAIL 占位符）。已有的占位符不碰。
  const CODE_WORD = /`[^`\n]+`|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()\s]*\)|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g;

  // 和 keepNames 一样：原文按序记进 tokens，序号接着往下编
  function keepCode(text, tokens, type = 'CODE') {
    return String(text).split(/(__PII_[A-Z]+_\d+__)/).map((piece, k) => (k % 2 ? piece : piece.replace(CODE_WORD, (m, at) => {
      const run = piece.slice(0, at).match(/\S*$/)[0] + piece.slice(at).match(/^\S*/)[0];
      if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(m) || /^[A-Za-z]+\((?:e?s)\)$/.test(m) || /@|:\/\//.test(run)) return m;
      const serial = tokens.length + 1;
      tokens.push({ type, serial, value: m });
      return placeholderFor(type, serial);
    }))).join('');
  }

  // 给「原文进、译文出」的翻译函数包一层保留代码和名字：整段只剩它们就不送；
  // 引擎弄丢了占位符，按原文再问一次（名字被意译好过名字消失）。
  function withKeptWords(translateFn) {
    return async (text) => {
      const tokens = [];
      const masked = keepNames(keepCode(text, tokens), tokens);
      if (!tokens.length) return translateFn(text);
      if (!/\p{L}/u.test(masked.replace(/__PII_[A-Z]+_\d+__/g, ''))) return text;
      const out = await translateFn(masked);
      const restored = restoreCounting(out, tokens);
      return restored.missing ? translateFn(text) : restored.text;
    };
  }

  // ── 缩写 ──────────────────────────────────────────────────────────────────
  // 免费引擎拿不到上下文，短缩写会被猜成别的词（LLM→法学硕士）。全大写的
  // 独立词（2-6 个字母，可带数字和复数 s：LLM、LLMs、GPU、HTML5）换成占位符原样
  // 带回；AI 引擎看得懂上下文，由调用方决定不走这一步。
  // 不保护的情况：整段只有缩写（没什么可给上下文的，原样交给引擎）；全大写的
  // 词至少三个、且多过带小写的词（喊口号的标题，DO NOT TOUCH 里每个词都是普通
  // 词）；下面这份名单——
  // 有固定译名的国家与机构（US→美国）和常被写成大写的普通词（NOT、FREE）；
  // 罗马数字（IV→第四）。
  const ACRONYM = /\b([A-Z][A-Z0-9]*[A-Z0-9])(s?)\b/g;
  const ACRONYM_TRANSLATE = new Set([
    'US', 'USA', 'UK', 'EU', 'UN', 'NATO', 'NASA', 'FBI', 'CIA', 'WHO',
    'AM', 'PM', 'TV', 'OK', 'NO', 'YES', 'NOT', 'NEW', 'FREE',
  ]);

  function isAcronym(base) {
    const letters = base.replace(/[0-9]/g, '').length;
    return letters >= 2 && letters <= 6 && !ACRONYM_TRANSLATE.has(base) && !/^[IVX]+$/.test(base);
  }

  function shouting(text) {
    const words = text.match(/\p{L}[\p{L}\p{N}]*/gu) || [];
    const caps = words.filter(w => w.length >= 2 && /\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w)).length;
    const lower = words.filter(w => /\p{Ll}/u.test(w)).length;
    return caps >= 3 && caps > lower;
  }

  // 返回 { text, tokens }；tokens 为空表示没动原文。按行判断：页面翻译把几个
  // 短块按行拼成一个请求，文件翻译把几十行字幕拼成一个，每行各算各的。
  function keepAcronyms(text) {
    const src = String(text);
    const tokens = [];
    const out = src.split('\n').map((line) => {
      if (shouting(line.replace(/__PII_[A-Z]+_\d+__/g, ' '))) return line;
      const before = tokens.length;
      const kept = line.replace(ACRONYM, (m, base) => {
        if (!isAcronym(base)) return m;
        const serial = tokens.length + 1;
        tokens.push({ type: 'ACRO', serial, value: m });
        return placeholderFor('ACRO', serial);
      });
      if (tokens.length > before && !/\p{L}/u.test(kept.replace(/__PII_[A-Z]+_\d+__/g, ''))) {
        tokens.length = before;
        return line;
      }
      return kept;
    }).join('\n');
    return tokens.length ? { text: out, tokens } : { text: src, tokens };
  }

  return { maskSensitive, restoreSensitive, restoreCounting, placeholderFor, keepNames, keepCode, withKeptWords, keepAcronyms };
});
