import { layout, strWidth } from './render.js';

const ESC = '\x1b[';
const HELP = 'j/k ↑/↓ scroll · space/b page · g/G top/end · / search · n/N next/prev · +/- zoom · t TL;DR · q quit';
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const MIN_WIDTH = 24;
const ZOOM_STEP = 8;

/**
 * `tldr` (optional): { label, load(signal) => Promise<article> } — produces the TL;DR view on demand.
 */
export function runPager(article, { maxWidth = 88, tldr = null } = {}) {
  const { stdin, stdout } = process;

  let doc = article;
  let articleTop = 0; // reading position saved while the TL;DR view is open
  const summary = { state: 'idle', doc: null, wanted: false, frame: 0, timer: null, abort: new AbortController() };

  let lines = [];
  let top = 0;
  let margin = 0;
  let query = '';
  let prompt = null; // string while typing a search
  let message = '';
  let textWidth = maxWidth;

  const rows = () => stdout.rows || 24;
  const cols = () => stdout.columns || 80;
  const page = () => rows() - 1;
  const maxTop = () => Math.max(0, lines.length - page());
  const widestText = () => Math.max(MIN_WIDTH, cols() - 4);

  function relayout() {
    const anchor = lines.length ? top / lines.length : 0;
    const width = Math.max(MIN_WIDTH, Math.min(textWidth, widestText()));
    margin = Math.max(2, Math.floor((cols() - width) / 2));
    lines = layout(doc, { width, color: true });
    top = Math.min(maxTop(), Math.round(anchor * lines.length));
  }

  function highlight(entry) {
    if (!query) return entry.ansi;
    const lower = entry.plain.toLowerCase();
    const q = query.toLowerCase();
    if (!lower.includes(q)) return entry.ansi;
    let out = '';
    let i = 0;
    for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
      out += entry.plain.slice(i, j) + `${ESC}7m${entry.plain.slice(j, j + q.length)}${ESC}0m`;
      i = j + q.length;
    }
    return out + entry.plain.slice(i);
  }

  function draw() {
    const pad = ' '.repeat(margin);
    let buf = `${ESC}H`;
    for (let r = 0; r < page(); r++) {
      const entry = lines[top + r];
      buf += `${ESC}2K${entry ? pad + highlight(entry) : ''}\r\n`;
    }
    buf += `${ESC}2K${statusLine()}`;
    stdout.write(buf);
  }

  function statusLine() {
    if (prompt !== null) return `/${prompt}${ESC}?25h`;
    const pct = lines.length <= page() ? 100 : Math.round(((top + page()) / lines.length) * 100);
    const right = ` ${Math.min(100, pct)}% `;
    const loading = summary.state === 'loading' ? `${SPINNER[summary.frame % SPINNER.length]} Summarizing with ${tldr.label}… ` : '';
    let left = ` ${message || loading || (doc === article ? HELP : 'TL;DR · t/q/Esc back to the article')}`;
    const room = cols() - strWidth(right);
    while (strWidth(left) > room) left = left.slice(0, -1);
    return `${ESC}?25l${ESC}7m${left}${' '.repeat(Math.max(0, room - strWidth(left)))}${right}${ESC}0m`;
  }

  // A terminal app cannot change the font size, so zoom narrows or widens the text column.
  function zoom(dir) {
    const current = Math.min(textWidth, widestText());
    if (dir === 0) textWidth = maxWidth;
    else textWidth = Math.max(MIN_WIDTH, Math.min(widestText(), current - dir * ZOOM_STEP));
    relayout();
    const width = Math.min(textWidth, widestText());
    const pct = Math.round((maxWidth / width) * 100);
    message = `Zoom ${pct}% · ${width} columns${width === widestText() ? ' (full width)' : width === MIN_WIDTH ? ' (max zoom)' : ''}`;
  }

  function showView(next, savedTop) {
    doc = next;
    lines = [];
    relayout();
    scrollTo(savedTop);
  }

  function toggleTldr() {
    if (doc !== article) return showView(article, articleTop);
    if (!tldr) {
      message = 'TL;DR needs OPENROUTER_API_KEY';
      return;
    }
    if (summary.state === 'ready') {
      articleTop = top;
      return showView(summary.doc, 0);
    }
    summary.wanted = true;
    if (summary.state === 'loading') return;
    summary.state = 'loading';
    summary.timer = setInterval(() => {
      summary.frame++;
      if (prompt === null && !message) draw();
    }, 100);
    tldr.load(summary.abort.signal).then(
      (result) => {
        summary.state = 'ready';
        summary.doc = result;
        if (summary.wanted && doc === article) {
          articleTop = top;
          showView(result, 0);
        }
      },
      (err) => {
        summary.state = 'idle';
        if (!summary.abort.signal.aborted) message = `TL;DR failed: ${err.message}`;
      },
    ).finally(() => {
      clearInterval(summary.timer);
      if (!summary.abort.signal.aborted) draw();
    });
  }

  function scrollTo(n) {
    top = Math.max(0, Math.min(maxTop(), n));
  }

  function find(dir) {
    if (!query) return;
    const q = query.toLowerCase();
    for (let k = 1; k <= lines.length; k++) {
      const i = (top + dir * k + lines.length) % lines.length;
      if (lines[i].plain.toLowerCase().includes(q)) {
        scrollTo(i - 2);
        message = `/${query}`;
        return;
      }
    }
    message = `Pattern not found: ${query}`;
  }

  return new Promise((resolve) => {
    function quit() {
      summary.abort.abort();
      clearInterval(summary.timer);
      stdout.off('resize', onResize);
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
      resolve();
    }

    function onResize() {
      relayout();
      draw();
    }

    function onData(data) {
      for (const key of data.match(/\x1b\[[0-9;<]*[~A-Za-z]|\x1bO[A-Z]|[\s\S]/gu) ?? []) onKey(key);
    }

    function onKey(key) {
      message = '';
      if (prompt !== null) {
        if (key === '\r' || key === '\n') {
          query = prompt;
          prompt = null;
          find(1);
        } else if (key === '\x1b' || key === '\x03') {
          prompt = null;
        } else if (key === '\x7f' || key === '\b') {
          prompt = prompt.slice(0, -1);
        } else if (key >= ' ' && !key.startsWith('\x1b')) {
          prompt += key;
        }
        draw();
        return;
      }

      switch (key) {
        case '\x03':
          return quit();
        case 'q': case 'Q': case '\x1b':
          if (doc === article) return quit();
          toggleTldr(); break;
        case 't': case 'T':
          toggleTldr(); break;
        case 'j': case '\x1b[B': case '\x1bOB': case '\r': case '\x0e':
          scrollTo(top + 1); break;
        case 'k': case '\x1b[A': case '\x1bOA': case '\x10':
          scrollTo(top - 1); break;
        case ' ': case 'f': case '\x1b[6~': case '\x06':
          scrollTo(top + page() - 1); break;
        case 'b': case '\x1b[5~': case '\x02':
          scrollTo(top - page() + 1); break;
        case 'd': case '\x04':
          scrollTo(top + Math.floor(page() / 2)); break;
        case 'u': case '\x15':
          scrollTo(top - Math.floor(page() / 2)); break;
        case 'g': case '\x1b[H': case '\x1b[1~': case '<':
          scrollTo(0); break;
        case 'G': case '\x1b[F': case '\x1b[4~': case '>':
          scrollTo(maxTop()); break;
        case '/':
          prompt = ''; break;
        case 'n':
          find(1); break;
        case 'N':
          find(-1); break;
        case '+': case '=':
          zoom(1); break;
        case '-': case '_':
          zoom(-1); break;
        case '0':
          zoom(0); break;
        case 'h': case '?':
          message = HELP; break;
        default:
          return;
      }
      draw();
    }

    stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    relayout();
    draw();
  });
}
