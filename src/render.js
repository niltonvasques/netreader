const SGR = {
  bold: '1',
  dim: '2',
  italic: '3',
  code: '36',
  link: '4;34',
  heading: '1;35',
  title: '1;33',
  quote: '3;32',
  caption: '2;3',
  meta: '2',
  bullet: '33',
};

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** Terminal column width of a string (handles wide CJK/emoji and zero-width marks roughly). */
export function strWidth(str) {
  let w = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 32 || (c >= 0x300 && c < 0x370) || c === 0x200b || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

function isWide(c) {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/**
 * Word-wrap styled segments into lines of at most `width` columns.
 * Returns an array of lines, each an array of segments.
 */
function wrap(segs, width) {
  const lines = [[]];
  let col = 0;
  const push = (t, s) => {
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    if (last && last.s === s) last.t += t;
    else line.push({ t, s });
    col += strWidth(t);
  };
  const newline = () => {
    const line = lines[lines.length - 1];
    if (line.length) line[line.length - 1].t = line[line.length - 1].t.replace(/ +$/, '');
    lines.push([]);
    col = 0;
  };

  for (const seg of segs) {
    for (const tok of seg.t.split(/(\n| +)/)) {
      if (!tok) continue;
      if (tok === '\n') {
        newline();
        continue;
      }
      if (tok.startsWith(' ')) {
        if (col > 0 && col < width) push(' ', seg.s);
        continue;
      }
      let word = tok;
      let w = strWidth(word);
      if (col > 0 && col + w > width) newline();
      while (w > width) {
        // Hard-break words longer than a full line (URLs, hashes).
        let cut = '';
        for (const ch of word) {
          if (strWidth(cut + ch) > width - col) break;
          cut += ch;
        }
        push(cut, seg.s);
        newline();
        word = word.slice(cut.length);
        w = strWidth(word);
      }
      if (word) push(word, seg.s);
    }
  }
  return lines;
}

function paint(segs, base, color) {
  if (!color) return segs.map((x) => x.t).join('');
  return segs
    .map(({ t, s }) => {
      const codes = [...base, ...s].map((k) => SGR[k]).filter(Boolean);
      return codes.length ? `${ESC}${codes.join(';')}m${t}${RESET}` : t;
    })
    .join('');
}

/**
 * Lay out an article for a given width.
 * Returns [{ ansi, plain }] — one entry per screen line.
 */
export function layout(article, { width, color = true }) {
  const out = [];
  const line = (segs, base = [], prefix = []) => {
    const all = [...prefix, ...segs];
    const plain = all.map((x) => x.t).join('');
    if (!plain.trim()) return blank();
    out.push({ ansi: paint(all, base, color), plain });
  };
  const blank = () => {
    if (out.length && out[out.length - 1].plain !== '') out.push({ ansi: '', plain: '' });
  };

  // Header: title, byline, source.
  for (const l of wrap([{ t: article.title || article.url, s: [] }], width)) line(l, ['title']);
  const byline = [article.author, article.date].filter(Boolean).join(' · ');
  if (byline) for (const l of wrap([{ t: byline, s: [] }], width)) line(l, ['meta']);
  for (const l of wrap([{ t: article.url, s: [] }], width)) line(l, ['meta']);
  line([{ t: '─'.repeat(Math.min(width, 60)), s: [] }], ['meta']);
  blank();

  let prevKind = null;
  for (const b of article.blocks) {
    const quote = b.quote ? [{ t: '│ ', s: ['quote'] }] : [];
    const qw = quote.length ? 2 : 0;

    if (b.kind === 'heading') {
      blank();
      const level = Number(b.tag[1]) || 2;
      const mark = level <= 2 ? '' : '#'.repeat(level - 1) + ' ';
      for (const l of wrap([{ t: mark, s: [] }, ...b.segs], width - qw)) line(l, ['heading'], quote);
      blank();
    } else if (b.kind === 'code') {
      blank();
      for (const raw of b.text.split('\n')) {
        const lines = wrap([{ t: raw.replace(/\t/g, '    ').replace(/ /g, ' '), s: [] }], width - 2 - qw);
        for (const l of lines) {
          for (const seg of l) seg.t = seg.t.replace(/\u00a0/g, ' ');
          line(l, ['code'], [...quote, { t: '  ', s: [] }]);
        }
      }
      blank();
    } else if (b.kind === 'item' || b.kind === 'term') {
      if (prevKind !== 'item' && prevKind !== 'term') blank();
      const indent = '  '.repeat(Math.max(0, b.depth - 1));
      const marker = b.kind === 'term' ? '' : b.num != null ? `${b.num}. ` : '• ';
      const lead = indent + marker;
      const lines = wrap(b.segs, width - strWidth(lead) - qw);
      lines.forEach((l, i) => {
        const pre = i === 0 ? { t: lead, s: ['bullet'] } : { t: ' '.repeat(strWidth(lead)), s: [] };
        line(l, b.kind === 'term' ? ['bold'] : [], [...quote, pre]);
      });
    } else if (b.kind === 'row') {
      if (prevKind !== 'row') blank();
      for (const l of wrap(b.segs, width - qw)) line(l, [], quote);
    } else {
      if (prevKind === 'item' || prevKind === 'row' || prevKind === 'term') blank();
      const base = b.kind === 'caption' ? ['caption'] : b.quote ? ['quote'] : [];
      for (const l of wrap(b.segs, width - qw)) line(l, base, quote);
      blank();
    }
    prevKind = b.kind;
  }
  while (out.length && out[out.length - 1].plain === '') out.pop();
  return out;
}
