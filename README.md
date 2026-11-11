# netreader

Read the main text of any web page in your terminal.

```sh
netreader https://paulgraham.com/greatwork.html
```

netreader fetches the page, splits the DOM into numbered text blocks, and asks
[Jev](https://openrouter.ai/typesafe/jev-router) (via OpenRouter) which blocks are the
article body, title, author and date. Navigation, ads, sidebars, comments and the rest
are dropped, and the article opens in a scrollable reader.

## Setup

```sh
npm install
npm link            # puts `netreader` on your PATH
echo 'OPENROUTER_API_KEY=sk-or-...' > .env
```

The key is read from the environment, `./.env`, or the `.env` next to the install.
Without a key (or with `--no-ai`) a local text-density heuristic is used instead.

## Usage

```
netreader [options] <url>

  -p, --print            Print to stdout instead of opening the reader (automatic when piped)
  -r, --refresh          Ignore the cache and re-extract the page
      --no-ai            Use the local heuristic extractor
  -m, --model <id>       OpenRouter model (default: $NETREADER_MODEL or typesafe/jev-router)
  -w, --width <n>        Maximum text width (default: 88)
  -t, --tldr             Print a TL;DR of the article instead of the article
      --tldr-model <id>  TL;DR model (default: $NETREADER_TLDR_MODEL or openai/gpt-6-luna)
```

Reader keys: `j`/`k` or arrows to scroll, `space`/`b` page, `d`/`u` half page,
`g`/`G` top/end, `/` search, `n`/`N` next/previous match, `+`/`-` zoom in/out,
`0` reset zoom, `t` TL;DR, `q` quit.

`t` asks [gpt-6-luna](https://openrouter.ai/openai/gpt-6-luna) for a short summary plus key
takeaways and opens it in place of the article; you can keep reading while it's generated.
Press `t`, `q` or `Esc` to return to where you were. Summaries are cached too.

Zoom narrows or widens the text column (a terminal program can't change the font size);
`-w` sets the starting width. For bigger glyphs, use your terminal's own font zoom
(e.g. `Ctrl+=`/`Ctrl+-` in foot or kitty) — the reader reflows to the new size.

Extracted articles are cached in `~/.cache/netreader`.
