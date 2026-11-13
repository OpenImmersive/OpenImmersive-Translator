'use strict';

// 简单文本格式的本地翻译：把文件拆成「骨架 + 可翻译单元」，只把单元送去翻译，
// 再按原骨架拼回。骨架（序号、时间轴、样式行、代码块、标签、换行符本身）一个
// 字节不改。单元里夹着的标记（行内代码、链接地址、字幕特效、行内 HTML 标签）
// 换成和页面翻译同一套占位符（__PII_TAG_n__），整句一次送出，译文回来再换回
// 原样；引擎弄丢了占位符，这一单元退回逐段翻译。
//
// 占位符和字母贴在一起时（`__PII_TAG_1__dashboard__PII_TAG_2__`），引擎把整串
// 当成一个标识符原样带回，所以送出前在两者之间补一个空格；译文回来再按目标语言
// 收拾占位符两侧的空白（见 tidySpaces）。
// 复杂格式（PDF/Word 等保留排版的）不在插件做，跳官网服务。
//
// UMD：options 页直接用（sensitive-mask.js 先加载），jest 里 require。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./sensitive-mask.js'));
  else root.YLFile = factory(root.YLSensitive);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (YLSensitive) {

  const FORMATS = ['srt', 'ass', 'html', 'txt', 'md'];

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  // ── 文档模型 ─────────────────────────────────────────────────────────────
  // 一个文件 = 片段数组。字符串是骨架，原样输出；对象是可翻译单元：
  //   src     送去翻译的文本（标记已换成占位符）
  //   orig    没翻成时的输出：字符串，或片段数组（HTML 里可能夹着 alt 单元）
  //   tokens  占位符 → 原标记，value 同样可以是片段数组
  //   lines   srt 多行字幕：译文按原行数拆回，sep 是原来的换行符
  //   escape  'text' | 'attr'：HTML 里的译文先转义再放回
  //   lang    目标语言码，决定占位符旁的空白怎么收拾、字幕在哪断行
  //   out     译文（已转义、占位符未还原）；undefined 表示没翻成，输出 orig
  const HAS_LETTER = /\p{L}/u;
  const PLACEHOLDER = /__PII_TAG_\d+__/g;

  function unit(src, orig, tokens = [], extra = {}) {
    if (tokens.length) src = padPlaceholders(src, tokens);
    return { src, orig, tokens, ...extra };
  }

  function hasProse(src) {
    return HAS_LETTER.test(src.replace(PLACEHOLDER, ''));
  }

  // 把 text 里命中 re 的标记换成占位符，原标记按序记进 tokens；kindOf 给出
  // 标记的种类（见 tidySpaces）
  function protect(text, re, tokens, kindOf = () => 'mark') {
    return text.replace(re, (m) => {
      const serial = tokens.length + 1;
      tokens.push({ type: 'TAG', serial, value: m, kind: kindOf(m) });
      return YLSensitive.placeholderFor('TAG', serial);
    });
  }

  // ── 占位符两侧的空白 ─────────────────────────────────────────────────────
  // 每个标记有一个种类：
  //   open   开标签（<a>、**、[），右侧是标签里面
  //   close  闭标签（</a>、**、](url)），左侧是标签里面
  //   atom   自成一体（<code>…</code>、<img>、`code`、裸链接），两侧都在外面
  //   mark   字幕特效之类的位置标记，两侧空白一律照原文
  // 引擎给的空白只会被删或压成一个空格，从不新增：
  //   不用空格分词的目标语言（中日泰…）：标签里面的空白删掉，外面的照原文，
  //   紧挨标点的删掉；外面的空白两边都是汉字或假名时也删掉（读 <a>门户</a> 中
  //   →读<a>门户</a>中），「两边」隔着标签看标签里面的字。_ 和 __ 强调例外：
  //   贴着汉字的 _ 在 markdown 里不算强调的开闭
  //   用空格分词的目标语言：标签里面的照原文，外面的压成一个空格（原文是中文
  //   时原文那里本来就没有空格，不能照原文删）
  const NO_SPACE_LANG = /^(zh|ja|yue|th|lo|km|my|bo|dz)(-|$)/i;
  const WORD_CHAR = /[\p{L}\p{N}]/u;
  const LOOSE_PLACEHOLDER = /_{1,4}[ \t]*PII[_ \t]+TAG[_ \t]+(\d+)(?!\d)(?:[ \t]*_{1,2})?/gi;

  // 记下原文里每个占位符两侧有没有空白（gap），再把贴着字母的一侧隔开
  function padPlaceholders(src, tokens) {
    const bySerial = new Map(tokens.map(t => [t.serial, t]));
    return src.replace(PLACEHOLDER, (m, at) => {
      const before = src[at - 1] || '', after = src[at + m.length] || '';
      const t = bySerial.get(+m.slice(10, -2));
      if (t) t.gap = { before: /\s/.test(before), after: /\s/.test(after) };
      return (WORD_CHAR.test(before) ? ' ' : '') + m + (WORD_CHAR.test(after) ? ' ' : '');
    });
  }

  // 把 s 里的占位符序号 n 换成 map(n)；认不出的写法原样留着
  function renumber(s, map) {
    return s.replace(LOOSE_PLACEHOLDER, (m, n) => YLSensitive.placeholderFor('TAG', map(+n)));
  }

  // 成对的标记（开标签和它的闭标签）在译文里仍然开在前、闭在后、两对之间
  // 不交错，原文里夹着文字的一对，译文里也还夹着文字
  function pairsIntact(out, src, tokens) {
    const stack = [], pairs = [];
    for (const t of tokens) {
      if (t.kind === 'open') stack.push(t);
      else if (t.kind === 'close' && stack.length) pairs.push([stack.pop(), t]);
    }
    if (!pairs.length) return true;
    const where = (s) => {
      const at = new Map();
      let m;
      const re = new RegExp(LOOSE_PLACEHOLDER.source, 'gi');
      while ((m = re.exec(s)) !== null) if (!at.has(+m[1])) at.set(+m[1], { start: m.index, end: re.lastIndex });
      return at;
    };
    const a = where(out), b = where(src);
    const span = (at, [o, c]) => at.has(o.serial) && at.has(c.serial) && [at.get(o.serial), at.get(c.serial)];
    const inside = [];
    for (const pair of pairs) {
      const o = span(a, pair), i = span(b, pair);
      if (!o) continue;
      if (o[0].start > o[1].start) return false;
      if (i && hasProse(src.slice(i[0].end, i[1].start)) && !hasProse(out.slice(o[0].end, o[1].start))) return false;
      inside.push([o[0].start, o[1].start]);
    }
    return !inside.some(([s1, e1]) => inside.some(([s2, e2]) => s1 < s2 && s2 < e1 && e1 < e2));
  }

  function keepGap(tok, side, noSpace) {
    const had = tok.gap ? tok.gap[side] : true;
    if (!tok.kind || tok.kind === 'mark') return had;
    const inner = (tok.kind === 'open' && side === 'after') || (tok.kind === 'close' && side === 'before');
    if (noSpace) return inner ? false : had;
    return inner ? had : true;
  }

  const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

  // 自成一体的标记显示出来的文字（<code>fetch()</code> → fetch()）
  function atomText(tok) {
    return render(tok.value).replace(/<[^>]*>|`/g, '').trim();
  }

  // 译文里的占位符写回标准形式，两侧空白按上面的规则收拾；字符串两端不动
  function tidySpaces(s, tokens, lang) {
    const noSpace = NO_SPACE_LANG.test(lang || '');
    const bySerial = new Map(tokens.map(t => [String(t.serial), t]));
    const texts = [], marks = [];
    let last = 0, m;
    LOOSE_PLACEHOLDER.lastIndex = 0;
    while ((m = LOOSE_PLACEHOLDER.exec(s)) !== null) {
      texts.push(s.slice(last, m.index));
      const tok = bySerial.get(String(+m[1]));
      marks.push({ tok, raw: tok ? YLSensitive.placeholderFor('TAG', tok.serial) : m[0] });
      last = LOOSE_PLACEHOLDER.lastIndex;
    }
    texts.push(s.slice(last));
    const ws = (keep) => (keep ? ' ' : '');
    // 第 i 个标记左边（side 'left'）或右边紧挨的空白，隔着它看过去的第一个字：
    // 开标签往里看它后面的译文，闭标签往里看它前面的，自成一体的看它自己的文字
    const seenThrough = (i, side) => {
      const tok = marks[i] && marks[i].tok;
      if (!tok || /^_/.test(typeof tok.value === 'string' ? tok.value : '')) return '';
      if (tok.kind === 'atom') { const a = atomText(tok); return side === 'left' ? a[0] || '' : a.slice(-1); }
      if (side === 'left' && tok.kind === 'open') {
        const next = texts[i + 1].trimStart();
        return next ? next[0] : seenThrough(i + 1, 'left');
      }
      if (side === 'right' && tok.kind === 'close') {
        const prev = texts[i].trimEnd();
        return prev ? prev.slice(-1) : (i > 0 ? seenThrough(i - 1, 'right') : '');
      }
      return '';
    };
    const cjkBoth = (a, b) => noSpace && CJK_CHAR.test(a || '') && CJK_CHAR.test(b || '');
    for (let j = 0; j < texts.length; j++) {
      const left = j > 0 ? marks[j - 1].tok : null;
      const right = j < marks.length ? marks[j].tok : null;
      const keepL = !left || keepGap(left, 'after', noSpace);
      const keepR = !right || keepGap(right, 'before', noSpace);
      let t = texts[j];
      if (j > 0 && j < marks.length && /^[ \t]+$/.test(t)) {
        texts[j] = ws(keepL && keepR && !cjkBoth(seenThrough(j - 1, 'right'), seenThrough(j, 'left')));
        continue;
      }
      const punct = (ch) => noSpace && /\p{P}/u.test(ch || '');
      if (left) t = t.replace(/^[ \t]+(.?)/u, (all, ch) => ws(keepL && !punct(ch) && !cjkBoth(ch, seenThrough(j - 1, 'right'))) + ch);
      if (right) t = t.replace(/(.?)[ \t]+$/u, (all, ch) => ch + ws(keepR && !punct(ch) && !cjkBoth(ch, seenThrough(j, 'left'))));
      texts[j] = t;
    }
    return texts.map((t, j) => t + (j < marks.length ? marks[j].raw : '')).join('');
  }

  function render(p) {
    if (typeof p === 'string') return p;
    if (Array.isArray(p)) return p.map(render).join('');
    const orig = render(p.orig);
    if (p.out === undefined) return orig;
    let s = YLSensitive.restoreSensitive(p.out, p.tokens.map(t => ({ ...t, value: render(t.value) })));
    if (p.lines > 1) s = splitBalanced(s.trim(), p.lines, p.lang).join(p.sep);
    return keepEdgeSpace(orig, s);
  }

  function collectUnits(parts, acc = []) {
    for (const p of parts) {
      if (typeof p === 'string') continue;
      if (Array.isArray(p)) { collectUnits(p, acc); continue; }
      acc.push(p);
      if (Array.isArray(p.orig)) collectUnits(p.orig, acc);
    }
    return acc;
  }

  // 每行连同它自己的换行符（\n、\r\n，末行为空串）一起保存，拼回时原样还原
  function splitLines(text) {
    const lines = [];
    const re = /\r?\n/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      lines.push({ body: text.slice(last, m.index), eol: m[0] });
      last = re.lastIndex;
    }
    lines.push({ body: text.slice(last), eol: '' });
    return lines;
  }

  // ── srt ──────────────────────────────────────────────────────────────────
  // 序号行与 `00:00:01,000 --> 00:00:04,000` 时间轴保持原样。一条字幕的几行
  // 是同一句话，合成一句翻译，再按原行数拆回；每行都以破折号开头的是两个人的
  // 对白，各翻各的。
  const SRT_TAG = /<[^>]+>|\{\\[^}]*\}/g;

  function parseSrt(text) {
    const lines = splitLines(text);
    const parts = [];
    for (let i = 0; i < lines.length;) {
      const { body, eol } = lines[i++];
      parts.push(body, eol);
      if (!body.includes('-->')) continue;
      let j = i;
      while (j < lines.length && lines[j].body.trim() !== '') j++;
      const cue = lines.slice(i, j);
      i = j;
      if (!cue.length) continue;
      const dialog = cue.length > 1 && cue.every(l => /^\s*[-–—]/.test(l.body));
      if (cue.length === 1 || dialog) {
        for (const l of cue) parts.push(srtUnit([l.body], l.body, ''), l.eol);
        continue;
      }
      const last = cue[cue.length - 1];
      const orig = cue.slice(0, -1).map(l => l.body + l.eol).join('') + last.body;
      parts.push(srtUnit(cue.map(l => l.body), orig, cue[0].eol), last.eol);
    }
    return parts;
  }

  function subtitleKind(tag) {
    if (tag[0] !== '<') return 'mark';
    return htmlKind(tag);
  }

  function srtUnit(bodies, orig, sep) {
    const tokens = [];
    const src = bodies.map(b => protect(b.trim(), SRT_TAG, tokens, subtitleKind)).join(' ');
    if (!hasProse(src)) return orig;
    return unit(src, orig, tokens, { lines: bodies.length, sep });
  }

  // 译文拆回 n 行：断点尽量让各行等宽（中日韩字按两格算），优先断在标点后；
  // 中日文本只在词边界断（Intl.Segmenter 按目标语言分词；没有 Segmenter 时
  // 只断在标点后），拉丁文只在空格处断。词边界里还要排除：数词和后面的量词、
  // 单位（十九|世纪、1950|年代、第|一个），以及数词连着数词的日期时间
  // （二十世纪|五十年代、3月|5日）、行首的虚词（的、了、吗…）、日文行首
  // 的平假名词（助词、词尾：は、に、され、ました）。找不到断点就少拆几行，
  // 绝不多于原行数。
  const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;
  const NO_LINE_START = /[\s,.;:!?)\]}%\-，。、；：！？）」』】》…]/;
  const BREAK_AFTER = /[,.;:!?，。、；：！？]/;
  const NUMERAL = /^[\d０-９〇零一二三四五六七八九十百千万亿两几第]+$/;
  const ZH_NO_START = /^的|^[了着过们吗呢吧啊么地得之]$/;
  const HIRAGANA_WORD = /^[\u3041-\u309f]+$/;
  const CJK_START = /^[\u3040-\u30ff\u3400-\u9fff]/;

  // 分词用的语言：目标语言是中文或日文时按它；没给目标语言时看译文本身
  function segmenterLocale(lang, text) {
    if (/^ja/i.test(lang || '')) return 'ja';
    if (/^(zh|yue)/i.test(lang || '')) return 'zh';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    return /[\u3400-\u9fff]/.test(text) ? 'zh' : undefined;
  }

  function width(s) {
    let w = 0;
    for (const ch of s) w += CJK.test(ch) ? 2 : 1;
    return w;
  }

  function insideMarkup(text, k) {
    return text.lastIndexOf('<', k - 1) > text.lastIndexOf('>', k - 1) ||
      text.lastIndexOf('{', k - 1) > text.lastIndexOf('}', k - 1);
  }

  function breakPoints(text, lang) {
    let bounds;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      bounds = [];
      const locale = segmenterLocale(lang, text);
      // 前两个非空白的词：「3 个」中间隔着空格也算数词加量词
      let prev = '', prev2 = '';
      for (const { index, segment } of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
        if (!segment.trim()) continue;
        const ok = index > 0 && !(NUMERAL.test(prev) && CJK_START.test(segment)) &&
          !(NUMERAL.test(prev2) && CJK_START.test(prev) && NUMERAL.test(segment)) &&
          !ZH_NO_START.test(segment) &&
          !(locale === 'ja' && HIRAGANA_WORD.test(segment) && !BREAK_AFTER.test(prev.slice(-1)));
        if (ok) bounds.push(index);
        prev2 = prev;
        prev = segment;
      }
    } else {
      bounds = Array.from({ length: Math.max(text.length - 1, 0) }, (_, i) => i + 1)
        .filter(k => text[k - 1] === ' ' || BREAK_AFTER.test(text[k - 1]));
    }
    return bounds.filter(k => !NO_LINE_START.test(text[k]) &&
      (text[k - 1] === ' ' || CJK.test(text[k - 1]) || CJK.test(text[k])) &&
      !insideMarkup(text, k));
  }

  function splitBalanced(text, n, lang) {
    if (n <= 1) return [text];
    const cands = breakPoints(text, lang);
    const total = width(text);
    const lines = [];
    let start = 0;
    for (let i = 1; i < n; i++) {
      const target = total * i / n;
      let best = -1, bestScore = Infinity;
      for (const k of cands) {
        if (k <= start) continue;
        const head = text.slice(0, k).trimEnd();
        const bonus = BREAK_AFTER.test(head.slice(-1)) ? total / n / 4 : 0;
        const score = Math.abs(width(head) - target) - bonus;
        if (score < bestScore) { best = k; bestScore = score; }
      }
      if (best < 0) break;
      lines.push(text.slice(start, best).trim());
      start = best;
    }
    lines.push(text.slice(start).trim());
    return lines.filter(Boolean);
  }

  // ── ass ──────────────────────────────────────────────────────────────────
  // 只有 `Dialogue:` 行的最后一个逗号段是台词；其余（脚本信息、样式、Format）
  // 不动。台词里的 `{\...}` 特效标签原样保留；\N 硬换行和 srt 的多行字幕
  // 一样处理：整句翻译，再按原行数拆回、用 \N 接上。
  const ASS_TAG = /\{[^}]*\}|\\[nh]/g;

  function parseAss(text) {
    const parts = [];
    for (const { body, eol } of splitLines(text)) {
      // Dialogue 前 9 个字段是固定元数据，第 10 段起才是台词（台词自身可含逗号）
      const idx = /^Dialogue\s*:/i.test(body) ? nthIndexOf(body, ',', 9) : -1;
      if (idx < 0) { parts.push(body, eol); continue; }
      const line = body.slice(idx + 1);
      const tokens = [];
      const rows = line.split('\\N');
      const src = rows.map(r => protect(r.trim(), ASS_TAG, tokens)).join(' ');
      parts.push(body.slice(0, idx + 1),
        hasProse(src) ? unit(src, line, tokens, { lines: rows.length, sep: '\\N' }) : line, eol);
    }
    return parts;
  }

  function nthIndexOf(s, ch, n) {
    let i = -1;
    for (let k = 0; k < n; k++) { i = s.indexOf(ch, i + 1); if (i < 0) return -1; }
    return i;
  }

  // ── html ─────────────────────────────────────────────────────────────────
  // 块级标签之间的一段行内内容（文字 + a/em/strong… + 行内代码）是一句话，
  // 整段作一个单元：行内标签和整个 <code>/<kbd>/<samp>/<var> 元素换成占位符。
  // <pre>/<script>/<style> 等整体不动。img 等标签的 alt/title 单独翻。
  const HTML_TOKEN = /<!--[\s\S]*?-->|<(script|style|pre|textarea|template|svg|math|noscript|code|kbd|samp|var)\b[^>]*>[\s\S]*?<\/\1\s*>|<[!/]?[a-zA-Z][^>]*>/gi;
  const HTML_ATOMIC = new Set(['code', 'kbd', 'samp', 'var']);
  const HTML_INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'data', 'del', 'dfn',
    'em', 'font', 'i', 'img', 'ins', 'label', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub',
    'sup', 'time', 'u', 'wbr']);
  const HTML_VOID = new Set(['br', 'img', 'wbr', 'hr', 'input']);
  const HTML_ATTR = /(\s(?:alt|title)\s*=\s*)("([^"]*)"|'([^']*)')/gi;

  function parseHtml(text) {
    const parts = [];
    let run = [];
    const flush = () => { if (run.length) parts.push(...htmlRun(run)); run = []; };
    let last = 0, m;
    HTML_TOKEN.lastIndex = 0;
    while ((m = HTML_TOKEN.exec(text)) !== null) {
      if (m.index > last) run.push(text.slice(last, m.index));
      last = HTML_TOKEN.lastIndex;
      const raw = m[0];
      const name = (m[1] || (/^<\/?([a-zA-Z][\w-]*)/.exec(raw) || [])[1] || '').toLowerCase();
      if (raw.startsWith('<!--') || HTML_ATOMIC.has(name)) run.push({ tag: [raw], kind: 'atom' });
      else if (m[1]) { flush(); parts.push(raw); }
      else if (HTML_INLINE.has(name)) run.push({ tag: attrParts(raw), kind: htmlKind(raw) });
      else { flush(); parts.push(...attrParts(raw)); }
    }
    if (last < text.length) run.push(text.slice(last));
    flush();
    return parts;
  }

  function htmlRun(run) {
    const tokens = [];
    const orig = [];
    let src = '';
    for (const r of run) {
      if (typeof r === 'string') { orig.push(r); src += decodeEntities(r); continue; }
      const serial = tokens.length + 1;
      tokens.push({ type: 'TAG', serial, value: r.tag, kind: r.kind });
      orig.push(r.tag);
      src += YLSensitive.placeholderFor('TAG', serial);
    }
    src = squash(src);
    if (!hasProse(src)) return orig;
    return [unit(src, orig, tokens, { escape: 'text' })];
  }

  // 行内标签的种类（见 tidySpaces）；markdown 的 <https://…> 自动链接也走这里
  function htmlKind(raw) {
    if (raw.startsWith('<!--') || raw.endsWith('/>') || /^<[a-z][\w+.-]*:|@/i.test(raw)) return 'atom';
    if (raw.startsWith('</')) return 'close';
    const name = ((/^<([a-zA-Z][\w-]*)/.exec(raw) || [])[1] || '').toLowerCase();
    return HTML_VOID.has(name) ? 'atom' : 'open';
  }

  function attrParts(raw) {
    if (raw.startsWith('</')) return [raw];
    const out = [];
    let last = 0, m;
    HTML_ATTR.lastIndex = 0;
    while ((m = HTML_ATTR.exec(raw)) !== null) {
      const val = m[3] !== undefined ? m[3] : m[4];
      const src = squash(decodeEntities(val));
      if (!HAS_LETTER.test(src)) continue;
      const start = m.index + m[1].length + 1;
      out.push(raw.slice(last, start), unit(src, val, [], { escape: 'attr' }));
      last = start + val.length;
    }
    out.push(raw.slice(last));
    return out;
  }

  // HTML 里的连续空白只是排版，合成一个空格送出：单元里不带换行才能拼批
  function squash(s) {
    return s.replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '');
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (_) { return all; }
    });
  }

  // 已经是实体的 & 不再转一次：引擎原样带回的 &mdash; 仍是 &mdash;
  function escapeHtml(s, mode) {
    let out = s.replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (mode === 'attr') out = out.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return out;
  }

  // ── md ───────────────────────────────────────────────────────────────────
  // 围栏代码块、缩进代码、空行、文件头的 front matter 原样保留；行首的标题/
  // 列表/引用标记不送翻译；行内代码、链接地址、裸链接、行内 HTML 标签换成
  // 占位符。一个段落（或列表项）折成几行时，几行合成一句翻译，译文写回成
  // 一行：markdown 里段内换行渲染出来就是一个空格，写成一行显示不变，比按
  // 原宽度重新折行简单，也不用猜中文该在哪折。没翻成的段落原样输出所有行。
  // 链接的 [ 和 ](地址) 各是一个占位符：只留 ](地址) 的话引擎看见落单的 [，
  // 会自己补一个 ]。强调（** * __ _ ~~）的开闭标记也各是一个占位符，中间的
  // 文字照常翻译；行内代码整个是一个占位符，不翻。
  const MD_PREFIX = /^\s*(?:>\s?|#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/;
  const MD_INLINE = /``.+?``|`[^`]*`|!?\[(?=[^\]]*\]\()|\]\([^)]*\)|<[^>]+>|https?:\/\/[^\s<>()]+|\\\|/g;

  // 成对的强调标记。_ 在词中间不算（snake_case_name），\* 是转义不算
  const MD_EMPHASIS = [
    /(?<![\\*])(\*{1,3})(?=[^\s*])([^]*?[^\s*\\])\1(?!\*)/g,
    /(?<![\p{L}\p{N}_\\])(_{1,3})(?=[^\s_])([^]*?[^\s_\\])\1(?![\p{L}\p{N}_])/gu,
    /(?<![~\\])(~~)(?=[^\s~])([^]*?[^\s~\\])\1(?!~)/g,
  ];

  // 行内标记换成占位符。先找代码、链接、标签、裸链接，再在剩下的文字里找成对
  // 的强调标记（已占住的位置先涂掉，免得代码里的 * 被当成强调）；嵌套的强调
  // 一层层往里找。
  function mdInline(text) {
    const spans = [];
    let m;
    MD_INLINE.lastIndex = 0;
    while ((m = MD_INLINE.exec(text)) !== null) {
      spans.push({ start: m.index, end: MD_INLINE.lastIndex, kind: mdKind(m[0]) });
    }
    const blank = (str, a, b) => str.slice(0, a) + '\u0001'.repeat(b - a) + str.slice(b);
    let masked = spans.reduce((str, sp) => blank(str, sp.start, sp.end), text);
    for (let depth = 0; depth < 3; depth++) {
      const found = [];
      for (const re of MD_EMPHASIS) {
        re.lastIndex = 0;
        while ((m = re.exec(masked)) !== null) {
          const n = m[1].length, end = m.index + m[0].length;
          found.push({ start: m.index, end: m.index + n, kind: 'open' }, { start: end - n, end, kind: 'close' });
        }
      }
      if (!found.length) break;
      for (const sp of found) masked = blank(masked, sp.start, sp.end);
      spans.push(...found);
    }
    spans.sort((a, b) => a.start - b.start);
    const tokens = [];
    let src = '', last = 0;
    for (const sp of spans) {
      const serial = tokens.length + 1;
      tokens.push({ type: 'TAG', serial, value: text.slice(sp.start, sp.end), kind: sp.kind });
      src += text.slice(last, sp.start) + YLSensitive.placeholderFor('TAG', serial);
      last = sp.end;
    }
    return { src: src + text.slice(last), tokens };
  }

  function mdKind(tok) {
    if (tok[0] === '[' || tok.startsWith('![')) return 'open';
    if (tok[0] === ']') return 'close';
    if (tok[0] === '<') return htmlKind(tok);
    return 'atom';
  }

  // 表格：表头行下面紧跟一行对齐行（|---|:--:|）才算表格，往下到空行为止。
  // 每个单元格各是一个单元，竖线和格子两边的空格原样留下；对齐行不动。
  const MD_QUOTE = /^[ \t]*(?:>[ \t]?)*/;
  const MD_ALIGN_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  // 能打断段落的行：标题、围栏、列表项、分隔线、setext 下划线、HTML 块
  const MD_BLOCK_START = /^[ \t]*(?:```|~~~|#{1,6}(?:[ \t]|$)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|-+[ \t]*$|<!--|<\/?(?:address|article|aside|blockquote|details|div|dl|dd|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|script|style)\b)/i;
  const MD_HARD_BREAK = /(?: {2,}|\\)$/;

  // 第 k 行能不能接在上一行的段落后面：同一引用层级、不是空行、不开新块
  function continuesParagraph(lines, k, depth) {
    const body = lines[k].body;
    if (quoteDepth(body) !== depth) return false;
    const rest = body.slice(MD_QUOTE.exec(body)[0].length);
    return rest.trim() !== '' && !MD_BLOCK_START.test(rest) && !isTableStart(lines, k);
  }

  function quoteDepth(body) {
    return (MD_QUOTE.exec(body)[0].match(/>/g) || []).length;
  }

  function isTableStart(lines, i) {
    const head = lines[i].body, next = lines[i + 1] && lines[i + 1].body;
    if (next === undefined || quoteDepth(head) !== quoteDepth(next)) return false;
    const align = next.slice(MD_QUOTE.exec(next)[0].length);
    return head.includes('|') && align.includes('|') && MD_ALIGN_ROW.test(align);
  }

  // 按没转义、不在行内代码里的 | 切开一行
  function splitCells(row) {
    const cuts = [];
    for (let k = 0; k < row.length; k++) {
      const ch = row[k];
      if (ch === '\\') { k++; continue; }
      if (ch === '`') {
        const tick = /^`+/.exec(row.slice(k))[0];
        const close = row.indexOf(tick, k + tick.length);
        if (close > 0) k = close + tick.length - 1;
        continue;
      }
      if (ch === '|') cuts.push(k);
    }
    const parts = [];
    let last = 0;
    for (const k of cuts) {
      parts.push(...mdCell(row.slice(last, k)), '|');
      last = k + 1;
    }
    parts.push(...mdCell(row.slice(last)));
    return parts;
  }

  function mdCell(cell) {
    const [, lead, content, trail] = /^([ \t]*)([^]*?)([ \t]*)$/.exec(cell);
    const { src, tokens } = mdInline(content);
    if (!hasProse(src)) return [cell];
    return [lead, unit(src, content, tokens), trail];
  }

  // 缩进四格的行在列表里是嵌套的列表项或列表项的续行，不是缩进代码：列表项的
  // 正文从标记后面那一列算起，缩进比它再多四格才是代码。空行之后顶格的非列表
  // 行，或顶格开新块（标题、围栏……）的行，结束列表。
  const MD_LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?=\S)/;
  const indentOf = (body) => /^[ \t]*/.exec(body)[0].replace(/\t/g, '    ').length;

  function parseMd(text) {
    const parts = [];
    let inFence = false;
    let listIndent = -1; // 当前列表最近一项的正文起始列；-1 = 不在列表里
    let prevBlank = false;
    const lines = splitLines(text);
    let i = 0;
    if (lines.length > 1 && lines[0].body.replace(/^\uFEFF/, '') === '---') {
      const close = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)$/.test(l.body));
      if (close > 0) for (; i <= close; i++) parts.push(lines[i].body, lines[i].eol);
    }
    for (; i < lines.length; i++) {
      const { body, eol } = lines[i];
      const blank = body.trim() === '';
      const wasBlank = prevBlank;
      prevBlank = blank;
      if (/^\s*(```|~~~)/.test(body)) { inFence = !inFence; parts.push(body, eol); continue; }
      if (inFence || blank) { parts.push(body, eol); continue; }
      const indent = indentOf(body);
      const item = MD_LIST_ITEM.exec(body);
      if (listIndent >= 0 && !item && indent < 2 && (wasBlank || MD_BLOCK_START.test(body))) listIndent = -1;
      if (indent >= (listIndent >= 0 ? listIndent + 4 : 4)) { parts.push(body, eol); continue; }
      if (item) listIndent = item[0].replace(/\t/g, '    ').length;
      if (isTableStart(lines, i)) {
        const depth = quoteDepth(body), head = i;
        for (let j = head; j < lines.length; j++) {
          const row = lines[j].body;
          if (j > head + 1 && (!row.trim() || !row.includes('|') || quoteDepth(row) !== depth)) break;
          const quote = MD_QUOTE.exec(row)[0];
          const rest = row.slice(quote.length);
          parts.push(quote, ...(j === head + 1 ? [rest] : splitCells(rest)), lines[j].eol);
          i = j;
        }
        continue;
      }
      const prefix = MD_PREFIX.exec(body)[0];
      const rest = body.slice(prefix.length);
      // 自己没有文字的行（分隔线、setext 下划线、只有代码的行）不开段落
      if (!hasProse(mdInline(rest).src)) { parts.push(body, eol); continue; }
      const depth = quoteDepth(body);
      let end = i;
      // 标题只占一行；以 HTML 标签开头的行可能是 HTML 块，也不往下合
      if (!/^(?:#{1,6}(?:[ \t]|$)|<[!/a-zA-Z])/.test(body.slice(MD_QUOTE.exec(body)[0].length).trimStart())) {
        while (end + 1 < lines.length && !MD_HARD_BREAK.test(lines[end].body) &&
          continuesParagraph(lines, end + 1, depth)) end++;
      }
      let joined = rest, orig = rest;
      if (end > i) {
        const more = lines.slice(i + 1, end + 1);
        joined = [rest, ...more.map(l => l.body.slice(MD_QUOTE.exec(l.body)[0].length))].map(t => t.trim()).join(' ');
        orig = rest + lines.slice(i, end).map((l, k) => l.eol + more[k].body).join('');
      }
      const { src, tokens } = mdInline(joined);
      parts.push(prefix, unit(src, orig, tokens), lines[end].eol);
      i = end;
    }
    return parts;
  }

  // ── txt ──────────────────────────────────────────────────────────────────
  function parseTxt(text) {
    const parts = [];
    for (const { body, eol } of splitLines(text)) {
      parts.push(HAS_LETTER.test(body) ? unit(body, body) : body, eol);
    }
    return parts;
  }

  function parse(format, text) {
    switch (format) {
      case 'srt': return parseSrt(text);
      case 'ass': return parseAss(text);
      case 'html': return parseHtml(text);
      case 'md': return parseMd(text);
      case 'txt': return parseTxt(text);
      default: throw new Error(`unsupported format: ${format}`);
    }
  }

  // 批量翻译。translateFn(text) -> Promise<string>；失败的单元保留原文，
  // 让用户至少拿到一个结构完整、部分翻译的文件，而不是整份失败。
  //
  // 但"保留原文"必须可见：引擎整条链路挂掉时（没配 Key、AI 档没登录、
  // 官网接口 404），每个单元都失败、每个都退回原文，最后交出一份和输入
  // 一模一样的文件还显示"完成"。所以返回值带上 failed/firstError，
  // 调用方能判断"部分没翻"和"根本没翻"。
  //
  // 多个单元拼成一个请求（按 \n 对齐拆回）：字幕文件动辄上千行，逐行请求
  // 一部 90 分钟纪录片要 6 分多钟；50 行一批直接压到半分钟内。引擎返回的
  // 行数对不上这一批就拆成单个单元重新排队，和其余批次一起受并发上限约束
  // （与页面翻译同为 4），正确性不赌批量，速度也不退回串行。
  async function translateFile({ format, text, translateFn, targetLang, concurrency = 4, onProgress,
    batchLines = 50, batchChars = 1800 }) {
    translateFn = YLSensitive.withKeptWords(translateFn);
    const parts = parse(format, text);
    const units = collectUnits(parts);
    for (const u of units) u.lang = targetLang;
    const total = units.length;
    let done = 0, translated = 0, failed = 0;
    let firstError = null;
    const noteError = (err) => {
      if (!firstError) firstError = (err && err.message) || String(err);
    };
    const progress = () => { done++; if (onProgress) onProgress(done, total); };
    const esc = (u, s) => (u.escape ? escapeHtml(s, u.escape) : s);
    const setOut = (u, s) => { u.out = u.tokens.length ? tidySpaces(s, u.tokens, u.lang) : s; };

    // 'ok' | 'empty' | 'lost'（占位符没能全部认回、成对标记被拆乱，或混进了
    // 别的单元的占位符）
    function settle(u, t) {
      if (!t || !t.trim()) return 'empty';
      if (t === u.src) return 'ok'; // 引擎原样带回：输出保持原字节
      const s = esc(u, t);
      if (u.tokens.length) {
        const { text: restored, missing } = YLSensitive.restoreCounting(s, u.tokens);
        if (missing || !pairsIntact(s, u.src, u.tokens) || new RegExp(LOOSE_PLACEHOLDER.source, 'i').test(restored)) return 'lost';
      }
      setOut(u, s);
      return 'ok';
    }

    // 占位符被弄丢：逐段翻译占位符之间的文字，标记按原位拼回
    async function piecewise(u) {
      const chunks = u.src.split(/(__PII_TAG_\d+__)/);
      let any = false;
      for (let k = 0; k < chunks.length; k += 2) {
        const c = chunks[k];
        let t = '';
        if (HAS_LETTER.test(c)) {
          try { t = await translateFn(c.trim()); } catch (err) { noteError(err); }
        }
        if (t && t.trim()) any = true;
        chunks[k] = t && t.trim() ? keepEdgeSpace(c, esc(u, t)) : esc(u, c);
      }
      if (any) setOut(u, chunks.join(''));
      return any;
    }

    async function runOne(u) {
      let r;
      try {
        r = settle(u, await translateFn(u.src));
      } catch (err) {
        noteError(err);
        r = 'empty';
      }
      if (r === 'lost') r = (await piecewise(u)) ? 'ok' : 'empty';
      if (r === 'ok') translated++; else failed++;
      progress();
    }

    // 一批里每个单元的占位符各自从 1 编号，引擎看见好几行都有 __PII_TAG_1__
    // 会把它们搅在一起；所以送出前整批接着编号，回来再按行减回去
    async function runBatch(batch) {
      if (batch.length === 1) return runOne(batch[0]);
      const offsets = [];
      let next = 0;
      const wire = batch.map((u) => {
        offsets.push(next);
        next += u.tokens.length;
        return renumber(u.src, (n) => n + offsets[offsets.length - 1]);
      });
      let lines = null;
      try {
        lines = String((await translateFn(wire.join('\n'))) || '').split('\n');
      } catch (err) { noteError(err); }
      if (!lines || lines.length !== batch.length) {
        queue.push(...batch.map(u => [u]));
        return;
      }
      batch.forEach((u, k) => {
        const own = (n) => (n > offsets[k] && n <= offsets[k] + u.tokens.length ? n - offsets[k] : 0);
        const r = settle(u, renumber(lines[k], own));
        if (r === 'lost') { queue.push([u]); return; }
        if (r === 'ok') translated++; else failed++;
        progress();
      });
    }

    // 组批：自带换行的单元会破坏按行对齐，单独成批
    const queue = [];
    let cur = [], curLen = 0;
    const flush = () => { if (cur.length) { queue.push(cur); cur = []; curLen = 0; } };
    for (const u of units) {
      if (u.src.includes('\n')) { flush(); queue.push([u]); continue; }
      if (cur.length >= batchLines || curLen + u.src.length > batchChars) flush();
      cur.push(u); curLen += u.src.length;
    }
    flush();

    await new Promise((resolve) => {
      let active = 0;
      const pump = () => {
        while (active < concurrency && queue.length) {
          const batch = queue.shift();
          active++;
          const next = () => { active--; pump(); };
          runBatch(batch).then(next, next);
        }
        if (!active && !queue.length) resolve();
      };
      pump();
    });

    return { text: render(parts), total, translated, failed, firstError };
  }

  // 片段两端的空白是排版的一部分（md 行内片段尤其明显），翻译服务会吃掉它们。
  function keepEdgeSpace(src, translated) {
    const lead = (src.match(/^\s*/) || [''])[0];
    const trail = (src.match(/\s*$/) || [''])[0];
    return lead + translated.trim() + trail;
  }

  return { FORMATS, extOf, parse, translateFile, keepEdgeSpace, splitBalanced };
});
