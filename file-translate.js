'use strict';

// 简单文本格式的本地翻译：把文件拆成「可翻译片段 + 骨架」，只把片段送去翻译，
// 再按原骨架拼回。骨架（时间轴、标签、代码块、链接语法）永远不进翻译请求。
// 复杂格式（PDF/Word 等保留排版的）不在插件做，跳官网服务。
//
// UMD：options 页直接用，jest 里 require。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.YLFile = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const FORMATS = ['srt', 'ass', 'html', 'txt', 'md'];

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  // ── srt ──────────────────────────────────────────────────────────────────
  // 序号行与 `00:00:01,000 --> 00:00:04,000` 时间轴保持原样，只翻字幕正文。
  function parseSrt(text) {
    const lines = text.split(/\r?\n/);
    const parts = [];
    for (const line of lines) {
      const isIndex = /^\d+$/.test(line.trim());
      const isTiming = /-->/.test(line);
      const isBlank = line.trim() === '';
      parts.push({ text: line, translatable: !(isIndex || isTiming || isBlank) });
    }
    return { parts, join: (out) => out.join('\n') };
  }

  // ── ass ──────────────────────────────────────────────────────────────────
  // 只有 `Dialogue:` 行的最后一个逗号段是台词；其余（样式、脚本信息）不动。
  // 台词里的 `{\...}` 特效标签要原样保留。
  function parseAss(text) {
    const lines = text.split(/\r?\n/);
    const parts = [];
    for (const line of lines) {
      if (!/^Dialogue\s*:/i.test(line)) { parts.push({ text: line, translatable: false }); continue; }
      // Dialogue 前 9 个字段是固定元数据，第 10 段起才是台词（台词自身可含逗号）
      const idx = nthIndexOf(line, ',', 9);
      if (idx < 0) { parts.push({ text: line, translatable: false }); continue; }
      const head = line.slice(0, idx + 1);
      const body = line.slice(idx + 1);
      parts.push({ text: head, translatable: false });
      // 拆出 {\tag} 特效块，只翻标签之间的文字
      const seg = body.split(/(\{[^}]*\})/);
      for (const s of seg) {
        if (!s) continue;
        parts.push({ text: s, translatable: !/^\{[^}]*\}$/.test(s) && s.trim() !== '' });
      }
      parts.push({ text: '\n', translatable: false, raw: true });
    }
    return { parts, join: (out) => joinRaw(out, parts) };
  }

  function nthIndexOf(s, ch, n) {
    let i = -1;
    for (let k = 0; k < n; k++) { i = s.indexOf(ch, i + 1); if (i < 0) return -1; }
    return i;
  }

  function joinRaw(out, parts) {
    let s = '';
    for (let i = 0; i < out.length; i++) s += parts[i].raw ? parts[i].text : out[i];
    return s.replace(/\n$/, '');
  }

  // ── html ─────────────────────────────────────────────────────────────────
  // 用正则切出标签与文本节点，只翻文本；script/style 内容整体跳过。
  function parseHtml(text) {
    const parts = [];
    const re = /(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>)/gi;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index), translatable: true });
      parts.push({ text: m[0], translatable: false });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), translatable: true });
    for (const p of parts) if (p.translatable && !p.text.trim()) p.translatable = false;
    return { parts, join: (out) => out.join('') };
  }

  // ── md ───────────────────────────────────────────────────────────────────
  // 围栏代码块、缩进代码、行内代码、链接/图片的 URL 部分都不翻。
  function parseMd(text) {
    const lines = text.split(/\r?\n/);
    const parts = [];
    let inFence = false;
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; parts.push({ text: line, translatable: false }); continue; }
      if (inFence || /^\s{4,}\S/.test(line) || line.trim() === '') {
        parts.push({ text: line, translatable: false });
        continue;
      }
      // 行内保护：`code`、[text](url) 的 url 段、裸链接
      const seg = line.split(/(`[^`]*`|\]\([^)]*\)|https?:\/\/\S+)/);
      for (const s of seg) {
        if (!s) continue;
        const protectedSeg = /^`[^`]*`$/.test(s) || /^\]\([^)]*\)$/.test(s) || /^https?:\/\//.test(s);
        parts.push({ text: s, translatable: !protectedSeg && s.trim() !== '' });
      }
      parts.push({ text: '\n', translatable: false, raw: true });
    }
    return { parts, join: (out) => joinRaw(out, parts) };
  }

  // ── txt ──────────────────────────────────────────────────────────────────
  function parseTxt(text) {
    const parts = text.split(/\r?\n/).map(line => ({ text: line, translatable: line.trim() !== '' }));
    return { parts, join: (out) => out.join('\n') };
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

  // 批量翻译。translateFn(text) -> Promise<string>；失败的片段保留原文，
  // 让用户至少拿到一个结构完整、部分翻译的文件，而不是整份失败。
  //
  // 但"保留原文"必须可见：引擎整条链路挂掉时（没配 Key、AI 档没登录、
  // 官网接口 404），每个片段都失败、每个都退回原文，最后交出一份和输入
  // 一模一样的文件还显示"完成"。所以返回值带上 failed/firstError，
  // 调用方能判断"部分没翻"和"根本没翻"。
  //
  // 多个片段拼成一个请求（按 \n 对齐拆回）：字幕文件动辄上千行，逐行请求
  // 一部 90 分钟纪录片要 6 分多钟；50 行一批直接压到半分钟内。引擎返回的
  // 行数对不上这一批就落回逐行，正确性不赌批量。
  async function translateFile({ format, text, translateFn, concurrency = 3, onProgress,
    batchLines = 50, batchChars = 1800 }) {
    const { parts, join } = parse(format, text);
    const out = parts.map(p => p.text);
    const idxs = [];
    parts.forEach((p, i) => { if (p.translatable) idxs.push(i); });

    // 组批：自带换行的片段会破坏按行对齐，单独成批
    const batches = [];
    let cur = [], curLen = 0;
    const flush = () => { if (cur.length) { batches.push(cur); cur = []; curLen = 0; } };
    for (const i of idxs) {
      const t = parts[i].text;
      if (t.includes('\n')) { flush(); batches.push([i]); continue; }
      if (cur.length >= batchLines || curLen + t.length > batchChars) flush();
      cur.push(i); curLen += t.length;
    }
    flush();

    let done = 0;
    let translated = 0;
    let failed = 0;
    let firstError = null;
    const total = idxs.length;
    const queue = batches.slice();
    const noteError = (err) => {
      if (!firstError) firstError = (err && err.message) || String(err);
    };
    const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      for (;;) {
        const batch = queue.shift();
        if (!batch) break;
        let ok = false;
        if (batch.length > 1) {
          try {
            const joined = batch.map(i => parts[i].text).join('\n');
            const lines = String((await translateFn(joined)) || '').split('\n');
            if (lines.length === batch.length) {
              batch.forEach((i, k) => {
                if (lines[k] && lines[k].trim()) {
                  out[i] = keepEdgeSpace(parts[i].text, lines[k]);
                  translated++;
                } else {
                  failed++;
                }
              });
              ok = true;
            }
          } catch (err) { noteError(err); /* 落回逐行 */ }
        }
        if (!ok) {
          for (const i of batch) {
            try {
              const t = await translateFn(parts[i].text);
              if (t) { out[i] = keepEdgeSpace(parts[i].text, t); translated++; }
              else failed++;
            } catch (err) { noteError(err); failed++; /* 保留原文 */ }
          }
        }
        done += batch.length;
        if (onProgress) onProgress(done, total);
      }
    });
    await Promise.all(workers);
    return { text: join(out), total, translated, failed, firstError };
  }

  // 片段两端的空白是排版的一部分（md 行内片段尤其明显），翻译服务会吃掉它们。
  function keepEdgeSpace(src, translated) {
    const lead = (src.match(/^\s*/) || [''])[0];
    const trail = (src.match(/\s*$/) || [''])[0];
    return lead + translated.trim() + trail;
  }

  return { FORMATS, extOf, parse, translateFile, keepEdgeSpace };
});
