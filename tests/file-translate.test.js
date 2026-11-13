'use strict';

const YLFile = require('../file-translate.js');

// Fake engine: uppercases, so it is obvious which segments were sent for
// translation and which were preserved verbatim.
const upper = async (t) => t.toUpperCase();

describe('extOf', () => {
  test('reads the extension case-insensitively', () => {
    expect(YLFile.extOf('movie.SRT')).toBe('srt');
    expect(YLFile.extOf('notes.md')).toBe('md');
    expect(YLFile.extOf('noext')).toBe('');
  });
});

describe('srt', () => {
  const src = ['1', '00:00:01,000 --> 00:00:04,000', 'Hello there', '', '2',
    '00:00:05,000 --> 00:00:07,500', 'General Kenobi'].join('\n');

  test('keeps indices and timings, translates only the caption lines', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'srt', text: src, translateFn: upper });
    expect(out).toContain('00:00:01,000 --> 00:00:04,000');
    expect(out).toContain('HELLO THERE');
    expect(out.split('\n')[0]).toBe('1');
    expect(out).toContain('GENERAL KENOBI');
  });
});

describe('ass', () => {
  const src = [
    '[Script Info]',
    'Title: Example',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}Hello, world{\\i0}',
  ].join('\n');

  test('translates only the dialogue text and preserves override tags', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'ass', text: src, translateFn: upper });
    expect(out).toContain('[Script Info]');
    expect(out).toContain('Title: Example');
    expect(out).toContain('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,');
    expect(out).toContain('{\\i1}');
    expect(out).toContain('{\\i0}');
    expect(out).toContain('HELLO, WORLD');
  });
});

describe('html', () => {
  const src = '<div class="a">Hello</div><script>var x = "keep me";</script><p>World</p>';

  test('translates text nodes but never tags or script bodies', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'html', text: src, translateFn: upper });
    expect(out).toContain('<div class="a">');
    expect(out).toContain('HELLO');
    expect(out).toContain('var x = "keep me";');
    expect(out).toContain('WORLD');
    expect(out).not.toContain('KEEP ME');
  });
});

describe('md', () => {
  const src = [
    '# Title',
    '',
    'Some text with `inline code` and a [link](https://example.com).',
    '',
    '```js',
    'const untouched = 1;',
    '```',
  ].join('\n');

  test('protects code fences, inline code and link targets', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'md', text: src, translateFn: upper });
    expect(out).toContain('const untouched = 1;');
    expect(out).toContain('`inline code`');
    expect(out).toContain('](https://example.com)');
    expect(out).toContain('SOME TEXT WITH');
    expect(out).toContain('# TITLE');
  });
});

describe('txt', () => {
  test('translates non-empty lines and keeps blank ones', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'txt', text: 'one\n\ntwo', translateFn: upper });
    expect(out).toBe('ONE\n\nTWO');
  });
});

describe('failure handling', () => {
  test('a failing segment keeps its original text instead of failing the file', async () => {
    const flaky = async (t) => { if (t.includes('boom')) throw new Error('engine down'); return t.toUpperCase(); };
    const res = await YLFile.translateFile({ format: 'txt', text: 'fine\nboom here\nalso fine', translateFn: flaky });
    expect(res.text).toBe('FINE\nboom here\nALSO FINE');
    expect(res.failed).toBe(1);
    expect(res.translated).toBe(2);
    expect(res.firstError).toBe('engine down');
  });

  // 整条引擎链路挂掉（没配 Key / AI 档没登录 / 接口 404）时每个片段都退回原文，
  // 交出的文件和输入一模一样。调用方必须能把这种情况和"部分没翻"区分开，
  // 否则界面只会显示"完成"，用户拿到一份根本没翻的文件。
  test('a dead engine reports every segment as failed, not a finished file', async () => {
    const dead = async () => { throw new Error('AI 翻译档即将上线'); };
    const res = await YLFile.translateFile({ format: 'txt', text: 'one\ntwo\nthree', translateFn: dead });
    expect(res.text).toBe('one\ntwo\nthree');
    expect(res.translated).toBe(0);
    expect(res.failed).toBe(3);
    expect(res.total).toBe(3);
    expect(res.firstError).toBe('AI 翻译档即将上线');
  });

  // 引擎不抛错、只是回空串（某些代理挂掉时的表现）同样算失败。
  test('an engine that answers with nothing counts as failure too', async () => {
    const silent = async () => '';
    const res = await YLFile.translateFile({ format: 'txt', text: 'one\ntwo', translateFn: silent });
    expect(res.translated).toBe(0);
    expect(res.failed).toBe(2);
  });

  test('a healthy engine reports no failures', async () => {
    const res = await YLFile.translateFile({ format: 'txt', text: 'one\ntwo', translateFn: upper });
    expect(res.failed).toBe(0);
    expect(res.translated).toBe(2);
    expect(res.firstError).toBeNull();
  });
});

describe('keepEdgeSpace', () => {
  test('restores leading and trailing whitespace the engine trimmed', () => {
    expect(YLFile.keepEdgeSpace('  hi ', 'salut')).toBe('  salut ');
  });
});

// ─── 批量请求（v1.12.0）────────────────────────────────────────────────────────

describe('batching', () => {
  test('many short lines go out in few requests, not one per line', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line number ${i}`);
    let calls = 0;
    const counting = async (t) => { calls++; return t.toUpperCase(); };
    const { text: out } = await YLFile.translateFile({ format: 'txt', text: lines.join('\n'), translateFn: counting });
    expect(out).toContain('LINE NUMBER 0');
    expect(out).toContain('LINE NUMBER 99');
    expect(calls).toBeLessThanOrEqual(5); // 100 行 ≤5 个请求（默认 50 行/批）
  });

  test('falls back to per-line when the engine merges lines', async () => {
    // 引擎把整批合并成一行（行数对不上）→ 该批落回逐行，结果仍全部译出
    const merging = async (t) => t.includes('\n') ? 'MERGED INTO ONE' : t.toUpperCase();
    const { text: out } = await YLFile.translateFile({ format: 'txt', text: 'aaa\nbbb\nccc', translateFn: merging });
    expect(out).toBe('AAA\nBBB\nCCC');
  });

  test('an empty translated line inside a batch keeps the original text', async () => {
    const dropSecond = async (t) => {
      if (!t.includes('\n')) return t.toUpperCase();
      const ls = t.split('\n');
      return ls.map((l, i) => (i === 1 ? '' : l.toUpperCase())).join('\n');
    };
    const { text: out } = await YLFile.translateFile({ format: 'txt', text: 'aaa\nbbb\nccc', translateFn: dropSecond });
    expect(out).toBe('AAA\nbbb\nCCC');
  });

  test('progress reports total translatable lines', async () => {
    const seen = [];
    await YLFile.translateFile({
      format: 'txt', text: 'aaa\nbbb\nccc', translateFn: upper,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen[seen.length - 1]).toEqual([3, 3]);
  });
});

// ─── 往返：未翻的部分一个字节都不改 ────────────────────────────────────────────

const identity = async (t) => t;
// 只动字母，占位符本来就是大写，原样穿过
const shout = async (t) => t.toUpperCase();

function sentBy(fn) {
  const sent = [];
  const wrapped = async (t) => { sent.push(t); return fn(t); };
  return { sent, fn: wrapped };
}

describe('ass round trip', () => {
  const src = '﻿' + [
    '[Script Info]',
    '; Script generated by Aegisub 3.2.2',
    'Title: Demo',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,0,0,2,10,10,10,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}Hello, world{\\i0}',
    'Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,First line\\Nsecond line\\nsoft break',
    'Comment: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,not shown',
    '',
  ].join('\r\n');

  test('an identity engine gives back the file byte for byte', async () => {
    const res = await YLFile.translateFile({ format: 'ass', text: src, translateFn: identity });
    expect(res.text).toBe(src);
  });

  test('only dialogue text changes; every other line and line break stays', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'ass', text: src, translateFn: shout });
    const a = src.split('\r\n'), b = out.split('\r\n');
    expect(b.length).toBe(a.length);
    a.forEach((line, i) => {
      if (!line.startsWith('Dialogue:')) { expect(b[i]).toBe(line); return; }
      const head = line.slice(0, line.lastIndexOf(',,') + 2);
      expect(b[i].startsWith(head)).toBe(true);
    });
    expect(out).toContain(',,{\\i1}HELLO, WORLD{\\i0}\r\n');
    const dialogue = b.find(l => l.includes('0:00:05.00'));
    const said = dialogue.slice(dialogue.lastIndexOf(',,') + 2);
    expect(said.split('\\N')).toHaveLength(2);
    expect(said.replace('\\N', ' ')).toBe('FIRST LINE SECOND LINE\\nSOFT BREAK');
  });

  // \N 把一句台词拆成两行：整句送出，译文再按 \N 拆回两行
  test('a dialogue line broken with \\N goes out as one sentence and comes back on two lines', async () => {
    const line = 'Dialogue: 0,0:00:04.50,0:00:08.00,Default,,0,0,0,,Today we will talk about how\\Nmachine translation works.';
    const { sent, fn } = sentBy(async () => '今天我们将讨论机器翻译的工作原理。');
    const { text: out } = await YLFile.translateFile({ format: 'ass', text: line, translateFn: fn });
    expect(sent).toEqual(['Today we will talk about how machine translation works.']);
    const said = out.slice(out.lastIndexOf(',,') + 2).split('\\N');
    expect(said).toHaveLength(2);
    expect(said.join('')).toBe('今天我们将讨论机器翻译的工作原理。');
  });
});

describe('md round trip', () => {
  const src = [
    '# Quick start',
    '',
    'Install the tool, then call `fetch()` with the [docs](https://example.com/docs) open.',
    '',
    '```bash',
    '# install',
    'npm install --save my-tool',
    'echo "hello world"',
    '```',
    'This paragraph follows the fence.',
    '',
    '## Steps',
    '',
    '- First item with **bold** text',
    '- [ ] Unchecked task',
    '1. Numbered step',
    '> Quoted advice here',
    '',
    '| Name | Value |',
    '|------|-------|',
    '| Speed | Fast |',
    '',
    '    indented code stays',
    '',
  ].join('\n');

  test('an identity engine gives back the file byte for byte', async () => {
    expect((await YLFile.translateFile({ format: 'md', text: src, translateFn: identity })).text).toBe(src);
    const crlf = src.replace(/\n/g, '\r\n');
    expect((await YLFile.translateFile({ format: 'md', text: crlf, translateFn: identity })).text).toBe(crlf);
  });

  test('fences, blank lines and line prefixes stay; only prose changes', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'md', text: src, translateFn: shout });
    const a = src.split('\n'), b = out.split('\n');
    expect(b.length).toBe(a.length);
    expect(b.slice(4, 9)).toEqual(a.slice(4, 9)); // 整个 ```bash 块
    expect(b[9]).toBe('THIS PARAGRAPH FOLLOWS THE FENCE.');
    a.forEach((line, i) => { if (line === '') expect(b[i]).toBe(''); });
    expect(b[0]).toBe('# QUICK START');
    expect(b[2]).toBe('INSTALL THE TOOL, THEN CALL `fetch()` WITH THE [DOCS](https://example.com/docs) OPEN.');
    expect(b[13]).toBe('- FIRST ITEM WITH **BOLD** TEXT');
    expect(b[14]).toBe('- [ ] UNCHECKED TASK');
    expect(b[15]).toBe('1. NUMBERED STEP');
    expect(b[16]).toBe('> QUOTED ADVICE HERE');
    expect(b[19]).toBe(a[19]); // 表格分隔行
    expect(b[22]).toBe(a[22]); // 缩进代码
  });

  // 测试者：四格缩进的嵌套列表没翻（被当成了缩进代码）
  test('nested list items indented four spaces are translated; indented code outside a list is not', async () => {
    const md = [
      '- Top item one',
      '    - Nested item with words',
      '        - Deeper nested item',
      '    - Second nested item',
      '1. Step one',
      '    1. Sub step here',
      '',
      '    Continuation paragraph of the step',
      '',
      'A paragraph ends the list.',
      '',
      '    indented code stays',
      '',
      '- Item before code',
      '',
      '      code inside the item, four past its text',
      '',
      'Another paragraph.',
      '',
      '    more code stays',
    ].join('\n');
    const { text: out } = await YLFile.translateFile({ format: 'md', text: md, translateFn: shout });
    expect(out.split('\n')).toEqual([
      '- TOP ITEM ONE',
      '    - NESTED ITEM WITH WORDS',
      '        - DEEPER NESTED ITEM',
      '    - SECOND NESTED ITEM',
      '1. STEP ONE',
      '    1. SUB STEP HERE',
      '',
      '    CONTINUATION PARAGRAPH OF THE STEP',
      '',
      'A PARAGRAPH ENDS THE LIST.',
      '',
      '    indented code stays',
      '',
      '- ITEM BEFORE CODE',
      '',
      '      code inside the item, four past its text',
      '',
      'ANOTHER PARAGRAPH.',
      '',
      '    more code stays',
    ]);
  });

  test('tab-indented nested items count as nested, not code', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'md', text: '- Top item\n\t- Nested with a tab', translateFn: shout });
    expect(out).toBe('- TOP ITEM\n\t- NESTED WITH A TAB');
  });

  // 只把 ](地址) 换掉时，引擎看见落单的 [ 会自己补一个 ]
  test('both brackets of a link go out as placeholders, so the engine sees no lone [', async () => {
    const { sent, fn } = sentBy(async (t) => t.replace('Read the', '阅读').replace('API docs', 'API 文档'));
    const { text: out } = await YLFile.translateFile({ format: 'md', text: 'Read the [API docs](https://example.com/docs) and ![a diagram](img.png) first.', translateFn: fn });
    expect(sent[0]).toBe('Read the __PII_TAG_1__ API docs __PII_TAG_2__ and __PII_TAG_3__ a diagram __PII_TAG_4__ first.');
    expect(out).toBe('阅读 [API 文档](https://example.com/docs) and ![a diagram](img.png) first.');
  });

  describe('emphasis and link text', () => {
    const zh = (answer) => async () => answer;

    test('bold markers go out as placeholders and the words inside are translated', async () => {
      const { sent, fn } = sentBy(zh('使用 __PII_TAG_1__ 一个 __PII_TAG_2__ 命令运行服务器'));
      const { text: out } = await YLFile.translateFile({ format: 'md', text: '- Run the server with **one** command', targetLang: 'zh-CN', translateFn: fn });
      expect(sent).toEqual(['Run the server with __PII_TAG_1__ one __PII_TAG_2__ command']);
      expect(out).toBe('- 使用**一个**命令运行服务器');
    });

    test('a one-word link text is translated and its URL kept', async () => {
      const { text: out } = await YLFile.translateFile({
        format: 'md', text: '- Open the [dashboard](https://example.com/dash) in your browser', targetLang: 'zh-CN',
        translateFn: zh('在浏览器中打开 __PII_TAG_1__ 仪表板 __PII_TAG_2__'),
      });
      expect(out).toBe('- 在浏览器中打开[仪表板](https://example.com/dash)');
    });

    test('italic, strike-through, nested emphasis and bold links keep every marker; inline code is not sent', async () => {
      const text = 'Use *care* with ~~old~~ `a*b*c` and **[the *new* docs](https://x.y/z_w)** for snake_case_name.';
      const { sent, fn } = sentBy(shout);
      const { text: out } = await YLFile.translateFile({ format: 'md', text, translateFn: fn });
      expect(sent[0]).not.toMatch(/a\*b|https|`|\*|~~/);
      // snake_case_name 里的 _ 不是强调：整个词作为代码原样带回
      expect(sent[0]).toMatch(/ FOR __PII_CODE_1__\.$/i);
      expect(out).toBe('USE *CARE* WITH ~~OLD~~ `a*b*c` AND **[THE *NEW* DOCS](https://x.y/z_w)** FOR snake_case_name.');
    });

    test('placeholders the engine rewrote are still put back', async () => {
      const { text: out } = await YLFile.translateFile({
        format: 'md', text: 'Run the server with **one** command', targetLang: 'zh-CN',
        translateFn: zh('使用 __ PII_TAG_1 __ 一个 __pii_tag_2__ 命令运行服务器'),
      });
      expect(out).toBe('使用**一个**命令运行服务器');
    });

    test('when the engine drops the markers the text around them is translated piece by piece', async () => {
      const lossy = async (t) => (t.includes('__PII_TAG_') ? t.replace(/__PII_TAG_\d+__/g, '') : t.toUpperCase());
      const { text: out } = await YLFile.translateFile({ format: 'md', text: 'Run the server with **one** command', translateFn: lossy });
      expect(out).toBe('RUN THE SERVER WITH **ONE** COMMAND');
    });
  });

  describe('tables', () => {
    const table = [
      '| Option | Meaning |',
      '|--------|:-------:|',
      '| port   | The port to listen on |',
      '| `a|b` | Pipe \\| inside **bold** |',
      '',
    ].join('\n');
    const ZH = { Option: '选项', Meaning: '含义', port: '端口', 'The port to listen on': '监听的端口' };
    const dict = async (t) => t.split('\n').map(l => ZH[l] || l.toUpperCase()).join('\n');

    test('each cell goes out on its own and the row keeps its pipes and spaces', async () => {
      const { sent, fn } = sentBy(dict);
      const { text: out } = await YLFile.translateFile({ format: 'md', text: table, targetLang: 'zh-CN', translateFn: fn });
      expect(sent.join('\n').split('\n')).toEqual(['Option', 'Meaning', 'port', 'The port to listen on',
        'Pipe __PII_TAG_1__ inside __PII_TAG_2__ bold __PII_TAG_3__']);
      expect(out.split('\n')).toEqual([
        '| 选项 | 含义 |',
        '|--------|:-------:|',
        '| 端口   | 监听的端口 |',
        '| `a|b` | PIPE \\| INSIDE **BOLD** |',
        '',
      ]);
    });

    test('tables without outer pipes and tables inside a blockquote', async () => {
      const src = 'Name | Value\n--- | ---\nspeed | fast\n\n> | A | B |\n> |:-:|---|\n> | x y | z |\nafter';
      const { text: out } = await YLFile.translateFile({ format: 'md', text: src, translateFn: shout });
      expect(out).toBe('NAME | VALUE\n--- | ---\nSPEED | FAST\n\n> | A | B |\n> |:-:|---|\n> | X Y | Z |\nAFTER');
    });

    test('an identity engine gives the table back byte for byte, CRLF too', async () => {
      expect((await YLFile.translateFile({ format: 'md', text: table, translateFn: identity })).text).toBe(table);
      const crlf = table.replace(/\n/g, '\r\n');
      expect((await YLFile.translateFile({ format: 'md', text: crlf, translateFn: identity })).text).toBe(crlf);
    });
  });

  describe('hard-wrapped paragraphs', () => {
    test('the lines of one paragraph go out as one sentence and come back as one line', async () => {
      const src = 'This is a long paragraph that\nwraps across three lines in the\n[source](https://x.y) file.\n\nNext paragraph.\n';
      const { sent, fn } = sentBy(async (t) => t.split('\n').map(l => (l.startsWith('This') ? '这是一个很长的段落，在 __PII_TAG_1__ 源 __PII_TAG_2__ 文件中折成三行。' : '下一段。')).join('\n'));
      const { text: out } = await YLFile.translateFile({ format: 'md', text: src, targetLang: 'zh-CN', translateFn: fn });
      expect(sent).toEqual(['This is a long paragraph that wraps across three lines in the __PII_TAG_1__ source __PII_TAG_2__ file.\nNext paragraph.']);
      expect(out).toBe('这是一个很长的段落，在[源](https://x.y)文件中折成三行。\n\n下一段。\n');
    });

    test('blockquote and list item continuations join under their own prefix', async () => {
      const src = ['> Quoted text that', '> continues here.', '>', '> Second para.', '', '- Item that', '  continues', '- Next', '  1. Nested', '     wrapped'].join('\n');
      const { text: out } = await YLFile.translateFile({ format: 'md', text: src, translateFn: shout });
      expect(out).toBe(['> QUOTED TEXT THAT CONTINUES HERE.', '>', '> SECOND PARA.', '', '- ITEM THAT CONTINUES', '- NEXT', '  1. NESTED WRAPPED'].join('\n'));
    });

    test('headings, list items, tables, fences, setext underlines, HTML blocks and hard breaks are not joined', async () => {
      const src = ['# Head', 'Text', '- one', '- two', 'Name | Value', '--- | ---', 'a | b', '```', 'code', '```',
        'Title', '=====', 'line one  ', 'line two\\', 'line three', '<div>', '</div>'].join('\n');
      const { text: out } = await YLFile.translateFile({ format: 'md', text: src, translateFn: shout });
      expect(out).toBe(['# HEAD', 'TEXT', '- ONE', '- TWO', 'NAME | VALUE', '--- | ---', 'A | B', '```', 'code', '```',
        'TITLE', '=====', 'LINE ONE  ', 'LINE TWO\\', 'LINE THREE', '<div>', '</div>'].join('\n'));
    });

    test('front matter is left alone', async () => {
      const src = '---\ntitle: Hello\ntags: [a, b]\n---\nBody text\nwraps.\n';
      const { text: out } = await YLFile.translateFile({ format: 'md', text: src, translateFn: shout });
      expect(out).toBe('---\ntitle: Hello\ntags: [a, b]\n---\nBODY TEXT WRAPS.\n');
    });

    test('a paragraph the engine could not translate keeps all its original lines', async () => {
      const src = 'First line of the paragraph\r\n  second line\r\n> quote\r\n';
      const { text: out, failed } = await YLFile.translateFile({ format: 'md', text: src, translateFn: async () => '' });
      expect(out).toBe(src);
      expect(failed).toBe(2);
    });
  });

  describe('placeholders in a batch', () => {
    const src = 'Run the server with **one** command\n\nOpen the [dashboard](https://example.com/dash) now';

    test('serials run on across the batch and come back per line', async () => {
      const { sent, fn } = sentBy(async (t) => t.replace('one', '一个').replace('dashboard', '仪表板'));
      const { text: out } = await YLFile.translateFile({ format: 'md', text: src, translateFn: fn });
      expect(sent).toEqual(['Run the server with __PII_TAG_1__ one __PII_TAG_2__ command\nOpen the __PII_TAG_3__ dashboard __PII_TAG_4__ now']);
      expect(out).toBe('Run the server with **一个** command\n\nOpen the [仪表板](https://example.com/dash) now');
    });

    test('a pair the engine turned inside out, emptied or moved to another line is retried on its own', async () => {
      const answers = {
        batch: '使用 __PII_TAG_2__ 命令运行 __PII_TAG_1__ 服务器\n在浏览器中打开 __PII_TAG_3__ __PII_TAG_4__ 仪表板',
        'Run the server with __PII_TAG_1__ one __PII_TAG_2__ command': '使用 __PII_TAG_1__ 一个 __PII_TAG_2__ 命令运行服务器',
        'Open the __PII_TAG_1__ dashboard __PII_TAG_2__ now': '现在打开 __PII_TAG_1__ 仪表板 __PII_TAG_2__',
      };
      const { sent, fn } = sentBy(async (t) => answers[t.includes('\n') ? 'batch' : t]);
      const { text: out } = await YLFile.translateFile({ format: 'md', text: src, targetLang: 'zh-CN', translateFn: fn });
      expect(sent).toHaveLength(3);
      expect(out).toBe('使用**一个**命令运行服务器\n\n现在打开[仪表板](https://example.com/dash)');

      const stray = async (t) => (t.includes('\n') ? '使用 __PII_TAG_1__ 一个 __PII_TAG_2__ __PII_TAG_3__ 命令\n打开 仪表板 __PII_TAG_4__' : answers[t]);
      const res = await YLFile.translateFile({ format: 'md', text: src, targetLang: 'zh-CN', translateFn: stray });
      expect(res.text).toBe('使用**一个**命令运行服务器\n\n现在打开[仪表板](https://example.com/dash)');
    });

    test('a pair that stays inside out on its own is translated piece by piece', async () => {
      const flipped = async (t) => (/__PII/.test(t) ? 'COMMAND __PII_TAG_2__ ONE __PII_TAG_1__ RUN' : t.toUpperCase());
      const { text: out } = await YLFile.translateFile({ format: 'md', text: 'Run the server with **one** command', translateFn: flipped });
      expect(out).toBe('RUN THE SERVER WITH **ONE** COMMAND');
    });
  });

  test('a line with inline code goes out as one sentence with a placeholder', async () => {
    const { sent, fn } = sentBy(identity);
    await YLFile.translateFile({ format: 'md', text: 'Call `fetch()` with the header today.', translateFn: fn });
    expect(sent).toEqual(['Call __PII_TAG_1__ with the header today.']);
  });
});

describe('srt cues', () => {
  const ZH = {
    'Today we will talk about how machine translation works.': '今天我们将讨论机器翻译的工作原理。',
    'Good.': '好。',
  };
  const dict = async (t) => t.split('\n').map(l => ZH[l] || l).join('\n');

  test('a two-line cue is translated as one sentence and split back into two lines', async () => {
    const src = '1\n00:00:01,000 --> 00:00:04,000\nToday we will talk about how\nmachine translation works.\n';
    const { sent, fn } = sentBy(dict);
    const { text: out } = await YLFile.translateFile({ format: 'srt', text: src, translateFn: fn });
    expect(sent).toEqual(['Today we will talk about how machine translation works.']);
    const lines = out.split('\n');
    expect(lines.slice(0, 2)).toEqual(['1', '00:00:01,000 --> 00:00:04,000']);
    expect(lines.length).toBe(5);
    expect(lines[2] && lines[3]).toBeTruthy();
    expect(lines[2] + lines[3]).toBe('今天我们将讨论机器翻译的工作原理。');
    expect(Math.abs(lines[2].length - lines[3].length)).toBeLessThanOrEqual(3);
  });

  test('never more lines than the original; a short translation may take fewer', async () => {
    const src = '1\r\n00:00:01,000 --> 00:00:02,000\r\nGood.\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nGood\r\n.\r\n';
    const { text: out } = await YLFile.translateFile({ format: 'srt', text: src, translateFn: async () => '好。' });
    expect(out).toBe('1\r\n00:00:01,000 --> 00:00:02,000\r\n好。\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n好。\r\n');
  });

  test('dialogue lines that each start with a dash stay separate sentences', async () => {
    const src = '1\n00:00:01,000 --> 00:00:04,000\n- Where are you going?\n- Home.';
    const { sent, fn } = sentBy(identity);
    await YLFile.translateFile({ format: 'srt', text: src, translateFn: fn, batchLines: 1 });
    expect(sent).toEqual(['- Where are you going?', '- Home.']);
  });

  test('an identity engine gives back the file byte for byte', async () => {
    const src = '1\r\n00:00:01,000 --> 00:00:04,000\r\n<i>Today we will talk about how</i>\r\nmachine translation works.\r\n\r\n';
    expect((await YLFile.translateFile({ format: 'srt', text: src, translateFn: identity })).text).toBe(src);
  });

  describe('Chinese and Japanese lines break between words', () => {
    test('a two-line srt cue never splits a numeral from its unit (十九 / 世纪)', async () => {
      const src = '4\n00:00:11,500 --> 00:00:15,000\n<i>The first systems were built\nin the nineteen fifties.</i>\n';
      const { sent, fn } = sentBy(async () => '__PII_TAG_1__第一个系统建于十九世纪五十年代。__PII_TAG_2__');
      const { text: out } = await YLFile.translateFile({ format: 'srt', text: src, targetLang: 'zh-CN', translateFn: fn });
      expect(sent).toEqual(['__PII_TAG_1__ The first systems were built in the nineteen fifties.__PII_TAG_2__']);
      expect(out.split('\n').slice(2, 4)).toEqual(['<i>第一个系统建于', '十九世纪五十年代。</i>']);
    });

    test('an ASS \\N line in Japanese breaks before a word, not before a particle or verb ending', async () => {
      const line = 'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,The first systems\\Nwere built in the 1950s.';
      const { text: out } = await YLFile.translateFile({ format: 'ass', text: line, targetLang: 'ja', translateFn: async () => '最初のシステムは1950年代に構築されました。' });
      expect(out.slice(out.lastIndexOf(',,') + 2).split('\\N')).toEqual(['最初のシステムは', '1950年代に構築されました。']);
    });

    test('numerals stay with their measure word, even across a space; 的 never starts a line', () => {
      expect(YLFile.splitBalanced('我们在 2024 年发布了 3 个版本，用户很喜欢。', 2, 'zh-CN')).toEqual(['我们在 2024 年发布了', '3 个版本，用户很喜欢。']);
      expect(YLFile.splitBalanced('他说了很多的话然后走了', 2, 'zh-CN')).toEqual(['他说了很多的话', '然后走了']);
      for (const lines of [YLFile.splitBalanced('第一个系统建于十九世纪五十年代。', 2, 'zh-CN'), YLFile.splitBalanced('第一个系统建于十九世纪五十年代。', 2)]) {
        expect(lines).toEqual(['第一个系统建于', '十九世纪五十年代。']);
      }
    });

    test('a date or time span built from several numerals stays on one line', () => {
      expect(YLFile.splitBalanced('<i>第一个系统是在二十世纪五十年代建造的。</i>', 2, 'zh-CN')).toEqual(['<i>第一个系统是在', '二十世纪五十年代建造的。</i>']);
      expect(YLFile.splitBalanced('会议定在2024年3月5日下午举行。', 2, 'zh-CN')).toEqual(['会议定在2024年3月5日', '下午举行。']);
    });

    test('without a Japanese break point the cue keeps fewer lines', () => {
      expect(YLFile.splitBalanced('ありがとうございます', 2, 'ja')).toEqual(['ありがとうございます']);
    });

    test('without Intl.Segmenter CJK text breaks only after punctuation', () => {
      const real = Intl.Segmenter;
      try {
        Intl.Segmenter = undefined;
        expect(YLFile.splitBalanced('欢迎回来，今天我们讨论机器翻译。', 2, 'zh-CN')).toEqual(['欢迎回来，', '今天我们讨论机器翻译。']);
        expect(YLFile.splitBalanced('今天我们讨论机器翻译的工作原理。', 2, 'zh-CN')).toEqual(['今天我们讨论机器翻译的工作原理。']);
      } finally {
        Intl.Segmenter = real;
      }
    });
  });

  test('Latin translations break at a space near the middle', () => {
    expect(YLFile.splitBalanced('Heute sprechen wir darüber, wie maschinelle Übersetzung funktioniert.', 2))
      .toEqual(['Heute sprechen wir darüber,', 'wie maschinelle Übersetzung funktioniert.']);
  });
});

describe('html', () => {
  const src = [
    '<!DOCTYPE html>',
    '<html><head><title>API guide</title><style>p { color: red; }</style></head>',
    '<body>',
    '<h1>Getting started</h1>',
    '<p>Call <code>fetch()</code> with the',
    '  <strong>Authorization</strong> header before Friday.</p>',
    '<pre>Total: 42',
    "  fetch('/api')</pre>",
    '<p><img src="cat.png" alt="A cat sleeping on a laptop" title="Sleepy cat"> Cats &amp; dogs</p>',
    '<script>const label = "Total:";</script>',
    '</body></html>',
  ].join('\n');

  test('an identity engine gives back the file byte for byte', async () => {
    expect((await YLFile.translateFile({ format: 'html', text: src, translateFn: identity })).text).toBe(src);
  });

  test('a sentence split by inline tags goes out whole; code, pre and script never go out', async () => {
    const { sent, fn } = sentBy(identity);
    await YLFile.translateFile({ format: 'html', text: src, translateFn: fn, batchLines: 1 });
    expect(sent).toContain('Call __PII_TAG_1__ with the __PII_TAG_2__ Authorization __PII_TAG_3__ header before Friday.');
    expect(sent).toContain('A cat sleeping on a laptop');
    expect(sent).toContain('Sleepy cat');
    expect(sent).toContain('__PII_TAG_1__ Cats & dogs');
    expect(sent.join('\n')).not.toMatch(/fetch|Total|color/);
  });

  test('translations go back in place, escaped, with tags and code intact', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'html', text: src, translateFn: shout });
    expect(out).toContain('<title>API GUIDE</title><style>p { color: red; }</style>');
    expect(out).toContain('<p>CALL <code>fetch()</code> WITH THE <strong>AUTHORIZATION</strong> HEADER BEFORE FRIDAY.</p>');
    expect(out).toContain("<pre>Total: 42\n  fetch('/api')</pre>");
    expect(out).toContain('<img src="cat.png" alt="A CAT SLEEPING ON A LAPTOP" title="SLEEPY CAT"> CATS &amp; DOGS</p>');
    expect(out).toContain('<script>const label = "Total:";</script>');
  });

  test('markup characters in a translation are escaped', async () => {
    const { text: out } = await YLFile.translateFile({
      format: 'html', text: '<p>Less is more</p><img alt="A b">', translateFn: async (t) => `${t} <x> "q"`, batchLines: 1,
    });
    expect(out).toBe('<p>Less is more &lt;x&gt; "q"</p><img alt="A b &lt;x&gt; &quot;q&quot;">');
  });

  // 占位符贴着单词时，引擎把整串当成标识符原样带回（"__PII_TAG_1__official__PII_TAG_2__"）
  test('a placeholder touching a word goes out with a space between them', async () => {
    const { sent, fn } = sentBy(identity);
    await YLFile.translateFile({ format: 'html', text: '<p>Read the <strong>official</strong> docs.</p>', translateFn: fn });
    expect(sent).toEqual(['Read the __PII_TAG_1__ official __PII_TAG_2__ docs.']);
  });

  describe('spaces the engine puts around inline tags', () => {
    const para = '<p>Read the <strong>official</strong> documentation in <a href="/docs">the developer portal</a> before you start.</p>';
    const code = '<p>Call <code>fetch()</code> with the <code>Authorization</code> header before Friday.</p>';
    const run = (text, answer, targetLang) =>
      YLFile.translateFile({ format: 'html', text, targetLang, translateFn: async () => answer });

    test('Chinese: no space inside a tag; outside it, none between Chinese characters', async () => {
      const { text: out } = await run(para,
        '在开始之前，请阅读 __PII_TAG_3__ 开发者门户 __PII_TAG_4__ 中的 __PII_TAG_1__ 官方 __PII_TAG_2__ 文档。', 'zh-CN');
      expect(out).toBe('<p>在开始之前，请阅读<a href="/docs">开发者门户</a>中的<strong>官方</strong>文档。</p>');
    });

    test('Chinese: a space outside a tag stays when Latin text or a digit is on either side', async () => {
      const src = '<p>Use the <strong>API</strong> key from <a href="/k">the 2 portals</a> today.</p>';
      const { text: out } = await run(src, '今天使用 __PII_TAG_3__ 2 个门户 __PII_TAG_4__ 中的 __PII_TAG_1__ API __PII_TAG_2__ 密钥。', 'zh-CN');
      expect(out).toBe('<p>今天使用 <a href="/k">2 个门户</a>中的 <strong>API</strong> 密钥。</p>');
    });

    test('Chinese markdown: no space between Chinese and ** or links, but _ and __ emphasis keep theirs', async () => {
      const { text: out } = await YLFile.translateFile({
        format: 'md', targetLang: 'zh-CN', text: 'Run it with **one** command, a __strong__ word, an _italic_ word, or the [dashboard](https://x.y).',
        translateFn: async () => '使用 __PII_TAG_1__ 一个 __PII_TAG_2__ 命令运行，__PII_TAG_3__ 强 __PII_TAG_4__ 单词、__PII_TAG_5__ 斜体 __PII_TAG_6__ 单词或打开 __PII_TAG_7__ 仪表板 __PII_TAG_8__ 。',
      });
      expect(out).toBe('使用**一个**命令运行，__强__ 单词、_斜体_ 单词或打开[仪表板](https://x.y)。');
    });

    test('Chinese: around a whole <code> element the source spacing is kept', async () => {
      const { text: out } = await run(code, '在周五之前使用 __PII_TAG_2__ 头调用 __PII_TAG_1__ 。', 'zh-CN');
      expect(out).toBe('<p>在周五之前使用 <code>Authorization</code> 头调用 <code>fetch()</code>。</p>');
    });

    test('Japanese is treated like Chinese, and a rewritten placeholder is still recognised', async () => {
      const { text: out } = await run(para,
        '始める前に、__PII_TAG_3__ 開発者ポータル __ PII_TAG_4 __ で __PII_TAG_1__ 公式の __PII_TAG_2__ ドキュメントを読んでください。', 'ja');
      expect(out).toBe('<p>始める前に、<a href="/docs">開発者ポータル</a>で<strong>公式の</strong>ドキュメントを読んでください。</p>');
    });

    test('spaced languages: inner spaces follow the source, outer ones collapse to one', async () => {
      const { text: out } = await run(para,
        'Lesen Sie die  __PII_TAG_1__ offizielle __PII_TAG_2__   Dokumentation im __PII_TAG_3__ Entwicklerportal __PII_TAG_4__, bevor Sie beginnen.', 'de');
      expect(out).toBe('<p>Lesen Sie die <strong>offizielle</strong> Dokumentation im <a href="/docs">Entwicklerportal</a>, bevor Sie beginnen.</p>');
      const { text: en } = await run('<p>Click <a href="#"> here </a> now.</p>', 'Click __PII_TAG_1__  here  __PII_TAG_2__ now, please.', 'en');
      expect(en).toBe('<p>Click <a href="#"> here </a> now, please.</p>');
    });

    test('a Chinese source translated into English keeps the space the engine put outside a tag', async () => {
      const { text: out } = await run('<p>请阅读<strong>官方</strong>文档。</p>', 'Please read the __PII_TAG_1__ official __PII_TAG_2__ documentation.', 'en');
      expect(out).toBe('<p>Please read the <strong>official</strong> documentation.</p>');
    });
  });

  test('when the engine drops placeholders the block is translated piece by piece around them', async () => {
    const lossy = async (t) => (t.includes('__PII_TAG_') ? t.replace(/__PII_TAG_\d+__/g, '') : t.toUpperCase());
    const { text: out } = await YLFile.translateFile({
      format: 'html', text: '<p>Call <code>fetch()</code> with the header.</p>', translateFn: lossy,
    });
    expect(out).toBe('<p>CALL <code>fetch()</code> WITH THE HEADER.</p>');
  });
});

describe('concurrency', () => {
  function tracking(answer) {
    const st = { inFlight: 0, max: 0, calls: 0 };
    st.fn = async (t) => {
      st.calls++; st.inFlight++; st.max = Math.max(st.max, st.inFlight);
      await new Promise(r => setTimeout(r, 5));
      st.inFlight--;
      return answer(t);
    };
    return st;
  }

  test('a small markdown file goes out in one request', async () => {
    const md = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} uses \`code${i}\` here.\n`).join('\n');
    const st = tracking(t => t.toUpperCase());
    const { text: out } = await YLFile.translateFile({ format: 'md', text: md, translateFn: st.fn });
    expect(st.calls).toBe(1);
    expect(out).toContain('PARAGRAPH 19 USES `code19` HERE.');
  });

  test('a batch the engine cannot align falls back to concurrent single requests, at most four at once, in order', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line number ${i}`);
    const st = tracking(t => (t.includes('\n') ? 'MERGED' : t.toUpperCase()));
    const { text: out } = await YLFile.translateFile({ format: 'txt', text: lines.join('\n'), translateFn: st.fn });
    expect(out).toBe(lines.map(l => l.toUpperCase()).join('\n'));
    expect(st.max).toBe(4);
  });
});

// 样例文件（tests/fixtures/file-translate/，每份另拼一个 CRLF 版本）：恒等引擎
// 翻完必须一字节不差，无论目标语言是否用空格分词
describe('fixture round trips', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, 'fixtures', 'file-translate');
  const files = fs.readdirSync(dir).filter(f => YLFile.FORMATS.includes(YLFile.extOf(f)));

  test.each(files.flatMap(f => [[f, 'LF', 'zh-CN'], [f, 'CRLF', 'zh-CN'], [f, 'LF', 'en'], [f, 'CRLF', 'en']]))(
    '%s (%s, %s) comes back byte for byte from an identity engine', async (f, eol, targetLang) => {
      let src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (eol === 'CRLF') src = src.replace(/\n/g, '\r\n');
      const res = await YLFile.translateFile({ format: YLFile.extOf(f), text: src, targetLang, translateFn: identity });
      expect(res.text).toBe(src);
      expect(res.total).toBeGreaterThan(0);
    });
});

describe('keep-list of product names', () => {
  test('a kept name goes out as a placeholder and comes back as written', async () => {
    const seen = [];
    const fn = async (t) => { seen.push(t); return t.replace('Follow us on', '关注我们：'); };
    const { text: out } = await YLFile.translateFile({ format: 'txt', text: 'Follow us on Bluesky', translateFn: fn });
    expect(seen).toEqual(['Follow us on __PII_NAME_1__']);
    expect(out).toBe('关注我们： Bluesky');
  });
});

describe('code-like words outside backticks', () => {
  test('snake_case, camelCase, dotted names and calls go out as placeholders and come back as written', async () => {
    const { sent, fn } = sentBy(shout);
    const text = 'Set max_retries in config.yml, then call getItem() and res.json before parseInt.';
    const { text: out } = await YLFile.translateFile({ format: 'txt', text, translateFn: fn });
    expect(sent).toEqual(['Set __PII_CODE_1__ in __PII_CODE_2__, then call __PII_CODE_3__ and __PII_CODE_4__ before __PII_CODE_5__.']);
    expect(out).toBe('SET max_retries IN config.yml, THEN CALL getItem() AND res.json BEFORE parseInt.');
  });

  test('ordinary prose is not frozen: abbreviations, plurals in parentheses, sentence ends, URLs and emails', async () => {
    const { sent, fn } = sentBy(shout);
    const text = 'Check the file(s), e.g. the U.S. list. Next, mail ops@example.com or open https://example.com/a_b.html today.';
    const { text: out } = await YLFile.translateFile({ format: 'txt', text, translateFn: fn });
    expect(sent).toEqual([text]);
    expect(out).toBe(text.toUpperCase());
  });

  test('localhost is kept in markdown prose and table cells', async () => {
    const { sent, fn } = sentBy(async (t) => t.replace('The server listens on', '服务器监听').replace('Address', '地址'));
    const text = 'The server listens on localhost.\n\n| Address | localhost |\n|---|---|\n';
    const { text: out } = await YLFile.translateFile({ format: 'md', text, targetLang: 'zh-CN', translateFn: fn });
    expect(sent.join('\n')).not.toContain('localhost');
    expect(out).toContain('服务器监听 localhost.');
    expect(out).toContain('| localhost |');
  });

  test('in markdown, a snake_case word is kept and its underscores are not read as emphasis', async () => {
    const { text: out } = await YLFile.translateFile({ format: 'md', text: 'A snake_case_name that stays as it is.', translateFn: shout });
    expect(out).toBe('A snake_case_name THAT STAYS AS IT IS.');
  });
});
