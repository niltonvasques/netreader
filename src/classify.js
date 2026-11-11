const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'typesafe/jev-router';

const SYSTEM = `You are the content-extraction engine of a terminal web reader.
You receive the metadata of a web page and an outline of its text blocks, one per line:
  <id>\t<tag>\t<dom path>\t<text snippet>  (long texts end with "…[N chars]")

Decide which blocks form the MAIN content: the article/post/documentation body the reader came for.
Exclude navigation, menus, headers/footers, breadcrumbs, sidebars, ads, cookie/newsletter/subscribe prompts,
share buttons, "related/recommended/read more" lists, tag lists, comment sections, author bios at the end,
copyright notices, and skip links. Keep in-body headings, lists, code, tables, quotes and captions.
Do NOT include the article's own title heading or its byline/date line in "keep" — report them in the fields instead.

Reply with JSON only:
{"title": string, "author": string|null, "date": string|null, "keep": string}
"keep" is a comma-separated list of block ids and inclusive ranges in document order, e.g. "12-40,43,47-90".`;

export function buildOutline(blocks) {
  const snip = blocks.length > 2500 ? 60 : 110;
  return blocks
    .map((b) => {
      const t = b.text.replace(/\s+/g, ' ');
      const s = t.length > snip ? `${t.slice(0, snip)}…[${t.length} chars]` : t;
      return `${b.id}\t${b.tag}\t${b.path}\t${s}`;
    })
    .join('\n');
}

export function parseRanges(spec, max) {
  const ids = new Set();
  for (const part of String(spec ?? '').split(/[\s,]+/)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i < max; i++) ids.add(i);
  }
  return ids;
}

export async function classifyWithJev({ blocks, meta, url, apiKey, model = DEFAULT_MODEL }) {
  const user = [
    `URL: ${url}`,
    `<title>: ${meta.docTitle ?? ''}`,
    meta.ogTitle && `og:title: ${meta.ogTitle}`,
    meta.author && `meta author: ${meta.author}`,
    meta.published && `meta published: ${meta.published}`,
    meta.siteName && `site: ${meta.siteName}`,
    '',
    'BLOCKS:',
    buildOutline(blocks),
  ]
    .filter((l) => l !== null && l !== undefined && l !== false)
    .join('\n');

  let json;
  let routed;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ json, routed } = await complete({ apiKey, model, user }));
      break;
    } catch (err) {
      if (attempt >= 3 || err.fatal) throw err;
    }
  }
  const keep = parseRanges(json.keep, blocks.length);
  if (!keep.size) throw new Error('model returned no content blocks');

  return {
    title: json.title || meta.ogTitle || meta.docTitle,
    author: json.author || null,
    date: json.date || null,
    keep,
    via: routed ? `${model} → ${routed}` : model,
  };
}

async function complete({ apiKey, model, user }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'netreader',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = new Error(`OpenRouter ${res.status}: ${body.error?.message ?? res.statusText}`);
    err.fatal = res.status === 401 || res.status === 402 || res.status === 403;
    throw err;
  }
  const content = body.choices?.[0]?.message?.content ?? '';
  const start = content.indexOf('{');
  if (start === -1) throw new Error(`model returned no JSON (finish_reason: ${body.choices?.[0]?.finish_reason})`);
  return { json: JSON.parse(content.slice(start, content.lastIndexOf('}') + 1)), routed: body.model };
}

/**
 * Offline fallback: score containers by the amount of paragraph text beneath them
 * and keep the blocks inside the best one.
 */
export function classifyHeuristic({ blocks, meta }) {
  const scores = new Map();
  for (const b of blocks) {
    if (b.kind !== 'para' || b.text.length < 60) continue;
    // Credit the block's container and its ancestors, decaying with distance.
    for (let i = b.chain.length - 1, w = 1; i >= 0 && w > 0.1; i--, w /= 2) {
      const key = b.chain[i];
      scores.set(key, (scores.get(key) ?? 0) + b.text.length * w);
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [k, v] of scores) if (v > bestScore) [best, bestScore] = [k, v];

  const keep = new Set();
  for (const b of blocks) {
    if (best === null || b.chain.includes(best)) keep.add(b.id);
  }

  const h1 = blocks.find((b) => b.tag === 'h1' && keep.has(b.id));
  if (h1) keep.delete(h1.id);
  return {
    title: meta.ogTitle || h1?.text || meta.docTitle,
    author: meta.author,
    date: meta.published,
    keep,
    via: 'heuristic',
  };
}
