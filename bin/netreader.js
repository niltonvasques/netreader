#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { classifyHeuristic, classifyWithJev, DEFAULT_MODEL } from '../src/classify.js';
import { extract } from '../src/extract.js';
import { fetchHtml, normalizeUrl } from '../src/fetch.js';
import { runPager } from '../src/pager.js';
import { layout } from '../src/render.js';

const USAGE = `Usage: netreader [options] <url>

Read the main text of a web page in your terminal.

Options:
  -p, --print        Print the article to stdout instead of opening the reader
  -r, --refresh      Ignore the cache and re-extract the page
      --no-ai        Skip Jev and use the local heuristic extractor
  -m, --model <id>   OpenRouter model (default: $NETREADER_MODEL or ${DEFAULT_MODEL})
  -w, --width <n>    Maximum text width (default: 88)
  -h, --help         Show this help

Environment:
  OPENROUTER_API_KEY  Read from the environment, ./.env, or the netreader install's .env

Keys: j/k ↑/↓ scroll · space/b page · d/u half page · g/G top/end · / search · n/N · q quit`;

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'netreader');

function loadEnv() {
  for (const file of [join(process.cwd(), '.env'), join(appDir, '.env')]) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {}
    }
  }
}

function spinner(text) {
  if (!process.stderr.isTTY) return { set() {}, stop() {} };
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let i = 0;
  let label = text;
  const timer = setInterval(() => process.stderr.write(`\r\x1b[2K${frames[i++ % frames.length]} ${label}`), 80);
  return {
    set(t) {
      label = t;
    },
    stop() {
      clearInterval(timer);
      process.stderr.write('\r\x1b[2K');
    },
  };
}

function cachePath(url, mode) {
  return join(cacheDir, `${createHash('sha1').update(`${mode}:${url}`).digest('hex')}.json`);
}

async function getArticle(url, opts) {
  const mode = opts.ai ? opts.model : 'heuristic';
  const file = cachePath(url, mode);
  if (!opts.refresh && existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
  }

  const spin = spinner(`Fetching ${url}`);
  try {
    const { html, finalUrl } = await fetchHtml(url);
    const { blocks, meta } = extract(html);
    if (!blocks.length) throw new Error('no readable text found on the page');

    let result;
    if (opts.ai) {
      spin.set(`Asking Jev to find the article in ${blocks.length} blocks…`);
      try {
        result = await classifyWithJev({ blocks, meta, url: finalUrl, apiKey: opts.apiKey, model: opts.model });
      } catch (err) {
        spin.stop();
        process.stderr.write(`netreader: Jev classification failed (${err.message}); using heuristic\n`);
        result = classifyHeuristic({ blocks, meta });
      }
    } else {
      result = classifyHeuristic({ blocks, meta });
    }

    const article = {
      url: finalUrl,
      title: result.title,
      author: result.author,
      date: result.date,
      via: result.via,
      blocks: blocks.filter((b) => result.keep.has(b.id)).map(({ kind, tag, segs, text, depth, num, quote }) => ({
        kind, tag, segs, text, depth, num, quote,
      })),
    };
    if (result.via !== 'heuristic' || !opts.ai) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify(article));
    }
    return article;
  } finally {
    spin.stop();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        print: { type: 'boolean', short: 'p' },
        refresh: { type: 'boolean', short: 'r' },
        'no-ai': { type: 'boolean' },
        model: { type: 'string', short: 'm' },
        width: { type: 'string', short: 'w' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(`netreader: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { values, positionals } = args;
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  loadEnv();
  const apiKey = process.env.OPENROUTER_API_KEY;
  let ai = !values['no-ai'];
  if (ai && !apiKey) {
    process.stderr.write('netreader: OPENROUTER_API_KEY not set; using heuristic extractor\n');
    ai = false;
  }

  const width = Number.parseInt(values.width ?? '88', 10) || 88;
  const article = await getArticle(normalizeUrl(positionals[0]), {
    ai,
    apiKey,
    refresh: values.refresh,
    model: values.model || process.env.NETREADER_MODEL || DEFAULT_MODEL,
  });

  if (values.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    const color = process.stdout.isTTY && !process.env.NO_COLOR;
    const cols = process.stdout.isTTY ? process.stdout.columns : 80;
    const lines = layout(article, { width: Math.min(width, cols), color });
    process.stdout.write(lines.map((l) => (color ? l.ansi : l.plain)).join('\n') + '\n');
    return;
  }
  await runPager(article, { maxWidth: width });
}

main().catch((err) => {
  console.error(`netreader: ${err.message}`);
  process.exit(1);
});
