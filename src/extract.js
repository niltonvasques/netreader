import * as cheerio from 'cheerio';

// Elements that never carry readable article text.
const DROP = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form', 'input',
  'button', 'select', 'textarea', 'object', 'embed', 'video', 'audio', 'picture', 'img', 'map',
  'dialog', 'link', 'meta',
]);

// Elements that flow inside a line of text.
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i',
  'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var', 'wbr', 'label', 'img', 'picture',
]);

const STYLE_OF = {
  b: 'bold', strong: 'bold',
  i: 'italic', em: 'italic', cite: 'italic', dfn: 'italic',
  code: 'code', kbd: 'code', samp: 'code', tt: 'code', var: 'code',
  a: 'link',
};

/**
 * Parse HTML into a flat list of text blocks in document order.
 * Each block: { id, kind, tag, segs: [{t, s}], text, depth, num, quote, path }
 */
export function extract(html) {
  const $ = cheerio.load(html);
  const meta = readMeta($);
  const body = $('body')[0] || $.root()[0];

  const blocks = [];
  const inlineCache = new Map();
  const nodeIds = new Map();
  const nodeId = (n) => {
    if (!nodeIds.has(n)) nodeIds.set(n, nodeIds.size);
    return nodeIds.get(n);
  };

  const isElement = (n) => n.type === 'tag' || n.type === 'script' || n.type === 'style';

  function isHidden(el) {
    const a = el.attribs || {};
    if ('hidden' in a || a['aria-hidden'] === 'true') return true;
    return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '');
  }

  function inlineOnly(el) {
    if (inlineCache.has(el)) return inlineCache.get(el);
    const ok =
      INLINE.has(el.name) &&
      (el.children || []).every((c) => c.type === 'text' || c.type === 'comment' || (isElement(c) && inlineOnly(c)));
    inlineCache.set(el, ok);
    return ok;
  }

  function collectSegs(nodes, style, out) {
    for (const n of nodes) {
      if (n.type === 'text') {
        out.push({ t: n.data, s: style });
      } else if (isElement(n)) {
        if (DROP.has(n.name) || isHidden(n)) continue;
        if (n.name === 'br') {
          out.push({ t: '\n', s: style });
          continue;
        }
        const add = STYLE_OF[n.name];
        const s = add && !style.includes(add) ? [...style, add] : style;
        collectSegs(n.children || [], s, out);
      }
    }
    return out;
  }

  function normalizeSegs(segs) {
    const out = [];
    for (const seg of segs) {
      const t = seg.t.replace(/[ \t\r\n\f ]+/g, (m) => (seg.t === '\n' ? '\n' : ' '));
      const prev = out[out.length - 1];
      if (prev && prev.s.join() === seg.s.join()) prev.t += t;
      else out.push({ t, s: seg.s });
    }
    // Collapse doubled spaces across segment boundaries and trim the block edges.
    for (let i = 1; i < out.length; i++) {
      if (/[ \n]$/.test(out[i - 1].t)) out[i].t = out[i].t.replace(/^ +/, '');
    }
    for (const s of out) s.t = s.t.replace(/ *\n */g, '\n');
    if (out.length) {
      out[0].t = out[0].t.replace(/^\s+/, '');
      out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, '');
    }
    return out.filter((s) => s.t.length);
  }

  function ancestorInfo(el) {
    let depth = 0;
    let quote = false;
    const path = [];
    const chain = [];
    for (let p = el; p && p !== body && p.type !== 'root'; p = p.parent) {
      chain.unshift(nodeId(p));
      if (p.name === 'ul' || p.name === 'ol') depth++;
      if (p.name === 'blockquote') quote = true;
      if (path.length < 4) path.unshift(describe(p));
    }
    return { depth, quote, chain, path: path.join('>') };
  }

  function describe(el) {
    const a = el.attribs || {};
    let d = el.name;
    if (a.role) d += `[${a.role}]`;
    if (a.id) d += `#${a.id.slice(0, 24)}`;
    const cls = (a.class || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) d += '.' + cls.map((c) => c.slice(0, 24)).join('.');
    return d;
  }

  function kindOf(tag) {
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'li') return 'item';
    if (tag === 'pre') return 'code';
    if (tag === 'tr') return 'row';
    if (tag === 'figcaption' || tag === 'caption') return 'caption';
    if (tag === 'dt') return 'term';
    return 'para';
  }

  function listNumber(li) {
    const list = li.parent;
    if (!list || list.name !== 'ol') return null;
    let n = Number.parseInt(list.attribs?.start, 10);
    if (Number.isNaN(n)) n = 1;
    for (const sib of list.children) {
      if (sib === li) return n;
      if (isElement(sib) && sib.name === 'li') n++;
    }
    return null;
  }

  function emit(el, segs, kindOverride) {
    const norm = kindOverride === 'code' ? segs.filter((s) => s.t.length) : normalizeSegs(segs);
    const text = norm.map((s) => s.t).join('');
    if (!text.trim()) return;
    const tag = el.name || 'div';
    const info = ancestorInfo(el);
    blocks.push({
      id: blocks.length,
      kind: kindOverride || kindOf(tag),
      tag,
      segs: norm,
      text,
      depth: info.depth,
      quote: info.quote,
      path: info.path,
      chain: info.chain,
      num: tag === 'li' ? listNumber(el) : null,
    });
  }

  function walk(el) {
    if (DROP.has(el.name) || isHidden(el)) return;

    if (el.name === 'pre') {
      const text = $(el).text().replace(/^\n/, '').replace(/\s+$/, '');
      emit(el, [{ t: text, s: [] }], 'code');
      return;
    }

    if (el.name === 'tr') {
      const cells = (el.children || []).filter((c) => isElement(c) && (c.name === 'td' || c.name === 'th'));
      if (cells.length && cells.every((c) => (c.children || []).every((k) => k.type !== 'tag' || inlineOnly(k)))) {
        const segs = [];
        cells.forEach((c, i) => {
          if (i) segs.push({ t: ' │ ', s: ['dim'] });
          segs.push(...normalizeSegs(collectSegs(c.children || [], c.name === 'th' ? ['bold'] : [], [])));
        });
        emit(el, segs, 'row');
        return;
      }
    }

    // Runs of text/inline children become one block; block-level children are walked recursively.
    let run = [];
    const flush = () => {
      if (run.length) emit(el, collectSegs(run, [], []));
      run = [];
    };
    for (const child of el.children || []) {
      if (child.type === 'text') run.push(child);
      else if (isElement(child)) {
        if (inlineOnly(child)) run.push(child);
        else {
          flush();
          walk(child);
        }
      }
    }
    flush();
  }

  walk(body);
  return { blocks, meta };
}

function readMeta($) {
  const pick = (...sels) => {
    for (const sel of sels) {
      const v = $(sel).first().attr('content');
      if (v && v.trim()) return v.trim();
    }
    return null;
  };
  return {
    docTitle: $('title').first().text().trim() || null,
    ogTitle: pick('meta[property="og:title"]', 'meta[name="twitter:title"]'),
    author: pick('meta[name="author"]', 'meta[property="article:author"]', 'meta[name="parsely-author"]'),
    published: pick('meta[property="article:published_time"]', 'meta[name="date"]', 'meta[itemprop="datePublished"]'),
    siteName: pick('meta[property="og:site_name"]'),
    lang: $('html').attr('lang') || null,
  };
}
