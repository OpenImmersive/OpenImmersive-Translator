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
