import { layout, strWidth } from './render.js';

const ESC = '\x1b[';
const HELP = 'j/k ↑/↓ scroll · space/b page · g/G top/end · / search · n/N next/prev · q quit';

export function runPager(article, { maxWidth = 88 } = {}) {
  const { stdin, stdout } = process;

  let lines = [];
  let top = 0;
  let margin = 0;
  let query = '';
  let prompt = null; // string while typing a search
  let message = '';

  const rows = () => stdout.rows || 24;
  const cols = () => stdout.columns || 80;
  const page = () => rows() - 1;
  const maxTop = () => Math.max(0, lines.length - page());

  function relayout() {
    const anchor = lines.length ? top / lines.length : 0;
    const width = Math.max(20, Math.min(maxWidth, cols() - 4));
    margin = Math.max(2, Math.floor((cols() - width) / 2));
    lines = layout(article, { width, color: true });
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
    let left = ` ${message || HELP}`;
    const room = cols() - strWidth(right);
    while (strWidth(left) > room) left = left.slice(0, -1);
    return `${ESC}?25l${ESC}7m${left}${' '.repeat(Math.max(0, room - strWidth(left)))}${right}${ESC}0m`;
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
        case 'q': case 'Q': case '\x03': case '\x1b':
          return quit();
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
