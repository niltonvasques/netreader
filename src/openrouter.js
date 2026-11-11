const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * One chat completion via OpenRouter, retried on transient failures.
 * Returns { content, routed } where `routed` is the model that actually answered.
 */
export async function chat({ apiKey, model, messages, json = false, attempts = 3, signal }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request({ apiKey, model, messages, json, signal });
    } catch (err) {
      if (attempt >= attempts || err.fatal || signal?.aborted) throw err;
    }
  }
}

async function request({ apiKey, model, messages, json, signal }) {
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
      ...(json && { response_format: { type: 'json_object' } }),
      messages,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = new Error(`OpenRouter ${res.status}: ${body.error?.message ?? res.statusText}`);
    err.fatal = res.status === 401 || res.status === 402 || res.status === 403;
    throw err;
  }
  const content = body.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error(`model returned an empty reply (finish_reason: ${body.choices?.[0]?.finish_reason})`);
  return { content, routed: body.model };
}
