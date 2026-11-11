import { chat } from './openrouter.js';

export const DEFAULT_TLDR_MODEL = 'openai/gpt-6-luna';
const MAX_CHARS = 400_000;

const SYSTEM = `You write TL;DRs of articles for a terminal reader.
Reply in plain text (no markdown headings, tables or bold), in the article's language:
first a one- or two-sentence summary of the article's main point,
then a blank line, then 3 to 7 key takeaways, one per line, each starting with "- ".`;

export async function summarize({ article, apiKey, model = DEFAULT_TLDR_MODEL, signal }) {
  let text = article.blocks.map((b) => b.text).join('\n\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n\n[truncated]`;

  const header = [`Title: ${article.title ?? ''}`, article.author && `Author: ${article.author}`, `URL: ${article.url}`];
  const { content } = await chat({
    apiKey,
    model,
    signal,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${header.filter(Boolean).join('\n')}\n\n${text}` },
    ],
  });
  return content.trim();
}

/** Turn a TL;DR reply into an article the renderer can lay out. */
export function tldrArticle(article, summary, model) {
  const blocks = [];
  for (const raw of summary.split('\n')) {
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    const t = (item ? item[1] : raw).replace(/\*\*|__/g, '').trim();
    if (!t) continue;
    blocks.push({ kind: item ? 'item' : 'para', tag: item ? 'li' : 'p', segs: [{ t, s: [] }], text: t, depth: 1, num: null, quote: false });
  }
  return { url: article.url, title: `TL;DR · ${article.title ?? article.url}`, author: `Summary by ${model}`, blocks };
}
