const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export function normalizeUrl(input) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
}

export async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  const charset = detectCharset(res.headers.get('content-type'), buf);
  let html;
  try {
    html = new TextDecoder(charset).decode(buf);
  } catch {
    html = new TextDecoder('utf-8').decode(buf);
  }
  return { html, finalUrl: res.url || url };
}

function detectCharset(contentType, buf) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}
